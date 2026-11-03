import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  clearRunTurnCheckpoints,
  dropRunTurnCheckpoint,
  loadRunTurnCheckpoint,
  saveRunTurnCheckpoint,
} from "./run-turn-checkpoint.js";

const run = { id: "fixture-run", spaceId: "fixture-space" };
const scope = {
  idempotencyKey: JSON.stringify(["runtime_checkpoint", run.id]),
  runId: run.id,
  spaceId: run.spaceId,
  kind: "runtime_checkpoint",
  status: "runtime_checkpoint",
};
type Row = typeof scope & { result: unknown };

function fixture() {
  let stored: Row | undefined;
  const currentRun = { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 };
  const order: string[] = [];
  const matches = (where: Record<string, unknown>, row: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const client = {
    run: {
      updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        order.push("lock");
        return { count: matches(where, { ...currentRun }) ? 1 : 0 };
      }),
    },
    externalEffect: {
      findUnique: vi.fn(async () => (stored ? structuredClone(stored) : null)),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: Record<string, unknown>;
          create: Row;
          update: { result: string };
        }) => {
          order.push("save");
          if (stored && !matches(where, { ...stored })) throw new Error("checkpoint key conflict");
          stored = stored ? { ...stored, ...update } : { ...create };
          return stored;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { OR: Record<string, unknown>[] } }) => {
        order.push("clear");
        if (stored && where.OR.some((part) => matches(part, { ...stored }))) stored = undefined;
        return { count: 1 };
      }),
    },
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => {
      const before = stored ? structuredClone(stored) : undefined;
      try {
        return await action(client);
      } catch (error) {
        stored = before;
        throw error;
      }
    },
  };
  return {
    prisma: client as unknown as PrismaClient,
    client,
    currentRun,
    order,
    stored: () => stored,
    corrupt: (patch: Partial<Row>) => {
      stored = { ...scope, result: "fixture", ...patch };
    },
  };
}

describe("server-only run turn checkpoint", () => {
  it("distinguishes no row from a latest-only checkpoint", async () => {
    const f = fixture();
    expect(await loadRunTurnCheckpoint(f.prisma, run)).toBeUndefined();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "first");
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "replacement");
    expect(await loadRunTurnCheckpoint(f.prisma, run)).toBe("replacement");
    expect(f.client.externalEffect.upsert.mock.calls.map(([call]) => call.where)).toEqual([
      scope,
      scope,
    ]);
    expect(f.order).toEqual(["lock", "save", "lock", "save"]);
  });

  it("propagates database load failure instead of treating it as no checkpoint", async () => {
    const f = fixture();
    const failure = new Error("fixture storage unavailable");
    f.client.externalEffect.findUnique.mockRejectedValueOnce(failure);
    await expect(loadRunTurnCheckpoint(f.prisma, run)).rejects.toBe(failure);
  });

  it.each([
    { runId: "other-run" },
    { spaceId: "other-space" },
    { kind: "approval" },
    { status: "completed" },
    { result: null },
    { result: {} },
    { result: "" },
  ])("rejects a present checkpoint with invalid scope, marker or content: %j", async (patch) => {
    const f = fixture();
    f.corrupt(patch);
    await expect(loadRunTurnCheckpoint(f.prisma, run)).rejects.toThrow(
      "Unsupported turn checkpoint",
    );
  });

  it.each(["save", "drop"] as const)(
    "fences %s before changing a checkpoint",
    async (operation) => {
      for (const patch of [
        { leaseOwner: "stale-worker" },
        { leaseFence: 8 },
        { status: "cancelled" },
        { spaceId: "other-space" },
      ]) {
        const f = fixture();
        f.corrupt({ result: "keep" });
        Object.assign(f.currentRun, patch);
        const call =
          operation === "save"
            ? saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "replacement")
            : dropRunTurnCheckpoint(f.prisma, run, "worker", 7);
        await expect(call).rejects.toThrow("lease expired");
        expect(f.stored()?.result).toBe("keep");
        expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
        expect(f.client.externalEffect.deleteMany).not.toHaveBeenCalled();
      }
    },
  );

  it("does not overwrite a mismatching row under the same unique key", async () => {
    const f = fixture();
    f.corrupt({ status: "approved", result: "keep" });
    await expect(saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "new")).rejects.toThrow(
      "checkpoint key conflict",
    );
    expect(f.stored()).toMatchObject({ status: "approved", result: "keep" });
  });

  it("rejects empty payloads before acquiring a write lock", async () => {
    const f = fixture();
    await expect(saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "")).rejects.toThrow(
      "Unsupported turn checkpoint",
    );
    expect(f.client.run.updateMany).not.toHaveBeenCalled();
  });

  it("drops only the exact server checkpoint, after locking its running owner", async () => {
    const f = fixture();
    f.corrupt({ result: "keep until drop" });
    await dropRunTurnCheckpoint(f.prisma, run, "worker", 7);
    expect(f.stored()).toBeUndefined();
    expect(f.order).toEqual(["lock", "clear"]);
    expect(f.client.externalEffect.deleteMany).toHaveBeenCalledWith({ where: { OR: [scope] } });
  });

  it("keeps a different Space and normal effects outside terminal cleanup", async () => {
    const f = fixture();
    f.corrupt({ result: "keep" });
    await clearRunTurnCheckpoints(f.prisma, [{ ...run, spaceId: "other-space" }]);
    expect(f.stored()?.result).toBe("keep");
    f.corrupt({ kind: "write_effect", status: "completed", result: "normal effect" });
    await clearRunTurnCheckpoints(f.prisma, [run]);
    expect(f.stored()?.result).toBe("normal effect");
  });

  it("does no database work for an empty terminal winner set", async () => {
    const f = fixture();
    await clearRunTurnCheckpoints(f.prisma, []);
    expect(f.client.externalEffect.deleteMany).not.toHaveBeenCalled();
  });
});
