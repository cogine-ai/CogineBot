import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import {
  asSystem,
  currentDbContext,
  databaseCredentials,
  drainUnscopedDatabaseAccess,
  installDbContext,
  rlsBypassKey,
  runAsSystem,
  runAsSystemInTransaction,
  runAsTenant,
  withRowLevelSecurity,
  withTransactionContext,
} from "./row-security.js";

afterEach(() => {
  drainUnscopedDatabaseAccess();
});

function poolBoundary(
  connectionString = "postgres://app:secret@db/coginebot",
  password = "secret",
) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
  const release = vi.fn();
  const client = { query, release, password } as unknown as PoolClient;
  const pool = { options: { connectionString }, connect: async () => client } as unknown as Pool;
  installDbContext(pool);
  return { pool, client, query, release };
}

describe("database context pool checkout", () => {
  it("uses the authenticated connection password rather than URL-only credentials", async () => {
    const { pool, query } = poolBoundary("postgres://app:other@db/coginebot", "secret");
    await runAsSystem("effective authentication", () => pool.connect());
    expect(query.mock.calls[0]?.[1]).toEqual([
      "",
      "",
      "on",
      "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab",
    ]);
  });

  it("bootstraps and releases one authenticated checkout for concurrent resolver callers", async () => {
    const client = {
      password: "secret",
      release: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const connect = vi.fn(async () => client);
    const pool = { connect } as unknown as Pool;
    const key = installDbContext(pool);
    expect(installDbContext(pool)).toBe(key);
    expect(await Promise.all([key(), key()])).toEqual([
      "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab",
      "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab",
    ]);
    expect(connect).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
    await runAsSystem("resolved checkout", () => pool.connect());
    expect(client.query.mock.calls[0]).toEqual([
      expect.stringContaining("app.rls_bypass_key"),
      ["", "", "on", await key()],
    ]);
  });

  it("retries authentication after a transient resolver failure", async () => {
    const failure = new Error("temporarily unavailable");
    const client = { password: "secret", release: vi.fn() };
    const connect = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(client);
    const resolver = installDbContext({ connect } as unknown as Pool);
    await expect(resolver()).rejects.toBe(failure);
    expect(await resolver()).toBe(
      "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab",
    );
    expect(connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", () => "unresolved password"])(
    "rejects missing or unresolved authenticated passwords without exposing them (%s)",
    async (password) => {
      const client = { password, release: vi.fn(), query: vi.fn() };
      const resolver = installDbContext({ connect: async () => client } as unknown as Pool);
      await expect(resolver()).rejects.toThrow(
        "Protected database access requires an authenticated password",
      );
      expect(client.release).toHaveBeenCalledWith(expect.any(Error));
      expect(client.query).not.toHaveBeenCalled();
    },
  );

  it("refuses a changed physical connection credential instead of replacing its pool key", async () => {
    const { pool, client, query, release } = poolBoundary();
    const resolver = installDbContext(pool);
    const original = await resolver();
    client.password = "rotation-password-do-not-expose";
    const result = await pool.connect().catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      "Database authentication changed; create a new pool and register its key",
    );
    expect(await resolver()).toBe(original);
    expect(release).toHaveBeenLastCalledWith(result);
    expect(query).not.toHaveBeenCalled();
  });

  it("discards callback checkouts with unavailable effective credentials", async () => {
    const done = vi.fn();
    const client = { password: undefined, query: vi.fn() } as unknown as PoolClient;
    const pool = {
      connect(callback: (error: undefined, client: PoolClient, release: typeof done) => void) {
        callback(undefined, client, done);
      },
    } as unknown as Pool;
    installDbContext(pool);
    const result = await new Promise<{ error: unknown; client: unknown }>((resolve) => {
      pool.connect((error, client) => resolve({ error, client }));
    });
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "Protected database access requires an authenticated password",
    );
    expect(result.client).toBeUndefined();
    expect(done).toHaveBeenCalledWith(result.error);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("keeps the queued caller's tenant when another tenant releases the connection", async () => {
    type Callback = (error: Error | undefined, client: PoolClient, done: () => void) => void;
    let checkout!: Callback;
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, password: "secret", release: vi.fn() } as unknown as PoolClient;
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
      password: "secret",
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
  it("preserves synchronous SDK extension chains and method return values", async () => {
    const { prisma, pool } = createDb("postgres://unused:unused@127.0.0.1:1/unused", {
      rowSecurity: true,
    });
    try {
      const client = asSystem(prisma, "synchronous fixture").$extends({
        client: {
          scope() {
            return currentDbContext();
          },
          identity<T>(value: T): T {
            return value;
          },
          fail() {
            throw new Error("sync failure");
          },
        },
      });
      expect(client.scope()).toEqual({ kind: "system", reason: "synchronous fixture" });
      expect(client.identity(42)).toBe(42);
      expect(() => client.fail()).toThrow("sync failure");
      expect(currentDbContext()).toBeUndefined();
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("defers SDK queries until awaited and keeps their system context inside a tenant", async () => {
    const { prisma, pool } = createDb("postgres://unused:unused@127.0.0.1:1/unused");
    const scopes: ReturnType<typeof currentDbContext>[] = [];
    try {
      const client = asSystem(
        withRowLevelSecurity(prisma, "offline-test-key"),
        "lazy SDK fixture",
      ).$extends({
        query: {
          async $allOperations() {
            scopes.push(currentDbContext());
            return [];
          },
        },
      });
      const pending = client.thread.findMany();
      expect(scopes).toEqual([]);
      await runAsTenant({ spaceId: "space-a", userId: "user-a" }, async () => {
        expect(await pending).toEqual([]);
        expect(scopes).toEqual([{ kind: "system", reason: "lazy SDK fixture" }]);
        expect(currentDbContext()).toEqual({
          kind: "tenant",
          spaceId: "space-a",
          userId: "user-a",
        });
      });
      expect(currentDbContext()).toBeUndefined();
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("preserves native promise catch and finally binding plus plain synchronous values", async () => {
    const failure = new Error("native failure");
    const scopes: ReturnType<typeof currentDbContext>[] = [];
    const raw = {
      marker: "native marker",
      details: { count: 3 },
      read() {
        return this.marker;
      },
      reject() {
        return Promise.reject(failure);
      },
    };
    const client = asSystem(raw, "native fixture");
    expect(client.read()).toBe("native marker");
    expect(client.details).toEqual({ count: 3 });
    expect(client.details.count).toBe(3);
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, async () => {
      const pending = client
        .reject()
        .catch((error) => {
          expect(error).toBe(failure);
          scopes.push(currentDbContext());
          return 42;
        })
        .finally(() => {
          scopes.push(currentDbContext());
        });
      expect(pending).toBeInstanceOf(Promise);
      expect(await pending).toBe(42);
      expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: "space-a", userId: "user-a" });
    });
    expect(scopes).toEqual([
      { kind: "system", reason: "native fixture" },
      { kind: "system", reason: "native fixture" },
    ]);
    expect(currentDbContext()).toBeUndefined();
  });

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
      [Symbol.for("prisma.client.transaction.scope_context")]: {
        kind: "nested",
        txId: "fixture-tx",
      },
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
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "keeps an explicitly passed transaction's key across clients and later extensions (system fixture=%s, resolver=%s)",
    async (systemFixture, useResolver) => {
      const calls: unknown[][] = [];
      const tx = {
        [Symbol.for("prisma.client.transaction.scope_context")]: {
          kind: "nested",
          txId: "identity-tx",
        },
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
      const wrapped = withRowLevelSecurity(raw, useResolver ? async () => "key-a" : "key-a");
      const a = (systemFixture ? asSystem(wrapped, "transaction fixture") : wrapped).$extends({});
      const b = withRowLevelSecurity(raw, "key-b");
      await a.$transaction((txA) =>
        b.$transaction(() => runAsSystemInTransaction(txA, "nested explicit A", async () => "ok")),
      );
      expect(calls).toEqual([[], ["key-a"], ["off", ""]]);
    },
  );
});

function isolatedTransactionBoundary(rowSecurity = true) {
  type Call = {
    model?: string;
    operation: string;
    args: object;
    query: (args: object) => Promise<unknown>;
    __internalParams: { transaction: { kind: string; id: string } };
  };
  let hook!: (call: Call) => Promise<unknown>;
  let bypass = "off";
  let key = "";
  const options: { pauseRead?: () => Promise<void>; failRestore?: Error } = {};
  const dispatch = (operation: string, query: () => Promise<unknown>, model?: string) =>
    hook({
      model,
      operation,
      args: {},
      query,
      __internalParams: {
        transaction: { kind: "itx", id: "guarded-tx" },
      },
    });
  const tx = {
    [Symbol.for("prisma.client.transaction.scope_context")]: { kind: "nested", txId: "guarded-tx" },
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      return dispatch("$queryRaw", async () => {
        const sql = strings.join("");
        if (sql.includes("AS bypass")) return [{ bypass, key }];
        if (sql.includes("'on'")) {
          bypass = "on";
          key = values[0] as string;
        } else {
          if (options.failRestore) throw options.failRestore;
          bypass = values[0] as string;
          key = values[1] as string;
        }
        return [];
      });
    },
    thread: {
      findMany() {
        return dispatch(
          "findMany",
          async () => {
            await options.pauseRead?.();
            return [{ id: "visible-row" }];
          },
          "Thread",
        );
      },
    },
  };
  const raw = {
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    $extends(extension: { query?: { $allOperations: typeof hook } }) {
      if (extension.query) hook = extension.query.$allOperations;
      return this;
    },
  } as unknown as PrismaClient;
  return {
    client: rowSecurity ? withRowLevelSecurity(raw, "key-a") : withTransactionContext(raw),
    options,
  };
}

describe("system transaction isolation", () => {
  it("rejects overlapping system steps before either can restore the other's bypass", async () => {
    const tx = {
      [Symbol.for("prisma.client.transaction.scope_context")]: {
        kind: "nested",
        txId: "overlap-tx",
      },
      async $queryRaw(strings: TemplateStringsArray) {
        return strings.join("").includes("AS bypass") ? [{ bypass: "off", key: "" }] : [];
      },
    };
    const raw = {
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
      $extends() {
        return this;
      },
    } as unknown as PrismaClient;
    const client = withRowLevelSecurity(raw, "key-a");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await client.$transaction(async (tx) => {
      const first = runAsSystemInTransaction(tx, "first step", async () => {
        entered();
        await barrier;
      });
      await started;
      try {
        await expect(
          runAsSystemInTransaction(tx, "overlapping step", async () => "unsafe"),
        ).rejects.toThrow("Concurrent system transaction access");
      } finally {
        release();
        await first;
      }
    });
  });

  it.each([true, false])(
    "reserves an ordinary query through downstream awaits before allowing system entry (row security=%s)",
    async (rowSecurity) => {
      const f = isolatedTransactionBoundary(rowSecurity);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.options.pauseRead = async () => {
        entered();
        await barrier;
      };
      await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
        f.client.$transaction(async (tx) => {
          const pending = tx.thread.findMany();
          await started;
          try {
            await expect(
              runAsSystemInTransaction(tx, "unsafe overlap with read", async () => undefined),
            ).rejects.toThrow("Concurrent system transaction access");
          } finally {
            release();
          }
          expect(await pending).toEqual([{ id: "visible-row" }]);
          await expect(
            runAsSystemInTransaction(tx, "safe sequential step", async () => "done"),
          ).resolves.toBe("done");
        }),
      );
    },
  );

  it("rejects sibling queries and late reuse in compatibility mode", async () => {
    const f = isolatedTransactionBoundary(false);
    let closed!: Prisma.TransactionClient;
    await runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
      f.client.$transaction(async (tx) => {
        closed = tx;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const pending = runAsSystemInTransaction(tx, "exclusive compatibility step", async () => {
          expect(await tx.thread.findMany()).toEqual([{ id: "visible-row" }]);
          entered();
          await barrier;
        });
        await started;
        try {
          await expect(tx.thread.findMany()).rejects.toThrow(
            "Concurrent system transaction access",
          );
          await expect(
            runAsSystemInTransaction(tx, "sibling compatibility step", async () => undefined),
          ).rejects.toThrow("Concurrent system transaction access");
        } finally {
          release();
          await pending;
        }
      }),
    );
    await expect(
      runAsSystemInTransaction(closed, "late compatibility step", async () => undefined),
    ).rejects.toThrow("Concurrent system transaction access");
  });

  it("requires rollback for an unfinished compatibility query and rejects unbound clients", async () => {
    const f = isolatedTransactionBoundary(false);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<unknown> | undefined;
    f.options.pauseRead = () => barrier;
    try {
      await expect(
        f.client.$transaction(async (tx) => {
          await expect(
            runAsSystemInTransaction(tx, "unfinished compatibility read", async () => {
              pending = tx.thread.findMany();
            }),
          ).rejects.toThrow("Concurrent system transaction access");
        }),
      ).rejects.toThrow("Concurrent system transaction access");
    } finally {
      release();
      await pending;
    }
    const query = vi.fn();
    await expect(
      runAsSystemInTransaction({ $queryRaw: query }, "unknown raw client", async () => undefined),
    ).rejects.toThrow("context-aware interactive transaction");
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps a failed restore unusable even if the callback catches its error", async () => {
    const f = isolatedTransactionBoundary();
    const failure = new Error("restore hook failed before SQL");
    f.options.failRestore = failure;
    await expect(
      runAsTenant({ spaceId: "space-a", userId: "user-a" }, () =>
        f.client.$transaction(async (tx) => {
          await expect(
            runAsSystemInTransaction(tx, "failed restore", async () => undefined),
          ).rejects.toBe(failure);
          f.options.failRestore = undefined;
          await expect(tx.thread.findMany()).rejects.toThrow(
            "Concurrent system transaction access",
          );
        }),
      ),
    ).rejects.toThrow("Concurrent system transaction access");
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
    expect(rlsBypassKey("postgres://app:wrong@db/coginebot?password=wrong&password=secret")).toBe(
      key,
    );
    expect(rlsBypassKey("postgres://app:secret@db/coginebot?password=secret&password=")).toBe(key);
  });

  it("uses the last credential query value and then falls back to URL userinfo", () => {
    expect(
      databaseCredentials(
        "postgres://url-user:url-password@db/coginebot?user=first&user=last&password=first&password=last",
      ),
    ).toEqual({ user: "last", password: "last" });
    expect(
      databaseCredentials(
        "postgres://url-user:url-password@db/coginebot?user=first&user=&password=first&password=",
      ),
    ).toEqual({ user: "url-user", password: "url-password" });
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

function prismaBoundary(
  internal: EngineCall["__internalParams"] = undefined,
  model = "Thread",
  bypassKey: string | (() => Promise<string>) = "test-key",
) {
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
    client: withRowLevelSecurity(prisma, bypassKey),
    query,
    findFirst,
    executeRaw,
    transaction,
    scopes,
  };
}

describe("context-aware Prisma queries", () => {
  it("uses the authenticated pool resolver before a system unique read borrows its connection", async () => {
    const client = { password: "secret", release: vi.fn() };
    const connect = vi.fn(async () => client);
    const resolver = installDbContext({ connect } as unknown as Pool);
    const f = prismaBoundary(undefined, "Thread", resolver);
    await runAsSystem("system unique", () => f.client.thread.findUnique({ where: { id: "a" } }));
    expect(client.release).toHaveBeenCalledOnce();
    expect(f.executeRaw.mock.calls[0]?.[0]).toMatchObject({
      values: ["", "", "on", "e3ab53f78a8d87ee6f8476b690739dd5823af9545de951578b0c157049ce1cab"],
    });
    expect(f.query).toHaveBeenCalledWith({ where: { id: "a" } });
  });

  it("rejects an empty system key before a protected query runs", async () => {
    const f = prismaBoundary(undefined, "Thread", "");
    await expect(
      runAsSystem("missing credential", () => f.client.thread.findUnique({ where: { id: "a" } })),
    ).rejects.toThrow("requires an authenticated password");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });

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
