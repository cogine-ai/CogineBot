import { readFile } from "node:fs/promises";
import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  appendEventInTransaction,
  beginRoutineRetryExecution,
  claimSteering,
  finalizeRun,
} from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import { createThreadMessage } from "./messages.js";
import { claimRoutineRetry } from "./routine-retry.js";
import { loadRunProgressReset, reserveRunProgressResetInTransaction } from "./run-progress.js";
import { reserveRunSelfRecovery } from "./run-self-recovery.js";
import {
  clearRunTurnCheckpoints,
  dropRunTurnCheckpoint,
  loadRunTurnCheckpoint,
  saveRunTurnCheckpoint,
} from "./run-turn-checkpoint.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("run turn checkpoint fencing (PostgreSQL)", () => {
  const organizationId = "turn-checkpoint-organization";
  const spaceId = "turn-checkpoint-space";
  const otherSpaceId = "turn-checkpoint-other-space";
  const userId = "turn-checkpoint-user";
  const botId = "turn-checkpoint-bot";
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Checkpoint fixture", email: "checkpoint@example.test" },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Checkpoint fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: {
          create: [
            {
              id: spaceId,
              name: "Checkpoint fixture",
              bots: { create: { id: botId, userId, name: "Fixture", color: "ink" } },
            },
            { id: otherSpaceId, name: "Other checkpoint fixture" },
          ],
        },
      },
    });
    await prisma.member.create({
      data: {
        id: "turn-checkpoint-member",
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: "turn-checkpoint-space-member",
        organizationId,
        spaceId,
        userId,
        createdAt: new Date(),
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
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Checkpoint fixture", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const task = await prisma.task.create({
      data: { spaceId, botId, userId, threadId: thread.id, prompt: "fixture", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        userId,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 7, status: "running" },
    });
    return { run, thread, task, attempt };
  }

  function finishInput(f: Awaited<ReturnType<typeof seed>>) {
    return {
      runId: f.run.id,
      spaceId,
      botId,
      threadId: f.thread.id,
      taskId: f.task.id,
      attemptId: f.attempt.id,
      leaseOwner: "worker",
      leaseFence: 7,
      outcome: "completed" as const,
      blocks: [],
    };
  }

  async function seedRetry() {
    const f = await seed();
    const routine = await prisma.routine.create({
      data: {
        spaceId,
        botId,
        userId,
        name: "Retry fixture",
        prompt: "current instructions",
        crons: ["0 * * * *"],
        active: true,
        latestRunId: f.run.id,
      },
    });
    const taskSnapshot = {
      prompt: "original expanded prompt",
      routineInstructions: "authorized instructions",
      routineSites: ["https://fixture.example"],
      connectionIds: ["synthetic-selected-account"],
    };
    const pin = {
      modelPinned: true,
      modelProvider: "openai-compatible",
      modelId: "synthetic-pinned-model",
      modelCredentialId: "synthetic-pinned-credential",
      thinkingLevel: "low",
    };
    await prisma.task.update({ where: { id: f.task.id }, data: taskSnapshot });
    await prisma.run.update({
      where: { id: f.run.id },
      data: { routineId: routine.id, trigger: "routine", ...pin },
    });
    const failure = {
      ...finishInput(f),
      outcome: "failed" as const,
      error: "Provider unavailable",
      retryRoutine: true,
    };
    return { ...f, routine, failure, taskSnapshot, pin };
  }

  it("commits one retry intent with the original failure and one scoped child after its deadline", async () => {
    const f = await seedRetry();
    await expect(finalizeRun(prisma, { ...f.failure, leaseFence: 6 })).resolves.toBe(false);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
      routineRetryAt: null,
    });
    const terminal = await finalizeRun(prisma, f.failure);
    const due = terminal === false ? undefined : terminal.routineRetryAt;
    if (!due) throw new Error("Missing routine retry intent");
    const source = await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(source).toMatchObject({ status: "failed", routineRetryAt: due });
    expect(due.getTime() - source.completedAt!.getTime()).toBe(12 * 60_000);
    await expect(
      claimRoutineRetry(prisma, f.run.id, new Date(due.getTime() - 1)),
    ).resolves.toBeNull();
    const claims = await Promise.all([
      claimRoutineRetry(prisma, f.run.id, due),
      claimRoutineRetry(prisma, f.run.id, due),
    ]);
    const childId = claims.find((claim) => claim !== null)?.runId;
    expect(claims.filter(Boolean)).toHaveLength(1);
    const children = await prisma.run.findMany({
      where: { retryOfRunId: f.run.id },
      include: { task: true },
    });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: childId,
      spaceId,
      userId,
      botId,
      threadId: f.thread.id,
      routineId: f.routine.id,
      status: "queued",
      trigger: "routine",
      ...f.pin,
      task: f.taskSnapshot,
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "failed",
      routineRetryAt: null,
    });
    const child = children[0]!;
    await prisma.run.update({
      where: { id: child.id },
      data: {
        status: "running",
        leaseOwner: "retry-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const startedAt = new Date();
    await expect(
      beginRoutineRetryExecution(prisma, {
        runId: child.id,
        workerId: "retry-worker",
        fence: 1,
        startedAt,
      }),
    ).resolves.toEqual({ started: true });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      startedAt,
    });
  });

  it("discards an already scheduled retry when the Bot has left the Group", async () => {
    const f = await seedRetry();
    const terminal = await finalizeRun(prisma, f.failure);
    const due = terminal === false ? undefined : terminal.routineRetryAt;
    if (!due) throw new Error("Missing routine retry intent");
    await prisma.chatGroupMember.deleteMany({ where: { groupId: f.thread.groupId!, botId } });
    await expect(claimRoutineRetry(prisma, f.run.id, due)).resolves.toBeNull();
    expect(await prisma.run.count({ where: { retryOfRunId: f.run.id } })).toBe(0);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "failed",
      routineRetryAt: null,
    });
  });

  it.each(["Routine pause", "Group membership loss"] as const)(
    "cancels an unstarted retry after %s and continues only authorized human steering",
    async (revocation) => {
      const f = await seedRetry();
      const terminal = await finalizeRun(prisma, f.failure);
      const due = terminal === false ? undefined : terminal.routineRetryAt;
      if (!due) throw new Error("Missing routine retry intent");
      const child = await claimRoutineRetry(prisma, f.run.id, due);
      if (!child) throw new Error("Missing routine retry Run");
      await prisma.run.update({
        where: { id: child.runId },
        data: {
          status: "running",
          leaseOwner: "retry-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const message = await createThreadMessage(prisma, {
        threadId: f.thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "Handle this message instead." }],
      });
      const pending = await prisma.steeringMessage.create({
        data: { messageId: message.id, botId, userId },
      });
      const mayContinue = revocation === "Routine pause";
      if (mayContinue) {
        await prisma.routine.update({
          where: { id: f.routine.id },
          data: { active: false, nextRunAt: null, latestRunId: null, autoCompletedRunId: null },
        });
      } else {
        await prisma.chatGroupMember.deleteMany({ where: { groupId: f.thread.groupId!, botId } });
      }
      const begin = { ...child, workerId: "retry-worker", fence: 1, startedAt: new Date() };
      await expect(beginRoutineRetryExecution(prisma, { ...begin, fence: 0 })).resolves.toEqual({
        started: false,
      });
      const result = await beginRoutineRetryExecution(prisma, begin);
      expect(result).toEqual({
        started: false,
        cancellationSeq: expect.any(Number),
        ...(mayContinue ? { continuationRunId: expect.any(String) } : {}),
      });
      expect(
        await prisma.run.findUniqueOrThrow({ where: { id: child.runId }, include: { task: true } }),
      ).toMatchObject({
        status: "cancelled",
        startedAt: null,
        leaseOwner: null,
        task: { status: "cancelled" },
      });
      expect(
        await prisma.event.findMany({
          where: { runId: child.runId },
          select: { type: true, seq: true },
        }),
      ).toEqual([{ type: "run.cancelled", seq: result.cancellationSeq }]);
      const followUps = await prisma.run.findMany({
        where: { threadId: f.thread.id, trigger: "follow_up" },
      });
      expect(followUps).toHaveLength(mayContinue ? 1 : 0);
      if (mayContinue) {
        expect(followUps[0]).toMatchObject({
          id: result.continuationRunId,
          sourceMessageId: message.id,
          status: "queued",
        });
      }
      expect(
        await prisma.steeringMessage.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({
        runId: result.continuationRunId ?? null,
        claimedAt: null,
      });
    },
  );

  it("keeps a human steering continuation instead of a background retry", async () => {
    const f = await seedRetry();
    const message = await createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Continue with my changes." }],
    });
    await prisma.steeringMessage.create({ data: { messageId: message.id, botId, userId } });
    const terminal = await finalizeRun(prisma, f.failure);
    expect(terminal).toEqual({ continuationRunId: expect.any(String) });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "failed",
      routineRetryAt: null,
    });
  });

  it.each(["tool", "message", "effect", "steering"] as const)(
    "vetoes a routine retry after prior %s",
    async (prior) => {
      const f = await seedRetry();
      if (prior === "tool") {
        await prisma.$transaction((tx) =>
          appendEventInTransaction(tx, {
            spaceId,
            threadId: f.thread.id,
            botId,
            runId: f.run.id,
            type: "agent.tool.called",
            payload: { name: "schedule_list" },
          }),
        );
      } else if (prior === "message") {
        await createThreadMessage(prisma, {
          threadId: f.thread.id,
          runId: f.run.id,
          botId,
          role: "bot",
          blocks: [{ kind: "text", text: "Already replied." }],
        });
      } else if (prior === "effect") {
        await prisma.externalEffect.create({
          data: {
            spaceId,
            runId: f.run.id,
            kind: "synthetic_tool",
            idempotencyKey: `${f.run.id}:fixture`,
            status: "intended",
            request: {},
          },
        });
      } else {
        const message = await createThreadMessage(prisma, {
          threadId: f.thread.id,
          role: "user",
          blocks: [{ kind: "text", text: "Continue with these changes." }],
        });
        await prisma.steeringMessage.create({
          data: { messageId: message.id, botId, userId, runId: f.run.id, claimedAt: new Date() },
        });
      }
      expect(await finalizeRun(prisma, f.failure)).not.toHaveProperty("routineRetryAt");
      expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
        status: "failed",
        routineRetryAt: null,
      });
    },
  );

  it("shares three output recovery slots across concurrent calls and successor leases", async () => {
    const f = await seed();
    const input = { runId: f.run.id, spaceId, leaseOwner: "worker", leaseFence: 7 };
    expect(f.run.selfRecoveries).toBe(0);
    for (const invalid of [
      { spaceId: otherSpaceId },
      { leaseOwner: "other-worker" },
      { leaseFence: 6 },
      { now: f.run.leaseExpiresAt! },
    ]) {
      await expect(reserveRunSelfRecovery(prisma, { ...input, ...invalid })).resolves.toBe(false);
    }
    await expect(reserveRunSelfRecovery(prisma, input)).resolves.toBe(true);
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "fixture");
    await dropRunTurnCheckpoint(prisma, f.run, "worker", 7);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "successor", leaseFence: 8 },
    });
    await expect(reserveRunSelfRecovery(prisma, input)).resolves.toBe(false);
    const successor = { ...input, leaseOwner: "successor", leaseFence: 8 };
    const reservations = await Promise.all(
      Array.from({ length: 5 }, () => reserveRunSelfRecovery(prisma, successor)),
    );
    expect(reservations.filter(Boolean)).toHaveLength(2);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      selfRecoveries: 3,
    });
    const stopped = await seed();
    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [stopped.run], new Date()));
    await expect(reserveRunSelfRecovery(prisma, { ...input, runId: stopped.run.id })).resolves.toBe(
      false,
    );
  });

  it("commits partial output and failure once, with no write by a stale or cancelled worker", async () => {
    const f = await seed();
    await prisma.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId,
        botId,
        threadId: f.thread.id,
        runId: f.run.id,
        type: "thread.progress",
        payload: { text: "Already shown fragment.", streaming: true },
      }),
    );
    const input = {
      ...finishInput(f),
      outcome: "failed" as const,
      error: "Output recovery limit",
      partialText: "Already shown fragment.\0\uD83D",
    };
    await expect(finalizeRun(prisma, { ...input, leaseFence: 6 })).resolves.toBe(false);
    await expect(prisma.message.count({ where: { runId: f.run.id } })).resolves.toBe(0);
    const results = await Promise.all([finalizeRun(prisma, input), finalizeRun(prisma, input)]);
    expect(results.filter(Boolean)).toEqual([{ continuationRunId: null }]);
    const messages = await prisma.message.findMany({ where: { runId: f.run.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "bot",
      blocks: [{ kind: "text", text: "Already shown fragment.\uFFFD\uFFFD" }],
    });
    const events = await prisma.event.findMany({
      where: { runId: f.run.id },
      orderBy: { seq: "asc" },
    });
    expect(events.map(({ type }) => type)).toEqual(["thread.message.created", "run.failed"]);
    expect(events[1]!.payload).toEqual({ error: input.error });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "failed",
      error: input.error,
    });
    const stopped = await seed();
    await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [stopped.run], new Date()));
    await expect(
      finalizeRun(prisma, {
        ...finishInput(stopped),
        outcome: "failed",
        error: input.error,
        partialText: input.partialText,
      }),
    ).resolves.toBe(false);
    await expect(prisma.message.count({ where: { runId: stopped.run.id } })).resolves.toBe(0);
  });

  const resetClock = Date.parse("2026-10-20T12:00:00.000Z");
  const resetTime = (offsetMs: number) => new Date(resetClock + offsetMs);

  async function seedSteering(
    f: Awaited<ReturnType<typeof seed>>,
    claimedAt: Date | null,
    overrides: {
      authorUserId?: string;
      steeringUserId?: string;
      originTrigger?: string;
      clientNonce?: string;
      blocks?: MessageBlock[];
    } = {},
  ) {
    const message = await createThreadMessage(prisma, {
      threadId: f.thread.id,
      role: "user",
      authorUserId: overrides.authorUserId ?? userId,
      blocks: overrides.blocks ?? [{ kind: "text", text: "Synthetic steering" }],
      clientNonce: overrides.clientNonce,
    });
    return prisma.steeringMessage.create({
      data: {
        messageId: message.id,
        botId,
        runId: f.run.id,
        userId: overrides.steeringUserId ?? userId,
        originTrigger: overrides.originTrigger,
        claimedAt,
      },
    });
  }

  function resetInput(f: Awaited<ReturnType<typeof seed>>, steeringId: string, offsetMs: number) {
    return {
      runId: f.run.id,
      spaceId,
      botId,
      threadId: f.thread.id,
      leaseOwner: "worker",
      leaseFence: 7,
      steeringId,
      now: resetTime(offsetMs),
    };
  }

  function reserveRunProgressReset(db: PrismaClient, input: ReturnType<typeof resetInput>) {
    return db.$transaction((tx) => reserveRunProgressResetInTransaction(tx, input));
  }

  it("commits a live owner reset with its claim and restores it without granting again", async () => {
    const f = await seed();
    const claim = {
      runId: f.run.id,
      botId,
      threadId: f.thread.id,
      leaseOwner: "worker",
      leaseFence: 7,
      seenIds: [],
    };
    const opening = await seedSteering(f, null);
    const initial = await claimSteering(prisma, claim);
    expect(initial).toMatchObject([{ id: opening.id, ownerInput: true }]);
    expect(initial[0]?.progressResetAt).toBeUndefined();
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toBeUndefined();
    const replayedOpening = await claimSteering(prisma, { ...claim, liveProgressReset: true });
    expect(replayedOpening[0]?.progressResetAt).toBeUndefined();
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toBeUndefined();

    const owner = await seedSteering(f, null);
    const channel = await seedSteering(f, null, { clientNonce: "messaging:fixture" });
    const liveClaim = {
      ...claim,
      seenIds: [opening.id],
      liveProgressReset: true as const,
    };
    const live = await Promise.all([
      claimSteering(prisma, liveClaim),
      claimSteering(prisma, liveClaim),
    ]);
    for (const batch of live) {
      expect(batch.map(({ id }) => id)).toEqual([owner.id, channel.id]);
      expect(batch[1]?.progressResetAt).toBeUndefined();
    }
    const grants = live.map((batch) => batch[0]?.progressResetAt).filter(Boolean);
    expect(grants).toEqual([expect.any(Date)]);

    // Simulate losing the worker after the claim commits, before it can emit or apply the event.
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "successor", leaseFence: 8 },
    });
    const successor = { ...claim, leaseOwner: "successor", leaseFence: 8 };
    const expected = { startedAt: grants[0], startMessageSeq: 3 };
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toEqual(expected);
    const recovered = await claimSteering(prisma, successor);
    expect(recovered.map(({ id }) => id)).toEqual([opening.id, owner.id, channel.id]);
    expect(recovered.every((item) => item.progressResetAt === undefined)).toBe(true);
    const replayedLive = await claimSteering(prisma, { ...successor, liveProgressReset: true });
    expect(replayedLive.every((item) => item.progressResetAt === undefined)).toBe(true);
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toEqual(expected);
  });

  it("serializes steering resets and preserves the latest budget anchor across a new lease", async () => {
    const f = await seed();
    const first = await seedSteering(f, resetTime(0));
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toBeUndefined();
    const results = await Promise.all([
      reserveRunProgressReset(prisma, resetInput(f, first.id, 0)),
      reserveRunProgressReset(prisma, resetInput(f, first.id, 0)),
    ]);
    expect(results.filter(Boolean)).toEqual([{ startedAt: resetTime(0), startMessageSeq: 1 }]);
    const update = await createThreadMessage(prisma, {
      threadId: f.thread.id,
      runId: f.run.id,
      botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Progress after reset" }],
      clientNonce: `user-progress:${f.run.id}:0`,
    });
    expect(update.seq).toBe(1);

    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "successor", leaseFence: 8 },
    });
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toEqual({
      startedAt: resetTime(0),
      startMessageSeq: 1,
    });
    const reserve = (id: string, offset: number) =>
      reserveRunProgressReset(prisma, {
        ...resetInput(f, id, offset),
        leaseOwner: "successor",
        leaseFence: 8,
      });
    const tooEarly = await seedSteering(f, resetTime(59_999));
    await expect(reserve(tooEarly.id, 59_999)).resolves.toBeUndefined();
    await expect(reserve(tooEarly.id, 60_000)).resolves.toBeUndefined();
    const second = await seedSteering(f, resetTime(60_000));
    await expect(
      reserveRunProgressReset(prisma, resetInput(f, second.id, 60_000)),
    ).resolves.toBeUndefined();
    await expect(reserve(second.id, 60_000)).resolves.toEqual({
      startedAt: resetTime(60_000),
      startMessageSeq: 4,
    });
    const third = await seedSteering(f, resetTime(120_000));
    await expect(reserve(third.id, 120_000)).resolves.toEqual({
      startedAt: resetTime(120_000),
      startMessageSeq: 5,
    });
    const fourth = await seedSteering(f, resetTime(180_000));
    await expect(reserve(fourth.id, 180_000)).resolves.toBeUndefined();
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toEqual({
      startedAt: resetTime(120_000),
      startMessageSeq: 5,
    });
    expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(1);
    expect(await prisma.event.count({ where: { runId: f.run.id } })).toBe(0);
  });

  it("rejects initial, unclaimed, outside, wrong-scope, and stopped steering", async () => {
    const f = await seed();
    const initial = await seedSteering(f, resetTime(0));
    await prisma.run.update({
      where: { id: f.run.id },
      data: { sourceMessageId: initial.messageId },
    });
    const invalid = [
      initial,
      await seedSteering(f, null),
      await seedSteering(f, resetTime(0), { authorUserId: "fixture-peer" }),
      await seedSteering(f, resetTime(0), { steeringUserId: "fixture-peer" }),
      await seedSteering(f, resetTime(0), { originTrigger: "webhook" }),
      await seedSteering(f, resetTime(0), { clientNonce: "messaging:fixture" }),
      await seedSteering(f, resetTime(0), {
        blocks: [
          {
            kind: "channel_message",
            provider: "fixture",
            channelId: "fixture-channel",
            fromAddress: "fixture-address",
            fromLabel: "Fixture author",
            text: "Synthetic channel message",
          },
        ],
      }),
    ];
    for (const steering of invalid) {
      await expect(
        reserveRunProgressReset(prisma, resetInput(f, steering.id, 0)),
      ).resolves.toBeUndefined();
    }
    const owned = await seedSteering(f, resetTime(0));
    const input = resetInput(f, owned.id, 0);
    await expect(
      reserveRunProgressReset(prisma, { ...input, spaceId: otherSpaceId }),
    ).resolves.toBeUndefined();
    for (const trigger of ["messaging", "webhook", "routine", "tickets"]) {
      await prisma.run.update({ where: { id: f.run.id }, data: { trigger } });
      await expect(reserveRunProgressReset(prisma, input)).resolves.toBeUndefined();
    }
    await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "cancelled", trigger: "user" },
    });
    await expect(reserveRunProgressReset(prisma, input)).resolves.toBeUndefined();
    await expect(loadRunProgressReset(prisma, f.run.id)).resolves.toBeUndefined();
  });

  it("fails closed when the persisted reset would restore a different budget", async () => {
    const f = await seed();
    const ownerSteering = await seedSteering(f, resetTime(0));
    const corrupt = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        idempotencyKey: JSON.stringify(["runtime_progress_reset", f.run.id]),
        kind: "runtime_progress_reset",
        status: "runtime_progress_reset",
        request: {},
        result: [{ steeringId: ownerSteering.id, startedAtMs: resetClock, startMessageSeq: -1 }],
      },
    });
    await expect(loadRunProgressReset(prisma, f.run.id)).rejects.toThrow(
      "Invalid Run progress reset state",
    );
    await expect(
      reserveRunProgressReset(prisma, resetInput(f, ownerSteering.id, 0)),
    ).rejects.toThrow("Invalid Run progress reset state");
    await expect(prisma.externalEffect.findUnique({ where: { id: corrupt.id } })).resolves.toEqual(
      corrupt,
    );
  });

  it("backfills existing MCP rows by executing the actual migration on a transaction-local old table", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261103020000_mcp_verbatim_results/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$transaction(async (tx) => {
      // The actual migration can resolve only this connection's synthetic table.
      // COMMIT drops it; rollback also undoes its creation if an assertion fails.
      await tx.$executeRaw`CREATE TEMP TABLE mcp_servers (id text PRIMARY KEY) ON COMMIT DROP`;
      await tx.$executeRaw`SET LOCAL search_path = pg_temp`;
      await tx.$executeRaw`INSERT INTO pg_temp.mcp_servers (id) VALUES ('existing-fixture-row')`;
      await tx.$executeRawUnsafe(migration);
      const rows = await tx.$queryRaw<Array<{ id: string; verbatimResults: boolean }>>`
        SELECT id, "verbatimResults" FROM pg_temp.mcp_servers`;
      expect(rows).toEqual([{ id: "existing-fixture-row", verbatimResults: false }]);
    });
  });

  it("defaults MCP result retention off and persists explicit choices without granting tools", async () => {
    const server = await prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "checkpoint-fixture-server",
        name: "Fixture",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
      },
    });
    expect(server.verbatimResults).toBe(false);
    for (const verbatimResults of [true, false]) {
      const updated = await prisma.mcpServer.update({
        where: { id: server.id },
        data: { verbatimResults },
      });
      expect(updated).toMatchObject({ verbatimResults, allowAllTools: false, allowedTools: [] });
      expect(
        (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).verbatimResults,
      ).toBe(verbatimResults);
    }
  });

  it("stores the latest opaque turn only, without events or normal effect mutation", async () => {
    const f = await seed();
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "write_effect",
        status: "completed",
        idempotencyKey: `ordinary:${f.run.id}`,
        request: {},
        result: { receipt: "keep" },
      },
    });
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "first fixture turn");
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "latest fixture turn");
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("latest fixture turn");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_checkpoint" } }),
    ).toBe(1);
    expect(await prisma.event.count({ where: { runId: f.run.id } })).toBe(0);
    expect(await prisma.message.count({ where: { runId: f.run.id } })).toBe(0);
    await dropRunTurnCheckpoint(prisma, f.run, "worker", 7);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect(await prisma.externalEffect.findUnique({ where: { id: effect.id } })).toEqual(effect);
  });

  it("fails closed on a mismatching Space and a malformed persisted value", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "keep scoped fixture");
    await expect(
      loadRunTurnCheckpoint(prisma, { ...f.run, spaceId: otherSpaceId }),
    ).rejects.toThrow("Unsupported turn checkpoint");
    await expect(
      saveRunTurnCheckpoint(prisma, { ...f.run, spaceId: otherSpaceId }, "worker", 7, "foreign"),
    ).rejects.toThrow("lease expired");
    await clearRunTurnCheckpoints(prisma, [{ id: f.run.id, spaceId: otherSpaceId }]);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("keep scoped fixture");
    await prisma.externalEffect.update({
      where: { idempotencyKey: JSON.stringify(["runtime_checkpoint", f.run.id]) },
      data: { result: { invalid: true } },
    });
    await expect(loadRunTurnCheckpoint(prisma, f.run)).rejects.toThrow(
      "Unsupported turn checkpoint",
    );
  });

  it("rejects stale owner/fence writes and drops without losing the current turn", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "keep");
    for (const [owner, fence] of [
      ["other-worker", 7],
      ["worker", 6],
    ] as const) {
      await expect(saveRunTurnCheckpoint(prisma, f.run, owner, fence, "wrong")).rejects.toThrow(
        "lease expired",
      );
      await expect(dropRunTurnCheckpoint(prisma, f.run, owner, fence)).rejects.toThrow(
        "lease expired",
      );
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("keep");
  });

  it("clears a save that acquired the Run lock before cancellation", async () => {
    const f = await seed();
    let entered!: () => void;
    const atUpsert = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This query extension pauses the real transaction after its real Run write lock.
    const blocked = prisma.$extends({
      query: {
        externalEffect: {
          async upsert({ args, query }) {
            entered();
            await gate;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const save = saveRunTurnCheckpoint(blocked, f.run, "worker", 7, "racing save");
    try {
      await Promise.race([
        atUpsert,
        save.then(() => {
          throw new Error("Save bypassed the checkpoint upsert");
        }),
      ]);
      const cancel = prisma.$transaction((tx) => cancelRunsInTransaction(tx, [f.run], new Date()));
      release();
      await save;
      expect(await cancel).toHaveLength(1);
    } finally {
      release();
      await save.catch(() => undefined);
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "cancelled",
    );
  });

  it("rejects a late save when cancellation has already won the Run lock", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "old turn");
    let entered!: () => void;
    const terminalWritten = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = prisma.$transaction(async (tx) => {
      const winners = await cancelRunsInTransaction(tx, [f.run], new Date());
      entered();
      await gate;
      return winners;
    });
    try {
      await Promise.race([
        terminalWritten,
        cancel.then(() => {
          throw new Error("Cancellation bypassed its terminal barrier");
        }),
      ]);
      const late = saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "must not return");
      const rejected = expect(late).rejects.toThrow("lease expired");
      release();
      await cancel;
      await rejected;
    } finally {
      release();
      await cancel.catch(() => undefined);
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
  });

  it("does not cancel or clear a run that completed after the caller's snapshot", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "retained winning state");
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
    expect(
      await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [f.run], new Date())),
    ).toEqual([]);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("retained winning state");
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).status).toBe(
      "running",
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe(
      "running",
    );
  });

  it("clears only the finalized turn and rolls checkpoint deletion back on finalization failure", async () => {
    const f = await seed();
    const peer = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "finishing turn");
    await saveRunTurnCheckpoint(prisma, peer.run, "worker", 7, "peer turn");
    await expect(
      finalizeRun(prisma, { ...finishInput(f), attemptId: "missing-attempt" }),
    ).rejects.toThrow("Active run attempt");
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("finishing turn");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "running",
    );
    await expect(finalizeRun(prisma, { ...finishInput(f), leaseFence: 6 })).resolves.toBe(false);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("finishing turn");
    await expect(finalizeRun(prisma, finishInput(f))).resolves.toEqual({ continuationRunId: null });
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect(await loadRunTurnCheckpoint(prisma, peer.run)).toBe("peer turn");
    const events = await prisma.event.findMany({ where: { runId: f.run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.completed");
    expect(JSON.stringify(events)).not.toContain("finishing turn");
  });

  it("only clears an aged wait after its exact episode wins", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "waiting turn");
    const waiting = await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "waiting_input" },
    });
    const input = {
      runId: f.run.id,
      threadId: f.thread.id,
      status: "waiting_input" as const,
      updatedAt: waiting.updatedAt,
      now: new Date(),
    };
    await expect(
      prisma.$transaction((tx) => expireStuckRun(tx, { ...input, updatedAt: new Date(0) })),
    ).resolves.toBeNull();
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("waiting turn");
    await expect(prisma.$transaction((tx) => expireStuckRun(tx, input))).resolves.toMatchObject({
      continuationRunId: null,
    });
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
  });
});
