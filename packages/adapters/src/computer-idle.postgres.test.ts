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
import { SandboxRateLimitError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { clearThread, createDb, createThreadEvents } from "@rakazo/db";
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
        controlLeaseExpiresAt: new Date("2000-01-01"),
        controlBotId: null,
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

  it("does not touch a workspace while the user still controls its computer", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { controlBotId: "active-viewer", controlLeaseExpiresAt: new Date("2100-01-01") },
    });
    await sleepComputerIfIdle(deps, computerId);
    expect(clearCounts).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
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
      controlLeaseExpiresAt: new Date("2000-01-01"),
      controlBotId: null,
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

  it.each([false, true])(
    "settles a parked takeover at the limit only while it stays parked (resumed=%s)",
    async (resumed) => {
      const { id, homeRevision } = await seed();
      const prisma = database.prisma;
      const runningSince = new Date(Date.now() - 3 * 60 * 60_000);
      await prisma.computer.update({ where: { id }, data: { runningSince } });
      await prisma.computerExecutionLease.deleteMany({ where: { computerId: id } });
      const owner = { userId: context.userId, spaceId };
      const bot = await prisma.bot.create({
        data: {
          ...owner,
          computerId: id,
          name: "Parked Bot",
          color: "slate",
          thread: { create: owner },
        },
        include: { thread: true },
      });
      const task = await prisma.task.create({
        data: {
          ...owner,
          botId: bot.id,
          threadId: bot.thread!.id,
          prompt: "Synthetic work",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          ...owner,
          botId: bot.id,
          threadId: bot.thread!.id,
          taskId: task.id,
          status: "waiting_takeover",
          trigger: "chat",
        },
      });
      const lease = await prisma.computerExecutionLease.create({
        data: {
          computerId: id,
          botId: bot.id,
          runId: run.id,
          fence: 7,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      if (!resumed) {
        const waitingInput = await prisma.run.create({
          data: {
            ...owner,
            botId: bot.id,
            threadId: bot.thread!.id,
            taskId: task.id,
            status: "waiting_input",
            trigger: "chat",
          },
        });
        await prisma.computer.update({ where: { id }, data: { executionRunId: waitingInput.id } });
      }
      let running = true;
      const stop = vi.fn(async () => {
        running = false;
      });
      const sandbox = {
        billsWhileRunning: () => true,
        inspectPowerState: async () => (running ? "running" : "stopped"),
        inspectBackgroundWork: vi.fn().mockResolvedValue("active"),
        async *exportWorkspace() {
          yield { path: "notes.txt", content: Buffer.from("workspace after the wait") };
          if (resumed) {
            await prisma.run.update({
              where: { id: run.id },
              data: {
                status: "running",
                leaseOwner: "synthetic-worker",
                leaseExpiresAt: new Date(Date.now() + 60_000),
              },
            });
          }
        },
        stop,
      } as unknown as SandboxProvider;
      await sleepComputerIfIdle(
        {
          prisma,
          home,
          sandbox,
          events: createThreadEvents(prisma),
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher,
        },
        id,
        runningSince.toISOString(),
      );
      const state = await prisma.computer.findUniqueOrThrow({ where: { id } });
      expect(state.state).toBe(resumed ? "running" : "suspended");
      expect(state.suspensionReason).toBe(resumed ? null : "active_limit");
      expect(state.runningSince).toEqual(resumed ? runningSince : null);
      expect(state.executionRunId).toBeNull();
      expect(state.homeRevision).not.toBe(homeRevision);
      expect(await home.readFile(id, "notes.txt", context)).toBe("workspace after the wait");
      expect(stop).toHaveBeenCalledTimes(resumed ? 0 : 1);
      expect(sandbox.inspectBackgroundWork).not.toHaveBeenCalled();
      expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: resumed ? "running" : "waiting_takeover",
      });
      expect(
        await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } }),
      ).toMatchObject({
        fence: 7,
        expiresAt: resumed ? lease.expiresAt : new Date(0),
      });
    },
  );

  it("publishes completed files and written bytes during a claimed save without changing its stamp", async () => {
    const { id, record, ref } = await seed();
    const prisma = database.prisma;
    const claimed = await prisma.computer.update({
      where: { id },
      data: { state: "suspending" },
    });
    const bot = await prisma.bot.create({
      data: {
        spaceId,
        userId: context.userId,
        computerId: id,
        name: "Progress test",
        color: "slate",
        thread: { create: { spaceId, userId: context.userId } },
      },
      include: { thread: true },
    });
    const groups = await Promise.all(
      [false, true].map((archived) =>
        prisma.chatGroup.create({
          data: {
            spaceId,
            userId: context.userId,
            name: "Progress group",
            archivedAt: archived ? new Date() : null,
            members: { create: { botId: bot.id } },
            thread: { create: { spaceId, userId: context.userId } },
          },
          include: { thread: true },
        }),
      ),
    );
    const events = createThreadEvents(prisma);
    const sandbox = {
      async *exportWorkspace() {
        const initial = await prisma.computer.findUniqueOrThrow({ where: { id } });
        expect(initial.workspaceSaveProgress).toMatchObject({ progress: { files: 0, bytes: 0 } });
        yield { path: "empty.txt", content: Buffer.alloc(0) };
        yield {
          path: "notes.txt",
          body: (async function* () {
            await delay(1100);
            yield Buffer.from("abc");
            const partial = await prisma.computer.findUniqueOrThrow({ where: { id } });
            expect(partial.updatedAt).toEqual(claimed.updatedAt);
            expect(partial.workspaceSaveProgress).toMatchObject({
              claimAt: claimed.updatedAt.toISOString(),
              progress: { files: 1, bytes: 3 },
            });
            yield Buffer.from("de");
          })(),
        };
      },
    } as unknown as SandboxProvider;
    const revision = await checkpointAndRecordComputerWorkspace(
      { prisma, home, sandbox, events },
      record,
      ref,
      context,
      { claim: { state: "suspending", updatedAt: claimed.updatedAt } },
    );
    expect(await home.readFile(id, "notes.txt", context)).toBe("abcde");
    for (const thread of [bot.thread, groups[0]!.thread, groups[1]!.thread]) {
      expect(
        await prisma.event.findMany({
          where: { threadId: thread!.id, type: "computer.status" },
          select: { botId: true, payload: true },
        }),
      ).toEqual(
        thread?.id === groups[1]!.thread?.id
          ? []
          : [
              { botId: bot.id, payload: { workspaceSaveChanged: true } },
              { botId: bot.id, payload: { workspaceSaveChanged: true } },
            ],
      );
    }
    expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      homeRevision: revision,
      updatedAt: claimed.updatedAt,
      workspaceSaveProgress: null,
      workspaceSaveFailure: null,
    });
  });

  it("classifies an in-place revision failure as storage without fabricating copied bytes", async () => {
    const { id, record, ref, homeRevision } = await seed();
    const prisma = database.prisma;
    const claimed = await prisma.computer.update({
      where: { id },
      data: { kind: "docker", state: "suspending" },
    });
    const error = new Error("synthetic revision failure");
    const revise = vi.spyOn(home, "revise").mockImplementationOnce(async () => {
      const current = await prisma.computer.findUniqueOrThrow({ where: { id } });
      expect(current.workspaceSaveProgress).toMatchObject({ progress: null });
      throw error;
    });
    try {
      await expect(
        checkpointAndRecordComputerWorkspace(
          { prisma, home, sandbox: {} as SandboxProvider, events: createThreadEvents(prisma) },
          record,
          { ...ref, kind: "docker" },
          context,
          { claim: { state: "suspending", updatedAt: claimed.updatedAt } },
        ),
      ).rejects.toBe(error);
    } finally {
      revise.mockRestore();
    }
    expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      homeRevision,
      workspaceSaveProgress: null,
      workspaceSaveFailure: { reason: "storage_failed" },
    });
  });

  it("deduplicates a failure across retries and reasons until a successful save", async () => {
    const { id, record, ref, homeRevision } = await seed();
    const prisma = database.prisma;
    const addLinkedBot = () =>
      prisma.bot.create({
        data: {
          spaceId,
          userId: context.userId,
          computerId: id,
          name: "Save test",
          color: "slate",
          thread: { create: { spaceId, userId: context.userId } },
        },
        include: { thread: true },
      });
    const bot = await addLinkedBot();
    const threadId = bot.thread!.id;
    const events = createThreadEvents(prisma);
    const fail = (error: Error, sink?: ThreadEvents) =>
      checkpointAndRecordComputerWorkspace(
        {
          prisma,
          home,
          events: sink,
          sandbox: {
            async *exportWorkspace() {
              yield await Promise.reject(error);
            },
          } as unknown as SandboxProvider,
        },
        record,
        ref,
        context,
      );
    const rateLimited = new SandboxRateLimitError();
    await expect(fail(rateLimited)).rejects.toBe(rateLimited);
    const beforeEvents = await prisma.computer.findUniqueOrThrow({ where: { id } });
    expect(beforeEvents.workspaceSaveFailure).toMatchObject({
      reason: "rate_limited",
      notifiedThreadIds: [],
    });
    expect(await prisma.message.count({ where: { threadId, role: "system" } })).toBe(0);

    await Promise.all([
      expect(fail(rateLimited, events)).rejects.toBe(rateLimited),
      expect(fail(rateLimited, events)).rejects.toBe(rateLimited),
    ]);
    const limit = new WorkspaceTooLargeError("files");
    await expect(fail(limit, events)).rejects.toBe(limit);
    const newlyLinked = await addLinkedBot();
    await expect(fail(limit, events)).rejects.toBe(limit);
    const notices = (target = threadId) =>
      prisma.message.findMany({
        where: { threadId: target, role: "system" },
        orderBy: { seq: "asc" },
      });
    expect(await notices()).toMatchObject([
      { clientNonce: (beforeEvents.workspaceSaveFailure as { nonce: string }).nonce },
    ]);
    expect(await notices(newlyLinked.thread!.id)).toMatchObject([
      { clientNonce: (await notices())[0]!.clientNonce },
    ]);
    expect(await prisma.event.count({ where: { threadId, type: "thread.message.created" } })).toBe(
      1,
    );
    expect(await prisma.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      homeRevision,
      workspaceSaveFailure: { reason: "too_many_files" },
    });
    expect(await home.readFile(id, "notes.txt", context)).toBe("last valid home");

    await clearThread(prisma, { spaceId, threadId, botId: bot.id });
    expect(await notices()).toHaveLength(0);
    await expect(fail(limit, events)).rejects.toBe(limit);
    expect(await notices()).toHaveLength(0);
    const previousNonce = (await notices(newlyLinked.thread!.id))[0]!.clientNonce;

    await checkpointAndRecordComputerWorkspace(
      {
        prisma,
        home,
        events,
        sandbox: {
          async *exportWorkspace() {
            yield { path: "notes.txt", content: Buffer.from("new save") };
          },
        } as unknown as SandboxProvider,
      },
      record,
      ref,
      context,
    );
    expect(
      (await prisma.computer.findUniqueOrThrow({ where: { id } })).workspaceSaveFailure,
    ).toBeNull();
    await expect(fail(limit, events)).rejects.toBe(limit);
    const after = await notices();
    expect(after).toHaveLength(1);
    expect(after[0]!.clientNonce).not.toBe(previousNonce);
    expect(await notices(newlyLinked.thread!.id)).toHaveLength(2);
    expect(await home.readFile(id, "notes.txt", context)).toBe("new save");
  });

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
    const profileOnlyId = "旧-bot-profile";
    const foreignId = "another-space-bot";
    const foreignSpaceId = `other-${spaceId}`;
    const tombstone = (botId: string, tenantId = spaceId) => ({
      id: botId,
      spaceId: tenantId,
      name: "Deleted bot",
      deletedByUserId: context.userId,
      memoriesPreserved: true,
    });
    await prisma.space.create({
      data: { id: foreignSpaceId, organizationId, name: "Other Team" },
    });
    await prisma.botDeletion.createMany({
      data: [
        ...Array.from({ length: 2_000 }, (_, index) => tombstone(`historical-${index}`)),
        tombstone(profileOnlyId),
        tombstone(foreignId, foreignSpaceId),
      ],
    });
    const deletedPaths = [
      `bots/${deletedId}/notes.txt`,
      `.browser-profiles/${teamBrowserProfileName(deletedId)}/Default/Network/Cookies`,
      `.browser-profiles/${teamBrowserProfileName(profileOnlyId)}/Local State`,
    ];
    const survivorPaths = [
      "bots/deleted-bot-other/notes.txt",
      `bots/${foreignId}/notes.txt`,
      `.browser-profiles/${teamBrowserProfileName(foreignId)}/Local State`,
    ];
    const sandbox = {
      async *exportWorkspace() {
        for (const filePath of [...deletedPaths, ...survivorPaths]) {
          yield { path: filePath, content: Buffer.from("new content") };
        }
        await prisma.botDeletion.create({ data: tombstone(deletedId) });
      },
    } as unknown as SandboxProvider;
    const discard = vi.spyOn(home, "discardStagedDirectory");
    let revision: string;
    try {
      revision = await checkpointAndRecordComputerWorkspace(
        { prisma, home, sandbox },
        record,
        ref,
        context,
      );
      expect(discard).toHaveBeenCalledTimes(deletedPaths.length);
    } finally {
      discard.mockRestore();
    }
    expect(revision).not.toBe(homeRevision);
    for (const filePath of survivorPaths) {
      expect(await home.readFile(id, filePath, context)).toBe("new content");
    }
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
