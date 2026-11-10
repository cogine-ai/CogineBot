import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileNotFoundError, SandboxNotFoundError } from "@e2b/desktop";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sleepComputerIfIdle } from "./computer-idle.js";
import {
  checkpointAndRecordComputerWorkspace,
  teamBrowserProfileName,
} from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";

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
  let exportError: Error;
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
          yield await Promise.reject(exportError);
        },
        stop,
      } as unknown as SandboxProvider,
    };
  });

  beforeEach(async () => {
    computerId = `idle-computer-${randomUUID()}`;
    beforeMissing = undefined;
    exportError = new SandboxNotFoundError("Synthetic sandbox unavailable");
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

  it("retains the current resource and control after a typed file error with sandbox-like wording", async () => {
    exportError = new FileNotFoundError("sandbox settings.json not found");
    await expect(sleepComputerIfIdle(deps, computerId)).rejects.toBe(exportError);
    expect(clearCounts).toEqual([]);
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "running",
      providerRef: "missing-provider",
      homeRevision: "saved-before",
      controlHolder: "user",
      controlLeaseId: "old-control",
      controlLeaseExpiresAt: new Date("2100-01-01"),
      controlBotId: "old-bot",
      controlRunId: "old-run",
    });
    expect(stop).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
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

describePostgres("safe workspace publication", () => {
  const organizationId = `save-organization-${randomUUID()}`;
  const spaceId = `save-space-${randomUUID()}`;
  const context = {
    operationId: "save-test",
    traceId: "save-test",
    spaceId,
    userId: "owner",
    botId: "writer",
    runId: "saving-run",
    screenLeaseId: "saving-run:4",
    signal: new AbortController().signal,
  } satisfies AdapterContext;
  let database: ReturnType<typeof createDb>;
  let root: string;
  let home: LocalAgentHomeStore;

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    await database.prisma.organization.create({
      data: { id: organizationId, name: "Save Test", slug: organizationId, createdAt: new Date() },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Save Test" },
    });
    root = await mkdtemp(path.join(tmpdir(), "workspace-save-pg-"));
    home = new LocalAgentHomeStore(root);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (!database) return;
    await database.prisma.organization.deleteMany({ where: { id: organizationId } });
    await database.prisma.$disconnect();
    await database.pool.end();
  });

  async function seed() {
    const id = `save-computer-${randomUUID()}`;
    await home.writeFile(id, "notes.txt", "last valid home", context);
    const homeRevision = await home.revise(id);
    const record = await database.prisma.computer.create({
      data: {
        id,
        spaceId,
        userId: context.userId,
        scope: "team",
        scopeKey: id,
        homeKey: id,
        homeRevision,
        providerRef: id,
        kind: "e2b",
        state: "running",
        executionLeases: {
          create: {
            botId: context.botId,
            runId: context.runId,
            fence: 4,
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });
    expect(record).toMatchObject({ homeRevisionAt: null, restorePending: false });
    const ref = { id, botId: context.botId, providerRef: id, kind: "e2b" } as const;
    return { id, record, ref, homeRevision };
  }

  it.each(["generation", "restore pending", "expired lease", "revision record"] as const)(
    "retains the last valid home if %s invalidates publication",
    async (failure) => {
      const { id, record, ref, homeRevision } = await seed();
      const injected = new Error("Synthetic revision record failure");
      const prisma =
        failure === "revision record"
          ? (database.prisma.$extends({
              query: {
                computer: {
                  async updateMany({ args, query }) {
                    if (args.data.homeRevision) throw injected;
                    return query(args);
                  },
                },
              },
            }) as unknown as PrismaClient)
          : database.prisma;
      const sandbox = {
        async *exportWorkspace() {
          yield { path: "notes.txt", content: Buffer.from("replacement") };
          if (failure === "generation") {
            await prisma.computer.update({
              where: { id },
              data: { screenGeneration: { increment: 1 } },
            });
          }
          if (failure === "restore pending") {
            await prisma.computer.update({ where: { id }, data: { restorePending: true } });
          }
          if (failure === "expired lease") {
            await prisma.computerExecutionLease.updateMany({
              where: { computerId: id, runId: context.runId },
              data: { expiresAt: new Date(0) },
            });
          }
        },
      } as unknown as SandboxProvider;
      const save = checkpointAndRecordComputerWorkspace(
        { prisma, home, sandbox },
        record,
        ref,
        context,
      );
      if (failure === "revision record") await expect(save).rejects.toBe(injected);
      else await expect(save).rejects.toMatchObject({ name: "ComputerCheckpointChangedError" });
      expect(await home.readFile(id, "notes.txt", context)).toBe("last valid home");
      expect(await readFile(path.join(root, "home-revisions", `${id}.txt`), "utf8")).toBe(
        homeRevision,
      );
      expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
        homeRevision,
        homeRevisionAt: null,
        state: "running",
      });
      await vi.waitFor(async () => expect(await readdir(path.join(root, "staging"))).toEqual([]));
    },
  );

  it("excludes tombstones written during export and records the completed revision", async () => {
    const { id, record, ref, homeRevision } = await seed();
    const prisma = database.prisma;
    const deletedId = "deleted-bot";
    const deletedPaths = [
      `bots/${deletedId}/notes.txt`,
      `.browser-profiles/${teamBrowserProfileName(deletedId)}/Default/Network/Cookies`,
    ];
    const survivor = "bots/deleted-bot-other/notes.txt";
    const sandbox = {
      async *exportWorkspace() {
        for (const filePath of [...deletedPaths, survivor]) {
          yield { path: filePath, content: Buffer.from("new content") };
        }
        await prisma.botDeletion.create({
          data: {
            id: deletedId,
            spaceId,
            name: "Deleted bot",
            deletedByUserId: context.userId,
            memoriesPreserved: true,
          },
        });
      },
    } as unknown as SandboxProvider;
    const revision = await checkpointAndRecordComputerWorkspace(
      { prisma, home, sandbox },
      record,
      ref,
      context,
    );
    expect(revision).not.toBe(homeRevision);
    expect(await home.readFile(id, survivor, context)).toBe("new content");
    for (const filePath of deletedPaths) {
      await expect(home.readFile(id, filePath, context)).rejects.toThrow();
    }
    expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      homeRevision: revision,
      homeRevisionAt: expect.any(Date),
      updatedAt: record.updatedAt,
      state: "running",
    });
  });

  it.each(["uncommitted", "committed"] as const)(
    "recovers an %s save left behind by another process",
    async (outcome) => {
      const { id, homeRevision } = await seed();
      const nextRevision = "rev-interrupted-fixture";
      const oldHome = home.pathFor(id);
      const previous = `${oldHome}.previous`;
      const markerDir = path.join(root, "home-revisions");
      const pending = path.join(markerDir, `${id}.pending.json`);
      const marker = path.join(markerDir, `${id}.txt`);
      await writeFile(
        pending,
        JSON.stringify({
          revision: nextRevision,
          baseRevision: homeRevision,
          previousMarker: homeRevision,
          replaceHome: true,
          hadHome: true,
        }),
      );
      await rename(oldHome, previous);
      await mkdir(oldHome);
      await writeFile(path.join(oldHome, "notes.txt"), "staged home");
      await writeFile(marker, nextRevision);
      if (outcome === "committed") {
        await database.prisma.computer.update({
          where: { id },
          data: { homeRevision: nextRevision },
        });
      }

      const reopened = new LocalAgentHomeStore(root, database.prisma);
      expect(await reopened.readFile(id, "notes.txt", context)).toBe(
        outcome === "committed" ? "staged home" : "last valid home",
      );
      expect(await readFile(marker, "utf8")).toBe(
        outcome === "committed" ? nextRevision : homeRevision,
      );
      expect(await readdir(path.dirname(oldHome))).not.toContain(path.basename(previous));
      expect(await readdir(markerDir)).not.toContain(path.basename(pending));
    },
  );

  it("keeps readers and another publication out after a database transaction expires", async () => {
    const { id, record, ref } = await seed();
    const prisma = database.prisma;
    const winner = new LocalAgentHomeStore(root, prisma);
    const provider = (content: string) =>
      ({
        async *exportWorkspace() {
          yield { path: "notes.txt", content: Buffer.from(content) };
        },
      }) as unknown as SandboxProvider;
    let installed!: () => void;
    let resume!: () => void;
    const installedGate = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const resumeGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let first = true;
    const timingOut = {
      computer: prisma.computer,
      $transaction<T>(
        work: (tx: Prisma.TransactionClient) => Promise<T>,
        options: { timeout: number },
      ) {
        if (!first) return prisma.$transaction(work, options);
        first = false;
        return prisma.$transaction(
          async (tx) => {
            const result = await work(tx);
            installed();
            await resumeGate;
            return result;
          },
          { timeout: 500 },
        );
      },
    } as unknown as PrismaClient;

    const failure = checkpointAndRecordComputerWorkspace(
      { prisma: timingOut, home, sandbox: provider("uncommitted data") },
      record,
      ref,
      context,
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        installedGate,
        failure.then((error) => {
          throw error;
        }),
      ]);
      let readFinished = false;
      let published = false;
      const reading = winner.readFile(id, "notes.txt", context).finally(() => {
        readFinished = true;
      });
      const saving = checkpointAndRecordComputerWorkspace(
        { prisma, home: winner, sandbox: provider("winner data") },
        record,
        ref,
        context,
      ).finally(() => {
        published = true;
      });

      // The row lock has expired even though the original filesystem operation has not finished.
      await delay(600);
      expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
        homeRevision: record.homeRevision,
      });
      expect(readFinished).toBe(false);
      expect(published).toBe(false);
      resume();

      expect(await failure).toMatchObject({ code: "P2028" });
      expect(["last valid home", "winner data"]).toContain(await reading);
      const revision = await saving;
      expect(await winner.readFile(id, "notes.txt", context)).toBe("winner data");
      expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
        homeRevision: revision,
      });
    } finally {
      resume();
      await failure;
    }
  });
});
