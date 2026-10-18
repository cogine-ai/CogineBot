import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createRepos } from "./repos.js";
import { BotSectionNameConflictError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("sidebar group undo (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `section-user-${suffix}`;
  const spaceId = `section-space-${suffix}`;
  const organizationId = `section-org-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({ data: { id: userId, name: "Section tester", email: actor.email } });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Section Org",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("retries the real unique-key race with a regular same-name create and restores archived members", async () => {
    const section = await prisma.botSection.create({ data: { spaceId, userId, name: "Product" } });
    const bot = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "Planner",
        color: "blue",
        sectionId: section.id,
        archivedAt: new Date(),
      },
    });
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Planning", sectionId: section.id, archivedAt: new Date() },
    });
    const snapshot = await createRepos(prisma).removeBotSection(actor, section.id);
    const concurrentBot = await prisma.bot.create({
      data: { spaceId, userId, name: "Concurrent creator", color: "blue" },
    });
    let winnerId: string | undefined;
    const conflicts: string[] = [];
    const racingPrisma = prisma.$extends({
      query: {
        botSection: {
          async create({ args, query }) {
            // The restore transaction has already read its Serializable snapshot.
            // This ordinary create commits on a separate connection before its INSERT.
            if (!winnerId) {
              const winner = await createRepos(prisma).createBotSection(actor, {
                botId: concurrentBot.id,
                name: "Product",
              });
              winnerId = winner.id;
            }
            try {
              return await query(args);
            } catch (error) {
              if (error && typeof error === "object" && "code" in error)
                conflicts.push(String(error.code));
              throw error;
            }
          },
        },
      },
    });

    const restored = await createRepos(racingPrisma as unknown as PrismaClient).restoreBotSection(
      actor,
      snapshot,
    );

    expect(conflicts).toEqual(["P2002"]);
    expect(restored.id).toBe(winnerId);
    expect(await prisma.botSection.count({ where: { spaceId, userId, name: "Product" } })).toBe(1);
    expect(await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
      sectionId: winnerId,
      archivedAt: expect.any(Date),
    });
    expect(await prisma.chatGroup.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({
      sectionId: winnerId,
      archivedAt: expect.any(Date),
    });
  });

  it("rejects an existing name atomically without moving or unpinning the target", async () => {
    const existing = await prisma.botSection.create({
      data: { spaceId, userId, name: "Existing" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Unmoved", color: "blue", pinned: true },
    });

    await expect(
      createRepos(prisma).createBotSection(actor, {
        botId: bot.id,
        name: existing.name,
      }),
    ).rejects.toBeInstanceOf(BotSectionNameConflictError);

    expect(await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toMatchObject({
      sectionId: null,
      pinned: true,
    });
    expect(await prisma.botSection.count({ where: { spaceId, userId, name: existing.name } })).toBe(
      1,
    );
  });
  it("rejects client-supplied historical reserved names through both restore paths", async () => {
    const section = await prisma.botSection.create({
      data: { spaceId, userId, name: "Unassigned" },
    });
    const repos = createRepos(prisma);
    await repos.updateBotSection(actor, { sectionId: section.id, name: "Legacy renamed" });
    await expect(
      repos.updateBotSection(actor, { sectionId: section.id, name: "Unassigned" }),
    ).rejects.toThrow();

    await expect(
      repos.restoreBotSectionName(actor, {
        sectionId: section.id,
        name: "Unassigned",
        expectedName: "Legacy renamed",
      }),
    ).rejects.toThrow();

    const snapshot = await repos.removeBotSection(actor, section.id);
    await expect(
      repos.restoreBotSection(actor, {
        ...snapshot,
        section: { ...snapshot.section, name: "Unassigned" },
      }),
    ).rejects.toThrow();

    expect(await prisma.botSection.findUnique({ where: { id: section.id } })).toBeNull();
  });

  it("keeps a concurrent rename when the expected-name update no longer matches", async () => {
    const section = await prisma.botSection.create({ data: { spaceId, userId, name: "Current" } });
    const racingPrisma = prisma.$extends({
      query: {
        botSection: {
          async update({ args, query }) {
            await prisma.botSection.update({ where: { id: section.id }, data: { name: "Later" } });
            return query(args);
          },
        },
      },
    });

    await expect(
      createRepos(racingPrisma as unknown as PrismaClient).restoreBotSectionName(actor, {
        sectionId: section.id,
        name: "Previous",
        expectedName: "Current",
      }),
    ).rejects.toBeInstanceOf(BotSectionNameConflictError);

    expect(await prisma.botSection.findUniqueOrThrow({ where: { id: section.id } })).toMatchObject({
      name: "Later",
    });
  });
});
