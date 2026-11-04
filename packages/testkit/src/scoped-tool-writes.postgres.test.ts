import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "../../adapters/src/scratchpad-tools.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("scoped tool writes (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `tool-write-org-${suffix}`;
  const spaceId = `tool-write-space-${suffix}`;
  const userId = `tool-write-user-${suffix}`;
  const otherUserId = `tool-write-other-${suffix}`;
  const botId = `tool-write-bot-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.createMany({
      data: [userId, otherUserId].map((id) => ({
        id,
        name: "Tool writer",
        email: `${id}@example.test`,
      })),
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Tool writes",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Tasks", isDefault: true },
    });
    await prisma.bot.create({
      data: { id: botId, spaceId, userId, name: "Writer", color: "blue" },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });

  it("does not overwrite a note whose owner changes after it was read", async () => {
    const added = await addScratchpadItemFromTool(
      { prisma },
      { spaceId, botId, userId, title: "Original note", notes: "Keep these notes" },
    );
    if (!("item" in added)) throw new Error("Note fixture was not created");
    const itemId = added.item.id;
    let changed = false;
    const racing = prisma.$extends({
      query: {
        scratchpadItem: {
          async findFirst({ args, query }) {
            const found = await query(args);
            if (found?.id === itemId && !changed) {
              changed = true;
              await prisma.scratchpadItem.update({
                where: { id: itemId },
                data: { userId: otherUserId },
              });
            }
            return found;
          },
        },
      },
    });
    const result = await updateScratchpadItemFromTool(
      { prisma: racing as unknown as PrismaClient },
      { spaceId, botId, userId, itemId, title: "Must not replace it" },
    );
    expect(result).toEqual({ error: "Scratchpad item not found." });
    const listed = await listScratchpadItemsFromTool(
      { prisma },
      { spaceId, botId, includeDone: true },
    );
    expect(listed.items.find((item) => item.id === itemId)).toMatchObject({
      title: "Original note",
      status: "open",
      notes: "Keep these notes",
    });
  });

  it("does not remove a note whose owner changes after it was read", async () => {
    const added = await addScratchpadItemFromTool(
      { prisma },
      { spaceId, botId, userId, title: "Keep this note" },
    );
    if (!("item" in added)) throw new Error("Note fixture was not created");
    const itemId = added.item.id;
    let changed = false;
    const racing = prisma.$extends({
      query: {
        scratchpadItem: {
          async findFirst({ args, query }) {
            const found = await query(args);
            if (found?.id === itemId && !changed) {
              changed = true;
              await prisma.scratchpadItem.update({
                where: { id: itemId },
                data: { userId: otherUserId },
              });
            }
            return found;
          },
        },
      },
    });
    const result = await removeScratchpadItemFromTool(
      { prisma: racing as unknown as PrismaClient },
      { spaceId, botId, userId, itemId },
    );
    expect(result).toEqual({ error: "Scratchpad item not found." });
    const listed = await listScratchpadItemsFromTool(
      { prisma },
      { spaceId, botId, includeDone: true },
    );
    expect(listed.items.find((item) => item.id === itemId)).toMatchObject({
      title: "Keep this note",
    });
  });

  it.each(["spaceId", "botId", "userId"] as const)(
    "refuses a note write with incomplete %s authority",
    async (missing) => {
      const added = await addScratchpadItemFromTool(
        { prisma },
        { spaceId, botId, userId, title: "Complete authority required" },
      );
      if (!("item" in added)) throw new Error("Note fixture was not created");
      const itemId = added.item.id;
      const result = await updateScratchpadItemFromTool({ prisma }, {
        spaceId,
        botId,
        userId,
        itemId,
        title: "Must not land",
        [missing]: undefined,
      } as unknown as Parameters<typeof updateScratchpadItemFromTool>[1]);
      expect(result).toEqual({ error: "Scratchpad item not found." });
      const listed = await listScratchpadItemsFromTool(
        { prisma },
        { spaceId, botId, includeDone: true },
      );
      expect(listed.items.find((item) => item.id === itemId)).toMatchObject({
        title: "Complete authority required",
      });
    },
  );

  it("keeps the legal note lifecycle available", async () => {
    const added = await addScratchpadItemFromTool(
      { prisma },
      { spaceId, botId, userId, title: "A legal note" },
    );
    if (!("item" in added)) throw new Error("Note fixture was not created");
    const input = { spaceId, botId, userId, itemId: added.item.id };
    expect(
      await updateScratchpadItemFromTool(
        { prisma },
        { ...input, title: "Updated", status: "parked" },
      ),
    ).toMatchObject({ item: { title: "Updated", status: "parked" } });
    expect(await completeScratchpadItemFromTool({ prisma }, input)).toMatchObject({
      item: { status: "done" },
    });
    expect(await removeScratchpadItemFromTool({ prisma }, input)).toMatchObject({
      ok: true,
      itemId: input.itemId,
    });
    const listed = await listScratchpadItemsFromTool(
      { prisma },
      { spaceId, botId, includeDone: true },
    );
    expect(listed.items.find((item) => item.id === input.itemId)).toBeUndefined();
  });

  it.each(["update", "complete", "remove"] as const)(
    "%s refuses a note that is deleted after the initial read",
    async (action) => {
      const added = await addScratchpadItemFromTool(
        { prisma },
        { spaceId, botId, userId, title: "Removed concurrently" },
      );
      if (!("item" in added)) throw new Error("Note fixture was not created");
      const itemId = added.item.id;
      let removed = false;
      const racing = prisma.$extends({
        query: {
          scratchpadItem: {
            async findFirst({ args, query }) {
              const found = await query(args);
              if (found?.id === itemId && !removed) {
                removed = true;
                await prisma.scratchpadItem.delete({ where: { id: itemId } });
              }
              return found;
            },
          },
        },
      });
      const deps = { prisma: racing as unknown as PrismaClient };
      const input = { spaceId, botId, userId, itemId };
      const result =
        action === "update"
          ? await updateScratchpadItemFromTool(deps, { ...input, title: "Must not return success" })
          : action === "complete"
            ? await completeScratchpadItemFromTool(deps, input)
            : await removeScratchpadItemFromTool(deps, input);
      expect(result).toEqual({ error: "Scratchpad item not found." });
      const listed = await listScratchpadItemsFromTool(
        { prisma },
        { spaceId, botId, includeDone: true },
      );
      expect(listed.items.find((item) => item.id === itemId)).toBeUndefined();
    },
  );
});
