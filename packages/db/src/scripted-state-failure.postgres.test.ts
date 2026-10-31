import { randomUUID } from "node:crypto";
import { runSecretKind } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { FailScriptedRunInput } from "./scripted-state-failure.js";
import { failScriptedRunPreservingSteering } from "./scripted-state-failure.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("scripted recovery failure (PostgreSQL)", () => {
  const spaceId = "scripted-failure-space";
  const botId = "scripted-failure-bot";
  const userId = "scripted-failure-user";
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
      data: [userId, `${userId}-other`].map((id) => ({
        id,
        name: "Failure Test User",
        email: `${id}@example.test`,
      })),
    });
    await prisma.organization.create({
      data: {
        id: spaceId,
        name: "Scripted Failure Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Scripted Failure Space",
            bots: {
              create: { id: botId, userId, name: "Failure Test Bot", color: "ink" },
            },
          },
        },
      },
    });
    await prisma.space.create({
      data: { id: `${spaceId}-other`, organizationId: spaceId, name: "Other Failure Test Space" },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: spaceId } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, `${userId}-other`] } } });
    } finally {
      await close();
    }
  });

  async function seed(status = "running", leaseOwner: string | null = "worker-1") {
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Failure Test Group", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId, groupId: group.id, nextMessageSeq: 3, nextEventSeq: 1 },
    });
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId: thread.id, userId, prompt: "fixture", status },
    });
    const savedState = { marker: randomUUID(), cursor: "preserve verbatim" };
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        userId,
        status,
        trigger: "follow_up",
        leaseOwner,
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        scriptedState: savedState,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 7, status: status === "queued" ? "waiting_input" : "running" },
    });
    const messages = await Promise.all(
      [0, 1, 2].map((seq) =>
        prisma.message.create({
          data: {
            threadId: thread.id,
            seq,
            role: "user",
            blocks: [{ kind: "text", text: `member ${seq}` }],
          },
        }),
      ),
    );
    await prisma.run.update({ where: { id: run.id }, data: { sourceMessageId: messages[1]!.id } });
    for (const [index, message] of messages.entries()) {
      await prisma.steeringMessage.create({
        data: {
          messageId: message.id,
          botId,
          userId,
          runId: run.id,
          claimedAt: index < 2 ? new Date() : null,
        },
      });
    }
    await prisma.event.create({
      data: {
        spaceId,
        botId,
        threadId: thread.id,
        seq: 0,
        runId: run.id,
        type: "thread.progress",
        payload: { text: "working" },
      },
    });
    const current = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const input: FailScriptedRunInput = {
      runId: run.id,
      taskId: task.id,
      threadId: thread.id,
      spaceId,
      botId,
      status,
      leaseOwner,
      workerId: "worker-1",
      leaseFence: 7,
      attemptId: attempt.id,
      error: "fixture recovery cannot be verified",
    };
    const steering = await prisma.steeringMessage.findMany({
      where: { runId: run.id },
      orderBy: { id: "asc" },
    });
    return { input, run: current, attempt, task, steering, savedState };
  }

  it("fails once while retaining the entire claimed and fresh batch and cursor", async () => {
    const fixture = await seed();
    const result = await failScriptedRunPreservingSteering(prisma, fixture.input);
    expect(result).toEqual({ threadId: fixture.input.threadId, seq: 1 });
    await expect(failScriptedRunPreservingSteering(prisma, fixture.input)).resolves.toBeNull();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "failed",
      error: fixture.input.error,
      leaseOwner: null,
      leaseExpiresAt: null,
      scriptedState: fixture.savedState,
    });
    expect(
      await prisma.attempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
    ).toMatchObject({ status: "failed", error: fixture.input.error, finishedAt: expect.any(Date) });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).toMatchObject({
      status: "failed",
    });
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: fixture.run.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fixture.steering);
    expect(await prisma.run.count({ where: { threadId: fixture.input.threadId } })).toBe(1);
    expect(await prisma.message.count({ where: { threadId: fixture.input.threadId } })).toBe(3);
    const events = await prisma.event.findMany({ where: { runId: fixture.run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run.failed",
      payload: { error: fixture.input.error },
    });
  });

  it.each([
    { leaseFence: 6 },
    { leaseOwner: "other-worker" },
    { status: "queued" },
    { spaceId: "other-space" },
    { botId: "other-bot" },
    { threadId: "other-thread" },
    { taskId: "other-task" },
    { updatedAt: new Date(0) },
  ])("rejects a stale or foreign failure fence: %j", async (changed) => {
    const fixture = await seed();
    await expect(
      failScriptedRunPreservingSteering(prisma, { ...fixture.input, ...changed }),
    ).resolves.toBeNull();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toEqual(
      fixture.run,
    );
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: fixture.run.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fixture.steering);
    expect(await prisma.event.count({ where: { runId: fixture.run.id, type: "run.failed" } })).toBe(
      0,
    );
  });

  it("rolls back all terminal writes when the expected attempt is missing", async () => {
    const fixture = await seed();
    await expect(
      failScriptedRunPreservingSteering(prisma, { ...fixture.input, attemptId: "missing-attempt" }),
    ).rejects.toThrow("Active run attempt was not available to fail");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toEqual(
      fixture.run,
    );
    expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).toMatchObject({
      status: "running",
    });
    expect(
      await prisma.event.count({ where: { runId: fixture.run.id, type: "thread.progress" } }),
    ).toBe(1);
  });

  it("rolls back terminal state when its failure event cannot be saved", async () => {
    const fixture = await seed();
    const fault = new Error("failure event unavailable");
    const failing = prisma.$extends({
      query: {
        event: {
          async create() {
            throw fault;
          },
        },
      },
    }) as PrismaClient;
    await expect(failScriptedRunPreservingSteering(failing, fixture.input)).rejects.toBe(fault);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toEqual(
      fixture.run,
    );
    expect(
      await prisma.attempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
    ).toMatchObject({ status: "running", finishedAt: null });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).toMatchObject({
      status: "running",
    });
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: fixture.run.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fixture.steering);
    expect(
      await prisma.event.count({ where: { runId: fixture.run.id, type: "thread.progress" } }),
    ).toBe(1);
  });

  it("allows one concurrent terminal writer", async () => {
    const fixture = await seed();
    const results = await Promise.all([
      failScriptedRunPreservingSteering(prisma, fixture.input),
      failScriptedRunPreservingSteering(prisma, fixture.input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.event.count({ where: { runId: fixture.run.id, type: "run.failed" } })).toBe(
      1,
    );
    expect(await prisma.run.count({ where: { threadId: fixture.input.threadId } })).toBe(1);
  });

  it("fails a queued admission episode without leaving a retryable run", async () => {
    const fixture = await seed("queued", null);
    const { attemptId: _attemptId, ...input } = fixture.input;
    await failScriptedRunPreservingSteering(prisma, { ...input, updatedAt: fixture.run.updatedAt });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
      status: "failed",
    });
    expect(
      await prisma.attempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
    ).toMatchObject({ status: "failed" });
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: fixture.run.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fixture.steering);
  });

  it.each(["waiting_input", "waiting_takeover", "running"])(
    "fails the prior %s attempt when admission has advanced the run fence",
    async (status) => {
      const fixture = await seed();
      await prisma.attempt.update({
        where: { id: fixture.attempt.id },
        data: { status },
      });
      const history = await prisma.attempt.create({
        data: { runId: fixture.run.id, fence: 5, status: "completed", finishedAt: new Date() },
      });
      const neighbor = await seed();
      await prisma.run.update({
        where: { id: fixture.run.id },
        data: { leaseFence: 8 },
      });
      const { attemptId: _attemptId, ...input } = fixture.input;
      await failScriptedRunPreservingSteering(prisma, { ...input, leaseFence: 8 });
      expect(
        await prisma.attempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
      ).toMatchObject({ status: "failed", error: input.error, finishedAt: expect.any(Date) });
      expect(await prisma.attempt.findUniqueOrThrow({ where: { id: history.id } })).toEqual(
        history,
      );
      expect(
        await prisma.attempt.findUniqueOrThrow({ where: { id: neighbor.attempt.id } }),
      ).toEqual(neighbor.attempt);
      expect(
        await prisma.steeringMessage.findMany({
          where: { runId: fixture.run.id },
          orderBy: { id: "asc" },
        }),
      ).toEqual(fixture.steering);
      expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toMatchObject({
        status: "failed",
        scriptedState: fixture.savedState,
      });
    },
  );

  it("leaves a task running when a different sibling is still active", async () => {
    const fixture = await seed();
    await prisma.run.create({
      data: {
        spaceId,
        botId,
        userId,
        threadId: fixture.input.threadId,
        taskId: fixture.task.id,
        status: "running",
        trigger: "user",
      },
    });
    await failScriptedRunPreservingSteering(prisma, fixture.input);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.task.id } })).toMatchObject({
      status: "running",
    });
  });

  it("expires only the failed run's execution lease while preserving user control", async () => {
    const fixture = await seed();
    const expiresAt = new Date(Date.now() + 60_000);
    const computer = await prisma.computer.create({
      data: {
        spaceId,
        userId,
        kind: "fake",
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        controlHolder: "user",
        controlLeaseId: "active-user-control",
        controlLeaseExpiresAt: expiresAt,
        controlRunId: fixture.run.id,
        executionRunId: fixture.run.id,
        executionBotId: botId,
        executionLeaseExpiresAt: expiresAt,
      },
    });
    const own = await prisma.computerExecutionLease.create({
      data: { computerId: computer.id, botId, runId: fixture.run.id, expiresAt },
    });
    const other = await prisma.computerExecutionLease.create({
      data: { computerId: computer.id, botId: "other-bot", runId: "other-run", expiresAt },
    });
    await failScriptedRunPreservingSteering(prisma, fixture.input);
    expect(
      await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: own.id } }),
    ).toMatchObject({ expiresAt: new Date(0) });
    expect(
      await prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: other.id } }),
    ).toEqual(other);
    expect(await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
      controlHolder: "user",
      controlLeaseId: "active-user-control",
      controlRunId: fixture.run.id,
      controlLeaseExpiresAt: expiresAt,
    });
  });

  it("clears only the failed run's owned staged input", async () => {
    const fixture = await seed();
    const owned = await prisma.secret.create({
      data: { spaceId, userId, kind: runSecretKind(fixture.run.id), ciphertext: "fixture-only" },
    });
    const neighbors = await Promise.all(
      [
        { spaceId: `${spaceId}-other`, userId, kind: runSecretKind(fixture.run.id) },
        { spaceId, userId: `${userId}-other`, kind: runSecretKind(fixture.run.id) },
        { spaceId, userId, kind: runSecretKind("another-run") },
        { spaceId, userId, kind: "connector-login" },
        { spaceId: null, userId, kind: "model" },
      ].map((data) => prisma.secret.create({ data: { ...data, ciphertext: "fixture-only" } })),
    );
    await failScriptedRunPreservingSteering(prisma, fixture.input);
    expect(await prisma.secret.findUnique({ where: { id: owned.id } })).toBeNull();
    for (const neighbor of neighbors)
      expect(await prisma.secret.findUnique({ where: { id: neighbor.id } })).toEqual(neighbor);
    expect(
      await prisma.steeringMessage.findMany({
        where: { runId: fixture.run.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(fixture.steering);
  });

  it("keeps staged input when the failure fence is stale", async () => {
    const fixture = await seed();
    const secret = await prisma.secret.create({
      data: { spaceId, userId, kind: runSecretKind(fixture.run.id), ciphertext: "fixture-only" },
    });
    await expect(
      failScriptedRunPreservingSteering(prisma, { ...fixture.input, leaseFence: 6 }),
    ).resolves.toBeNull();
    expect(await prisma.secret.findUnique({ where: { id: secret.id } })).toEqual(secret);
  });

  it("restores staged input when the terminal transaction rolls back", async () => {
    const fixture = await seed();
    const secret = await prisma.secret.create({
      data: { spaceId, userId, kind: runSecretKind(fixture.run.id), ciphertext: "fixture-only" },
    });
    const fault = new Error("terminal event unavailable");
    const failing = prisma.$extends({
      query: {
        event: {
          async create() {
            throw fault;
          },
        },
      },
    }) as PrismaClient;
    await expect(failScriptedRunPreservingSteering(failing, fixture.input)).rejects.toBe(fault);
    expect(await prisma.secret.findUnique({ where: { id: secret.id } })).toEqual(secret);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toEqual(
      fixture.run,
    );
  });

  it("does not let an observer fail another worker's active run", async () => {
    const fixture = await seed();
    const secret = await prisma.secret.create({
      data: { spaceId, userId, kind: runSecretKind(fixture.run.id), ciphertext: "fixture-only" },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        runId: fixture.run.id,
        spaceId,
        kind: "scripted.file",
        idempotencyKey: randomUUID(),
        request: {},
        status: "executing",
      },
    });
    await expect(
      failScriptedRunPreservingSteering(prisma, { ...fixture.input, workerId: "observer" }),
    ).resolves.toBeNull();
    expect(await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } })).toEqual(
      fixture.run,
    );
    expect(await prisma.secret.findUnique({ where: { id: secret.id } })).toEqual(secret);
    expect(await prisma.externalEffect.findUnique({ where: { id: effect.id } })).toEqual(effect);
  });
});
