import { randomUUID } from "node:crypto";
import { createDb, createThreadEvents, RunHistoryWriteError } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import { appendToolCompletionAudit } from "./executor.js";
import { persistMessageInTransaction, publishMessage, withRunLease } from "./run-messages.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("attempt history isolation (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let base: ExecutorDeps;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const userId = randomUUID();
  const organizationId = randomUUID();
  const spaceId = randomUUID();

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    const bot = await db.prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "Fixture",
        color: "slate",
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    identity = { userId, spaceId, botId: bot.id, threadId: bot.thread!.id };
    base = { prisma: db.prisma, events: createThreadEvents(db.prisma) } as ExecutorDeps;
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function createRun(owner = "worker-a") {
    const task = await db.prisma.task.create({
      data: { ...identity, prompt: "Fixture", status: "running" },
    });
    return db.prisma.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: owner,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  it("rejects a superseded direct message without changing sequences or first response", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: "worker-b", leaseFence: 2 },
    });
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } });
    await expect(
      publishMessage(deps, run, "bot", [{ kind: "text", text: "stale" }]),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } })).toEqual(
      thread,
    );
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
  });

  it("keeps concurrent attempt dependencies isolated instead of mutating their shared factory", async () => {
    const [a, b] = await Promise.all([createRun("worker-a"), createRun("worker-b")]);
    const aDeps = withRunLease(base, a.id, { owner: "worker-a", fence: 1 });
    const bDeps = withRunLease(base, b.id, { owner: "worker-b", fence: 1 });
    expect(base.runLease).toBeUndefined();
    expect(base.events).not.toBe(aDeps.events);
    await Promise.all([
      publishMessage(aDeps, a, "bot", [{ kind: "text", text: "reply A" }]),
      publishMessage(bDeps, b, "bot", [{ kind: "text", text: "reply B" }]),
    ]);
    await db.prisma.run.update({
      where: { id: a.id },
      data: { leaseFence: 2, leaseOwner: "new-a" },
    });
    await expect(
      aDeps.events.append({
        ...identity,
        runId: a.id,
        type: "thread.progress",
        payload: { streaming: true, delta: "stale A" },
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await bDeps.events.append({
      ...identity,
      runId: b.id,
      type: "thread.progress",
      payload: { streaming: true, delta: "still B" },
    });
    expect(await db.prisma.event.count({ where: { runId: b.id } })).toBe(2);
  });

  it("allows an audit after the same attempt paused but fences it out after a new claim", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    await appendToolCompletionAudit(
      deps,
      { ...identity, runId: run.id },
      {
        name: "ask_user",
        executionId: "paused-tool",
        durationMs: 1,
        result: { paused: true },
        paused: true,
      },
    );
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "agent.tool.completed" } }),
    ).toBe(1);
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: "worker-b", leaseFence: 2 },
    });
    await expect(
      deps.events.append({
        ...identity,
        runId: run.id,
        type: "thread.progress",
        payload: { activity: true, text: "stale audit" },
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(1);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
  });

  it("rolls back the direct message, its event, and first-response timestamp together", async () => {
    const run = await createRun();
    const lease = { owner: "worker-a", fence: 1 };
    await expect(
      db.prisma.$transaction(async (tx) => {
        await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [{ kind: "text", text: "rolled back" }],
          undefined,
          undefined,
          false,
          lease,
        );
        throw new Error("fixture transaction rollback");
      }),
    ).rejects.toThrow("fixture transaction rollback");
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
    const deps = withRunLease(base, run.id, lease);
    await publishMessage(deps, run, "bot", [{ kind: "text", text: "committed" }]);
    const stamped = (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
      .firstResponseAt;
    expect(stamped).toBeInstanceOf(Date);
    await publishMessage(deps, run, "bot", [{ kind: "text", text: "later" }]);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(stamped);
  });

  it("rejects a cancelled run even when the old owner and fence still match", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await expect(
      publishMessage(deps, run, "bot", [{ kind: "text", text: "late" }]),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
  });
});
