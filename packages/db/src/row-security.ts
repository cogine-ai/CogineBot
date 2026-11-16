import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";

/**
 * Who a database operation runs for. Row-level security policies read the
 * matching `app.*` settings on the connection that runs the statement.
 *
 * - `tenant`: rows are limited to one Space (and, for user-owned rows, one user).
 * - `system`: an explicit, named bypass for work that legitimately spans
 *   tenants (job dispatch, reconcilers, webhooks before they resolve a tenant).
 *
 * Without a context, protected tables return no rows and reject writes.
 * Tenant settings assume trusted backend SQL and server-derived identities.
 * They do not authenticate a caller with arbitrary SQL execution capability.
 */
export type DbContext =
  | { kind: "tenant"; spaceId: string; userId: string }
  | { kind: "system"; reason: string };

const storage = new AsyncLocalStorage<DbContext>();

export function currentDbContext(): DbContext | undefined {
  return storage.getStore();
}

export function runAsTenant<T>(
  tenant: { spaceId: string; userId: string },
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  return within({ kind: "tenant", spaceId: tenant.spaceId, userId: tenant.userId }, fn);
}

/**
 * Run `fn` across tenants. Each call is an audited bypass of row-level
 * security, so name why: `grep -rn "runAsSystem("` lists every one.
 */
export function runAsSystem<T>(reason: string, fn: () => T | PromiseLike<T>): Promise<T> {
  return within({ kind: "system", reason }, fn);
}

/**
 * The same client with every call run as an explicit system context, for test
 * fixtures and assertions that have no request or job around them. Code under
 * test keeps the context its request or job gives it.
 */
export function asSystem<T extends object>(client: T, reason = "test fixture"): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === TRANSACTION_BYPASS_KEY) return value;
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          storage.run({ kind: "system", reason }, () => {
            const result = Reflect.apply(value, target, args);
            return result && typeof result === "object" ? asSystem(result, reason) : result;
          });
      }
      if (value && typeof value === "object") return asSystem(value, reason);
      return value;
    },
  });
}

const TRANSACTION_BYPASS_KEY = Symbol("transaction bypass key");
const PRISMA_TRANSACTION_SCOPE = Symbol.for("prisma.client.transaction.scope_context");

/** SDK transaction identity only; system steps separately verify the context binding. */
export function isInteractiveTransaction(value: object): value is Prisma.TransactionClient {
  const scope = Reflect.get(value, PRISMA_TRANSACTION_SCOPE) as { txId?: unknown } | undefined;
  return typeof scope?.txId === "string";
}

type TransactionBinding = { mode: "disabled" } | { mode: "enabled"; bypassKey: BypassKeySource };

type TransactionState = TransactionBinding & {
  owner?: symbol;
  queries: number;
  poisoned: boolean;
  closed: boolean;
};
type TransactionOwner = { state: TransactionState; token: symbol; parent?: TransactionOwner };
const transactionOwner = new AsyncLocalStorage<TransactionOwner>();

function ownerFor(state: TransactionState): symbol | undefined {
  for (let frame = transactionOwner.getStore(); frame; frame = frame.parent)
    if (frame.state === state) return frame.token;
  return undefined;
}

function concurrentTransactionAccess(): Error {
  return new Error("Concurrent system transaction access is not supported");
}

function guardTransactionQuery(state: TransactionState): void {
  const owner = ownerFor(state);
  if (
    state.closed ||
    state.poisoned ||
    state.owner !== owner ||
    (state.owner !== undefined && currentDbContext()?.kind !== "system")
  )
    throw concurrentTransactionAccess();
}

type SqlClient = Pick<PrismaClient, "$queryRaw">;

/**
 * runAsSystem for a step inside an interactive transaction a tenant opened: the
 * transaction's connection keeps the settings it was checked out with, so this
 * turns the bypass on for `fn` and back afterwards. Name why, as for runAsSystem.
 * A compatibility-mode transaction changes only the execution context, without
 * reading or changing connection settings or supplying an RLS bypass key.
 * The step is exclusive: reentrant steps and sibling queries are rejected.
 * A failed restore makes the transaction unusable and requires rollback.
 */
