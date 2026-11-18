import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { clearThread, markMemoryCleanupUnconfirmed } from "./events.js";

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
  it("defaults to no recorded failure without asserting external deletion", async () => {
    const scope = await seed();
    expect(
      (await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } }))
        .memoryCleanupUnconfirmed,
    ).toBe(false);
  });
  it("survives reload and repeated clears that delete the previous events", async () => {
    const scope = await seed();
    await markMemoryCleanupUnconfirmed(prisma, scope);
    for (let clear = 0; clear < 2; clear++) {
      const receipt = await clearThread(prisma, scope);
      expect(receipt.memoryCleanupUnconfirmed).toBe(true);
      expect(receipt.event.payload.memoryCleanupUnconfirmed).toBe(true);
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } }))
          .memoryCleanupUnconfirmed,
      ).toBe(true);
    }
  });
  it("records one metadata event under concurrent duplicate failures", async () => {
    const scope = await seed();
    await Promise.all(Array.from({ length: 4 }, () => markMemoryCleanupUnconfirmed(prisma, scope)));
    const events = await prisma.event.findMany({ where: { threadId: scope.threadId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.meta",
      payload: { memoryCleanupUnconfirmed: true },
    });
  });
  it("cannot lose a failure when clear races its transaction", async () => {
    const scope = await seed();
    await Promise.all([clearThread(prisma, scope), markMemoryCleanupUnconfirmed(prisma, scope)]);
    expect(
      (await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } }))
        .memoryCleanupUnconfirmed,
    ).toBe(true);
    const again = await clearThread(prisma, scope);
    expect(again.memoryCleanupUnconfirmed).toBe(true);
  });
  it.each(["spaceId", "botId"] as const)(
    "does not mutate another target for a wrong %s",
    async (field) => {
      const scope = await seed();
      await markMemoryCleanupUnconfirmed(prisma, { ...scope, [field]: "unrelated-target" });
      expect(
        (await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } }))
          .memoryCleanupUnconfirmed,
      ).toBe(false);
      expect(await prisma.event.count({ where: { threadId: scope.threadId } })).toBe(0);
    },
  );
  it("rolls back the sticky bit when event insertion fails", async () => {
    const scope = await seed();
    // Inject an event-sequence collision: the append must fail after the status update.
    await prisma.event.create({ data: { ...scope, seq: 0, type: "thread.meta", payload: {} } });
    await expect(markMemoryCleanupUnconfirmed(prisma, scope)).rejects.toThrow();
    expect(
      (await prisma.thread.findUniqueOrThrow({ where: { id: scope.threadId } }))
        .memoryCleanupUnconfirmed,
    ).toBe(false);
    expect(await prisma.event.count({ where: { threadId: scope.threadId } })).toBe(1);
  });
});
