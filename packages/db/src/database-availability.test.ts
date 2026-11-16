import { describe, expect, it, vi } from "vitest";
import { isDatabaseUnavailable } from "./client.js";
import { retryWhileDatabaseUnavailable } from "./database-availability.js";

/** Prisma's error for a write during a failover, as its pg driver adapter reports it. */
function readOnlyPrismaError() {
  return Object.assign(new Error("Database error. Code: `25006`."), {
    code: "P2039",
    meta: {
      driverAdapterError: Object.assign(
        new Error("cannot execute INSERT in a read-only transaction"),
        {
          cause: { kind: "postgres", code: "25006", originalCode: "25006" },
        },
      ),
    },
  });
}

describe("isDatabaseUnavailable", () => {
  it.each([
    ["a write on a read-only database through Prisma", readOnlyPrismaError()],
    [
      "an unreachable database through Prisma",
      Object.assign(new Error("Can't reach database server at db:5432"), {
        code: "P1001",
        meta: { driverAdapterError: { cause: { kind: "DatabaseNotReachable" } } },
      }),
    ],
    [
      "a read-only error from pg",
      Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
        code: "25006",
        severity: "ERROR",
      }),
    ],
    ["a pool checkout timeout", new Error("timeout exceeded when trying to connect")],
    ["too many clients", new Error("sorry, too many clients already")],
    ["a query on a connection that died", new Error("Query read timeout")],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    [
      "an administrator shutdown",
      Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      }),
    ],
    ["a wrapped cause", new Error("job failed", { cause: readOnlyPrismaError() })],
  ])("counts %s", (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it("counts a refused socket only when it came from a database connection", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    expect({
      unknownSource: isDatabaseUnavailable(refused),
      database: isDatabaseUnavailable(refused, { fromDatabaseConnection: true }),
      vendor: isDatabaseUnavailable(
        new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      ),
    }).toEqual({ unknownSource: false, database: true, vendor: false });
  });

  it("does not count errors in the work itself", () => {
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error("Slack rejected the message"))).toBe(false);
  });
});

describe("database work availability retry", () => {
  it("backs off a repeatable database operation and returns its actual result", async () => {
    let calls = 0;
    const waits: number[] = [];
    const operation = async () => {
      calls += 1;
      if (calls <= 4) throw readOnlyPrismaError();
      return { receipt: "same-fenced-operation" };
    };
    await expect(
      retryWhileDatabaseUnavailable(operation, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).resolves.toEqual({ receipt: "same-fenced-operation" });
    expect(calls).toBe(5);
    expect(waits).toEqual([200, 400, 800, 1600]);
  });

  it("does not repeat constraint or application failures", async () => {
    const error = Object.assign(new Error("duplicate key"), { code: "P2002" });
    const operation = vi.fn(async () => {
      throw error;
    });
    const sleep = vi.fn();
    await expect(retryWhileDatabaseUnavailable(operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying at its database recovery budget without inventing success", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const error = readOnlyPrismaError();
      const operation = vi.fn(async () => {
        throw error;
      });
      await expect(
        retryWhileDatabaseUnavailable(operation, {
          waitMs: 500,
          sleep: async (ms) => {
            vi.setSystemTime(Date.now() + ms);
          },
        }),
      ).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an outage error when shutdown interrupts its wait", async () => {
    const error = readOnlyPrismaError();
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      throw error;
    });
    await expect(
      retryWhileDatabaseUnavailable(operation, {
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
      }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