export async function runAsSystemInTransaction<T>(
  tx: SqlClient,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  const state = Reflect.get(tx, TRANSACTION_BYPASS_KEY) as TransactionState | undefined;
  if (!state || typeof state !== "object")
    throw new Error("System transaction requires a context-aware interactive transaction");
  if (state.closed || state.poisoned || state.owner !== undefined || state.queries)
    throw concurrentTransactionAccess();
  const token = Symbol("system transaction owner");
  state.owner = token;
  const frame: TransactionOwner = { state, token, parent: transactionOwner.getStore() };
  try {
    return await transactionOwner.run(frame, () =>
      within({ kind: "system", reason }, async () => {
        let enable: (() => Promise<unknown>) | undefined;
        let restore: (() => Promise<unknown>) | undefined;
        if (state.mode === "enabled") {
          const bypassKey = await resolveBypassKey(state.bypassKey);
          const [previous] = await tx.$queryRaw<
            Array<{ bypass: string | null; key: string | null }>
          >`SELECT current_setting('app.rls_bypass', true) AS bypass,
            current_setting('app.rls_bypass_key', true) AS key`;
          restore = () =>
            tx.$queryRaw`SELECT set_config('app.rls_bypass', ${previous?.bypass ?? "off"}, true),
            set_config('app.rls_bypass_key', ${previous?.key ?? ""}, true)`;
          enable = () =>
            tx.$queryRaw`SELECT set_config('app.rls_bypass', 'on', true),
              set_config('app.rls_bypass_key', ${bypassKey}, true)`;
        }
        let failed = false;
        let failure: unknown;
        let result!: T;
        try {
          await enable?.();
          result = await fn();
        } catch (error) {
          failed = true;
          failure = error;
        }
        try {
          if (state.queries) throw concurrentTransactionAccess();
          await restore?.();
        } catch (error) {
          state.poisoned = true;
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        if (failed) throw failure;
        return result;
      }),
    );
  } finally {
    state.owner = undefined;
  }
}

// Prisma operations are lazy and start when awaited. Await inside the scope so
// an operation returned from `fn` still runs with this context.
function within<T>(context: DbContext, fn: () => T | PromiseLike<T>): Promise<T> {
  return storage.run(context, async () => await fn());
}

export const ROW_SECURITY_MODELS: ReadonlySet<string> = new Set([
  "AiDataConsent",
  "User",
  "Session",
  "Account",
  "Verification",
  "RateLimit",
  "Organization",
  "BillingAccount",
  "ActionApprovalRule",
  "ActionAutoReviewPreference",
  "Member",
  "Space",
  "SpaceMember",
  "SpaceCollaborationChange",
  "Invitation",
  "DeploymentSettings",
  "UserModelCredential",
  "UserVoiceCredential",
  "SpaceModelPreference",
  "SpaceBackupModel",
  "SpaceVoicePreference",
  "Bot",
  "BotPackagePreview",
  "BotPackageImport",
  "BotPackageComponent",
  "BotSection",
  "BotDeletion",
  "ChatGroup",
  "ChatGroupMember",
  "Thread",
  "Message",
  "Event",
  "Task",
  "Run",
  "SteeringMessage",
  "Attempt",
  "CloudAgent",
  "ExternalEffect",
  "Routine",
  "ScratchpadItem",
  "TaughtSkill",
  "AgentSkill",
  "Connection",
  "CapabilityInstall",
  "OpenApiImportReceipt",
  "MemoryDocument",
  "MemoryRevision",
  "AgentHome",
  "BrowserProfile",
  "ComputerUpdate",
  "Computer",
  "ComputerExecutionLease",
  "Artifact",
  "UsageRecord",
  "NotificationPreference",
  "SpaceMemoryConfig",
  "Secret",
  "McpServer",
  "McpOAuthSession",
  "ModelOAuthSession",
  "BotMcpServer",
  "MessagingIdentity",
  "MessagingInstallSession",
  "MessagingInstallation",
  "MessagingCredentialCleanup",
  "MessagingChannel",
  "MessagingChannelMember",
  "MessagingLinkCode",
  "Page",
  "PageVersion",
  "MessagingOutbound",
  "AgentConnection",
  "BotSecret",
  "DeploymentIdentity",
  "DeploymentTransferSession",
  "DeploymentTransferItem",
  "ExternalConversation",
  "ExternalMessage",
  "AgentSecret",
  "IntegrationProviderConfig",
  "Board",
  "Ticket",
  "TicketComment",
  "NativeAppConfig",
  "NativeOAuthSession",
  "NativeOAuthGrant",
  "NativeRoutineTrigger",
  "NativeNotionHook",
  "NativeSlackHook",
  "NativeSlackEventInbox",
]);

/**
 * Proves a system context to the database. The policies honour app.rls_bypass only
 * alongside this key. A deployment owner must register its digest in the private
 * store before protected system access can work; the runtime cannot read that store.
 * This deterministic URL-only utility does not resolve environment or pgpass
 * credentials. Runtime contexts use the authenticated pool connection instead.
 */
export function rlsBypassKey(connectionString: string | undefined): string {
  const { password } = databaseCredentials(connectionString);
  return password ? passwordBypassKey(password) : "";
}

function passwordBypassKey(password: string): string {
  return createHmac("sha256", password).update("coginebot rls bypass").digest("hex");
}

export type RlsBypassKeyResolver = () => Promise<string>;
type BypassKeySource = string | RlsBypassKeyResolver;

async function resolveBypassKey(source: BypassKeySource): Promise<string> {
  const key = typeof source === "function" ? await source() : source;
  if (typeof key !== "string" || !key)
    throw new Error("Protected system database access requires an authenticated password");
  return key;
}

// Match pg-connection-string: the last query value wins, then an empty value
// falls back to URL userinfo. Environment/pgpass belong to the connected client.
export function databaseCredentials(connectionString: string | undefined): {
  user: string;
  password: string;
} {
  let normalized = connectionString ?? "";
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(normalized))
    normalized = encodeURI(normalized).replace(/%25(\d\d)/g, "%$1");
  try {
    const url = new URL(normalized);
    return {
      user: url.searchParams.getAll("user").at(-1) || decodeURIComponent(url.username),
      password: url.searchParams.getAll("password").at(-1) || decodeURIComponent(url.password),
    };
  } catch {
    return { user: "", password: "" };
  }
}

