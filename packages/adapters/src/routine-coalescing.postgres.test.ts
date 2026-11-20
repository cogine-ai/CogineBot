import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { appendEvent, createDb, createGroupRepos, Prisma, sendUserMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { createJobReconciler } from "./job-reconciler.js";
import { requireRoutineTrigger } from "./native-connectors/events/store.js";
import { findPendingRoutineTick, routineTimerNonce } from "./routine-coalescing.js";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  updateScheduleFromTool,
} from "./schedule-tools.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
describePostgres("routine timer coalescing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  beforeAll(async () => {
    db = createDb(url!);
    system = db.prisma;
    await system.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    const bot = await system.bot.create({
      data: {
        spaceId,
        userId,
        name: "Timer Fixture",
        color: "slate",
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    if (!bot.thread) throw new Error("fixture thread missing");
    identity = { userId, spaceId, botId: bot.id, threadId: bot.thread.id };
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function fixture() {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "timer fixture",
        prompt: "fixture",
        authorizedInstructions: "fixture",
        crons: ["* * * * *"],
        active: true,
      },
    });
    const config = {
      ...identity,
      routineId: routine.id,
      prompt: "fixture",
      routineInstructions: routine.authorizedInstructions,
      routineSites: routine.authorizedSites,
    };
    async function create(
      tx: Prisma.TransactionClient,
      clientNonce: string | null,
      data: Partial<Prisma.RunUncheckedCreateInput> = {},
    ) {
      const task = await tx.task.create({
        data: {
          ...identity,
          prompt: config.prompt,
          routineInstructions: config.routineInstructions,
          routineSites: config.routineSites,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          ...identity,
          routineId: routine.id,
          taskId: task.id,
          trigger: "routine",
          status: "queued",
          clientNonce,
          ...data,
        },
      });
    }
    return { routine, config, create };
  }

  it("recovers an edited first occurrence after a lost enqueue receipt without firing it twice", async () => {
    const { routine } = await fixture();
    const now = new Date("2027-02-14T23:59:00Z");
    const first = new Date("2027-02-15T00:01:00Z");
    const oldDue = new Date("2027-02-15T00:00:00Z");
    await system.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: oldDue, timezone: "Asia/Taipei" },
    });
    const queued = new Map<string, BackgroundJob>();
    const enqueue = vi.fn(async (job: BackgroundJob) => {
      if (job.replaceKey) queued.set(job.replaceKey, job);
    });
    const cancel = vi.fn(async (key: string) => {
      queued.delete(key);
    });
    const deps = {
      prisma: system,
      events: { append: (event: Parameters<typeof appendEvent>[1]) => appendEvent(system, event) },
      jobs: { enqueue, cancel, close: async () => undefined },
    } as Parameters<typeof updateScheduleFromTool>[0];
    const target = { ...identity, directThread: true, routineId: routine.id };
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      enqueue.mockRejectedValueOnce(new Error("Lost enqueue reply"));
      expect(
        await updateScheduleFromTool(deps, {
          ...target,
          schedule: { startAt: "2027-02-15T08:01" },
        }),
      ).toMatchObject({
        routineId: routine.id,
        nextRunAt: first.toISOString(),
        timezone: "Asia/Taipei",
      });
      expect(
        await updateScheduleFromTool(deps, {
          ...target,
          schedule: {},
          active: false,
        }),
      ).toMatchObject({ active: false, nextRunAt: null });
      expect(cancel).toHaveBeenCalledOnce();
      expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject({
        startAt: first,
        nextRunAt: null,
      });

      enqueue.mockImplementationOnce(async (job) => {
        if (job.replaceKey) queued.set(job.replaceKey, job);
        throw new Error("Lost resume enqueue reply");
      });
      expect(
        await updateScheduleFromTool(deps, {
          ...target,
          schedule: {},
          active: true,
        }),
      ).toMatchObject({ active: true, nextRunAt: first.toISOString() });
      enqueue.mockClear();
      vi.setSystemTime(new Date(first.getTime() - 30_000));
      await createJobReconciler({ prisma: system, jobs: deps.jobs }).reconcileOnce();
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: first.toISOString() },
        }),
      );
      expect([...queued.values()]).toEqual([
        expect.objectContaining({
          payload: { routineId: routine.id, scheduledFor: first.toISOString() },
        }),
      ]);
      const wakeups = createRunExecutor({
        prisma: system,
        jobs: deps.jobs,
        events: {
          append: (event: Parameters<typeof appendEvent>[1]) => appendEvent(system, event),
        },
      } as Parameters<typeof createRunExecutor>[0]);
      vi.setSystemTime(first);
      await wakeups.wakeRoutine(routine.id, oldDue.toISOString());
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
      await wakeups.wakeRoutine(routine.id, first.toISOString());
      await wakeups.wakeRoutine(routine.id, first.toISOString());
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
      const updated = await updateScheduleFromTool(deps, {
        ...target,
        prompt: "Revised fixture",
        schedule: {},
      });
      expect(updated).toMatchObject({
        nextRunAt: "2027-02-15T00:02:00.000Z",
      });
      expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject({
        prompt: "Revised fixture",
        authorizedInstructions: null,
        authorizedSites: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes duplicate admission and binds group edits to the original thread and owner", async () => {
    async function groupThread(name: string) {
      const group = await system.chatGroup.create({
        data: { spaceId, userId, name, thread: { create: { spaceId, userId } } },
        include: { thread: true },
      });
      if (!group.thread) throw new Error("fixture group thread missing");
      return group.thread;
    }
    const origin = await groupThread("Original");
    const other = await groupThread("Other");
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const deps = {
      prisma: system,
      jobs,
      events: { append: (event: Parameters<typeof appendEvent>[1]) => appendEvent(system, event) },
    } as Parameters<typeof createScheduleFromTool>[0];
    const input = {
      ...identity,
      threadId: origin.id,
      name: "Concurrent check",
      prompt: "Report status",
      schedule: { cron: "0 9 * * *" },
    };
    const [first, second] = await Promise.all([
      createScheduleFromTool(deps, input),
      createScheduleFromTool(deps, { ...input, name: " concurrent CHECK " }),
    ]);
    expect([first, second].filter((result) => "ok" in result)).toHaveLength(1);
    expect([first, second].find((result) => "error" in result)?.error).toContain("name");
    const row = await system.routine.findFirstOrThrow({
      where: { spaceId, botId: identity.botId, name: { equals: input.name, mode: "insensitive" } },
    });
    const target = {
      ...identity,
      threadId: origin.id,
      directThread: false,
      routineId: row.id,
      schedule: {},
      name: "Updated check",
    };
    for (const input of [
      { ...target, threadId: other.id },
      { ...target, userId: randomUUID() },
      { ...target, threadId: other.id, directThread: true },
    ]) {
      expect(await updateScheduleFromTool(deps, input)).toEqual({
        error: "Schedule not found in this conversation.",
      });
    }
    expect(await updateScheduleFromTool(deps, target)).toMatchObject({
      routineId: row.id,
      name: "Updated check",
    });
    expect(
      await cancelScheduleFromTool(deps, {
        ...identity,
        directThread: true,
        nameThreadId: identity.threadId,
        name: "Updated check",
      }),
    ).toEqual({ error: "Schedule not found." });
    expect(await system.routine.count({ where: { id: row.id } })).toBe(1);
    expect(jobs.enqueue).toHaveBeenCalledOnce();
  });

  it.each(["schedule", "prompt"] as const)(
    "keeps worker progress when the %s update follows a concurrent timer claim",
    async (kind) => {
      const { routine } = await fixture();
      const due = new Date("2027-02-15T09:00:00Z");
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: due } });
      const jobs = {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: async () => undefined,
      };
      const events = {
        append: (event: Parameters<typeof appendEvent>[1]) => appendEvent(system, event),
      };
      const executor = createRunExecutor({ prisma: system, jobs, events } as unknown as Parameters<
        typeof createRunExecutor
      >[0]);
      let signalRead!: () => void;
      let signalClaim!: () => void;
      const read = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      const claimed = new Promise<void>((resolve) => {
        signalClaim = resolve;
      });
      // Yield after the editor has read the old occurrence so the real worker can claim it.
      const prisma = {
        routine: {
          findFirst: async (args: Prisma.RoutineFindFirstArgs) => {
            const before = await system.routine.findFirst(args);
            signalRead();
            await claimed;
            return before;
          },
        },
        $transaction: system.$transaction.bind(system),
      } as unknown as PrismaClient;
      vi.useFakeTimers({ toFake: ["Date"], now: due });
      try {
        const update = updateScheduleFromTool(
          { prisma, jobs, events },
          {
            ...identity,
            routineId: routine.id,
            ...(kind === "prompt"
              ? { prompt: "Revised fixture", schedule: {} }
              : { schedule: { cron: "0 10 * * *" } }),
          },
        );
        await read;
        try {
          await executor.wakeRoutine(routine.id, due.toISOString());
        } finally {
          signalClaim();
        }
        const saved = await update;
        if (kind === "schedule")
          expect(saved).toMatchObject({ error: expect.stringContaining("changed") });
        else expect(saved).toMatchObject({ ok: true, nextRunAt: "2027-02-15T09:01:00.000Z" });
        expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
        expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject(
          { nextRunAt: new Date("2027-02-15T09:01:00Z") },
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["archive", "remove bot", "dissolve"] as const)(
    "does not route an existing group schedule to the DM after %s",
    async (change) => {
      const group = await system.chatGroup.create({
        data: {
          spaceId,
          userId,
          name: "Source group",
          thread: { create: { spaceId, userId } },
          members: { create: { botId: identity.botId } },
        },
        include: { thread: true },
      });
      const { routine } = await fixture();
      const due = new Date(Date.now() - 1_000);
      await system.routine.update({
        where: { id: routine.id },
        data: { threadId: group.thread!.id, groupScoped: true, nextRunAt: due },
      });
      if (change === "archive")
        await system.chatGroup.update({
          where: { id: group.id },
          data: { archivedAt: new Date() },
        });
      if (change === "remove bot")
        await system.chatGroupMember.deleteMany({ where: { groupId: group.id } });
      if (change === "dissolve") {
        await createGroupRepos(system).removeGroup(
          {
            spaceId,
            userId,
            email: "actor@example.test",
            isDeploymentOwner: false,
          },
          group.id,
        );
        expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject(
          { threadId: null, groupScoped: true, active: false, nextRunAt: null },
        );
      }
      const enqueue = vi.fn(async () => undefined);
      const executor = createRunExecutor({
        prisma: system,
        jobs: { enqueue },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await executor.wakeRoutine(routine.id, due.toISOString());
      expect(enqueue).not.toHaveBeenCalled();
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(0);
      expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject({
        active: false,
        nextRunAt: null,
      });
    },
  );

  it("requires a runnable trigger before an old group Routine can become active", async () => {
    const { routine } = await fixture();
    await system.routine.update({
      where: { id: routine.id },
      data: { groupScoped: true, crons: [], webhookEnabled: true },
    });
    await expect(requireRoutineTrigger(system, identity, routine.id)).rejects.toThrow(
      "Add a schedule or application event before resuming.",
    );
    await system.routine.update({ where: { id: routine.id }, data: { active: false } });
    await expect(requireRoutineTrigger(system, identity, routine.id)).resolves.toBeUndefined();
  });

  it("refreshes a group routine's editor without sending the group run to the direct thread", async () => {
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Scheduled group",
        thread: { create: { spaceId, userId } },
        members: { create: { botId: identity.botId } },
      },
      include: { thread: true },
    });
    const threadId = group.thread!.id;
    const due = new Date(Date.now() - 1_000);
    const { routine } = await fixture();
    await system.routine.update({
      where: { id: routine.id },
      data: { threadId, groupScoped: true, nextRunAt: due },
    });
    const append = vi.fn((input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input));
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const executor = createRunExecutor({
      prisma: system,
      jobs,
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.wakeRoutine(routine.id, due.toISOString());
    const run = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    expect(run.threadId).toBe(threadId);
    expect(append.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ threadId, type: "routine.fired", runId: run.id }),
      {
        spaceId,
        botId: identity.botId,
        threadId: identity.threadId,
        type: "routine.updated",
        payload: { routineId: routine.id, active: true },
      },
    ]);
  });

  it("serializes a group timer claim with archive and keeps the schedule paused after restore", async () => {
    const group = await system.chatGroup.create({
      data: {
        spaceId,
        userId,
        name: "Scheduled group",
        thread: { create: { spaceId, userId } },
        members: { create: { botId: identity.botId } },
      },
      include: { thread: true },
    });
    const { routine } = await fixture();
    const due = new Date(Date.now() - 1000);
    await system.routine.update({
      where: { id: routine.id },
      data: { threadId: group.thread!.id, groupScoped: true, webhookEnabled: true, nextRunAt: due },
    });
    await expect(
      sendUserMessage(system, {
        ...identity,
        blocks: [{ kind: "text", text: "Inbound fixture" }],
        prompt: routine.prompt,
        trigger: "webhook",
        routineSources: {
          trigger: "webhook",
          routines: [{ id: routine.id, prompt: routine.prompt }],
        },
      }),
    ).rejects.toThrow("Routine source conversation changed.");
    expect(
      await system.run.count({ where: { threadId: identity.threadId, trigger: "webhook" } }),
    ).toBe(0);
    let signalTask!: () => void;
    let releaseTask!: () => void;
    const atTask = new Promise<void>((resolve) => {
      signalTask = resolve;
    });
    const mayCreate = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const prisma = new Proxy(system, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key, target);
        return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            work(
              new Proxy(tx, {
                get(transaction, property) {
                  if (property !== "task") return Reflect.get(transaction, property, transaction);
                  return {
                    create: async (args: Prisma.TaskCreateArgs) => {
                      signalTask();
                      await mayCreate;
                      return tx.task.create(args);
                    },
                  };
                },
              }),
            ),
          );
      },
    });
    const events = {
      append: (event: Parameters<typeof appendEvent>[1]) => appendEvent(system, event),
    };
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const wake = createRunExecutor({ prisma, events, jobs } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);
    const firing = wake.wakeRoutine(routine.id, due.toISOString());
    await atTask;
    const repos = createGroupRepos(system);
    const actor = { spaceId, userId, email: "actor@example.test", isDeploymentOwner: false };
    let archiving: ReturnType<typeof repos.archiveGroup> | undefined;
    try {
      await expect(
        system.$queryRaw`SELECT id FROM chat_groups WHERE id=${group.id} FOR UPDATE NOWAIT`,
      ).rejects.toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      });
      archiving = repos.archiveGroup(actor, group.id);
    } finally {
      releaseTask();
      await firing;
    }
    await archiving;
    const run = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    expect(run.status).toBe("cancelled");
    const resume = {
      ...identity,
      threadId: group.thread!.id,
      routineId: routine.id,
      active: true,
      schedule: {},
    };
    expect(await updateScheduleFromTool({ prisma: system, events, jobs }, resume)).toEqual({
      error: "The original conversation is no longer available.",
    });
    await repos.restoreGroup(actor, group.id);
    expect(await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).toMatchObject({
      active: false,
      nextRunAt: null,
    });
    await wake.wakeRoutine(routine.id, due.toISOString());
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });

  it("serializes concurrent ticks into one pending catch-up", async () => {
    const { routine, config, create } = await fixture();
    const tick = (index: number) =>
      system.$transaction(async (tx) => {
        await tx.routine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
        return (
          (await findPendingRoutineTick(tx, config)) ??
          create(tx, routineTimerNonce(routine.id, `tick-${index}`))
        );
      });
    const results = await Promise.all([tick(1), tick(2)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });

  it.each(["pause", "delete", "reschedule"] as const)(
    "rejects a worker's stale tick when %s commits after its first read",
    async (change) => {
      const { routine } = await fixture();
      const dueAt = new Date(Date.now() - 60_000);
      const newDueAt = new Date(dueAt.getTime() + 1_000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
      let observed = false;
      const prisma = system.$extends({
        query: {
          routine: {
            async findUnique({ args, query }) {
              const read = await query(args);
              if (observed || args.where.id !== routine.id) return read;
              observed = true;
              expect(read).toMatchObject({ active: true, nextRunAt: dueAt });
              if (change === "delete") await system.routine.delete({ where: { id: routine.id } });
              else {
                await system.routine.update({
                  where: { id: routine.id },
                  data:
                    change === "pause"
                      ? { active: false, nextRunAt: null }
                      : {
                          nextRunAt: newDueAt,
                          prompt: "Use the updated instructions",
                          authorizedInstructions: "Use the updated instructions",
                        },
                });
              }
              return read;
            },
          },
        },
      }) as PrismaClient;
      const executor = createRunExecutor({
        prisma,
        secrets: [],
        jobs,
        events: {
          append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
          notify: async () => undefined,
        },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      expect(observed).toBe(true);
      expect(jobs.enqueue).not.toHaveBeenCalled();
      expect(
        await system.run.count({
          where: { spaceId, clientNonce: routineTimerNonce(routine.id, dueAt.toISOString()) },
        }),
      ).toBe(0);
      if (change !== "reschedule") return;

      await executor.wakeRoutine(routine.id, newDueAt.toISOString());
      const current = await system.run.findFirstOrThrow({
        where: { routineId: routine.id },
        include: { task: true },
      });
      expect(current.task).toMatchObject({
        prompt: "Use the updated instructions",
        routineInstructions: "Use the updated instructions",
      });
      expect(current.clientNonce).toBe(routineTimerNonce(routine.id, newDueAt.toISOString()));
    },
  );
  it.each([
    { routineInstructions: "different owner instructions" },
    { routineInstructions: null },
    { routineSites: ["example.com"] },
  ])(
    "preserves pending work with the same execution prompt and different authorization %j",
    async (data) => {
      const { routine, config, create } = await fixture();
      const previous = await system.$transaction(async (tx) => {
        const run = await create(tx, routineTimerNonce(routine.id, "2026-01-01T00:00:00Z"));
        await tx.task.update({ where: { id: run.taskId }, data });
        return run;
      });
      expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
      expect(await system.run.findUnique({ where: { id: previous.id } })).toMatchObject({
        status: "queued",
      });
    },
  );
  it("preserves ambiguous legacy runs even with scheduled firing events", async () => {
    const { config, create } = await fixture();
    const legacy = await system.$transaction((tx) => create(tx, null));
    await appendEvent(system, {
      spaceId: identity.spaceId,
      threadId: identity.threadId,
      botId: identity.botId,
      type: "routine.fired",
      runId: legacy.id,
      payload: { routineId: config.routineId, scheduledFor: "2026-01-01T00:00:00Z" },
    });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    expect(await system.run.findUnique({ where: { id: legacy.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("preserves a queued one-shot when its routine is edited into a recurring timer", async () => {
    const { routine, create } = await fixture();
    const scheduledAt = new Date(Date.now() - 1_000);
    await system.routine.update({
      where: { id: routine.id },
      data: {
        crons: [ONCE_ROUTINE_CRON],
        nextRunAt: scheduledAt,
      },
    });
    const executor = createRunExecutor({
      prisma: system,
      secrets: [],
      jobs: {
        enqueue: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.wakeRoutine(routine.id, scheduledAt.toISOString());
    const oneShot = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    expect(oneShot.clientNonce).toBeNull();
    let duplicateId: string | null = null;
    for (let tick = 0; tick < 3; tick++) {
      const dueAt = new Date(scheduledAt.getTime() + tick);
      await system.routine.update({
        where: { id: routine.id },
        data: {
          crons: ["* * * * *"],
          active: true,
          nextRunAt: dueAt,
        },
      });
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      if (tick === 0) {
        const duplicate = await system.$transaction((tx) =>
          create(tx, routineTimerNonce(routine.id, "duplicate")),
        );
        duplicateId = duplicate.id;
      }
    }
    expect(await system.run.findUnique({ where: { id: oneShot.id } })).toMatchObject({
      status: "queued",
    });
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(3);
    expect(await system.run.findUnique({ where: { id: duplicateId! } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await system.run.count({
        where: {
          routineId: routine.id,
          status: "queued",
          clientNonce: { startsWith: `routine-timer:${routine.id}:` },
        },
      }),
    ).toBe(1);
    expect(await system.event.count({ where: { runId: oneShot.id, type: "run.cancelled" } })).toBe(
      0,
    );
  });
  it("keeps an existing busy-computer delay on a reused run", async () => {
    const { config, create, routine } = await fixture();
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "tick")),
    );
    const wakeAt = new Date(Date.now() + 60_000);
    const updated = await system.run.update({ where: { id: pending.id }, data: { wakeAt } });
    await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      wakeAt,
      updatedAt: updated.updatedAt,
    });
  });
  it.each([
    { saved: "credential-a", requested: "credential-b" },
    { saved: null, requested: "credential-a" },
    { saved: "credential-a", requested: null },
  ])(
    "preserves work pinned to credential $saved when the current choice is $requested",
    async ({ saved, requested }) => {
      const { config, create, routine } = await fixture();
      const pin = {
        modelProvider: "fixture",
        modelId: "fixture-model",
        modelPinned: true as const,
      };
      const pending = await system.$transaction((tx) =>
        create(tx, routineTimerNonce(routine.id, "pinned"), { ...pin, modelCredentialId: saved }),
      );
      expect(
        await system.$transaction((tx) =>
          findPendingRoutineTick(tx, { ...config, ...pin, modelCredentialId: requested }),
        ),
      ).toBeNull();
      expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
      expect(await system.task.findUniqueOrThrow({ where: { id: pending.taskId } })).toMatchObject({
        status: "queued",
      });
      expect(
        await system.event.count({ where: { runId: pending.id, type: "run.cancelled" } }),
      ).toBe(0);
    },
  );
  it("reuses only the pending run pinned to the same credential without rebinding its siblings", async () => {
    const { config, create, routine } = await fixture();
    const pin = { modelProvider: "fixture", modelId: "fixture-model", modelPinned: true as const };
    const other = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "other"), {
        ...pin,
        modelCredentialId: "credential-a",
      }),
    );
    const matching = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "matching"), {
        ...pin,
        modelCredentialId: "credential-b",
      }),
    );
    expect(
      await system.$transaction((tx) =>
        findPendingRoutineTick(tx, { ...config, ...pin, modelCredentialId: "credential-b" }),
      ),
    ).toMatchObject({ id: matching.id });
    expect(await system.run.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other);
    expect(await system.run.findUniqueOrThrow({ where: { id: matching.id } })).toEqual(matching);
  });
  it.each([
    { label: "a saved continuation", value: { version: 1 } },
    { label: "JSON null", value: Prisma.JsonNull },
  ])("preserves a Scripted state containing $label", async ({ value }) => {
    const { config, create, routine } = await fixture();
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "scripted"), { scriptedState: value }),
    );
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
    expect(await system.event.count({ where: { runId: pending.id, type: "run.cancelled" } })).toBe(
      0,
    );
  });
  it("preserves a private saved turn as existing work", async () => {
    const { config, create, routine } = await fixture();
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "checkpoint")),
    );
    const checkpoint = await system.externalEffect.create({
      data: {
        runId: pending.id,
        spaceId,
        idempotencyKey: JSON.stringify(["runtime_checkpoint", pending.id]),
        kind: "runtime_checkpoint",
        status: "runtime_checkpoint",
        request: {},
        result: "saved-private-turn",
      },
    });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
    expect(await system.externalEffect.findUniqueOrThrow({ where: { id: checkpoint.id } })).toEqual(
      checkpoint,
    );
  });
  it.each(["execution", "control"])(
    "preserves a run with live computer %s ownership",
    async (kind) => {
      const { config, create, routine } = await fixture();
      const pending = await system.$transaction((tx) =>
        create(tx, routineTimerNonce(routine.id, "owned")),
      );
      const computer = await system.computer.create({
        data: {
          spaceId,
          userId,
          scopeKey: randomUUID(),
          homeKey: randomUUID(),
          kind: "fake",
          ...(kind === "control" ? { controlRunId: pending.id } : {}),
        },
      });
      if (kind === "execution") {
        await system.computerExecutionLease.create({
          data: {
            computerId: computer.id,
            botId: identity.botId,
            runId: pending.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      }
      expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
      expect(await system.run.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
      expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toEqual(
        computer,
      );
    },
  );
  it("cancels redundant recurring ticks without touching an actual attempt", async () => {
    const { config, create, routine } = await fixture();
    const older = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "older")),
    );
    const duplicate = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "duplicate")),
    );
    const attempted = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "attempted")),
    );
    await system.attempt.create({ data: { runId: attempted.id, fence: 1, status: "running" } });
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.id).toBe(older.id);
    expect(reused?.cancelledEvents).toHaveLength(1);
    expect(await system.run.findUnique({ where: { id: duplicate.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.task.findUnique({ where: { id: duplicate.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await system.event.count({ where: { runId: duplicate.id, type: "run.cancelled" } }),
    ).toBe(1);
    expect(await system.run.findUnique({ where: { id: attempted.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("drains a bounded recurring batch within the default transaction deadline", async () => {
    const { routine, config } = await fixture();
    const rows = Array.from({ length: 100 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
    await system.task.createMany({
      data: rows.map(({ taskId }) => ({
        ...identity,
        id: taskId,
        status: "queued",
        prompt: config.prompt,
        routineInstructions: config.routineInstructions,
        routineSites: config.routineSites,
      })),
    });
    await system.run.createMany({
      data: rows.map(({ id, taskId }, index) => ({
        ...identity,
        id,
        taskId,
        routineId: routine.id,
        trigger: "routine",
        status: "queued",
        clientNonce: routineTimerNonce(routine.id, `tick-${index}`),
      })),
    });
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.cancelledEvents).toHaveLength(99);
    expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(1);
    expect(await system.run.count({ where: { routineId: routine.id, status: "cancelled" } })).toBe(
      99,
    );
  });
  it("finds pending recurring work behind over a page of ambiguous legacy rows", async () => {
    const { routine, config, create } = await fixture();
    const rows = Array.from({ length: 120 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
    await system.task.createMany({
      data: rows.map(({ taskId }) => ({
        ...identity,
        id: taskId,
        status: "queued",
        prompt: "fixture",
      })),
    });
    await system.run.createMany({
      data: rows.map(({ id, taskId }) => ({
        ...identity,
        id,
        taskId,
        routineId: routine.id,
        trigger: "routine",
        status: "queued",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "tick")),
    );
    for (let tick = 0; tick < 3; tick++) {
      expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toMatchObject({
        id: pending.id,
      });
    }
    expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(
      121,
    );
    expect(await system.run.count({ where: { routineId: routine.id, status: "cancelled" } })).toBe(
      0,
    );
  });
  it.each(["leased", "completed"])(
    "preserves an already %s run when its publication rejects",
    async (status) => {
      const { routine } = await fixture();
      const dueAt = new Date(Date.now() - 1_000);
      await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
      const published: string[] = [];
      const executor = createRunExecutor({
        prisma: system,
        secrets: [],
        jobs: {
          enqueue: async (job: BackgroundJob) => {
            published.push(job.name);
            if (job.name !== "run.continue") return;
            // Emulate the independent dispatcher winning before notification fails.
            const dispatched = await system.run.update({
              where: { id: job.payload.runId },
              data: {
                status,
                leaseFence: 1,
                ...(status === "leased"
                  ? { leaseOwner: "fixture-worker" }
                  : { completedAt: new Date() }),
              },
            });
            if (status === "completed") {
              await system.task.update({
                where: { id: dispatched.taskId },
                data: { status: "completed" },
              });
            }
            throw new Error("notification failed after dispatch");
          },
          cancel: async () => undefined,
          close: async () => undefined,
        },
        events: {
          append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
          notify: async () => undefined,
        },
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      const surviving = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
      expect(surviving.status).toBe(status);
      expect(await system.task.findUnique({ where: { id: surviving.taskId } })).toMatchObject({
        status: status === "completed" ? "completed" : "queued",
        routineInstructions: routine.authorizedInstructions,
        routineSites: routine.authorizedSites,
      });
      expect(
        (
          await system.routine.findUniqueOrThrow({ where: { id: routine.id } })
        ).nextRunAt!.getTime(),
      ).toBeGreaterThan(dueAt.getTime());
      expect(published).toEqual(["run.continue", "routine.wakeup"]);
      // Retrying the original occurrence is now a safe no-op, not a nonce conflict.
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
    },
  );
  it("preserves work reused by a later tick before the original publication rejects", async () => {
    const { routine } = await fixture();
    const dueAt = new Date(Date.now() - 1_000);
    await system.routine.update({ where: { id: routine.id }, data: { nextRunAt: dueAt } });
    const clock = vi.spyOn(Date, "now");
    let laterTickFired = false;
    let advancedSchedule: Date | null = null;
    let reusedId: string | null = null;
    let executor: ReturnType<typeof createRunExecutor>;
    executor = createRunExecutor({
      prisma: system,
      secrets: [],
      jobs: {
        enqueue: async (job: BackgroundJob) => {
          if (job.name !== "run.continue" || laterTickFired) return;
          reusedId = job.payload.runId;
          laterTickFired = true;
          const afterFirstTick = await system.routine.findUniqueOrThrow({
            where: { id: routine.id },
          });
          // The first publication stalls until the next natural occurrence is due.
          clock.mockReturnValue(afterFirstTick.nextRunAt!.getTime() + 1_000);
          await executor.wakeRoutine(routine.id, afterFirstTick.nextRunAt!.toISOString());
          advancedSchedule = (await system.routine.findUniqueOrThrow({ where: { id: routine.id } }))
            .nextRunAt;
          throw new Error("first publication failed after catch-up reuse");
        },
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    try {
      await executor.wakeRoutine(routine.id, dueAt.toISOString());
      expect(laterTickFired).toBe(true);
      const surviving = await system.run.findUniqueOrThrow({ where: { id: reusedId! } });
      expect(surviving).toMatchObject({ status: "queued", leaseFence: 0 });
      expect(await system.task.findUnique({ where: { id: surviving.taskId } })).toMatchObject({
        status: "queued",
      });
      expect(
        (await system.routine.findUniqueOrThrow({ where: { id: routine.id } })).nextRunAt,
      ).toEqual(advancedSchedule);
      expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
