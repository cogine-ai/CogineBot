import { randomUUID } from "node:crypto";
import { SandboxNotFoundError } from "@e2b/desktop";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sleepComputerIfIdle } from "./computer-idle.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("idle missing-computer suspension claim", () => {
  const organizationId = `idle-organization-${randomUUID()}`;
  const spaceId = `idle-space-${randomUUID()}`;
  let database: ReturnType<typeof createDb>;
  let computerId: string;
  let claimAt: Date;
  let beforeMissing: (() => Promise<unknown>) | undefined;
  const clearCounts: number[] = [];
  const stop = vi.fn();
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn();
  let deps: Parameters<typeof sleepComputerIfIdle>[0];

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    await database.prisma.organization.create({
      data: { id: organizationId, name: "Idle Test", slug: organizationId, createdAt: new Date() },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Idle Test" },
    });
    const prisma = database.prisma.$extends({
      query: {
        computer: {
          async updateMany({ args, query }) {
            const result = await query(args);
            if (args.data.state === "suspending") claimAt = args.data.updatedAt as Date;
            if (args.data.providerRef === null) clearCounts.push(result.count);
            return result;
          },
        },
      },
    });
    deps = {
      prisma: prisma as unknown as PrismaClient,
      home: { commit } as unknown as AgentHomeStore,
      jobs: { enqueue } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      sandbox: {
        inspectBackgroundWork: async () => "idle",
        exportWorkspace: async function* () {
          await beforeMissing?.();
          yield await Promise.reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
        },
        stop,
      } as unknown as SandboxProvider,
    };
  });

  beforeEach(async () => {
    computerId = `idle-computer-${randomUUID()}`;
    beforeMissing = undefined;
    clearCounts.length = 0;
    stop.mockClear();
    enqueue.mockClear();
    commit.mockClear();
    await database.prisma.computer.create({
      data: {
        id: computerId,
        spaceId,
        userId: "idle-owner",
        scope: "team",
        scopeKey: computerId,
        homeKey: computerId,
        homeRevision: "saved-before",
        providerRef: "missing-provider",
        kind: "e2b",
        state: "running",
        controlHolder: "user",
        controlLeaseId: "old-control",
        controlLeaseExpiresAt: new Date("2100-01-01"),
        controlBotId: "old-bot",
        controlRunId: "old-run",
        updatedAt: new Date("2000-01-01"),
      },
    });
  });

  afterAll(async () => {
    if (!database) return;
    await database.prisma.organization.deleteMany({ where: { id: organizationId } });
    await database.prisma.$disconnect();
    await database.pool.end();
  });

  it("clears only the claimed dead resource and control while preserving its saved home", async () => {
    await sleepComputerIfIdle(deps, computerId);
    expect(clearCounts).toEqual([1]);
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "stopped",
      providerRef: null,
      homeRevision: "saved-before",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["reference", "generation", "kind", "maintenance", "state"])(
    "does not clear a newer %s owner even when its timestamp matches the old claim",
    async (change) => {
      beforeMissing = () =>
        database.prisma.computer.update({
          where: { id: computerId },
          data: {
            ...(change === "reference" ? { providerRef: "new-provider" } : {}),
            ...(change === "generation" ? { screenGeneration: { increment: 1 } } : {}),
            ...(change === "kind" ? { kind: "daytona" } : {}),
            ...(change === "maintenance" ? { maintenanceId: "new-maintenance" } : {}),
            ...(change === "state" ? { state: "running" } : {}),
            updatedAt: claimAt,
            controlHolder: "user",
            controlLeaseId: "new-control",
          },
        });
      await sleepComputerIfIdle(deps, computerId);
      expect(clearCounts).toEqual([0]);
      expect(
        await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
      ).toMatchObject({
        state: change === "state" ? "running" : "suspending",
        providerRef: change === "reference" ? "new-provider" : "missing-provider",
        screenGeneration: ["reference", "generation", "state"].includes(change) ? 2 : 1,
        kind: change === "kind" ? "daytona" : "e2b",
        maintenanceId: change === "maintenance" ? "new-maintenance" : null,
        homeRevision: "saved-before",
        controlHolder: "user",
        controlLeaseId: "new-control",
      });
      expect(stop).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