type Settings = [spaceId: string, userId: string, bypass: "on" | "off", bypassKey: string];

function settingsFor(context: DbContext | undefined, bypassKey: string): Settings {
  if (context?.kind === "tenant") return [context.spaceId, context.userId, "off", ""];
  if (context?.kind === "system") return ["", "", "on", bypassKey];
  return ["", "", "off", ""];
}

const SET_SESSION =
  "SELECT set_config('app.space_id', $1, false), set_config('app.user_id', $2, false), set_config('app.rls_bypass', $3, false), set_config('app.rls_bypass_key', $4, false)";
const applied = new WeakMap<PoolClient, string>();

async function applySettings(client: PoolClient, settings: Settings): Promise<void> {
  const key = settings.join("\u0000");
  // A new connection has none of these settings yet.
  if (applied.get(client) === key) return;
  // Forget the old value first: if this fails, the next checkout sets it again.
  applied.delete(client);
  await client.query(SET_SESSION, settings);
  applied.set(client, key);
}

const poolKeys = new WeakMap<Pool, RlsBypassKeyResolver>();

/**
 * Give every connection checked out of `pool` the settings of the context that
 * asked for it, captured when `connect` is called (the callback of a queued
 * checkout can run in whichever request released the connection). A
 * connection only gets a round trip when its settings change, and a checkout
 * with no context clears what an earlier one left behind.
 * The returned resolver uses the pool's first authenticated password and shares
 * its key with Prisma operations. Credential rotation requires a new pool and
 * registration of its digest; a pool rejects connections with a different key.
 */
