import { randomUUID } from "node:crypto";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import {
  BOT_SECRET_HTTP_REQUEST_KIND,
  callClientNonce,
  formatBotSecretHttpApprovalDetail,
  runSecretKind,
} from "@rakazo/core";
import { answerRunInput, createDb, createThreadMessage, pauseRunForInput } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveThreadTarget, sendThreadMessage } from "../../../apps/api/src/thread-target.js";
import { reconcileStuckWork } from "../../adapters/src/stuck-work.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("question routing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const organizations: string[] = [];
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!, {
      poolMax: 5,
      applicationName: "question-routing-fixture",
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function fixture(
    blocks: MessageBlock[] = [{ kind: "ask", text: "Which city?", status: "pending" }],
    group = false,
  ) {
    MessageBlockSchema.array().parse(blocks);
    const id = randomUUID();
    const userId = `question-user-${id}`;
    users.push(userId);
    await db.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${id}@example.test` },
    });
    const organization = await db.prisma.organization.create({
      data: { id: `question-org-${id}`, name: "Fixture", slug: id, createdAt: new Date() },
    });
    organizations.push(organization.id);
    const space = await db.prisma.space.create({
      data: { id: `question-space-${id}`, organizationId: organization.id, name: "Fixture" },
    });
    const bot = await db.prisma.bot.create({
      data: { spaceId: space.id, userId, name: "Fixture", color: "ink" },
    });
    const otherBot = group
      ? await db.prisma.bot.create({
          data: { spaceId: space.id, userId, name: "Second", color: "ink" },
        })
      : null;
    const chatGroup = otherBot
      ? await db.prisma.chatGroup.create({
          data: {
            spaceId: space.id,
            userId,
            name: "Group",
            members: { create: [{ botId: bot.id }, { botId: otherBot.id }] },
          },
        })
      : null;
    const thread = await db.prisma.thread.create({
      data: {
        spaceId: space.id,
        userId,
        ...(chatGroup ? { groupId: chatGroup.id } : { botId: bot.id }),
      },
    });
    const identity = { spaceId: space.id, userId, botId: bot.id, threadId: thread.id };
    const task = await db.prisma.task.create({
      data: { ...identity, prompt: "Original work", status: "running" },
    });
    const run = await db.prisma.run.create({
      data: {
        ...identity,
        taskId: task.id,
        trigger: "user",
        status: "waiting_input",
        checkpoint: "original-checkpoint",
      },
    });
    const card = await createThreadMessage(db.prisma, {
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      role: "bot",
      blocks,
    });
    const enqueue = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    const actor = { spaceId: space.id, userId } as Actor;
    const target = await resolveThreadTarget(
      db.prisma,
      actor,
      chatGroup ? { groupId: chatGroup.id } : { botId: bot.id },
    );
    const send = (text: string, clientNonce = randomUUID(), mentions?: string[]) =>
      sendThreadMessage(
        { prisma: db.prisma, jobs: { enqueue } as never, events: { notify } as never },
        actor,
        target,
        { text, clientNonce, mentions },
      );
    return {
      ...identity,
      task,
      run,
      card,
      send,
      enqueue,
      notify,
      actor,
      target,
      otherBot,
      chatGroup,
    };
  }

  it.each(["screen", "voice", "clipped", "unmarked"] as const)(
    "requires an exact on-screen authenticated request approval for %s",
    async (mode) => {
      const id = randomUUID();
      const args = {
        name: "fixture_key",
        method: "POST",
        url: "https://example.org/report?q=full",
        body: '{"approved":"the whole body"}',
      };
      const detail = formatBotSecretHttpApprovalDetail(args)!;
      const f = await fixture([
        {
          kind: "ask",
          approvalEffectId: id,
          ...(mode !== "unmarked" ? { reviewMode: "screen" } : {}),
          text: "Review before secret_request",
          detail: mode === "clipped" ? detail.slice(0, -2) : detail,
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ]);
      await db.prisma.externalEffect.create({
        data: {
          id,
          runId: f.run.id,
          spaceId: f.spaceId,
          kind: "secret_request",
          idempotencyKey: id,
          status: "intended",
          request: [BOT_SECRET_HTTP_REQUEST_KIND, { id: "fixture-key", revision: "rev" }, args],
        },
      });
      const answered = await answerRunInput(db.prisma, {
        spaceId: f.spaceId,
        threadId: f.threadId,
        runId: f.run.id,
        messageId: f.card.id,
        answeredByUserId: f.userId,
        answer: "allow",
        clientNonce: mode === "voice" ? callClientNonce("fixture") : undefined,
      });
      expect(answered).toBe(mode === "screen");
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: mode === "screen" ? "approved" : "intended",
      });
    },
  );

  it("allows an owner to dismiss a legacy authenticated card without authorizing anything", async () => {
    const id = randomUUID();
    const f = await fixture([
      {
        kind: "ask",
        approvalEffectId: id,
        text: "Review before secret_request",
        status: "pending",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "always", label: "Always allow this tool" },
          { id: "deny", label: "Deny" },
        ],
      },
    ]);
    await db.prisma.externalEffect.create({
      data: {
        id,
        runId: f.run.id,
        spaceId: f.spaceId,
        kind: "secret_request",
        idempotencyKey: id,
        status: "intended",
        request: { name: "fixture_key", url: "https://example.org/items" },
      },
    });
    const answer = (value: string) =>
      answerRunInput(db.prisma, {
        spaceId: f.spaceId,
        threadId: f.threadId,
        runId: f.run.id,
        messageId: f.card.id,
        answeredByUserId: f.userId,
        answer: value,
      });
    expect(await answer("allow")).toBe(false);
    expect(await answer("always")).toBe(false);
    expect(await db.prisma.actionApprovalRule.count({ where: { spaceId: f.spaceId } })).toBe(0);
    expect(await answer("deny")).toBe(true);
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "denied",
    });
  });

  it("starts separate work after an intervening message and retires the old ordinary question", async () => {
    const f = await fixture();
    await createThreadMessage(db.prisma, {
      threadId: f.threadId,
      role: "bot",
      botId: f.botId,
      blocks: [{ kind: "text", text: "A newer conversation." }],
    });
    const sent = await f.send("Prepare another report.");
    expect(sent.runId).not.toBe(f.run.id);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled",
      checkpoint: null,
    });
    expect(await db.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
      status: "cancelled",
      prompt: "Original work",
    });
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      blocks: [
        { kind: "ask", text: "Which city?", status: "answered", answer: "Prepare another report." },
      ],
    });
    expect(sent.runIds).toEqual([sent.runId]);
  });

  it("answers the latest ordinary question on the same Run", async () => {
    const f = await fixture();
    const sent = await f.send("Paris");
    expect(sent.runId).toBe(f.run.id);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "queued",
    });
    expect(await db.prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).toMatchObject({
      prompt: "Paris",
    });
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      blocks: [{ kind: "ask", text: "Which city?", status: "answered", answer: "Paris" }],
    });
    expect(f.enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    "secret",
    "approval",
    "plain-secret",
    "secret-plain",
    "plain-approval",
    "approval-plain",
  ])("preserves %s cards and effects when unrelated work starts", async (kind) => {
    const effectId = randomUUID();
    const ordinary = { kind: "ask" as const, text: "Ordinary", status: "pending" as const };
    const protectedAsk: MessageBlock = {
      kind: "ask",
      text: "Protected",
      status: "pending",
      ...(kind.includes("secret")
        ? { input: "secret" as const }
        : { approvalEffectId: effectId, actions: [{ id: "allow", label: "Allow" }] }),
    };
    const blocks = kind.startsWith("plain-")
      ? [ordinary, protectedAsk]
      : kind.endsWith("-plain")
        ? [protectedAsk, ordinary]
        : [protectedAsk];
    const f = await fixture(blocks);
    const effect = await db.prisma.externalEffect.create({
      data: {
        id: effectId,
        spaceId: f.spaceId,
        runId: f.run.id,
        kind: "request_secret",
        idempotencyKey: effectId,
        status: "intended",
        request: {},
      },
    });
    await createThreadMessage(db.prisma, {
      threadId: f.threadId,
      role: "bot",
      botId: f.botId,
      blocks: [{ kind: "text", text: "Newer context" }],
    });
    const before = await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } });
    const sent = await f.send("allow");
    expect(sent.runId).not.toBe(f.run.id);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(before);
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      blocks,
    });
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).toEqual(
      effect,
    );
  });

  it("retires only the old ordinary Run's internal checkpoint and temporary input", async () => {
    const f = await fixture();
    const checkpoint = await db.prisma.externalEffect.create({
      data: {
        spaceId: f.spaceId,
        runId: f.run.id,
        kind: "runtime_checkpoint",
        status: "runtime_checkpoint",
        idempotencyKey: JSON.stringify(["runtime_checkpoint", f.run.id]),
        request: { blob: "unstarted tail" },
      },
    });
    const real = await db.prisma.externalEffect.create({
      data: {
        spaceId: f.spaceId,
        runId: f.run.id,
        kind: "send_email",
        status: "completed",
        idempotencyKey: randomUUID(),
        request: { subject: "Already sent" },
        result: { delivered: true },
      },
    });
    const temporary = await db.prisma.secret.create({
      data: {
        spaceId: f.spaceId,
        userId: f.userId,
        kind: runSecretKind(f.run.id),
        ciphertext: "synthetic-temporary",
      },
    });
    const unrelated = await db.prisma.secret.create({
      data: {
        spaceId: f.spaceId,
        userId: f.userId,
        kind: "model-key",
        ciphertext: "synthetic-retained",
      },
    });
    await createThreadMessage(db.prisma, {
      threadId: f.threadId,
      role: "bot",
      botId: f.botId,
      blocks: [{ kind: "text", text: "Newer context" }],
    });
    await f.send("New task");
    expect(await db.prisma.externalEffect.findUnique({ where: { id: checkpoint.id } })).toBeNull();
    expect(await db.prisma.secret.findUnique({ where: { id: temporary.id } })).toBeNull();
    expect(await db.prisma.secret.findUniqueOrThrow({ where: { id: unrelated.id } })).toEqual(
      unrelated,
    );
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: real.id } })).toEqual(
      real,
    );
  });

  it("routes a group to new work while preserving the ordinary question history", async () => {
    const f = await fixture(undefined, true);
    await createThreadMessage(db.prisma, {
      threadId: f.threadId,
      role: "bot",
      botId: f.otherBot!.id,
      blocks: [{ kind: "text", text: "Another bot replied" }],
    });
    const sent = await f.send("Everyone, prepare the report.", randomUUID(), [
      f.botId,
      f.otherBot!.id,
    ]);
    expect(sent.runIds).toHaveLength(2);
    expect(sent.runIds).not.toContain(f.run.id);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      blocks: [
        {
          kind: "ask",
          text: "Which city?",
          status: "answered",
          answer: "Everyone, prepare the report.",
        },
      ],
    });
  });

  it("releases the old execution lease within the input pause transaction", async () => {
    const f = await fixture();
    const computer = await db.prisma.computer.create({
      data: {
        spaceId: f.spaceId,
        userId: f.userId,
        kind: "container",
        scopeKey: randomUUID(),
        homeKey: randomUUID(),
        state: "running",
      },
    });
    await db.prisma.bot.update({ where: { id: f.botId }, data: { computerId: computer.id } });
    await db.prisma.run.update({
      where: { id: f.run.id },
      data: {
        status: "running",
        leaseOwner: "old-worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    const attempt = await db.prisma.attempt.create({
      data: { runId: f.run.id, fence: 7, status: "running" },
    });
    const lease = await db.prisma.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: f.botId,
        runId: f.run.id,
        fence: 9,
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    const paused = await pauseRunForInput(db.prisma, {
      spaceId: f.spaceId,
      threadId: f.threadId,
      botId: f.botId,
      runId: f.run.id,
      attemptId: attempt.id,
      leaseOwner: "old-worker",
      leaseFence: 7,
      blocks: [{ kind: "ask", text: "Waiting", status: "pending" }],
    });
    expect(paused).toBe(true);
    expect(
      (
        await db.prisma.computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } })
      ).expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });
  it.each(["secret", "approval"])(
    "keeps the latest %s card pending when composer text starts new work",
    async (kind) => {
      const effectId = randomUUID();
      const protectedAsk: MessageBlock = {
        kind: "ask",
        text: "Protected",
        status: "pending",
        ...(kind === "secret"
          ? { input: "secret" as const }
          : {
              approvalEffectId: effectId,
              actions: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            }),
      };
      const f = await fixture([protectedAsk]);
      const effect = await db.prisma.externalEffect.create({
        data: {
          id: effectId,
          spaceId: f.spaceId,
          runId: f.run.id,
          kind: "request_secret",
          idempotencyKey: effectId,
          status: "intended",
          request: {},
        },
      });
      const sent = await f.send("continue");
      expect(sent.runId).not.toBe(f.run.id);
      expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject(
        { blocks: [protectedAsk] },
      );
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
      ).toEqual(effect);
    },
  );

  it.each(["secret", "approval"])(
    "answers only the ordinary first block of a latest mixed %s card",
    async (kind) => {
      const effectId = randomUUID();
      const ordinary: MessageBlock = { kind: "ask", text: "Ordinary", status: "pending" };
      const protectedAsk: MessageBlock = {
        kind: "ask",
        text: "Protected",
        status: "pending",
        ...(kind === "secret"
          ? { input: "secret" as const }
          : {
              approvalEffectId: effectId,
              actions: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            }),
      };
      const f = await fixture([ordinary, protectedAsk]);
      const effect = await db.prisma.externalEffect.create({
        data: {
          id: effectId,
          spaceId: f.spaceId,
          runId: f.run.id,
          kind: "request_secret",
          idempotencyKey: effectId,
          status: "intended",
          request: {},
        },
      });
      expect((await f.send("continue")).runId).toBe(f.run.id);
      expect(await db.prisma.message.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject(
        { blocks: [{ ...ordinary, status: "answered", answer: "continue" }, protectedAsk] },
      );
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } }),
      ).toEqual(effect);
    },
  );

  it("serializes simultaneous same-nonce sends behind the real thread lock", async () => {
    const f = await fixture();
    await createThreadMessage(db.prisma, {
      threadId: f.threadId,
      botId: f.botId,
      role: "bot",
      blocks: [{ kind: "text", text: "Newer context" }],
    });
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${f.threadId} FOR UPDATE`;
      entered();
      await hold;
    });
    await locked;
    const nonce = randomUUID();
    const sends = [f.send("New report", nonce), f.send("New report", nonce)];
    try {
      await vi.waitFor(async () => {
        const [row] = await db.prisma.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'question-routing-fixture' AND wait_event_type = 'Lock' AND query ILIKE '%threads%'`;
        expect(row!.count).toBeGreaterThanOrEqual(2);
      });
    } finally {
      release();
      await Promise.allSettled([owner, ...sends]);
    }
    await owner;
    const [a, b] = await Promise.all(sends);
    expect(a).toEqual(b);
    expect(
      await db.prisma.message.count({ where: { threadId: f.threadId, clientNonce: nonce } }),
    ).toBe(1);
    expect(await db.prisma.run.count({ where: { threadId: f.threadId } })).toBe(2);
    expect(await db.prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } })).toBe(
      1,
    );
  });

  it.each([false, true])(
    "scans the exact takeover deadline while preserving actual user control=%s",
    async (hasScreen) => {
      const f = await fixture();
      const now = new Date();
      await db.prisma.run.update({
        where: { id: f.run.id },
        data: { status: "waiting_takeover", updatedAt: new Date(now.getTime() - 30 * 60_000) },
      });
      if (hasScreen) {
        const computer = await db.prisma.computer.create({
          data: {
            spaceId: f.spaceId,
            userId: f.userId,
            kind: "container",
            scopeKey: randomUUID(),
            homeKey: randomUUID(),
            state: "running",
            controlHolder: "none",
            controlBotId: f.botId,
            controlRunId: f.run.id,
            controlLeaseId: randomUUID(),
            controlLeaseExpiresAt: new Date(now.getTime() - 60_000),
          },
        });
        await db.prisma.bot.update({ where: { id: f.botId }, data: { computerId: computer.id } });
      }
      const deps = {
        prisma: db.prisma,
        jobs: { enqueue: f.enqueue } as never,
        events: { notify: f.notify } as never,
        batchSize: 100,
        now: new Date(now.getTime() - 1),
      };
      await reconcileStuckWork(deps);
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        "waiting_takeover",
      );
      await reconcileStuckWork({ ...deps, now });
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        hasScreen ? "waiting_takeover" : "cancelled",
      );
      await reconcileStuckWork({ ...deps, now });
      expect(
        await db.prisma.event.count({ where: { runId: f.run.id, type: "run.cancelled" } }),
      ).toBe(hasScreen ? 0 : 1);
    },
  );
});
