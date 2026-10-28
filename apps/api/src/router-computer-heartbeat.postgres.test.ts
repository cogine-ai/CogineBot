import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("computer attendance lifecycle compare-and-swap", () => {
  const organizationId = `heartbeat-organization-${randomUUID()}`;
  const spaceId = `heartbeat-space-${randomUUID()}`;
  const actor: Actor = {
    spaceId,
    userId: "heartbeat-viewer",
    email: "heartbeat-viewer@example.test",
    isDeploymentOwner: false,
  };
  let database: ReturnType<typeof createDb>;
  let botId: string;
  let computerId: string;
  let afterSnapshot: (() => Promise<unknown>) | undefined;
  const casCounts: number[] = [];
  const keepAlive = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  let heartbeat: () => Promise<unknown>;

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    await database.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Heartbeat Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Heartbeat Test" },
    });
    const instrumented = database.prisma.$extends({
      query: {
        bot: {
          async findFirst({ args, query }) {
            const snapshot = await query(args);
            if (snapshot && args.where?.id === botId && afterSnapshot) {
              const change = afterSnapshot;
              afterSnapshot = undefined;
              await change();
            }
            return snapshot;
          },
        },
        computer: {
          async updateMany({ args, query }) {
            const result = await query(args);
            casCounts.push(result.count);
            return result;
          },
        },
      },
    });
    const deps = {
      prisma: instrumented as unknown as PrismaClient,
      sandbox: { keepAlive },
      jobs: { enqueue },
      env: { defaultProvider: "fake", defaultModel: "fake", sandboxProvider: "fake" },
      dataDir: "/tmp/heartbeat-postgres-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    heartbeat = () => client.computer.heartbeat({ botId });
  });

  beforeEach(async () => {
    keepAlive.mockClear();
    enqueue.mockClear();
    casCounts.length = 0;
    afterSnapshot = undefined;
    botId = `heartbeat-bot-${randomUUID()}`;
    computerId = `heartbeat-computer-${randomUUID()}`;
    await database.prisma.computer.create({
      data: {
        id: computerId,
        spaceId,
        userId: "heartbeat-computer-owner",
        scope: "team",
        scopeKey: computerId,
        homeKey: computerId,
        kind: "e2b",
        providerRef: "heartbeat-provider",
        state: "running",
        controlHolder: "user",
        controlLeaseId: "heartbeat-human-lease",
        controlLeaseExpiresAt: new Date("2030-01-01"),
      },
    });
    await database.prisma.bot.create({
      data: {
        id: botId,
        spaceId,
        userId: actor.userId,
        name: "Heartbeat",
        color: "ink",
        computerId,
      },
    });
  });

  afterAll(async () => {
    if (!database) return;
    await database.prisma.organization.deleteMany({ where: { id: organizationId } });
    await database.prisma.$disconnect();
    await database.pool.end();
  });

  it("keeps an authorized Team view alive without assuming the viewer owns the computer", async () => {
    await expect(heartbeat()).resolves.toEqual({ ok: true });
    expect(casCounts).toEqual([1]);
    expect(keepAlive).toHaveBeenCalledWith(
      {
        id: "heartbeat-provider",
        providerRef: "heartbeat-provider",
        botId: computerId,
        kind: "e2b",
      },
      { onlyIfRunning: true },
    );
    const computer = await database.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(computer.controlLeaseId).toBe("heartbeat-human-lease");
    expect(computer.controlLeaseExpiresAt).toEqual(new Date("2030-01-01"));
  });

  it.each([
    "stop",
    "provider",
    "kind",
    "home",
    "maintenance",
    "computer-generation",
    "bot-switch",
    "bot-switching",
    "bot-generation",
    "archive",
  ])("rejects attendance after a concurrent %s change", async (change) => {
    afterSnapshot = async () => {
      if (change === "bot-switch")
        return database.prisma.bot.update({ where: { id: botId }, data: { computerId: null } });
      if (change === "bot-switching")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { computerSwitching: true },
        });
      if (change === "bot-generation")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { screenGeneration: { increment: 1 } },
        });
      if (change === "archive")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { archivedAt: new Date() },
        });
      return database.prisma.computer.update({
        where: { id: computerId },
        data: {
          ...(change === "stop" ? { state: "suspending" } : {}),
          ...(change === "provider" ? { providerRef: "replacement" } : {}),
          ...(change === "kind" ? { kind: "docker" } : {}),
          ...(change === "home" ? { homeKey: `replacement-${computerId}` } : {}),
          ...(change === "maintenance" ? { maintenanceId: "maintenance" } : {}),
          ...(change === "computer-generation" ? { screenGeneration: { increment: 1 } } : {}),
        },
      });
    };
    await expect(heartbeat()).resolves.toEqual({ ok: true });
    expect(casCounts).toEqual([0]);
    expect(keepAlive).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
