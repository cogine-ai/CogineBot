import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import type { Prisma } from "./generated/prisma/client.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { installDbContext, withRowLevelSecurity, withTransactionContext } from "./row-security.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
  /** Enable context-aware queries during the staged row-security rollout. */
  rowSecurity?: boolean;
}

const DEFAULT_POOL_MAX = 4;
const CONNECT_RETRY_ATTEMPTS = 8;
const abortableCheckout = new AsyncLocalStorage<AbortSignal>();

/** Only work in this scope can discard its checked-out connection when stopped. */
export function withAbortableDatabaseCheckout<T>(signal: AbortSignal, work: () => Promise<T>) {
  return abortableCheckout.run(signal, work);
}

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Fail a checkout instead of queueing forever when Postgres is already at
    // max_connections (53300) or the pool is saturated.
    connectionTimeoutMillis: 10_000,
    // 0 disables idle eviction. Dropping idle clients and reopening them on the
    // next job burst is how a tight Postgres hits 53300; keep what we already have.
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    keepAlive: true,
  });
  // graphile-worker (and Node itself) require an 'error' listener on a shared
  // pool: an idle-client disconnect is otherwise an unhandled error that kills
  // the process and orphans the TCP sessions until Postgres times them out.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  installConnectRetry(pool);
  if (options.rowSecurity) installDbContext(pool);
  return pool;
}

export function createDb(
  connectionString: string,
  options: DbClientOptions = {},
): { prisma: PrismaClient; pool: Pool } {
  const pool = createPool(connectionString, options);
  const adapter = new PrismaPg(pool);
  // History is read explicitly by the owner's settings routes and writers.
  const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
    adapter,
    omit: { bot: { settingsHistory: true } },
  });
  return {
    prisma: options.rowSecurity
      ? withRowLevelSecurity(prisma, installDbContext(pool))
      : withTransactionContext(prisma),
    pool,
  };
}

export function isTooManyDatabaseConnections(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (code === "P2037" || code === "53300") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Too many database connections opened") ||
      message.includes("sorry, too many clients already")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** pg-pool's error when no connection frees up within `connectionTimeoutMillis`. */
function isPoolCheckoutTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout exceeded when trying to connect";
}

/**
 * Postgres codes, Prisma codes and pg driver adapter error kinds that say the database cannot
 * take the work right now: read-only during a failover, shutting down or starting up, out of
 * connections, or not reachable.
 */
const UNAVAILABLE_CODES = new Set([
  "25006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "P1001",
  "P1002",
  "P1017",
  "P2024",
  "P2037",
]);
const UNAVAILABLE_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
]);
/** Raw socket failures, which only count when the caller knows they came from a database connection. */
const SOCKET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);
/** pg's own errors for a connection that died: `query_timeout` firing, or the socket closing. */
const UNAVAILABLE_MESSAGE =
  /read-only transaction|^Connection terminated|Can't reach database server|^Query read timeout$/;

/**
 * Whether an error means the database is unavailable rather than that the work is wrong, so
 * callers back off and wait instead of failing the work. Follows causes, Prisma's driver adapter
 * error and aggregated connection attempts. Socket errors also come from other services, so they
 * count only with `fromDatabaseConnection`.
 */
export function isDatabaseUnavailable(
  error: unknown,
  options: { fromDatabaseConnection?: boolean } = {},
): boolean {
  if (isTooManyDatabaseConnections(error)) return true;
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (isPoolCheckoutTimeout(current)) return true;
    const fields = current as Record<string, unknown>;
    for (const key of ["code", "originalCode"]) {
      const code = fields[key];
      if (typeof code !== "string") continue;
      if (UNAVAILABLE_CODES.has(code)) return true;
      if (options.fromDatabaseConnection && SOCKET_CODES.has(code)) return true;
    }
    if (typeof fields.kind === "string" && UNAVAILABLE_KINDS.has(fields.kind)) return true;
    if (current instanceof Error && UNAVAILABLE_MESSAGE.test(current.message)) return true;
    pending.push(fields.cause, fields.meta, fields.driverAdapterError);
    if (Array.isArray(fields.errors)) pending.push(...fields.errors);
  }
  return false;
}

export async function retryOnTooManyConnections<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONNECT_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTooManyDatabaseConnections(error) || attempt >= attempts - 1) throw error;
      await sleep(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
}

function installConnectRetry(pool: Pool): void {
  type ConnectCallback = (
    err: Error,
    client: PoolClient,
    done: (release?: boolean) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };
  const detachAbort = new WeakMap<PoolClient, () => void>();
  pool.on("release", (_error, client) => detachAbort.get(client)?.());

  function bindAbort(client: PoolClient, signal: AbortSignal): PoolClient {
    if (signal.aborted) {
      client.release(true);
      signal.throwIfAborted();
    }
    // End only the still-checked-out socket. Its release removes this listener
    // before the pool can lend it to any other operation.
    const stop = () => void client.end().catch(() => undefined);
    signal.addEventListener("abort", stop, { once: true });
    detachAbort.set(client, () => {
      signal.removeEventListener("abort", stop);
      detachAbort.delete(client);
    });
    return client;
  }

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    if (!callback) {
      const signal = abortableCheckout.getStore();
      const checkout = retryOnTooManyConnections(() => {
        signal?.throwIfAborted();
        return originalConnect();
      });
      return signal ? checkout.then((client) => bindAbort(client, signal)) : checkout;
    }
    const attempt = (n: number) => {
      originalConnect((err, client, done) => {
        if (err && isTooManyDatabaseConnections(err) && n < CONNECT_RETRY_ATTEMPTS - 1) {
          setTimeout(() => attempt(n + 1), Math.min(5_000, 200 * 2 ** n));
          return;
        }
        callback(err, client, done);
      });
    };
    attempt(0);
  }

  pool.connect = connect as Pool["connect"];
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
