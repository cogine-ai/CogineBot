import { randomUUID } from "node:crypto";
import type { AgentHomeStore, RealtimeFanout } from "@rakazo/adapter-kit";
import { destroyBot, FakeSandboxProvider } from "@rakazo/adapters";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  bindWaitingTakeoverControl,
  clearThread,
  createDb,
  createThreadEvents,
  finalizeComputerControlRelease,
  pauseRunForTakeover,
  settleReleasedTakeoverCards,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stopThreadRuns } from "../../../apps/api/src/thread-target.ts";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const pending = [{ kind: "computer", state: "Needs you", text: "Protected input" }];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!enabled).sequential("takeover release settlement (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let f: Awaited<ReturnType<typeof fixture>>;
  const organizationIds: string[] = [];
  const userIds: string[] = [];
  const publish = vi.fn(async (_topic: string, _payload: string) => undefined);
  const realtime = { publish } as unknown as RealtimeFanout;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "takeover-release-fixture",
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    f = await fixture();
    publish.mockClear();
  });

  async function fixture() {
    const id = randomUUID();
    const userId = `takeover-user-${id}`;
    const organizationId = `takeover-org-${id}`;
    userIds.push(userId);
    organizationIds.push(organizationId);
    await db.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${id}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: id, createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `takeover-space-${id}`, organizationId, name: "Fixture" },
    });
    const computer = await db.prisma.computer.create({
      data: {
        spaceId: space.id,
        userId,
        kind: "container",
        scopeKey: `team:${id}`,
        homeKey: `home-${id}`,
        state: "running",
      },
    });
    const bot = await db.prisma.bot.create({
      data: { spaceId: space.id, userId, name: "First", color: "ink", computerId: computer.id },
    });
    const otherBot = await db.prisma.bot.create({
      data: { spaceId: space.id, userId, name: "Second", color: "ink", computerId: computer.id },
    });
    const privateThread = await db.prisma.thread.create({
      data: { spaceId: space.id, userId, botId: bot.id },
    });
    const group = await db.prisma.chatGroup.create({
      data: {
        spaceId: space.id,
        userId,
        name: "Group",
        members: { create: [{ botId: bot.id }, { botId: otherBot.id }] },
      },
    });
    const groupThread = await db.prisma.thread.create({
      data: { spaceId: space.id, userId, groupId: group.id },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: space.id,
        userId,
        botId: bot.id,
        threadId: groupThread.id,
        prompt: "Fixture",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        userId,
        botId: bot.id,
        threadId: groupThread.id,
        taskId: task.id,
        trigger: "user",
        status: "waiting_takeover",
        leaseOwner: "worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const siblingTask = await db.prisma.task.create({
      data: {
        spaceId: space.id,
        userId,
        botId: otherBot.id,
        threadId: groupThread.id,
        prompt: "Sibling",
        status: "running",
      },
    });
    const sibling = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        userId,
        botId: otherBot.id,
        threadId: groupThread.id,
        taskId: siblingTask.id,
        trigger: "user",
        status: "running",
        leaseFence: 11,
      },
    });
    const card = await db.prisma.message.create({
      data: {
        threadId: groupThread.id,
        seq: 0,
        role: "bot",
        botId: bot.id,
        runId: run.id,
        blocks: pending,
      },
    });
    const siblingCard = await db.prisma.message.create({
      data: {
        threadId: groupThread.id,
        seq: 1,
        role: "bot",
        botId: otherBot.id,
        runId: sibling.id,
        blocks: pending,
      },
    });
    await db.prisma.thread.update({ where: { id: groupThread.id }, data: { nextMessageSeq: 2 } });
    const leaseId = `lease-${id}`;
    await db.prisma.computer.update({
      where: { id: computer.id },
      data: {
        controlHolder: "user",
        controlLeaseId: leaseId,
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: bot.id,
        controlRunId: run.id,
      },
    });
    return {
      userId,
      space,
      computer,
      bot,
      otherBot,
      privateThread,
      group,
      groupThread,
      task,
      run,
      sibling,
      card,
      siblingCard,
      leaseId,
    };
  }

  function releaseInput(reason: "done" | "released" | "skipped" | "expired" = "done") {
    return {
      spaceId: f.space.id,
      computerId: f.computer.id,
      botId: f.bot.id,
      runId: f.run.id as string | null,
      leaseId: f.leaseId,
      holder: "bot" as const,
      reason,
    };
  }
  function repairInput() {
    return {
      spaceId: f.space.id,
      threadId: f.groupThread.id,
      botId: f.bot.id,
      runId: f.run.id,
      reason: "takeover",
    };
  }
  const events = () =>
    db.prisma.event.findMany({ where: { threadId: f.groupThread.id }, orderBy: { seq: "asc" } });
  const card = () => db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } });
  const run = () => db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
  const computer = () => db.prisma.computer.findUniqueOrThrow({ where: { id: f.computer.id } });

  it.each(["done", "released", "skipped", "expired"] as const)(
    "atomically settles %s on the group run and notifies the durable final cursor",
    async (reason) => {
      const notified: unknown[] = [];
      publish.mockImplementationOnce(async (topic, payload) => {
        notified.push({
          topic,
          payload: JSON.parse(payload),
          blocks: (await card()).blocks,
          leaseId: (await computer()).controlLeaseId,
          events: (await events()).length,
        });
      });
      expect(
        await finalizeComputerControlRelease(db.prisma, releaseInput(reason), realtime),
      ).toEqual({ runId: f.run.id });
      expect(notified).toEqual([
        {
          topic: `thread:${f.groupThread.id}`,
          payload: { cursor: 1 },
          blocks: [
            {
              ...pending[0],
              state: reason === "done" || reason === "released" ? "Done" : "Skipped",
            },
          ],
          leaseId: null,
          events: 2,
        },
      ]);
      expect(await run()).toMatchObject({
        status: "queued",
        checkpoint: reason === "done" || reason === "released" ? "takeover" : "takeover-skipped",
        leaseFence: 7,
        leaseOwner: "worker",
      });
      expect((await events()).map((event) => [event.type, event.runId])).toEqual([
        ["thread.message.updated", f.run.id],
        ["computer.takeover.released", f.run.id],
      ]);
      expect((await events())[0]?.payload).toMatchObject({ messageId: f.card.id, messageSeq: 0 });
      expect(await db.prisma.event.count({ where: { threadId: f.privateThread.id } })).toBe(0);
      expect(await db.prisma.run.findUnique({ where: { id: f.sibling.id } })).toMatchObject({
        status: "running",
        leaseFence: 11,
      });
      expect(
        (await db.prisma.message.findUniqueOrThrow({ where: { id: f.siblingCard.id } })).blocks,
      ).toEqual(pending);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it("settles a private run on its own private thread", async () => {
    await db.prisma.run.update({ where: { id: f.run.id }, data: { threadId: f.privateThread.id } });
    await db.prisma.message.update({
      where: { id: f.card.id },
      data: { threadId: f.privateThread.id },
    });
    await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime);
    expect((await card()).blocks).toEqual([{ ...pending[0], state: "Done" }]);
    expect(await db.prisma.event.count({ where: { threadId: f.privateThread.id } })).toBe(2);
    expect(await events()).toHaveLength(0);
  });

  it.each(["queued", "leased", "running", "completed", "failed", "cancelled"])(
    "preserves %s status and its lease while settling only writable history",
    async (status) => {
      await db.prisma.run.update({ where: { id: f.run.id }, data: { status } });
      const resumed = status === "leased" || status === "running";
      expect(await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime)).toEqual({
        runId: resumed ? f.run.id : null,
      });
      expect(await run()).toMatchObject({
        status,
        leaseFence: 7,
        leaseOwner: "worker",
        checkpoint: resumed ? "takeover" : null,
      });
      expect((await card()).blocks).toEqual(
        status === "cancelled" ? pending : [{ ...pending[0], state: "Done" }],
      );
      expect((await computer()).controlLeaseId).toBeNull();
      expect((await events()).map((event) => event.type)).toEqual(
        status === "cancelled"
          ? ["computer.takeover.released"]
          : ["thread.message.updated", "computer.takeover.released"],
      );
      if (status === "cancelled") expect((await events())[0]?.runId).toBeNull();
    },
  );

  it.each(["lease", "computer", "space", "bot", "run"])(
    "rejects a wrong %s release and ignores a duplicate after the exact release",
    async (field) => {
      const input = releaseInput();
      const key = {
        lease: "leaseId",
        computer: "computerId",
        space: "spaceId",
        bot: "botId",
        run: "runId",
      }[field]!;
      expect(
        await finalizeComputerControlRelease(db.prisma, { ...input, [key]: "wrong" }, realtime),
      ).toBe(false);
      expect((await computer()).controlLeaseId).toBe(f.leaseId);
      expect((await card()).blocks).toEqual(pending);
      expect(await events()).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
      await finalizeComputerControlRelease(db.prisma, input, realtime);
      expect(await finalizeComputerControlRelease(db.prisma, input, realtime)).toBe(false);
      expect(await events()).toHaveLength(2);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "missing",
    "null",
    "foreign-bot",
    "foreign-space",
    "foreign-thread",
    "foreign-private-thread",
  ])("clears a %s run pointer without changing foreign history", async (kind) => {
    let runId: string | null = kind === "null" ? null : "missing-run";
    if (kind === "foreign-bot") runId = f.sibling.id;
    if (kind === "foreign-private-thread") {
      const thread = await db.prisma.thread.create({
        data: { spaceId: f.space.id, userId: f.userId, botId: f.otherBot.id },
      });
      await db.prisma.run.update({ where: { id: f.run.id }, data: { threadId: thread.id } });
      await db.prisma.message.update({ where: { id: f.card.id }, data: { threadId: thread.id } });
      runId = f.run.id;
    }
    if (kind === "foreign-space" || kind === "foreign-thread") {
      const other = await fixture();
      publish.mockClear();
      if (kind === "foreign-space") runId = other.run.id;
      else {
        await db.prisma.run.update({
          where: { id: f.run.id },
          data: { threadId: other.groupThread.id },
        });
        runId = f.run.id;
      }
    }
    await db.prisma.computer.update({
      where: { id: f.computer.id },
      data: { controlRunId: runId },
    });
    expect(
      await finalizeComputerControlRelease(db.prisma, { ...releaseInput(), runId }, realtime),
    ).toEqual({ runId: null });
    expect((await computer()).controlLeaseId).toBeNull();
    expect((await card()).blocks).toEqual(pending);
    expect((await run()).checkpoint).toBeNull();
    expect(await events()).toHaveLength(0);
    const fallback = await db.prisma.event.findMany({ where: { threadId: f.privateThread.id } });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ type: "computer.takeover.released", runId: null });
  });

  it("skips malformed and unrelated messages and repairs the same run only once", async () => {
    const otherRun = await db.prisma.run.create({
      data: {
        spaceId: f.space.id,
        userId: f.userId,
        botId: f.bot.id,
        threadId: f.groupThread.id,
        taskId: f.task.id,
        trigger: "user",
        status: "running",
      },
    });
    await db.prisma.message.createMany({
      data: [
        {
          threadId: f.groupThread.id,
          seq: 2,
          role: "bot",
          botId: f.bot.id,
          runId: f.run.id,
          blocks: { invalid: true },
        },
        {
          threadId: f.groupThread.id,
          seq: 3,
          role: "user",
          botId: f.bot.id,
          runId: f.run.id,
          blocks: pending,
        },
        {
          threadId: f.groupThread.id,
          seq: 4,
          role: "bot",
          botId: f.otherBot.id,
          runId: f.run.id,
          blocks: pending,
        },
        {
          threadId: f.groupThread.id,
          seq: 5,
          role: "bot",
          botId: f.bot.id,
          runId: f.run.id,
          blocks: [{ kind: "computer", state: "Done", text: "Earlier" }],
        },
        {
          threadId: f.groupThread.id,
          seq: 6,
          role: "bot",
          botId: f.bot.id,
          runId: f.run.id,
          blocks: [{ kind: "text", text: "Before" }, ...pending, ...pending],
        },
        {
          threadId: f.groupThread.id,
          seq: 7,
          role: "bot",
          botId: f.bot.id,
          runId: otherRun.id,
          blocks: pending,
        },
      ],
    });
    const before = await db.prisma.message.findMany({
      where: { threadId: f.groupThread.id, seq: { in: [2, 3, 4, 5, 7] } },
      orderBy: { seq: "asc" },
    });
    const notify = vi.fn(async (_threadId: string, _seq: number) => undefined);
    await settleReleasedTakeoverCards(
      db.prisma,
      { ...repairInput(), reason: "takeover-skipped" },
      notify,
    );
    await settleReleasedTakeoverCards(
      db.prisma,
      { ...repairInput(), reason: "takeover-skipped" },
      notify,
    );
    expect((await card()).blocks).toEqual([{ ...pending[0], state: "Skipped" }]);
    expect(
      await db.prisma.message.findMany({
        where: { threadId: f.groupThread.id, seq: { in: [2, 3, 4, 5, 7] } },
        orderBy: { seq: "asc" },
      }),
    ).toEqual(before);
    expect(await events()).toHaveLength(2);
    expect(notify).toHaveBeenCalledExactlyOnceWith(f.groupThread.id, 1);
  });

  it.each(["cancelled", "space", "bot", "thread", "run", "foreign-private-thread"])(
    "resume settlement refuses a %s boundary without cursor noise",
    async (kind) => {
      const input = repairInput();
      if (kind === "cancelled")
        await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
      else if (kind === "foreign-private-thread") {
        const thread = await db.prisma.thread.create({
          data: { spaceId: f.space.id, userId: f.userId, botId: f.otherBot.id },
        });
        await db.prisma.run.update({ where: { id: f.run.id }, data: { threadId: thread.id } });
        await db.prisma.message.update({ where: { id: f.card.id }, data: { threadId: thread.id } });
        input.threadId = thread.id;
      } else
        Object.assign(input, {
          [{ space: "spaceId", bot: "botId", thread: "threadId", run: "runId" }[kind]!]: "wrong",
        });
      const notify = vi.fn();
      await settleReleasedTakeoverCards(db.prisma, input, notify);
      expect((await card()).blocks).toEqual(pending);
      expect(await events()).toHaveLength(0);
      expect(
        (await db.prisma.thread.findUniqueOrThrow({ where: { id: f.groupThread.id } }))
          .nextEventSeq,
      ).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  function transactionBoundary(
    intercept: (tx: Prisma.TransactionClient) => Prisma.TransactionClient,
    failures: Array<{ code: unknown; sqlState: unknown }> = [],
  ): PrismaClient {
    return new Proxy(db.prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target
              .$transaction((tx) => callback(intercept(tx)), { timeout: 15_000 })
              .catch((error: unknown) => {
                const failure = error as {
                  code?: unknown;
                  meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
                };
                failures.push({
                  code: failure.code,
                  sqlState: failure.meta?.driverAdapterError?.cause?.originalCode,
                });
                throw error;
              });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  async function blockedWriter() {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const result = await db.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'takeover-release-fixture' AND wait_event_type = 'Lock'",
      );
      if (result.rows[0].count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected a PostgreSQL writer waiting for the held transaction lock");
  }
  function pauseAfterCard() {
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(target, key) {
            if (key !== "message") return Reflect.get(target, key);
            return new Proxy(target.message, {
              get(messages, method) {
                if (method !== "update") return Reflect.get(messages, method);
                return async (args: Parameters<typeof messages.update>[0]) => {
                  const result = await messages.update(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
    );
    return { prisma, reached, proceed };
  }

  it("rolls back lease, run, card, event and cursor together and publishes only the successful retry", async () => {
    const failed = new Error("injected event write failure");
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(target, key) {
            if (key !== "event") return Reflect.get(target, key);
            return new Proxy(target.event, {
              get(events, method) {
                return method === "create"
                  ? async () => {
                      throw failed;
                    }
                  : Reflect.get(events, method);
              },
            });
          },
        }),
    );
    await expect(finalizeComputerControlRelease(prisma, releaseInput(), realtime)).rejects.toBe(
      failed,
    );
    expect((await card()).blocks).toEqual(pending);
    expect(await computer()).toMatchObject({ controlLeaseId: f.leaseId, controlRunId: f.run.id });
    expect(await run()).toMatchObject({ status: "waiting_takeover", checkpoint: null });
    expect(await events()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime);
    expect((await events()).map((event) => event.seq)).toEqual([0, 1]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("serializes a simultaneous release and resume so the card gets one update and one notification", async () => {
    const gate = pauseAfterCard();
    const released = finalizeComputerControlRelease(gate.prisma, releaseInput(), realtime);
    await gate.reached.promise;
    const notify = vi.fn();
    const repaired = settleReleasedTakeoverCards(db.prisma, repairInput(), notify);
    try {
      await blockedWriter();
    } finally {
      gate.proceed.resolve();
    }
    await Promise.all([released, repaired]);
    expect((await events()).map((event) => event.type)).toEqual([
      "thread.message.updated",
      "computer.takeover.released",
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("serializes clear history before release without a computer/thread lock cycle", async () => {
    await db.prisma.computer.update({
      where: { id: f.computer.id },
      data: { executionRunId: f.run.id, executionBotId: f.bot.id },
    });
    const reached = deferred();
    const proceed = deferred();
    let held = false;
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "thread") return Reflect.get(client, key);
            return new Proxy(client.thread, {
              get(threads, method) {
                if (method !== "update") return Reflect.get(threads, method);
                return async (args: Parameters<typeof threads.update>[0]) => {
                  const result = await threads.update(args);
                  if (!held) {
                    held = true;
                    reached.resolve();
                    await proceed.promise;
                  }
                  return result;
                };
              },
            });
          },
        }),
    );
    const cleared = clearThread(
      prisma,
      {
        spaceId: f.space.id,
        botId: f.bot.id,
        threadId: f.groupThread.id,
        groupId: f.group.id,
      },
      realtime,
    );
    await reached.promise;
    const released = finalizeComputerControlRelease(db.prisma, releaseInput(), realtime);
    try {
      await blockedWriter();
    } finally {
      proceed.resolve();
    }
    await Promise.all([cleared, released]);
    expect((await run()).status).toBe("cancelled");
    expect(await db.prisma.message.findUnique({ where: { id: f.card.id } })).toBeNull();
    expect((await computer()).controlLeaseId).toBeNull();
    expect((await events()).map((event) => event.type)).toEqual([
      "thread.cleared",
      "computer.takeover.released",
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("serializes a takeover pause before release without a run/computer lock cycle", async () => {
    await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "running" } });
    const attempt = await db.prisma.attempt.create({
      data: { runId: f.run.id, fence: 7, status: "running" },
    });
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "run") return Reflect.get(client, key);
            return new Proxy(client.run, {
              get(runs, method) {
                if (method !== "updateMany") return Reflect.get(runs, method);
                return async (args: Parameters<typeof runs.updateMany>[0]) => {
                  const result = await runs.updateMany(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
    );
    const paused = pauseRunForTakeover(
      prisma,
      {
        spaceId: f.space.id,
        botId: f.bot.id,
        threadId: f.groupThread.id,
        runId: f.run.id,
        computerId: f.computer.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 7,
        reason: "Protected input",
      },
      realtime,
    );
    await reached.promise;
    const released = finalizeComputerControlRelease(db.prisma, releaseInput(), realtime);
    try {
      await blockedWriter();
    } finally {
      proceed.resolve();
    }
    await Promise.all([paused, released]);
    expect(await run()).toMatchObject({ status: "queued", checkpoint: "takeover", leaseFence: 7 });
    expect((await card()).blocks).toEqual([{ ...pending[0], state: "Done" }]);
    expect((await computer()).controlLeaseId).toBeNull();
    expect((await events()).map((event) => event.type)).toEqual([
      "computer.takeover.requested",
      "thread.message.updated",
      "computer.takeover.released",
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("lets release commit before clear history without leaving resurrected messages", async () => {
    await db.prisma.computer.update({
      where: { id: f.computer.id },
      data: { executionRunId: f.run.id, executionBotId: f.bot.id },
    });
    const gate = pauseAfterCard();
    const released = finalizeComputerControlRelease(gate.prisma, releaseInput(), realtime);
    await gate.reached.promise;
    const cleared = clearThread(
      db.prisma,
      { spaceId: f.space.id, botId: f.bot.id, threadId: f.groupThread.id, groupId: f.group.id },
      realtime,
    );
    try {
      await blockedWriter();
    } finally {
      gate.proceed.resolve();
    }
    await Promise.all([released, cleared]);
    expect((await run()).status).toBe("cancelled");
    expect(await db.prisma.message.findUnique({ where: { id: f.card.id } })).toBeNull();
    expect((await events()).map((event) => [event.type, event.seq])).toEqual([
      ["thread.cleared", 2],
    ]);
    expect((await computer()).controlLeaseId).toBeNull();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("lets a later takeover pause mark a fresh request after the prior release commits", async () => {
    await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "running" } });
    const attempt = await db.prisma.attempt.create({
      data: { runId: f.run.id, fence: 7, status: "running" },
    });
    const gate = pauseAfterCard();
    const released = finalizeComputerControlRelease(gate.prisma, releaseInput(), realtime);
    await gate.reached.promise;
    const paused = pauseRunForTakeover(
      db.prisma,
      {
        spaceId: f.space.id,
        botId: f.bot.id,
        threadId: f.groupThread.id,
        runId: f.run.id,
        computerId: f.computer.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 7,
        reason: "Another protected input",
      },
      realtime,
    );
    try {
      await blockedWriter();
    } finally {
      gate.proceed.resolve();
    }
    await Promise.all([released, paused]);
    expect(await run()).toMatchObject({ status: "waiting_takeover", checkpoint: null });
    expect((await card()).blocks).toEqual([{ ...pending[0], state: "Done" }]);
    expect(await computer()).toMatchObject({
      controlLeaseId: null,
      controlRunId: f.run.id,
      controlHolder: "none",
    });
    expect((await events()).map((event) => event.type)).toEqual([
      "thread.message.updated",
      "computer.takeover.released",
      "computer.takeover.requested",
    ]);
    expect(await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime)).toBe(false);
  });

  async function bindingFixture() {
    await db.prisma.computer.update({ where: { id: f.computer.id }, data: { controlRunId: null } });
    await db.prisma.computerExecutionLease.create({
      data: {
        computerId: f.computer.id,
        botId: f.bot.id,
        runId: f.run.id,
        fence: 13,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return {
      spaceId: f.space.id,
      botId: f.bot.id,
      computerId: f.computer.id,
      controlLeaseId: f.leaseId,
      controlRunId: null,
    };
  }
  const notifyBinding = (threadId: string, seq: number) =>
    createThreadEvents(db.prisma, realtime).notify(threadId, seq);

  it("binds the current execution run and grant atomically on its group thread, with no replay event", async () => {
    const input = await bindingFixture();
    const observed: unknown[] = [];
    const notify = async (threadId: string, seq: number) => {
      observed.push({
        threadId,
        seq,
        controlRunId: (await computer()).controlRunId,
        events: (await events()).map((event) => event.type),
      });
      await notifyBinding(threadId, seq);
    };
    expect(await bindWaitingTakeoverControl(db.prisma, input, notify)).toBe(true);
    expect(await bindWaitingTakeoverControl(db.prisma, input, notify)).toBe(false);
    expect(observed).toEqual([
      {
        threadId: f.groupThread.id,
        seq: 0,
        controlRunId: f.run.id,
        events: ["computer.takeover.granted"],
      },
    ]);
    expect((await events())[0]).toMatchObject({
      runId: f.run.id,
      payload: { leaseId: f.leaseId, takeoverRequested: true },
    });
    expect(await db.prisma.event.count({ where: { threadId: f.privateThread.id } })).toBe(0);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["lease", "control-run", "cancelled", "foreign-space", "foreign-private-thread"])(
    "does not bind or emit an orphan grant across a %s boundary",
    async (kind) => {
      const input = await bindingFixture();
      if (kind === "lease") input.controlLeaseId = "old-lease";
      if (kind === "control-run")
        await db.prisma.computer.update({
          where: { id: f.computer.id },
          data: { controlRunId: f.sibling.id },
        });
      if (kind === "cancelled")
        await db.prisma.run.update({ where: { id: f.run.id }, data: { status: "cancelled" } });
      if (kind === "foreign-space") input.spaceId = "wrong-space";
      if (kind === "foreign-private-thread") {
        const thread = await db.prisma.thread.create({
          data: { spaceId: f.space.id, userId: f.userId, botId: f.otherBot.id },
        });
        await db.prisma.run.update({ where: { id: f.run.id }, data: { threadId: thread.id } });
      }
      expect(await bindWaitingTakeoverControl(db.prisma, input, notifyBinding)).toBe(false);
      expect((await computer()).controlRunId).toBe(kind === "control-run" ? f.sibling.id : null);
      expect(await events()).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each(["fence", "run"])(
    "refuses a changed execution %s after its initial observation",
    async (kind) => {
      const input = await bindingFixture();
      const reached = deferred();
      const proceed = deferred();
      let reads = 0;
      const prisma = transactionBoundary(
        (tx) =>
          new Proxy(tx, {
            get(client, key) {
              if (key !== "run") return Reflect.get(client, key);
              return new Proxy(client.run, {
                get(runs, method) {
                  if (method !== "findFirst") return Reflect.get(runs, method);
                  return async (args: Parameters<typeof runs.findFirst>[0]) => {
                    const result = await runs.findFirst(args);
                    if (++reads === 2) {
                      reached.resolve();
                      await proceed.promise;
                    }
                    return result;
                  };
                },
              });
            },
          }),
      );
      const bound = bindWaitingTakeoverControl(prisma, input, notifyBinding);
      await reached.promise;
      try {
        await db.prisma.computerExecutionLease.update({
          where: { computerId_botId: { computerId: f.computer.id, botId: f.bot.id } },
          data: kind === "fence" ? { fence: 14 } : { runId: f.sibling.id },
        });
      } finally {
        proceed.resolve();
      }
      expect(await bound).toBe(false);
      expect((await computer()).controlRunId).toBeNull();
      expect(await events()).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("rolls back a binding if its same-transaction grant cannot be written", async () => {
    const input = await bindingFixture();
    const failed = new Error("grant write failed");
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "event") return Reflect.get(client, key);
            return new Proxy(client.event, {
              get(events, method) {
                return method === "create"
                  ? async () => {
                      throw failed;
                    }
                  : Reflect.get(events, method);
              },
            });
          },
        }),
    );
    await expect(bindWaitingTakeoverControl(prisma, input, notifyBinding)).rejects.toBe(failed);
    expect((await computer()).controlRunId).toBeNull();
    expect((await computer()).controlLeaseId).toBe(f.leaseId);
    expect(await events()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(await bindWaitingTakeoverControl(db.prisma, input, notifyBinding)).toBe(true);
    expect((await events())[0]?.seq).toBe(0);
  });

  it("lets binding commit before a release with the older null run pointer", async () => {
    const input = await bindingFixture();
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "computer") return Reflect.get(client, key);
            return new Proxy(client.computer, {
              get(computers, method) {
                if (method !== "updateMany") return Reflect.get(computers, method);
                return async (args: Parameters<typeof computers.updateMany>[0]) => {
                  const result = await computers.updateMany(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
    );
    const bound = bindWaitingTakeoverControl(prisma, input, notifyBinding);
    await reached.promise;
    const released = finalizeComputerControlRelease(
      db.prisma,
      { ...releaseInput(), runId: null },
      realtime,
    );
    try {
      await blockedWriter();
    } finally {
      proceed.resolve();
    }
    expect(await bound).toBe(true);
    expect(await released).toBe(false);
    expect(await computer()).toMatchObject({ controlRunId: f.run.id, controlLeaseId: f.leaseId });
    expect((await events()).map((event) => event.type)).toEqual(["computer.takeover.granted"]);
    expect(await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime)).toEqual({
      runId: f.run.id,
    });
    expect((await events()).map((event) => event.type)).toEqual([
      "computer.takeover.granted",
      "thread.message.updated",
      "computer.takeover.released",
    ]);
  });

  it("lets release commit before binding without an orphan grant or revived lease", async () => {
    const input = await bindingFixture();
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "computer") return Reflect.get(client, key);
            return new Proxy(client.computer, {
              get(computers, method) {
                if (method !== "updateMany") return Reflect.get(computers, method);
                return async (args: Parameters<typeof computers.updateMany>[0]) => {
                  const result = await computers.updateMany(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
    );
    const released = finalizeComputerControlRelease(
      prisma,
      { ...releaseInput(), runId: null },
      realtime,
    );
    await reached.promise;
    const bound = bindWaitingTakeoverControl(db.prisma, input, notifyBinding);
    try {
      await blockedWriter();
    } finally {
      proceed.resolve();
    }
    expect(await released).toEqual({ runId: null });
    expect(await bound).toBe(false);
    expect(await computer()).toMatchObject({ controlRunId: null, controlLeaseId: null });
    expect(await events()).toHaveLength(0);
    expect((await run()).status).toBe("waiting_takeover");
    const fallback = await db.prisma.event.findMany({ where: { threadId: f.privateThread.id } });
    expect(fallback.map((event) => event.type)).toEqual(["computer.takeover.released"]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(["release", "repair", "binder"])(
    "retries a rolled-back %s conflict without duplicate durable events or notifications",
    async (kind) => {
      const binding = kind === "binder" ? await bindingFixture() : null;
      let rejected = false;
      const conflict = Object.assign(new Error("injected transaction conflict after mutation"), {
        code: "P2034",
      });
      const failures: Array<{ code: unknown; sqlState: unknown }> = [];
      const prisma = transactionBoundary(
        (tx) =>
          new Proxy(tx, {
            get(client, key) {
              if (key !== "event") return Reflect.get(client, key);
              return new Proxy(client.event, {
                get(events, method) {
                  if (method !== "create") return Reflect.get(events, method);
                  return async (args: Parameters<typeof events.create>[0]) => {
                    if (!rejected) {
                      rejected = true;
                      throw conflict;
                    }
                    return events.create(args);
                  };
                },
              });
            },
          }),
        failures,
      );
      if (binding)
        expect(await bindWaitingTakeoverControl(prisma, binding, notifyBinding)).toBe(true);
      else if (kind === "repair")
        await settleReleasedTakeoverCards(prisma, repairInput(), notifyBinding);
      else await finalizeComputerControlRelease(prisma, releaseInput(), realtime);
      expect(failures).toEqual([{ code: "P2034", sqlState: undefined }]);
      expect((await events()).map((event) => [event.type, event.seq])).toEqual(
        kind === "binder"
          ? [["computer.takeover.granted", 0]]
          : kind === "repair"
            ? [["thread.message.updated", 0]]
            : [
                ["thread.message.updated", 0],
                ["computer.takeover.released", 1],
              ],
      );
      expect(publish).toHaveBeenCalledOnce();
      expect((await card()).blocks).toEqual(
        kind === "binder" ? pending : [{ ...pending[0], state: "Done" }],
      );
    },
  );

  async function privateDeletionFixture() {
    await db.prisma.run.update({
      where: { id: f.run.id },
      data: { status: "cancelled", threadId: f.privateThread.id },
    });
    await db.prisma.task.update({
      where: { id: f.task.id },
      data: { threadId: f.privateThread.id },
    });
    await db.prisma.message.update({
      where: { id: f.card.id },
      data: { threadId: f.privateThread.id },
    });
    await db.prisma.chatGroup.delete({ where: { id: f.group.id } });
    f.groupThread = f.privateThread;
  }
  function deletionBarrier(failures: Array<{ code: unknown; sqlState: unknown }>) {
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "computer") return Reflect.get(client, key);
            return new Proxy(client.computer, {
              get(computers, method) {
                if (method !== "updateMany") return Reflect.get(computers, method);
                return async (args: Parameters<typeof computers.updateMany>[0]) => {
                  const result = await computers.updateMany(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
      failures,
    );
    return { prisma, reached, proceed };
  }
  function deleteCurrentBot(prisma: PrismaClient) {
    return destroyBot(
      {
        prisma,
        sandbox: new FakeSandboxProvider(),
        home: {} as AgentHomeStore,
        jobs: {
          enqueue: vi.fn().mockResolvedValue(undefined),
          cancel: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        },
      },
      f.bot,
      {
        operationId: "delete-fixture",
        traceId: "delete-fixture",
        spaceId: f.space.id,
        userId: f.userId,
        botId: f.bot.id,
        signal: new AbortController().signal,
      },
      { deleteMemories: true },
    );
  }

  it("converges a real destroyBot/release deadlock and treats all deleted-run repairs as gone", async () => {
    await privateDeletionFixture();
    const deletionFailures: Array<{ code: unknown; sqlState: unknown }> = [];
    const releaseFailures: Array<{ code: unknown; sqlState: unknown }> = [];
    const gate = deletionBarrier(deletionFailures);
    const deleted = deleteCurrentBot(gate.prisma);
    await gate.reached.promise;
    const released = finalizeComputerControlRelease(
      transactionBoundary((tx) => tx, releaseFailures),
      releaseInput(),
      realtime,
    );
    try {
      await blockedWriter();
    } finally {
      gate.proceed.resolve();
    }
    await Promise.all([deleted, released]);
    const actualFailures = [...deletionFailures, ...releaseFailures];
    expect(
      actualFailures.some((failure) => failure.code === "P2034" || failure.sqlState === "40P01"),
    ).toBe(true);
    console.info(
      "takeover deletion deadlock retries",
      JSON.stringify({ deletion: deletionFailures, release: releaseFailures }),
    );
    expect(await db.prisma.bot.findUnique({ where: { id: f.bot.id } })).toBeNull();
    expect(await db.prisma.thread.findUnique({ where: { id: f.privateThread.id } })).toBeNull();
    expect(await db.prisma.run.findUnique({ where: { id: f.run.id } })).toBeNull();
    expect(await computer()).toMatchObject({ controlLeaseId: null, controlRunId: null });
    const notifications = publish.mock.calls.length;
    expect(await finalizeComputerControlRelease(db.prisma, releaseInput(), realtime)).toBe(false);
    await settleReleasedTakeoverCards(db.prisma, repairInput(), notifyBinding);
    expect(
      await bindWaitingTakeoverControl(
        db.prisma,
        {
          spaceId: f.space.id,
          botId: f.bot.id,
          computerId: f.computer.id,
          controlLeaseId: f.leaseId,
          controlRunId: null,
        },
        notifyBinding,
      ),
    ).toBe(false);
    expect(await events()).toHaveLength(0);
    expect(publish).toHaveBeenCalledTimes(notifications);
  });

  it("does not bind a cancelled run while the real destroyBot transaction owns the computer", async () => {
    await privateDeletionFixture();
    const input = await bindingFixture();
    const gate = deletionBarrier([]);
    const deleted = deleteCurrentBot(gate.prisma);
    await gate.reached.promise;
    try {
      expect(await bindWaitingTakeoverControl(db.prisma, input, notifyBinding)).toBe(false);
    } finally {
      gate.proceed.resolve();
    }
    await deleted;
    expect(await events()).toHaveLength(0);
    expect(await computer()).toMatchObject({ controlLeaseId: null, controlRunId: null });
    expect(publish).not.toHaveBeenCalled();
  });

  const target = () => ({
    kind: "group" as const,
    groupId: f.group.id,
    groupName: "Group",
    threadId: f.groupThread.id,
    members: [],
    memberBotIds: [f.bot.id, f.otherBot.id],
  });
  const actor = () => ({
    spaceId: f.space.id,
    userId: f.userId,
    email: "fixture@example.test",
    isDeploymentOwner: false,
  });
  const stop = (prisma = db.prisma) =>
    stopThreadRuns(
      {
        prisma,
        sandbox: new FakeSandboxProvider(),
        events: createThreadEvents(db.prisma, realtime),
      },
      actor(),
      target(),
    );

  it("lets Stop win its thread lock before release without settling cancelled cards", async () => {
    const reached = deferred();
    const proceed = deferred();
    const prisma = transactionBoundary(
      (tx) =>
        new Proxy(tx, {
          get(client, key) {
            if (key !== "run") return Reflect.get(client, key);
            return new Proxy(client.run, {
              get(runs, method) {
                if (method !== "updateManyAndReturn") return Reflect.get(runs, method);
                return async (args: Parameters<typeof runs.updateManyAndReturn>[0]) => {
                  const result = await runs.updateManyAndReturn(args);
                  reached.resolve();
                  await proceed.promise;
                  return result;
                };
              },
            });
          },
        }),
    );
    const stopped = stop(prisma);
    await reached.promise;
    const released = finalizeComputerControlRelease(db.prisma, releaseInput(), realtime);
    try {
      await blockedWriter();
    } finally {
      proceed.resolve();
    }
    await Promise.all([stopped, released]);
    expect((await run()).status).toBe("cancelled");
    expect((await card()).blocks).toEqual(pending);
    expect((await computer()).controlLeaseId).toBeNull();
    expect(
      (await events()).filter((event) => event.type === "thread.message.updated"),
    ).toHaveLength(0);
    const release = (await events()).find((event) => event.type === "computer.takeover.released");
    expect(release?.runId).toBeNull();
    await settleReleasedTakeoverCards(db.prisma, repairInput());
    expect((await card()).blocks).toEqual(pending);
  });

  it("lets release finish before a waiting Stop without reviving either group run", async () => {
    const gate = pauseAfterCard();
    const released = finalizeComputerControlRelease(gate.prisma, releaseInput(), realtime);
    await gate.reached.promise;
    const stopped = stop();
    try {
      await blockedWriter();
    } finally {
      gate.proceed.resolve();
    }
    await Promise.all([released, stopped]);
    expect((await run()).status).toBe("cancelled");
    expect((await card()).blocks).toEqual([{ ...pending[0], state: "Done" }]);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: f.sibling.id } })).status).toBe(
      "cancelled",
    );
    expect((await events()).map((event) => event.type)).toEqual([
      "thread.message.updated",
      "computer.takeover.released",
      "run.cancelled",
      "run.cancelled",
    ]);
    await settleReleasedTakeoverCards(db.prisma, repairInput());
    expect(await events()).toHaveLength(4);
  });
});
