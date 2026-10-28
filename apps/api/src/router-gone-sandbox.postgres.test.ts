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

describePostgres("computer Gone cleanup lifecycle compare-and-swap", () => {
  const organizationId = `gone-organization-${randomUUID()}`;
  const spaceId = `gone-space-${randomUUID()}`;
  const actor: Actor = {
    spaceId,
    userId: "gone-viewer",
    email: "gone-viewer@example.test",
    isDeploymentOwner: false,
  };
  let database: ReturnType<typeof createDb>;
  let botId: string;
  let computerId: string;
  let afterSnapshot: (() => Promise<unknown>) | undefined;
  const casCounts: number[] = [];
  const connectScreen = vi.fn(async () => {
    if (afterSnapshot) {
      const change = afterSnapshot;
      afterSnapshot = undefined;
      await change();
    }
    const error = new Error("Resource no longer exists");
    error.name = "SandboxNotFoundError";
    throw error;
  });
  const enqueue = vi.fn().mockResolvedValue(undefined);
  let gone: () => Promise<unknown>;

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    await database.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Gone Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Gone Test" },
    });
    const instrumented = database.prisma.$extends({
      query: {
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
      sandbox: { connectScreen },
      jobs: { enqueue },
      env: { defaultProvider: "fake", defaultModel: "fake", sandboxProvider: "fake" },
      dataDir: "/tmp/gone-postgres-test",
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    gone = () => client.computer.screenUrl({ botId });
  });

  beforeEach(async () => {
    connectScreen.mockClear();
    enqueue.mockClear();
    casCounts.length = 0;
    afterSnapshot = undefined;
    botId = `gone-bot-${randomUUID()}`;
    computerId = `gone-computer-${randomUUID()}`;
    await database.prisma.computer.create({
      data: {
        id: computerId,
        spaceId,
        userId: "gone-computer-owner",
        scope: "team",
        scopeKey: computerId,
        homeKey: computerId,
        kind: "e2b",
        providerRef: "gone-provider",
        state: "running",
        controlHolder: "none",
        homeRevision: "saved-revision",
      },
    });
    await database.prisma.bot.create({
      data: {
        id: botId,
        spaceId,
        userId: actor.userId,
        name: "Gone",
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

  it("clears only the current dead target and preserves its saved workspace", async () => {
    await expect(gone()).resolves.toEqual({ url: null });
    expect(casCounts).toEqual([1]);
    const row = await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    expect(row).toMatchObject({
      state: "stopped",
      providerRef: null,
      homeRevision: "saved-revision",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["provider", "generation", "maintenance", "state", "kind", "home"])(
    "does not clear a replacement after a concurrent %s change",
    async (change) => {
      afterSnapshot = () =>
        database.prisma.computer.update({
          where: { id: computerId },
          data: {
            ...(change === "provider" ? { providerRef: "replacement" } : {}),
            ...(change === "generation" ? { screenGeneration: { increment: 1 } } : {}),
            ...(change === "maintenance" ? { maintenanceId: "replacement-maintenance" } : {}),
            ...(change === "state" ? { state: "suspending" } : {}),
            ...(change === "kind" ? { kind: "box" } : {}),
            ...(change === "home" ? { homeKey: `replacement-${computerId}` } : {}),
          },
        });
      await expect(gone()).resolves.toEqual({ url: null });
      expect(casCounts).toEqual([0]);
      const row = await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
      expect(row.providerRef).toBe(change === "provider" ? "replacement" : "gone-provider");
      expect(row.state).toBe(change === "state" ? "suspending" : "running");
      expect(row.homeRevision).toBe("saved-revision");
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
