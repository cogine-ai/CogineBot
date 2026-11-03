import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import {
  clearRunTurnCheckpoints,
  dropRunTurnCheckpoint,
  loadRunTurnCheckpoint,
  loadRunTurnCheckpointSecretEffectId,
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
type Row = typeof scope & { result: unknown; request: unknown };

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
          update: { result: unknown; request: unknown };
        }) => {
          order.push("save");
          if (stored && !matches(where, { ...stored })) throw new Error("checkpoint key conflict");
          stored = stored ? { ...stored, ...update } : { ...create };
          if (stored.result === Prisma.DbNull) stored.result = null;
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
      stored = { ...scope, result: "fixture", request: {}, ...patch };
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

  it("keeps a fenced binding without claiming helper transcript restoration", async () => {
    const f = fixture();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, undefined, "secret-a");
    expect(f.stored()).toEqual({
      ...scope,
      request: { pendingSecretEffectId: "secret-a", capture: "none" },
      result: null,
    });
    expect(await loadRunTurnCheckpoint(f.prisma, run)).toBeUndefined();
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    expect(f.order).toEqual(["lock", "save"]);
    expect(f.client.run.updateMany).toHaveBeenCalledWith({
      where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { leaseFence: 7 },
    });
    expect(f.client.externalEffect.upsert).toHaveBeenCalledWith({
      where: scope,
      create: {
        ...scope,
        request: { pendingSecretEffectId: "secret-a", capture: "none" },
        result: Prisma.DbNull,
      },
      update: {
        request: { pendingSecretEffectId: "secret-a", capture: "none" },
        result: Prisma.DbNull,
      },
    });
    expect(f.client.externalEffect.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: scope.idempotencyKey },
      select: { runId: true, spaceId: true, kind: true, status: true, request: true, result: true },
    });
  });

  it("refreshes a binding-only owner and removes its marker when a transcript is saved", async () => {
    const f = fixture();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "old transcript", "secret-old");
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, undefined, "secret-new");
    expect(await loadRunTurnCheckpoint(f.prisma, run)).toBeUndefined();
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-new");
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "captured transcript", "secret-next");
    expect(await loadRunTurnCheckpoint(f.prisma, run)).toBe("captured transcript");
    expect(f.stored()?.request).toEqual({ pendingSecretEffectId: "secret-next" });
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "ordinary transcript");
    expect(f.stored()).toMatchObject({ result: "ordinary transcript", request: {} });
  });

  it.each([undefined, ""])(
    "rejects a missing transcript without a valid binding (%j)",
    async (id) => {
      const f = fixture();
      await expect(
        saveRunTurnCheckpoint(f.prisma, run, "worker", 7, undefined, id),
      ).rejects.toThrow();
      expect(f.client.run.updateMany).not.toHaveBeenCalled();
      expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runId: "other-run" },
    { spaceId: "other-space" },
    { kind: "request_secret" },
    { status: "intended" },
    { result: "unexpected transcript" },
    { result: {} },
    { result: "" },
    { request: null },
    { request: [] },
    { request: {} },
    { request: { pendingSecretEffectId: "secret-a" } },
    { request: { pendingSecretEffectId: "secret-a", capture: "unknown" } },
    { request: { pendingSecretEffectId: "", capture: "none" } },
    { request: { pendingSecretEffectId: 1, capture: "none" } },
    { request: { pendingSecretEffectId: "secret-a", capture: "none", extra: true } },
  ])(
    "rejects an invalid present binding-only record instead of starting fresh (%j)",
    async (patch) => {
      const f = fixture();
      f.corrupt({
        result: null,
        request: { pendingSecretEffectId: "secret-a", capture: "none" },
        ...patch,
      });
      await expect(loadRunTurnCheckpoint(f.prisma, run)).rejects.toThrow(
        "Unsupported turn checkpoint",
      );
    },
  );

  it("rejects a stale binding-only save and clears only its exact terminal winner", async () => {
    const f = fixture();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, undefined, "secret-a");
    f.currentRun.leaseFence = 8;
    await expect(
      saveRunTurnCheckpoint(f.prisma, run, "worker", 7, undefined, "secret-b"),
    ).rejects.toThrow("lease expired");
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    await clearRunTurnCheckpoints(f.prisma, [{ ...run, spaceId: "other-space" }]);
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    await clearRunTurnCheckpoints(f.prisma, [run]);
    expect(f.stored()).toBeUndefined();
  });

  it("stores and refreshes the exact pending secret effect only in private request metadata", async () => {
    const f = fixture();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "first", "secret-a");
    expect(f.stored()).toMatchObject({
      result: "first",
      request: { pendingSecretEffectId: "secret-a" },
    });
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "second", "secret-b");
    expect(f.stored()).toMatchObject({
      result: "second",
      request: { pendingSecretEffectId: "secret-b" },
    });
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-b");
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "ordinary pause");
    expect(f.stored()).toMatchObject({ result: "ordinary pause", request: {} });
    await expect(loadRunTurnCheckpointSecretEffectId(f.prisma, run)).rejects.toThrow(
      "secret binding",
    );
    expect(f.client.externalEffect.upsert.mock.calls.map(([call]) => call.update.request)).toEqual([
      { pendingSecretEffectId: "secret-a" },
      { pendingSecretEffectId: "secret-b" },
      {},
    ]);
    expect(f.client.externalEffect.upsert.mock.calls.map(([call]) => call.create.request)).toEqual([
      { pendingSecretEffectId: "secret-a" },
      { pendingSecretEffectId: "secret-b" },
      {},
    ]);
  });

  it("treats only an absent checkpoint as legacy secret input and uses the exact reserved key", async () => {
    const f = fixture();
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBeUndefined();
    expect(f.client.externalEffect.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: scope.idempotencyKey },
      select: { runId: true, spaceId: true, kind: true, status: true, request: true, result: true },
    });
  });

  it.each([
    { result: null, request: { pendingSecretEffectId: "secret-a" } },
    { result: "transcript", request: { pendingSecretEffectId: "secret-a", capture: "none" } },
    { result: "", request: { pendingSecretEffectId: "secret-a", capture: "none" } },
    { result: {}, request: { pendingSecretEffectId: "secret-a", capture: "none" } },
    { result: null, request: { pendingSecretEffectId: "secret-a", capture: "unknown" } },
    { result: null, request: { pendingSecretEffectId: "secret-a", capture: "none", extra: true } },
    { result: null, request: { pendingSecretEffectId: "secret-a", capture: 1 } },
    { result: null, request: { pendingSecretEffectId: "", capture: "none" } },
    { result: null, request: { pendingSecretEffectId: 1, capture: "none" } },
    { result: null, request: { pendingSecretEffectId: ["secret-a"], capture: "none" } },
    { result: "transcript", request: { pendingSecretEffectId: "secret-a", extra: true } },
    { result: "", request: { pendingSecretEffectId: "secret-a" } },
    { result: null, request: { pendingSecretEffectId: "secret-a", capture: null } },
    { result: 0, request: { pendingSecretEffectId: "secret-a" } },
  ])("rejects the same malformed secret record on both read paths (%j)", async (patch) => {
    const f = fixture();
    f.corrupt(patch);
    await expect(loadRunTurnCheckpoint(f.prisma, run)).rejects.toThrow(
      "Unsupported turn checkpoint",
    );
    await expect(loadRunTurnCheckpointSecretEffectId(f.prisma, run)).rejects.toThrow(
      "secret binding",
    );
  });

  it.each([
    { runId: "other-run" },
    { spaceId: "other-space" },
    { kind: "approval" },
    { status: "completed" },
    { request: null },
    { request: [] },
    { request: "secret-a" },
    { request: {} },
    { request: { pendingSecretEffectId: "" } },
    { request: { pendingSecretEffectId: 1 } },
    { request: { pendingSecretEffectId: ["secret-a"] } },
  ])(
    "refuses present invalid secret binding instead of falling back to legacy (%j)",
    async (patch) => {
      const f = fixture();
      f.corrupt({ request: { pendingSecretEffectId: "secret-a" }, ...patch });
      await expect(loadRunTurnCheckpointSecretEffectId(f.prisma, run)).rejects.toThrow(
        "secret binding",
      );
    },
  );

  it("propagates a secret binding read failure without treating it as legacy", async () => {
    const f = fixture();
    const failure = new Error("fixture binding lookup failed");
    f.client.externalEffect.findUnique.mockRejectedValueOnce(failure);
    await expect(loadRunTurnCheckpointSecretEffectId(f.prisma, run)).rejects.toBe(failure);
  });

  it("rejects an empty secret binding before taking the Run write lock", async () => {
    const f = fixture();
    await expect(saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "turn", "")).rejects.toThrow(
      "secret binding",
    );
    expect(f.client.run.updateMany).not.toHaveBeenCalled();
    expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
  });

  it("keeps a previous binding when save rolls back and clears it only with the exact checkpoint", async () => {
    const f = fixture();
    await saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "turn", "secret-a");
    const upsert = f.client.externalEffect.upsert.getMockImplementation()!;
    f.client.externalEffect.upsert.mockImplementationOnce(async (input) => {
      await upsert(input);
      throw new Error("fixture late save failure");
    });
    await expect(
      saveRunTurnCheckpoint(f.prisma, run, "worker", 7, "new turn", "secret-b"),
    ).rejects.toThrow("fixture late save failure");
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    await clearRunTurnCheckpoints(f.prisma, [{ ...run, spaceId: "other-space" }]);
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBe("secret-a");
    await clearRunTurnCheckpoints(f.prisma, [run]);
    expect(await loadRunTurnCheckpointSecretEffectId(f.prisma, run)).toBeUndefined();
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
