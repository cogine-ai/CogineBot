import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import {
  currentDbContext,
  drainUnscopedDatabaseAccess,
  installDbContext,
  rlsBypassKey,
  runAsSystem,
  runAsSystemInTransaction,
  runAsTenant,
  withRowLevelSecurity,
} from "./row-security.js";

afterEach(() => {
  drainUnscopedDatabaseAccess();
});

function poolBoundary(connectionString = "postgres://app:secret@db/coginebot") {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { options: { connectionString }, connect: async () => client } as unknown as Pool;
  installDbContext(pool);
  return { pool, client, query, release };
}

describe("database context pool checkout", () => {
  it("keeps the queued caller's tenant when another tenant releases the connection", async () => {
    type Callback = (error: Error | undefined, client: PoolClient, done: () => void) => void;
    let checkout!: Callback;
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = {
      options: { connectionString: "postgres://app:secret@db/coginebot" },
      connect(callback: Callback) {
        checkout = callback;
      },
    } as unknown as Pool;
    installDbContext(pool);
    let finished!: () => void;
    const complete = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () => {
      pool.connect(() => finished());
    });
    await runAsTenant({ spaceId: "space-b", userId: "user-b" }, () => {
      checkout(undefined, client, () => undefined);
    });
    await complete;
    expect(query.mock.calls).toEqual([
      [expect.stringContaining("app.space_id"), ["space-a", "user-a", "off", ""]],
    ]);
  });

  it("clears all four settings when a reused connection leaves a trusted context", async () => {
    const { pool, query } = poolBoundary();
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () => pool.connect());
    await runAsSystem("fixture cross-tenant lookup", () => pool.connect());
    await pool.connect();
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ["space-a", "user-a", "off", ""],
      ["", "", "on", expect.stringMatching(/^[0-9a-f]{64}$/)],
      ["", "", "off", ""],
    ]);
  });

  it("discards a promise checkout whose settings cannot be applied", async () => {
    const { pool, query, release } = poolBoundary();
    const error = new Error("settings failed");
    query.mockRejectedValueOnce(error);
    await expect(
      runAsTenant({ spaceId: "space-a", userId: "user-a" }, () => pool.connect()),
    ).rejects.toBe(error);
    expect(release).toHaveBeenCalledWith(error);
  });

  it("discards a callback checkout whose settings cannot be applied", async () => {
    const error = new Error("settings failed");
    const done = vi.fn();
    const client = {
      query: vi.fn(async () => {
        throw error;
      }),
    } as unknown as PoolClient;
    const pool = {
      options: {},
      connect(callback: (error: undefined, client: PoolClient, done: () => void) => void) {
        callback(undefined, client, done);
      },
    } as unknown as Pool;
    installDbContext(pool);
    const outcome = await new Promise<{ error: unknown; client: unknown }>((resolve) => {
      pool.connect((error, client) => resolve({ error, client }));
    });
    expect(outcome).toEqual({ error, client: undefined });
    expect(done).toHaveBeenCalledWith(error);
  });
});

