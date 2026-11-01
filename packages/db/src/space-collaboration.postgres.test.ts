import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  authorizeBotCollaboration,
  authorizeCollaborationRunStart,
  BotCollaborationDisabledError,
  CannotChangeCollaborationError,
  CollaborationRevisionConflictError,
  collaborationRunFields,
  settleCollaborationDelivery,
  updateSpaceCollaborationForMember,
} from "./collaboration.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { SpaceNotFoundError } from "./spaces.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("Space collaboration policy and atomic dispatch", () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let organizationId: string;
  let owner: string;
  let member: string;
  let other: string;
  let spaceId: string;
  let otherSpaceId: string;
  let sender: { id: string; threadId: string };
  let recipient: { id: string; threadId: string };
  let external: { id: string; threadId: string };
  let sourceRunId: string;

  beforeEach(async () => {
    ({ prisma, pool } = createDb(process.env.DATABASE_URL!, {
      applicationName: "space-collaboration-fixture",
    }));
    [organizationId, owner, member, other, spaceId, otherSpaceId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    for (const id of [owner, member, other]) {
      await prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.test` } });
    }
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const id of [owner, member, other]) {
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          createdAt: new Date(),
          role: id === member ? "member" : "owner",
        },
      });
    }
    for (const id of [spaceId, otherSpaceId]) {
      await prisma.space.create({ data: { id, organizationId, name: "Fixture" } });
      for (const userId of [owner, member, other]) {
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId: id,
            organizationId,
            userId,
            createdAt: new Date(),
            role: (id === spaceId ? userId === owner : userId === other) ? "owner" : "member",
          },
        });
      }
    }
    const bot = async (targetSpace: string, userId: string) => {
      const row = await prisma.bot.create({
        data: {
          spaceId: targetSpace,
          userId,
          name: "Fixture",
          color: "slate",
          thread: { create: { spaceId: targetSpace, userId } },
        },
        include: { thread: true },
      });
      if (!row.thread) throw new Error("fixture thread missing");
      return { id: row.id, threadId: row.thread.id };
    };
    sender = await bot(spaceId, owner);
    recipient = await bot(spaceId, owner);
    external = await bot(otherSpaceId, other);
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId: owner,
        botId: sender.id,
        threadId: sender.threadId,
        prompt: "Fixture",
        status: "running",
      },
    });
    sourceRunId = (
      await prisma.run.create({
        data: {
          spaceId,
          userId: owner,
          botId: sender.id,
          threadId: sender.threadId,
          taskId: task.id,
          trigger: "user",
          status: "running",
          startedAt: new Date(),
        },
      })
    ).id;
  });
  afterEach(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner, member, other] } } });
    await prisma.$disconnect();
    await pool.end();
  });

  const update = (allowed: boolean, revision: number, userId = owner, target = spaceId) =>
    updateSpaceCollaborationForMember(prisma, {
      currentSpaceId: spaceId,
      spaceId: target,
      userId,
      allowBotCollaboration: allowed,
      expectedCollaborationRevision: revision,
    });

  async function dispatch(
    options: { cross?: boolean; running?: boolean; afterAuthorize?: () => Promise<void> } = {},
  ) {
    const target = options.cross ? external : recipient;
    const targetSpaceId = options.cross ? otherSpaceId : spaceId;
    const targetUserId = options.cross ? other : owner;
    return prisma.$transaction(async (tx) => {
      const revisions = await authorizeBotCollaboration(tx, {
        sourceRunId,
        sourceSpaceId: spaceId,
        sourceThreadId: sender.threadId,
        sourceBotId: sender.id,
        sourceUserId: owner,
        targetSpaceId,
        targetThreadId: target.threadId,
        targetBotId: target.id,
        targetUserId,
        toolName: options.cross ? "message_agent" : "message_bot",
      });
      await options.afterAuthorize?.();
      const outbound = await createThreadMessageInTransaction(tx, {
        threadId: sender.threadId,
        role: "bot",
        botId: sender.id,
        runId: sourceRunId,
        blocks: [
          {
            kind: "bot_message_sent",
            toBotId: target.id,
            toBotName: "Fixture",
            text: "Delegated work",
            deliveryStatus: "waiting_peer",
          },
        ],
      });
      const inbound = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: sender.id,
            fromBotName: "Fixture",
            text: "Delegated work",
            returnToMessageId: outbound.id,
          },
        ],
      });
      const task = await tx.task.create({
        data: {
          spaceId: targetSpaceId,
          userId: targetUserId,
          botId: target.id,
          threadId: target.threadId,
          prompt: "Delegated work",
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: targetSpaceId,
          userId: targetUserId,
          botId: target.id,
          threadId: target.threadId,
          taskId: task.id,
          trigger: "bot_message",
          status: options.running ? "running" : "queued",
          startedAt: options.running ? new Date() : null,
          sourceMessageId: inbound.id,
          ...collaborationRunFields({
            origin: options.cross ? "external_agent" : "bot_peer",
            sourceRunId,
            sourceSpaceId: spaceId,
            sourceBotId: sender.id,
            sourceRevision: revisions.sourceRevision,
            targetRevision: revisions.targetRevision,
            outboundMessageId: outbound.id,
          }),
        },
      });
      return { run, outbound, inbound };
    });
  }

  it.each(["local", "source", "recipient"] as const)(
    "suppresses pending legacy returns when the %s Space closes without reclassifying history",
    async (side) => {
      const pending = [];
      for (const status of ["running", "waiting_input", "queued", "completed"] as const) {
        const delivery = await dispatch({ cross: side !== "local", running: true });
        await prisma.run.update({
          where: { id: delivery.run.id },
          data: {
            origin: "human",
            parentRunId: null,
            collaborationSourceSpaceId: null,
            collaborationSourceBotId: null,
            collaborationSourceRevision: null,
            collaborationRevision: null,
            collaborationMessageId: null,
            collaborationStatus: null,
            status,
          },
        });
        pending.push({ id: delivery.run.id, status });
      }
      const historical = await dispatch({ cross: side !== "local", running: true });
      const handledAt = new Date();
      await prisma.run.update({
        where: { id: historical.run.id },
        data: {
          origin: "human",
          collaborationStatus: null,
          status: "completed",
          botOutcomeReturnedAt: handledAt,
        },
      });
      const target = side === "recipient" ? otherSpaceId : spaceId;
      await update(false, 0, side === "recipient" ? other : owner, target);
      await update(true, 1, side === "recipient" ? other : owner, target);
      for (const expected of pending)
        expect(await prisma.run.findUniqueOrThrow({ where: { id: expected.id } })).toMatchObject({
          origin: "human",
          status: expected.status,
          collaborationStatus: "policy_disabled",
          botOutcomeReturnedAt: expect.any(Date),
        });
      expect(
        await prisma.run.findUniqueOrThrow({ where: { id: historical.run.id } }),
      ).toMatchObject({
        origin: "human",
        status: "completed",
        collaborationStatus: null,
        botOutcomeReturnedAt: handledAt,
      });
      expect(await prisma.run.findUniqueOrThrow({ where: { id: sourceRunId } })).toMatchObject({
        origin: "human",
        status: "running",
        botOutcomeReturnedAt: null,
      });
    },
  );

  it("defaults to allowed and records the owner's committed revision and audit", async () => {
    const initial = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
    expect(initial).toMatchObject({ allowBotCollaboration: true, collaborationRevision: 0 });
    expect((await update(false, 0)).policy).toMatchObject({
      spaceId,
      allowBotCollaboration: false,
      collaborationRevision: 1,
      canManageCollaboration: true,
    });
    expect(await prisma.spaceCollaborationChange.findMany({ where: { spaceId } })).toEqual([
      expect.objectContaining({
        actorUserId: owner,
        previousAllowed: true,
        allowed: false,
        revision: 1,
      }),
    ]);
  });

  it.each(["member", "organization-owner"] as const)(
    "does not let a %s edit a Space it does not own",
    async (role) => {
      await expect(update(false, 0, role === "member" ? member : other)).rejects.toBeInstanceOf(
        CannotChangeCollaborationError,
      );
      expect(await prisma.spaceCollaborationChange.count({ where: { spaceId } })).toBe(0);
    },
  );

  it("does not reveal a non-member Space or permit stale overwrites", async () => {
    await expect(update(false, 0, owner, randomUUID())).rejects.toBeInstanceOf(SpaceNotFoundError);
    await update(false, 0);
    await expect(update(true, 0)).rejects.toBeInstanceOf(CollaborationRevisionConflictError);
    expect((await update(false, 1)).policy.collaborationRevision).toBe(1);
    expect(await prisma.spaceCollaborationChange.count({ where: { spaceId } })).toBe(1);
  });

  it("allows only one concurrent writer to commit the same expected revision", async () => {
    const results = await Promise.allSettled([update(false, 0), update(false, 0)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      CollaborationRevisionConflictError,
    );
    expect(await prisma.spaceCollaborationChange.count({ where: { spaceId } })).toBe(1);
  });

  it("cancels only never-started peer deliveries and settles their sender card", async () => {
    const queued = await dispatch();
    const running = await dispatch({ running: true });
    const human = await prisma.run.create({
      data: {
        spaceId,
        userId: owner,
        botId: sender.id,
        threadId: sender.threadId,
        taskId: (
          await prisma.task.create({
            data: {
              spaceId,
              userId: owner,
              botId: sender.id,
              threadId: sender.threadId,
              prompt: "Human follow-up",
              status: "queued",
            },
          })
        ).id,
        trigger: "follow_up",
        status: "queued",
      },
    });
    const result = await update(false, 0);
    expect(result.notices.length).toBeGreaterThan(0);
    expect(await prisma.run.findUnique({ where: { id: queued.run.id } })).toMatchObject({
      status: "cancelled",
      error: "policy_disabled",
      collaborationStatus: "policy_disabled",
      botOutcomeReturnedAt: expect.any(Date),
    });
    expect(await prisma.run.findUnique({ where: { id: running.run.id } })).toMatchObject({
      status: "running",
      collaborationStatus: "policy_disabled",
    });
    expect(await prisma.run.findUnique({ where: { id: human.id } })).toMatchObject({
      status: "queued",
    });
    expect(await prisma.message.findUnique({ where: { id: queued.outbound.id } })).toMatchObject({
      blocks: [expect.objectContaining({ deliveryStatus: "policy_disabled" })],
    });
    await update(true, 1);
    expect(
      (await prisma.$transaction((tx) => authorizeCollaborationRunStart(tx, queued.run.id)))
        .allowed,
    ).toBe(false);
    await settleCollaborationDelivery(prisma, queued.run.id, "completed");
    expect(await prisma.run.findUnique({ where: { id: queued.run.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "policy_disabled",
    });
  });

  it.each(["source", "target"] as const)(
    "closing either %s Space cancels an external pending delivery",
    async (side) => {
      const queued = await dispatch({ cross: true });
      if (side === "source") await update(false, 0);
      else await update(false, 0, other, otherSpaceId);
      expect(await prisma.run.findUnique({ where: { id: queued.run.id } })).toMatchObject({
        status: "cancelled",
        collaborationStatus: "policy_disabled",
      });
    },
  );

  it("serializes a committed delivery before the closing transaction settles it", async () => {
    let admitted!: () => void;
    let release!: () => void;
    const admittedPromise = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = dispatch({
      afterAuthorize: async () => {
        admitted();
        await releasePromise;
      },
    });
    await admittedPromise;
    const closing = update(false, 0);
    let blocked = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = 'space-collaboration-fixture'
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
          ) AS waiting
        `;
        if (waiting[0]?.waiting) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      release();
    }
    const [delivered] = await Promise.all([pending, closing]);
    expect(blocked).toBe(true);
    expect(await prisma.run.findUnique({ where: { id: delivered.run.id } })).toMatchObject({
      status: "cancelled",
      collaborationStatus: "policy_disabled",
    });
  });

  it.each(["parent", "message", "membership"] as const)(
    "rejects a queued delivery with stale %s authority",
    async (kind) => {
      const peer = await dispatch();
      if (kind === "parent")
        await prisma.run.update({ where: { id: peer.run.id }, data: { parentRunId: peer.run.id } });
      if (kind === "message")
        await prisma.run.update({
          where: { id: peer.run.id },
          data: { sourceMessageId: peer.outbound.id },
        });
      if (kind === "membership")
        await prisma.spaceMember.delete({
          where: { spaceId_userId: { spaceId, userId: owner } },
        });
      expect(
        (await prisma.$transaction((tx) => authorizeCollaborationRunStart(tx, peer.run.id)))
          .allowed,
      ).toBe(false);
      expect(await prisma.run.findUnique({ where: { id: peer.run.id } })).toMatchObject({
        status: "cancelled",
        error: "policy_disabled",
      });
    },
  );

  it("keeps the existing narrower Bot tool restriction authoritative", async () => {
    await prisma.bot.update({
      where: { id: sender.id },
      data: { disabledBuiltinTools: ["message_bot"] },
    });
    await expect(dispatch()).rejects.toBeInstanceOf(BotCollaborationDisabledError);
    expect(await prisma.run.count({ where: { origin: "bot_peer", spaceId } })).toBe(0);
  });
});