export function installDbContext(pool: Pool): RlsBypassKeyResolver {
  const installed = poolKeys.get(pool);
  if (installed) return installed;
  type ConnectCallback = (
    err: Error | undefined,
    client: PoolClient | undefined,
    done: (release?: unknown) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

  let key: string | undefined;
  let pending: Promise<string> | undefined;
  const captureKey = (client: PoolClient): string => {
    const password = client.password;
    if (typeof password !== "string" || !password)
      throw new Error("Protected database access requires an authenticated password");
    const candidate = passwordBypassKey(password);
    if (key !== undefined && key !== candidate)
      throw new Error("Database authentication changed; create a new pool and register its key");
    key = candidate;
    return candidate;
  };
  const resolveKey: RlsBypassKeyResolver = () => {
    if (key !== undefined) return Promise.resolve(key);
    if (!pending)
      pending = originalConnect()
        .then((client) => {
          let authenticated: string;
          try {
            authenticated = captureKey(client);
          } catch (error) {
            client.release(error as Error);
            throw error;
          }
          client.release();
          return authenticated;
        })
        .finally(() => {
          pending = undefined;
        });
    return pending;
  };
  const prepare = (client: PoolClient, context: DbContext | undefined) =>
    applySettings(client, settingsFor(context, captureKey(client)));

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const context = storage.getStore();
    if (!callback) {
      return originalConnect().then(async (client) => {
        try {
          await prepare(client, context);
          return client;
        } catch (error) {
          client.release(error as Error);
          throw error;
        }
      });
    }
    originalConnect((err, client, done) => {
      if (err || !client) return callback(err, client, done);
      Promise.resolve()
        .then(() => prepare(client, context))
        .then(
          () => callback(undefined, client, done),
          (error: Error) => {
            done(error);
            callback(error, undefined, () => undefined);
          },
        );
    });
  }

  pool.connect = connect as Pool["connect"];
  poolKeys.set(pool, resolveKey);
  return resolveKey;
}

const LOCAL_SETTINGS = (settings: Settings) =>
  Prisma.sql`SELECT set_config('app.space_id', ${settings[0]}, true), set_config('app.user_id', ${settings[1]}, true), set_config('app.rls_bypass', ${settings[2]}, true), set_config('app.rls_bypass_key', ${settings[3]}, true)`;

// A wrapped read keeps the pool's checkout timeout and no run limit it did not
// have before, instead of Prisma's 2s/5s transaction defaults.
const WRAPPED_OPERATION_OPTIONS = { maxWait: 10_000, timeout: 300_000 };

type InternalParams = { transaction?: { kind?: string; id?: string } };
function bindTransactions(
  client: PrismaClient,
  binding: TransactionBinding,
  transactions: Map<string, TransactionState>,
): PrismaClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "$extends")
        return (...args: unknown[]) =>
          bindTransactions(Reflect.apply(target.$extends, target, args), binding, transactions);
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      const transact = target.$transaction;
      return (...args: unknown[]) => {
        const parentScope = Reflect.get(target, PRISMA_TRANSACTION_SCOPE) as
          | { txId?: string }
          | undefined;
        const parentState = parentScope?.txId ? transactions.get(parentScope.txId) : undefined;
        if (parentState) {
          guardTransactionQuery(parentState);
          if (parentState.owner !== undefined) throw concurrentTransactionAccess();
        }
        const callback = args[0];
        if (typeof callback === "function")
          args[0] = async (tx: Prisma.TransactionClient) => {
            const scope = Reflect.get(tx, PRISMA_TRANSACTION_SCOPE) as
              | { txId?: string }
              | undefined;
            if (typeof scope?.txId !== "string")
              throw new Error("Interactive transaction identity is unavailable");
            const existing = transactions.get(scope.txId);
            const state: TransactionState = existing ?? {
              ...binding,
              queries: 0,
              poisoned: false,
              closed: false,
            };
            if (!existing) transactions.set(scope.txId, state);
            const bound = new Proxy(tx, {
              get(transaction, key, receiver) {
                if (key === TRANSACTION_BYPASS_KEY) return state;
                if (key === "$transaction")
                  return bindTransactions(transaction as PrismaClient, binding, transactions)
                    .$transaction;
                return Reflect.get(transaction, key, receiver);
              },
            });
            try {
              const result = await callback(bound);
              if (state.owner !== undefined || state.queries || state.poisoned)
                throw concurrentTransactionAccess();
              return result;
            } finally {
              if (!existing) {
                state.closed = true;
                transactions.delete(scope.txId);
              }
            }
          };
        return Reflect.apply(transact, target, args);
      };
    },
  });
}

