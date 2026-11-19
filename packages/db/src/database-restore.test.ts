import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDatabaseRestore } from "./database-restore.js";

const state = vi.hoisted(() => ({
  foreignWriter: false,
  connected: false,
  probeError: undefined as Error | undefined,
  connectCount: 1,
  clients: [] as EventEmitter[],
  closeRequested: undefined as (() => void) | undefined,
  ownerClosed: false,
}));

vi.mock("pg", async (importActual) => {
  const actual = await importActual<typeof import("pg")>();
  return {
    ...actual,
    Client: class {
      host: string;
      port: number;
      database: string | undefined;
      constructor(config: { connectionString: string }) {
        const parsed = new actual.Client(config);
        this.host = parsed.host;
        this.port = parsed.port;
        this.database = parsed.database;
      }
      async connect() {}
      async end() {
        state.ownerClosed = true;
      }
      async query(sql: string) {
        if (sql.includes("pg_stat_activity"))
          return { rows: [{ busy: state.foreignWriter || state.connected }] };
        if (sql.includes('AS "databaseOwner"'))
          return {
            rows: [
              {
                current: "owner",
                session: "owner",
                databaseOwner: "owner",
                grantRole: "runtime_grants",
              },
            ],
          };
        if (sql.includes("count(*)::int")) return { rows: [{ count: 0 }] };
        if (sql.includes("rls_bypass_keys"))
          return { rows: [{ digest: createHash("sha256").update("synthetic-key").digest("hex") }] };
        return { rows: [] };
      }
    },
  };
});

vi.mock("./client.js", () => ({
  createDb: () => {
    const pool = new EventEmitter();
    Object.assign(pool, {
      end: async () => {
        state.closeRequested?.();
      },
    });
    return {
      pool,
      prisma: {
        $queryRaw: async () => {
          for (let i = 0; i < state.connectCount; i++) {
            const client = new EventEmitter();
            client.once("end", () => {
              state.connected = state.clients.some(
                (entry) => entry !== client && entry.listenerCount("end") > 0,
              );
            });
            state.clients.push(client);
            state.connected = true;
            pool.emit("connect", client);
          }
          if (state.probeError) throw state.probeError;
          return [{ current: "runtime", session: "runtime" }];
        },
        $disconnect: async () => {},
      },
    };
  },
}));
vi.mock("./row-security.js", () => ({ installDbContext: () => async () => "synthetic-key" }));
vi.mock("./row-security-policies.js", () => ({
  describeRowSecurityPolicies: async () => ({ connectionEnforced: true }),
}));

const ownerUrl = "postgresql://owner:synthetic-owner@127.0.0.1:5432/restore_test";
const runtimeUrl = "postgresql://runtime:synthetic-runtime@127.0.0.1:5432/restore_test";

beforeEach(() => {
  state.foreignWriter = false;
  state.connected = false;
  state.probeError = undefined;
  state.connectCount = 1;
  state.clients = [];
  state.closeRequested = undefined;
  state.ownerClosed = false;
});

function pendingVerification() {
  const closeRequested = new Promise<void>((resolve) => {
    state.closeRequested = resolve;
  });
  let settled = false;
  const result = verifyDatabaseRestore(ownerUrl, [runtimeUrl])
    .then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    .finally(() => {
      settled = true;
    });
  return { closeRequested, result, settled: () => settled };
}

describe("restore verifier connection teardown", () => {
  it("waits for the runtime connection to end after the pool reports closure", async () => {
    const verification = pendingVerification();
    try {
      await verification.closeRequested;
      await setImmediate();
      expect(verification.settled()).toBe(false);
      expect(state.ownerClosed).toBe(false);
    } finally {
      for (const client of state.clients) client.emit("end");
    }
    expect(await verification.result).toMatchObject({
      value: { connectionEnforced: true },
      error: undefined,
    });
    expect(state.ownerClosed).toBe(true);
  });

  it("waits for every connected probe, including a replaced connection", async () => {
    state.connectCount = 2;
    const verification = pendingVerification();
    await verification.closeRequested;
    state.clients[0]!.emit("end");
    try {
      await setImmediate();
      expect(verification.settled()).toBe(false);
    } finally {
      state.clients[1]!.emit("end");
    }
    expect((await verification.result).error).toBeUndefined();
  });

  it("finishes closing a failed probe before returning its error", async () => {
    state.probeError = new Error("Synthetic probe failure");
    const verification = pendingVerification();
    try {
      await verification.closeRequested;
      await setImmediate();
      expect(verification.settled()).toBe(false);
    } finally {
      for (const client of state.clients) client.emit("end");
    }
    expect((await verification.result).error).toBe(state.probeError);
    expect(state.ownerClosed).toBe(true);
  });

  it("still rejects another writer present before verification", async () => {
    state.foreignWriter = true;
    await expect(verifyDatabaseRestore(ownerUrl, [runtimeUrl])).rejects.toThrow(
      "Stop database writers",
    );
    expect(state.clients).toHaveLength(0);
  });

  it("still rejects another writer that arrives while the probe is closing", async () => {
    const verification = pendingVerification();
    await verification.closeRequested;
    state.foreignWriter = true;
    for (const client of state.clients) client.emit("end");
    expect((await verification.result).error).toMatchObject({
      message: "Stop database writers before verifying the restored database",
    });
  });
});