describe("trusted database scopes", () => {
  it("awaits a lazy operation inside its scope and restores the parent after a failed bypass", async () => {
    const lazy = {
      // biome-ignore lint/suspicious/noThenProperty: Database operations are intentionally lazy thenables.
      then(resolve: (value: unknown) => void) {
        resolve(currentDbContext());
      },
    } as unknown as PromiseLike<ReturnType<typeof currentDbContext>>;
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, async () => {
      expect(await runAsSystem("lazy fixture lookup", () => lazy)).toEqual({
        kind: "system",
        reason: "lazy fixture lookup",
      });
      await expect(
        runAsSystem("failed fixture lookup", () => {
          throw new Error("failure");
        }),
      ).rejects.toThrow("failure");
      expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space-a", userId: "user-a" });
    });
    expect(currentDbContext()).toBeUndefined();
  });

  it("restores transaction-local bypass and key after a failed system step", async () => {
    const connectionString = "postgres://wrong:wrong@db/coginebot?user=tx-user&password=tx-secret";
    poolBoundary(connectionString);
    const calls: unknown[][] = [];
    const tx = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push(values);
        if (strings.join("").includes("AS bypass")) {
          return [{ bypass: "off", key: "previous-key", login: "tx-user" }];
        }
        return [];
      },
    } as unknown as Pick<PrismaClient, "$queryRaw">;
    const raw = {
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
      $extends() {
        return this;
      },
    } as unknown as PrismaClient;
    const client = withRowLevelSecurity(raw, rlsBypassKey(connectionString));
    const error = new Error("system step failed");
    await expect(
      runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
        client.$transaction((bound) =>
          runAsSystemInTransaction(bound, "fixture system transaction", async () => {
            expect(currentDbContext()).toEqual({
              kind: "system",
              reason: "fixture system transaction",
            });
            throw error;
          }),
        ),
      ),
    ).rejects.toBe(error);
    expect(calls).toEqual([[], [rlsBypassKey(connectionString)], ["off", "previous-key"]]);
    expect(currentDbContext()).toBeUndefined();
  });
});
describe("transaction identity", () => {
  it("keeps an explicitly passed transaction's key across clients and later extensions", async () => {
    const calls: unknown[][] = [];
    const tx = {
      async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push(values);
        return strings.join("").includes("AS bypass") ? [{ bypass: "off", key: "" }] : [];
      },
    };
    const raw = {
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
      $extends() {
        return this;
      },
    } as unknown as PrismaClient;
    const a = withRowLevelSecurity(raw, "key-a").$extends({});
    const b = withRowLevelSecurity(raw, "key-b");
    await a.$transaction((txA) =>
      b.$transaction(() => runAsSystemInTransaction(txA, "nested explicit A", async () => "ok")),
    );
    expect(calls).toEqual([[], ["key-a"], ["off", ""]]);
  });
});

describe("rlsBypassKey", () => {
  it("follows the password pg logs in with", () => {
    const key = rlsBypassKey("postgres://app:secret@db/coginebot");
    expect(key).toBe("e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab");
    expect(rlsBypassKey("postgres://app@db/coginebot?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:other@db/coginebot?password=secret")).toBe(key);
    expect(rlsBypassKey("postgres://app:secret@db/coginebot?password=")).toBe(key);
    expect(rlsBypassKey("postgres://app:s%cret@db/coginebot")).toMatch(/^[0-9a-f]{64}$/);
    expect(rlsBypassKey("postgres://app:secret@db/coginebot?password=other")).not.toBe(key);
  });

  it("is empty without a password", () => {
    expect(rlsBypassKey("postgres://app@db/coginebot")).toBe("");
    expect(rlsBypassKey("not a url")).toBe("");
  });
});

type QueryArgs = { where: Record<string, unknown>; select?: Record<string, boolean> };
type EngineCall = {
  model: string;
  operation: string;
  args: QueryArgs;
  query: (args: QueryArgs) => Promise<unknown>;
  __internalParams?: { transaction?: { kind: string }; dataPath?: string[] };
};

function prismaBoundary(internal: EngineCall["__internalParams"] = undefined, model = "Thread") {
  const scopes: ReturnType<typeof currentDbContext>[] = [];
  const query = vi.fn(async (args: QueryArgs) => {
    scopes.push(currentDbContext());
    return { id: "thread", where: args.where };
  });
  const findFirst = vi.fn(async (args: QueryArgs) => {
    scopes.push(currentDbContext());
    return { id: "thread", where: args.where };
  });
  const executeRaw = vi.fn(async (_sql: unknown) => 0);
  const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
  const prisma = {
    _runtimeDataModel: {
      models: {
        [model]: { fields: ["id", "spaceId", "userId", "botId", "name"].map((name) => ({ name })) },
      },
    },
    [model[0]!.toLowerCase() + model.slice(1)]: { findFirst, findFirstOrThrow: findFirst },
    $executeRaw: executeRaw,
    $transaction: transaction,
    $extends(extension: { query: { $allOperations: (call: EngineCall) => Promise<unknown> } }) {
      return {
        [model[0]!.toLowerCase() + model.slice(1)]: {
          findUnique: (args: QueryArgs) =>
            extension.query.$allOperations({
              model,
              operation: "findUnique",
              args,
              query,
              __internalParams: internal,
            }),
          findUniqueOrThrow: (args: QueryArgs) =>
            extension.query.$allOperations({
              model,
              operation: "findUniqueOrThrow",
              args,
              query,
              __internalParams: internal,
            }),
        },
      };
    },
  } as unknown as PrismaClient;
  return {
    client: withRowLevelSecurity(prisma, "test-key"),
    query,
    findFirst,
    executeRaw,
    transaction,
    scopes,
  };
}