const reportedMissing = new Set<string>();
const MAX_REPORTED = 500;

// The database already returns nothing here, so log once per call site to point
// at the missing runAsTenant / runAsSystem instead of an empty result.
function missingContext(model: string, operation: string): void {
  const error = new Error(`${model}.${operation} ran outside runAsTenant/runAsSystem`);
  const callSite = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((frame) => !/row-security|@prisma|node:internal/.test(frame))
    .slice(0, 3)
    .join("\n");
  const key = `${model}.${operation}\n${callSite}`;
  if (reportedMissing.has(key) || reportedMissing.size >= MAX_REPORTED) return;
  reportedMissing.add(key);
  getLogger().error("database access without a tenant or system context", error, {
    model,
    operation,
  });
}

/**
 * The call sites logged since the last call, cleared as they are returned.
 * Diagnostics and integration checks can use them to identify queries that
 * reached a protected model without an execution context.
 */
export function drainUnscopedDatabaseAccess(): string[] {
  const sites = [...reportedMissing];
  reportedMissing.clear();
  return sites;
}

function beginTransactionQuery(
  internal: InternalParams | undefined,
  transactions: Map<string, TransactionState>,
): TransactionState | undefined {
  const transaction = internal?.transaction;
  const state =
    transaction?.kind === "itx" && transaction.id ? transactions.get(transaction.id) : undefined;
  if (state) {
    guardTransactionQuery(state);
    state.queries++;
  }
  return state;
}

/**
 * Bind explicit system steps to factory transactions during the compatibility
 * rollout without changing ordinary query settings, unique reads or batch calls.
 */
export function withTransactionContext(prisma: PrismaClient): PrismaClient {
  const transactions = new Map<string, TransactionState>();
  const extended = prisma.$extends({
    query: {
      async $allOperations({ args, query, ...rest }) {
        const internal = (rest as { __internalParams?: InternalParams }).__internalParams;
        const state = beginTransactionQuery(internal, transactions);
        try {
          return await query(args);
        } finally {
          if (state) state.queries--;
        }
      },
    },
  }) as unknown as PrismaClient;
  return bindTransactions(extended, { mode: "disabled" }, transactions);
}

/**
 * Covers the two cases where Prisma, not the caller, decides when a
 * connection is checked out, so the pool would see the wrong context:
 * - outside a transaction, Prisma batches `findUnique` calls from one tick and
 *   runs them on the next, so each runs with transaction-local settings;
 * - a batch `$transaction([...])` starts on the next tick as well, so it is
 *   rejected inside a context; use an interactive transaction instead.
 */
export function withRowLevelSecurity(
  prisma: PrismaClient,
  bypassKey: BypassKeySource = "",
): PrismaClient {
  const transactions = new Map<string, TransactionState>();
  const extended = prisma.$extends({
    query: {
      async $allOperations({ model, operation, args, query, ...rest }) {
        const internal = (rest as { __internalParams?: InternalParams }).__internalParams;
        const transaction = internal?.transaction;
        const state = beginTransactionQuery(internal, transactions);
        try {
          const context = storage.getStore();
          if (!context) {
            if (model && ROW_SECURITY_MODELS.has(model)) missingContext(model, operation);
            return await query(args);
          }
          if (transaction?.kind === "batch") {
            throw new Error(
              "Batch $transaction([...]) cannot carry a database context; use an interactive transaction",
            );
          }
          const key = context.kind === "system" ? await resolveBypassKey(bypassKey) : "";
          if (transaction || (operation !== "findUnique" && operation !== "findUniqueOrThrow")) {
            return await query(args);
          }
          // Prisma 7's compact runtime model omits unique constraints. Preserve
          // native argument validation and isolate lazy unique or fluent reads
          // with the transaction-local context before their original query.
          const [, result] = await prisma.$transaction(
            [prisma.$executeRaw(LOCAL_SETTINGS(settingsFor(context, key))), query(args)],
            WRAPPED_OPERATION_OPTIONS as never,
          );
          return result;
        } finally {
          if (state) state.queries--;
        }
      },
    },
  }) as unknown as PrismaClient;
  return bindTransactions(extended, { mode: "enabled", bypassKey }, transactions);
}
