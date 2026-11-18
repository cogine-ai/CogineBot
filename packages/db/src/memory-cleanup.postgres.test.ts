import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { beginMemorySave, clearThread, finishMemorySave, settleMemoryCleanup } from "./events.js";
import { hasPendingMemoryCleanup, memoryCleanupIntents } from "./memory-cleanup.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled).sequential("durable memory cleanup uncertainty (PostgreSQL)", () => {
  const organizationId = "cleanup-fixture-organization";
  const spaceId = "cleanup-fixture-space";
  const userId = "cleanup-fixture-user";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let serial = 0;
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Cleanup fixture", email: "cleanup@example.test" },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Cleanup fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Cleanup fixture" } },
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });
  async function seed() {
    const bot = await prisma.bot.create({
      data: { id: `cleanup-bot-${++serial}`, spaceId, userId, name: "Fixture", color: "ink" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    return { spaceId, threadId: thread.id, botId: bot.id };
  }
  async function state(scope: Awaited<ReturnType<typeof seed>>) {
    const row = await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } });
    return {
      ...row,
      pending: hasPendingMemoryCleanup(row.memoryCleanupIntents, row.historyCompactionGeneration),
      intents: memoryCleanupIntents(row.memoryCleanupIntents),
    };
  }
  const save = (scope: Awaited<ReturnType<typeof seed>>, token = "save:0:49", generation = 0) => ({
    ...scope,
    token,
    generation,
  });
  async function clear(scope: Awaited<ReturnType<typeof seed>>) {
    return clearThread(prisma, { ...scope, memoryCleanupExpected: true });
  }
  it("defaults to no recorded failure or pending work without asserting deletion", async () => {
    const row = await state(await seed());
    expect(row.memoryCleanupUnconfirmed).toBe(false);
    expect(row.pending).toBe(false);
    expect(row.intents).toEqual([]);
  });
  it("retains the original clear responsibility when the consumer stops after local commit", async () => {
    const scope = await seed();
    const receipt = await clear(scope);
    const row = await state(scope);
    expect(receipt.memoryCleanupPending).toBe(true);
    expect(row.pending).toBe(true);
    expect(row.intents).toEqual([
      { token: receipt.cleanup!.token, kind: "clear", generations: [0, 0] },
    ]);
    expect(row.memoryCleanupUnconfirmed).toBe(false);
  });
  it("does not create a pending cleanup when no provider is configured", async () => {
    const scope = await seed();
    await clearThread(prisma, scope);
    expect((await state(scope)).pending).toBe(false);
  });
  it("rolls back destructive deletion if its intent transaction cannot commit", async () => {
    const scope = await seed();
    await prisma.message.create({
      data: { threadId: scope.threadId, seq: 0, role: "user", blocks: [] },
    });
    await prisma.thread.update({
      where: { id: scope.threadId },
      data: { nextMessageSeq: 1, historyCompactionGeneration: 2147483647 },
    });
    await expect(clear(scope)).rejects.toThrow();
    expect(await prisma.message.count({ where: { threadId: scope.threadId } })).toBe(1);
    expect((await state(scope)).intents).toEqual([]);
  });
  it("settles a successful clear without leaving a false warning", async () => {
    const scope = await seed();
    const receipt = await clear(scope);
    await expect(
      settleMemoryCleanup(prisma, { ...scope, token: receipt.cleanup!.token, unconfirmed: false }),
    ).resolves.toEqual({ memoryCleanupPending: false, memoryCleanupCursor: 1 });
    expect((await state(scope)).pending).toBe(false);
    expect(
      (
        await prisma.event.findFirstOrThrow({
          where: { threadId: scope.threadId },
          orderBy: { seq: "desc" },
        })
      ).payload,
    ).toMatchObject({ memoryCleanupPending: false });
  });
  it("keeps a prior failed outcome after reload, repeated clear and a later success", async () => {
    const scope = await seed();
    const first = await clear(scope);
    await settleMemoryCleanup(prisma, { ...scope, token: first.cleanup!.token, unconfirmed: true });
    const second = await clear(scope);
    expect(second.event.payload.memoryCleanupUnconfirmed).toBe(true);
    await settleMemoryCleanup(prisma, {
      ...scope,
      token: second.cleanup!.token,
      unconfirmed: false,
    });
    expect((await state(scope)).memoryCleanupUnconfirmed).toBe(true);
    expect((await state(scope)).pending).toBe(false);
  });
  it("records one failure metadata event under concurrent settlement", async () => {
    const scope = await seed();
    const receipt = await clear(scope);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        settleMemoryCleanup(prisma, { ...scope, token: receipt.cleanup!.token, unconfirmed: true }),
      ),
    );
    expect(
      await prisma.event.count({ where: { threadId: scope.threadId, type: "thread.meta" } }),
    ).toBe(1);
  });
  it("keeps both status and a surviving notification when settlement races another clear", async () => {
    const scope = await seed();
    const first = await clear(scope);
    await Promise.all([
      clearThread(prisma, scope),
      settleMemoryCleanup(prisma, { ...scope, token: first.cleanup!.token, unconfirmed: true }),
    ]);
    expect((await state(scope)).memoryCleanupUnconfirmed).toBe(true);
    const events = await prisma.event.findMany({ where: { threadId: scope.threadId } });
    expect(
      events.some(
        (event) =>
          (event.payload as { memoryCleanupUnconfirmed?: boolean }).memoryCleanupUnconfirmed,
      ),
    ).toBe(true);
  });
  it("retains the original intent when settlement and its event roll back", async () => {
    const scope = await seed();
    const receipt = await clear(scope);
    const row = await state(scope);
    await prisma.event.create({
      data: { ...scope, seq: row.nextEventSeq, type: "thread.meta", payload: {} },
    });
    await expect(
      settleMemoryCleanup(prisma, { ...scope, token: receipt.cleanup!.token, unconfirmed: true }),
    ).rejects.toThrow();
    const retained = await state(scope);
    expect(retained.memoryCleanupUnconfirmed).toBe(false);
    expect(retained.pending).toBe(true);
    expect(retained.intents).toEqual(row.intents);
  });
  it("does not warn for an in-flight save in the current generation", async () => {
    const scope = await seed();
    const intent = save(scope);
    await expect(beginMemorySave(prisma, intent)).resolves.toBe(true);
    expect((await state(scope)).pending).toBe(false);
    expect((await state(scope)).nextEventSeq).toBe(0);
    await expect(finishMemorySave(prisma, intent)).resolves.toBe(false);
    expect((await state(scope)).intents).toEqual([]);
  });
  it("skips an old-generation save that registers after clear", async () => {
    const scope = await seed();
    await clearThread(prisma, scope);
    await expect(beginMemorySave(prisma, save(scope))).resolves.toBe(false);
    expect((await state(scope)).intents).toEqual([]);
  });
  it.each(["save-first", "clear-first"])(
    "settles save and clear in their actual commit order: %s",
    async (order) => {
      const scope = await seed();
      const intent = save(scope);
      await beginMemorySave(prisma, intent);
      if (order === "save-first")
        await expect(finishMemorySave(prisma, intent)).resolves.toBe(false);
      const receipt = await clear(scope);
      if (order === "clear-first")
        await expect(finishMemorySave(prisma, intent)).resolves.toBe(true);
      await settleMemoryCleanup(prisma, {
        ...scope,
        token: receipt.cleanup!.token,
        unconfirmed: false,
      });
      expect((await state(scope)).pending).toBe(order === "clear-first");
      if (order === "clear-first")
        await settleMemoryCleanup(prisma, { ...scope, token: intent.token, unconfirmed: false });
      expect((await state(scope)).pending).toBe(false);
    },
  );
  it("does not settle an in-flight save when the early clear purge succeeds", async () => {
    const scope = await seed();
    const first = save(scope);
    const second = save(scope, "save:0:99");
    await beginMemorySave(prisma, first);
    await beginMemorySave(prisma, second);
    const receipt = await clear(scope);
    await settleMemoryCleanup(prisma, {
      ...scope,
      token: receipt.cleanup!.token,
      unconfirmed: false,
    });
    expect((await state(scope)).intents.map((item) => item.token).sort()).toEqual([
      first.token,
      second.token,
    ]);
    await finishMemorySave(prisma, first);
    await finishMemorySave(prisma, second);
    await settleMemoryCleanup(prisma, { ...scope, token: first.token, unconfirmed: false });
    expect((await state(scope)).pending).toBe(true);
    await settleMemoryCleanup(prisma, { ...scope, token: second.token, unconfirmed: true });
    expect((await state(scope)).pending).toBe(false);
    expect((await state(scope)).memoryCleanupUnconfirmed).toBe(true);
  });
  it("does not discard unresolved old work on another clear or disconnect", async () => {
    const scope = await seed();
    await beginMemorySave(prisma, save(scope));
    const first = await clear(scope);
    await clearThread(prisma, scope);
    expect((await state(scope)).intents.map((item) => item.token).sort()).toEqual([
      first.cleanup!.token,
      "save:0:49",
    ]);
    expect((await state(scope)).pending).toBe(true);
  });
  it.each(["spaceId", "botId"] as const)(
    "cannot register work against another target with wrong %s",
    async (field) => {
      const scope = await seed();
      await expect(
        beginMemorySave(prisma, { ...save(scope), [field]: "other-target" }),
      ).rejects.toThrow("unavailable");
      expect((await state(scope)).intents).toEqual([]);
    },
  );
  it("does not record a result for an absent operation token", async () => {
    const scope = await seed();
    await expect(
      settleMemoryCleanup(prisma, { ...scope, token: "other-operation", unconfirmed: true }),
    ).resolves.toEqual({ memoryCleanupPending: false, memoryCleanupCursor: -1 });
    expect((await state(scope)).memoryCleanupUnconfirmed).toBe(false);
    expect(await prisma.event.count({ where: { threadId: scope.threadId } })).toBe(0);
  });
  it.each(["settle-first", "clear-first"])(
    "retains a surviving failure event in explicit order %s",
    async (order) => {
      const scope = await seed();
      const first = await clear(scope);
      const settle = () =>
        settleMemoryCleanup(prisma, { ...scope, token: first.cleanup!.token, unconfirmed: true });
      if (order === "settle-first") {
        await settle();
        await clearThread(prisma, scope);
      } else {
        await clearThread(prisma, scope);
        await settle();
      }
      const events = await prisma.event.findMany({ where: { threadId: scope.threadId } });
      expect(
        events.some(
          (event) =>
            (event.payload as { memoryCleanupUnconfirmed?: boolean }).memoryCleanupUnconfirmed,
        ),
      ).toBe(true);
    },
  );
  it("retains save responsibility under a concurrent finish and clear", async () => {
    const scope = await seed();
    const intent = save(scope);
    await beginMemorySave(prisma, intent);
    const [stale, receipt] = await Promise.all([finishMemorySave(prisma, intent), clear(scope)]);
    await settleMemoryCleanup(prisma, {
      ...scope,
      token: receipt.cleanup!.token,
      unconfirmed: false,
    });
    expect((await state(scope)).pending).toBe(stale);
    if (stale) {
      expect((await state(scope)).intents.map((item) => item.token)).toContain(intent.token);
      await settleMemoryCleanup(prisma, { ...scope, token: intent.token, unconfirmed: false });
    }
    expect((await state(scope)).pending).toBe(false);
  });
});