describe("context-aware Prisma queries", () => {
  it("keeps same-tick unique reads bound to their separate tenant scopes", async () => {
    const f = prismaBoundary();
    const values = await Promise.all([
      runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
        f.client.thread.findUnique({ where: { id: "a" } }),
      ),
      runAsTenant({ spaceId: "space-b", userId: "user-b" }, () =>
        f.client.thread.findUnique({ where: { id: "b" } }),
      ),
    ]);
    expect(values).toEqual([
      { id: "thread", where: { id: "a" } },
      { id: "thread", where: { id: "b" } },
    ]);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.scopes).toEqual([
      { kind: "tenant", spaceId: "space-a", userId: "user-a" },
      { kind: "tenant", spaceId: "space-b", userId: "user-b" },
    ]);
  });

  it("preserves compound unique fields and accompanying filters", async () => {
    const f = prismaBoundary(undefined, "BotSecret");
    const input = {
      where: {
        userId_spaceId_botId_name: {
          userId: "user-a",
          spaceId: "space-a",
          botId: "bot-a",
          name: "token",
        },
        NOT: { id: "other" },
      },
      select: { id: true },
    };
    const value = await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
      f.client.botSecret.findUniqueOrThrow(input),
    );
    expect(value).toEqual({ id: "thread", where: input.where });
    expect(f.query).toHaveBeenCalledWith(input);
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.executeRaw.mock.calls[0]?.[0]).toMatchObject({
      values: ["space-a", "user-a", "off", ""],
    });
  });

  it("sets transaction-local identity for a fluent relation query", async () => {
    const f = prismaBoundary({ dataPath: ["messages"] });
    const value = await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
      f.client.thread.findUnique({ where: { id: "a" } }),
    );
    expect(value).toEqual({ id: "thread", where: { id: "a" } });
    expect(f.executeRaw.mock.calls[0]?.[0]).toMatchObject({
      values: ["space-a", "user-a", "off", ""],
    });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.findFirst).not.toHaveBeenCalled();
  });

  it("rejects batch transactions instead of letting deferred work borrow another context", async () => {
    const f = prismaBoundary({ transaction: { kind: "batch" } });
    await expect(
      runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
        f.client.thread.findUnique({ where: { id: "a" } }),
      ),
    ).rejects.toThrow("use an interactive transaction");
    expect(f.query).not.toHaveBeenCalled();
  });

  it("keeps interactive queries on their already scoped transaction connection", async () => {
    const f = prismaBoundary({ transaction: { kind: "itx" } });
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
      f.client.thread.findUnique({ where: { id: "a" } }),
    );
    expect(f.query).toHaveBeenCalledWith({ where: { id: "a" } });
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { id: undefined },
    { madeUp: { id: "a" } },
    { name: "a" },
    { id: { in: ["a"] } },
    { id: null },
  ])("preserves the native query and its validation for where %j", async (where) => {
    const f = prismaBoundary();
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
      f.client.thread.findUnique({ where } as never),
    );
    expect(f.findFirst).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledWith({ where });
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it("reports an unscoped protected query and drains the diagnostic", async () => {
    const f = prismaBoundary();
    await f.client.thread.findUnique({ where: { id: "a" } });
    expect(drainUnscopedDatabaseAccess()).toEqual([expect.stringContaining("Thread.findUnique")]);
    expect(drainUnscopedDatabaseAccess()).toEqual([]);
  });
});
