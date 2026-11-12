import { createHmac, randomUUID } from "node:crypto";
import type { ArtifactStore, MessagingInboundEvent, MessagingSurface } from "@rakazo/adapter-kit";
import {
  EncryptedSecretStore,
  MessagingInstallations,
  SLACK_INSTALL_SCOPES,
  SlackInstallProvider,
} from "@rakazo/adapters";
import {
  createDb,
  createThreadEvents,
  createThreadMessage,
  MessagingRouteAlreadyChosen,
} from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { SlackWorkspaceMessaging } from "./slack-workspace-messaging.js";
import { TeamChatBridge, teamChatMessageClientNonce } from "./team-chat-bridge.js";
import { inboundDeliveryClientNonce, messagingWakeIdempotencyKey } from "./webhook-inbound.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

postgres("installed Slack through the durable TeamChat bridge", () => {
  it("routes verified DMs, recovers their replies, and orders each conversation independently", async () => {
    const db = createDb(databaseUrl!);
    const org = randomUUID();
    const spaceId = randomUUID();
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const workspaceId = `T${org.replaceAll("-", "").toUpperCase()}`;
    const installerId = `U${org.replaceAll("-", "").toUpperCase()}`;
    const signingSecret = "synthetic-slack-install-signature";
    const provider = new SlackInstallProvider(
      {
        clientId: "fixture-client",
        clientSecret: "fixture-client-secret",
        signingSecret,
        redirectUri: "https://app.example.test/api/v1/messaging/install/slack/callback",
      },
      async (url) =>
        String(url).includes("/users.info")
          ? Response.json({ user: { real_name: "Fixture Installer" } })
          : String(url).includes("/auth.test")
            ? Response.json({ ok: true, team_id: workspaceId, user_id: "UBOT" })
            : Response.json({
                ok: true,
                token_type: "bot",
                app_id: "AFIXTURE",
                access_token: "synthetic-slack-token",
                scope: SLACK_INSTALL_SCOPES.join(","),
                team: { id: workspaceId, name: "Fixture Workspace" },
                authed_user: { id: installerId },
                bot_user_id: "UBOT",
              }),
    );
    let sink: (event: MessagingInboundEvent) => Promise<void>;
    const sendToThread = vi.fn<MessagingSurface["sendToThread"]>(async (outbound) => {
      expect(await outbound.beforeSubmit?.()).toBe(true);
      return { handle: "accepted-fixture" };
    });
    const transport = {
      onInbound: (callback: typeof sink) => {
        sink = callback;
      },
      handleWebhook: async (channel: string, request: Request) => {
        expect(channel).toBe("slack");
        const envelope = (await request.json()) as {
          event: { ts: string; text: string; channel: string; user: string; type: string };
        };
        await sink({
          type: "message",
          provider: "slack",
          workspaceId,
          handle: envelope.event.ts,
          from: envelope.event.user,
          fromLabel: "Fixture Installer",
          threadId: `slack:${envelope.event.channel}:123`,
          conversationKey: envelope.event.channel,
          isDirect: envelope.event.channel.startsWith("D"),
          ...(envelope.event.type === "app_mention" && { kind: "mention" }),
          content: envelope.event.text,
          mediaUrl: null,
          channelName: null,
          participants: [],
        });
        return new Response(null, { status: 200 });
      },
      sendToThread,
    } as unknown as ReturnType<SlackInstallProvider["surface"]>;
    vi.spyOn(provider, "surface").mockReturnValue(transport);
    const installs = new MessagingInstallations(
      db.prisma,
      new EncryptedSecretStore("synthetic-install-key"),
      provider,
    );
    const deps = {
      prisma: db.prisma,
      artifacts: {} as ArtifactStore,
      events: createThreadEvents(db.prisma),
      jobs: { enqueue: vi.fn(async () => undefined) },
    };
    let runtime = new SlackWorkspaceMessaging(installs, provider, deps);
    try {
      await db.prisma.user.create({ data: { id: userId, email, name: "Fixture" } });
      await db.prisma.organization.create({
        data: { id: org, name: "Fixture", slug: org, createdAt: new Date() },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          userId,
          organizationId: org,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await db.prisma.space.create({ data: { id: spaceId, organizationId: org, name: "Fixture" } });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          userId,
          spaceId,
          organizationId: org,
          role: "owner",
          createdAt: new Date(),
        },
      });
      const bot = await db.prisma.bot.create({
        data: { userId, spaceId, name: "Fixture Bot", color: "slate" },
      });
      const actor = { userId, spaceId, email, isDeploymentOwner: false };
      const attempt = await installs.start(actor, bot.id);
      await installs.complete(
        userId,
        new URL(attempt.url).searchParams.get("state")!,
        "fixture-code",
      );
      const installed = (await installs.activeByWorkspace(workspaceId))!;
      const at = installed.acceptAfter.getTime() + 1;
      const request = (channel = "DFIXTURE", eventAt = at, user = installerId) => {
        const providerTime = (eventAt / 1000).toFixed(3);
        const body = JSON.stringify({
          type: "event_callback",
          api_app_id: "AFIXTURE",
          team_id: workspaceId,
          event_time: Math.floor(eventAt / 1000),
          event: {
            type: channel.startsWith("D") ? "message" : "app_mention",
            event_ts: providerTime,
            ts: providerTime,
            text: "Hello fixture",
            user,
            channel,
          },
        });
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = createHmac("sha256", signingSecret)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        return new Request("https://app.example.test/api/v1/messaging/install/slack/events", {
          method: "POST",
          body,
          headers: {
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": `v0=${signature}`,
          },
        });
      };
      expect((await runtime.webhook(request())).status).toBe(200);
      expect((await runtime.webhook(request())).status).toBe(200);
      const rows = await db.prisma.externalMessage.findMany({
        where: { externalConversation: { workspaceId } },
        include: { externalConversation: { include: { thread: true } } },
      });
      expect(rows).toHaveLength(1);
      const inbound = rows[0]!;
      expect(inbound.status).toBe("running");
      expect(inbound.createdAt).toEqual(new Date(at));
      const run = await db.prisma.run.findUniqueOrThrow({ where: { id: inbound.runId! } });
      expect(run).toMatchObject({ botId: bot.id, userId, spaceId });
      await createThreadMessage(db.prisma, {
        runId: run.id,
        threadId: run.threadId,
        botId: bot.id,
        role: "bot",
        blocks: [{ kind: "text", text: "Fixture reply" }],
      });
      await db.prisma.run.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date() },
      });
      await runtime.stop();
      runtime = new SlackWorkspaceMessaging(installs, provider, deps);
      await (runtime as unknown as { maintain(): Promise<void> }).maintain();
      expect(sendToThread).toHaveBeenCalledOnce();
      expect(sendToThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "slack:DFIXTURE:123", body: "Fixture reply" }),
        expect.anything(),
      );
      expect(
        await db.prisma.externalMessage.findUnique({ where: { id: inbound.id } }),
      ).toMatchObject({
        status: "delivered",
        providerReplyHandle: "accepted-fixture",
      });
      // A stale reader cannot claim the retry or let another reply pass it.
      const bridge = new TeamChatBridge({
        ...deps,
        providerId: `slack~${installed.id}`,
        botId: bot.id,
        send: vi.fn(),
        installedSlack: {
          acceptAfter: installed.acceptAfter,
          isAvailable: async () => true,
          grant: installed,
        },
      });
      const reserve = bridge as unknown as {
        dueSlackReplies(botId: string, acceptAfter: Date, now: Date): Promise<string[]>;
        reserveDelivery(id: string): Promise<Date | undefined>;
      };
      await db.prisma.externalMessage.update({
        where: { id: inbound.id },
        data: { runId: null },
      });
      const older = await db.prisma.externalMessage.create({
        data: {
          externalConversationId: inbound.externalConversationId,
          providerEventId: "fixture-retry",
          senderId: installerId,
          senderName: "Fixture",
          content: "Older",
          status: "running",
          runId: run.id,
          createdAt: new Date(at + 1),
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      });
      const newer = await db.prisma.externalMessage.create({
        data: {
          externalConversationId: inbound.externalConversationId,
          providerEventId: "fixture-newer",
          senderId: installerId,
          senderName: "Fixture",
          content: "Newer",
          status: "running",
          createdAt: new Date(at + 2),
        },
      });
      await expect(reserve.reserveDelivery(older.id)).resolves.toBeUndefined();
      await expect(reserve.reserveDelivery(newer.id)).resolves.toBeUndefined();
      await db.prisma.externalMessage.update({
        where: { id: older.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await expect(reserve.reserveDelivery(older.id)).resolves.toBeInstanceOf(Date);
      await expect(reserve.reserveDelivery(newer.id)).resolves.toBeUndefined();
      await db.prisma.externalMessage.update({
        where: { id: older.id },
        data: { status: "delivered", runId: null },
      });
      await db.prisma.externalMessage.update({
        where: { id: newer.id },
        data: { runId: run.id },
      });
      const dueReplies = () => reserve.dueSlackReplies(bot.id, installed.acceptAfter, new Date());
      // Select B before a predecessor enters the pending lane. The reservation
      // must recheck the predecessor instead of trusting this stale selection.
      expect(await dueReplies()).toContain(newer.id);
      const nextAttemptAt = new Date(Date.now() + 60_000);
      await db.prisma.externalMessage.update({
        where: { id: older.id },
        data: { status: "received", nextAttemptAt },
      });
      expect(await dueReplies()).not.toContain(newer.id);
      await expect(reserve.reserveDelivery(newer.id)).resolves.toBeUndefined();
      await db.prisma.externalMessage.createMany({
        data: Array.from({ length: 21 }, (_, index) => ({
          externalConversationId: inbound.externalConversationId,
          providerEventId: `fixture-blocked-${index}`,
          senderId: installerId,
          senderName: "Fixture",
          content: "Waiting",
          status: "delivering",
          createdAt: new Date(at + 3 + index),
        })),
      });
      expect((await runtime.webhook(request("DOTHER", at + 30))).status).toBe(200);
      const other = await db.prisma.externalMessage.findFirstOrThrow({
        where: {
          externalConversation: { workspaceId },
          NOT: { externalConversationId: inbound.externalConversationId },
        },
        include: { run: true },
      });
      await createThreadMessage(db.prisma, {
        runId: other.run!.id,
        threadId: other.run!.threadId,
        botId: bot.id,
        role: "bot",
        blocks: [{ kind: "text", text: "Independent reply" }],
      });
      await db.prisma.run.update({
        where: { id: other.run!.id },
        data: { status: "completed", completedAt: new Date() },
      });
      await (runtime as unknown as { maintain(): Promise<void> }).maintain();
      expect(sendToThread).toHaveBeenCalledTimes(2);
      expect(sendToThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "slack:DOTHER:123", body: "Independent reply" }),
        expect.anything(),
      );
      expect(await db.prisma.externalMessage.findUnique({ where: { id: older.id } })).toMatchObject(
        {
          status: "received",
          nextAttemptAt,
        },
      );
      for (const status of ["queueing", "deferred"]) {
        await db.prisma.externalMessage.update({
          where: { id: older.id },
          data: { status },
        });
        expect(await dueReplies()).not.toContain(newer.id);
        await expect(reserve.reserveDelivery(newer.id)).resolves.toBeUndefined();
        await (runtime as unknown as { maintain(): Promise<void> }).maintain();
        expect(sendToThread).toHaveBeenCalledTimes(2);
      }
      await db.prisma.externalMessage.update({
        where: { id: older.id },
        data: { status: "ignored", nextAttemptAt: null },
      });
      await (runtime as unknown as { maintain(): Promise<void> }).maintain();
      expect(sendToThread).toHaveBeenCalledTimes(3);
      expect(sendToThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "slack:DFIXTURE:123", body: "Fixture reply" }),
        expect.anything(),
      );

      const routine = await db.prisma.routine.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          name: "Process Slack",
          prompt: "Classify the verified event",
          active: true,
          messageProvider: "slack",
          crons: [],
        },
      });
      const routeFor = async (channel: string) => {
        const row = await db.prisma.externalMessage.findFirstOrThrow({
          where: { externalConversation: { workspaceId, externalKey: channel } },
          include: { externalConversation: { include: { thread: true } } },
        });
        const runs = await db.prisma.run.findMany({
          where: { threadId: row.externalConversation.thread!.id },
          include: { task: true },
        });
        return { row, runs };
      };
      const expectRoutine = async (channel: string) => {
        const { row, runs } = await routeFor(channel);
        expect(row).toMatchObject({
          status: "ignored",
          engagementReason: "message_routine_wake",
          runId: null,
        });
        expect(runs).toHaveLength(1);
        expect(runs[0]?.trigger).toBe("webhook");
        expect(runs[0]?.task.prompt).toContain('Run routine "Process Slack":');
        expect(runs[0]?.task.prompt).toContain("<untrusted_delivery_payload>");
        return row;
      };
      const expectOrdinary = async (channel: string) => {
        const { row, runs } = await routeFor(channel);
        expect(row.status).toBe("running");
        expect(runs.map(({ trigger, id }) => [trigger, id])).toEqual([["messaging", row.runId]]);
      };
      const maintenance = () => (runtime as unknown as { maintain(): Promise<void> }).maintain();

      const duplicates = await Promise.all([
        runtime.webhook(request("DROUTINE", at + 200)),
        runtime.webhook(request("DROUTINE", at + 200)),
      ]);
      expect(duplicates.map(({ status }) => status)).toEqual([200, 200]);
      const woke = await expectRoutine("DROUTINE");

      // A stale queue owner can encounter a rearmed queueing row after a
      // different route committed. Its final transaction still sees the wake.
      await db.prisma.externalMessage.update({
        where: { id: woke.id },
        data: { status: "queueing", engagementReason: "message_teamchat_agent" },
      });
      const routineConversation = await routeFor("DROUTINE");
      const providerId = `slack~${installed.id}`;
      await expect(
        deps.events.sendUserMessage({
          spaceId,
          botId: bot.id,
          userId,
          threadId: routineConversation.row.externalConversation.thread!.id,
          blocks: [{ kind: "text", text: "Stale ordinary claim" }],
          prompt: "Stale ordinary claim",
          trigger: "messaging",
          clientNonce: teamChatMessageClientNonce(providerId, woke.providerEventId),
          teamChatClaim: {
            id: woke.id,
            route: "agent",
            installation: installed,
            competingNonce: inboundDeliveryClientNonce(
              "messaging",
              bot.id,
              messagingWakeIdempotencyKey(providerId, woke.providerEventId),
            ),
          },
        }),
      ).rejects.toBeInstanceOf(MessagingRouteAlreadyChosen);
      expect((await routeFor("DROUTINE")).runs).toHaveLength(1);

      // A process can exit after the durable wake but before settling its inbound row.
      await db.prisma.externalMessage.update({
        where: { id: woke.id },
        data: {
          status: "deferred",
          engagementReason: "message_routine_routing",
          nextAttemptAt: new Date(0),
        },
      });
      await runtime.stop();
      runtime = new SlackWorkspaceMessaging(installs, provider, deps);
      await maintenance();
      await expectRoutine("DROUTINE");

      expect((await runtime.webhook(request("DSTRANGER", at + 201, "USTRANGER"))).status).toBe(200);
      expect(
        await db.prisma.externalConversation.count({
          where: { workspaceId, externalKey: "DSTRANGER" },
        }),
      ).toBe(0);

      // The OAuth-linked installer can trigger a pure TeamChat channel, while
      // channels with a membership ledger require its current approved identity.
      await runtime.webhook(request("CPURE", at + 202));
      await expectRoutine("CPURE");
      const ledger = await db.prisma.messagingChannel.create({
        data: { provider: "slack", threadId: "slack:CGATED" },
      });
      const oldThreadLedger = await db.prisma.messagingChannel.create({
        data: { provider: "slack", threadId: "slack:CGATED:older" },
      });
      try {
        await runtime.webhook(request("CGATED", at + 203));
        await expectOrdinary("CGATED");
        const otherSpace = await db.prisma.space.create({
          data: { id: randomUUID(), organizationId: org, name: "Other Space" },
        });
        await db.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            userId,
            spaceId: otherSpace.id,
            organizationId: org,
            role: "owner",
            createdAt: new Date(),
          },
        });
        const otherBot = await db.prisma.bot.create({
          data: { userId, spaceId: otherSpace.id, name: "Other Bot", color: "slate" },
        });
        const identity = await db.prisma.messagingIdentity.create({
          data: {
            provider: "slack",
            address: installerId,
            userId,
            spaceId: otherSpace.id,
            botId: otherBot.id,
          },
        });
        const membership = await db.prisma.messagingChannelMember.create({
          data: {
            channelId: ledger.id,
            address: installerId,
            identityId: identity.id,
            status: "approved",
          },
        });
        const oldMembership = await db.prisma.messagingChannelMember.create({
          data: {
            channelId: oldThreadLedger.id,
            address: installerId,
            identityId: identity.id,
            status: "approved",
            updatedAt: new Date(0),
          },
        });
        await runtime.webhook(request("CGATED", at + 204));
        const channelRuns = () =>
          db.prisma.run.findMany({
            where: { thread: { externalConversation: { workspaceId, externalKey: "CGATED" } } },
            orderBy: { createdAt: "asc" },
            select: { trigger: true },
          });
        expect((await channelRuns()).map(({ trigger }) => trigger)).toEqual([
          "messaging",
          "messaging",
        ]);
        await db.prisma.messagingIdentity.update({
          where: { id: identity.id },
          data: { spaceId, botId: bot.id },
        });
        await runtime.webhook(request("CGATED", at + 205));
        expect((await channelRuns()).map(({ trigger }) => trigger)).toEqual([
          "messaging",
          "messaging",
          "webhook",
        ]);
        const send = deps.events.sendUserMessage;
        const probe = vi.spyOn(deps.events, "sendUserMessage");
        probe.mockImplementation(async (input) => {
          const claim = input.teamChatClaim;
          if (claim?.route !== "routine") return send(input);
          return send({
            ...input,
            teamChatClaim: {
              ...claim,
              verifySender: async (tx) => {
                const allowed = await claim.verifySender(tx);
                expect(allowed).toBe(true);
                // These locks prevent a leave or unlink from committing while
                // the verified sender's Run admission is in progress.
                await expect(
                  db.pool.query(
                    "SELECT id FROM messaging_channel_members WHERE id = $1 FOR UPDATE NOWAIT",
                    [membership.id],
                  ),
                ).rejects.toMatchObject({ code: "55P03" });
                await expect(
                  db.pool.query(
                    "SELECT id FROM messaging_channel_members WHERE id = $1 FOR UPDATE NOWAIT",
                    [oldMembership.id],
                  ),
                ).rejects.toMatchObject({ code: "55P03" });
                await expect(
                  db.pool.query(
                    "SELECT id FROM messaging_identities WHERE id = $1 FOR UPDATE NOWAIT",
                    [identity.id],
                  ),
                ).rejects.toMatchObject({ code: "55P03" });
                return allowed;
              },
            },
          });
        });
        try {
          await runtime.webhook(request("CGATED", at + 209));
          expect((await channelRuns()).map(({ trigger }) => trigger)).toEqual([
            "messaging",
            "messaging",
            "webhook",
            "webhook",
          ]);
          probe.mockImplementation(async (input) => {
            if (input.teamChatClaim?.route === "routine") {
              await db.prisma.messagingChannelMember.update({
                where: { id: oldMembership.id },
                data: { status: "left" },
              });
            }
            return send(input);
          });
          await runtime.webhook(request("CGATED", at + 210));
          expect((await channelRuns()).map(({ trigger }) => trigger)).toEqual([
            "messaging",
            "messaging",
            "webhook",
            "webhook",
            "messaging",
          ]);
        } finally {
          probe.mockRestore();
        }
        await db.prisma.messagingIdentity.delete({ where: { id: identity.id } });
      } finally {
        await db.prisma.messagingChannel.deleteMany({
          where: { id: { in: [ledger.id, oldThreadLedger.id] } },
        });
      }

      const send = deps.events.sendUserMessage;
      const intercept = vi.spyOn(deps.events, "sendUserMessage");
      const atRoutineAdmission = (change: (id: string) => Promise<unknown>) => {
        intercept.mockImplementation(async (input) => {
          if (input.teamChatClaim?.route === "routine") await change(input.teamChatClaim.id);
          return send(input);
        });
      };
      atRoutineAdmission(() =>
        db.prisma.routine.update({ where: { id: routine.id }, data: { active: false } }),
      );
      await runtime.webhook(request("DPAUSEDROUTINE", at + 206));
      await expectOrdinary("DPAUSEDROUTINE");
      await db.prisma.routine.update({ where: { id: routine.id }, data: { active: true } });

      const anotherRoutine = await db.prisma.routine.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          name: "Keep Running",
          prompt: "Handle the remaining match",
          active: true,
          messageProvider: "slack",
          crons: [],
        },
      });
      let capturedBoth = false;
      intercept.mockImplementation(async (input) => {
        if (input.teamChatClaim?.route === "routine" && !capturedBoth) {
          expect(input.routineSources?.routines.map(({ id }) => id).sort()).toEqual(
            [routine.id, anotherRoutine.id].sort(),
          );
          capturedBoth = true;
          await db.prisma.routine.update({ where: { id: routine.id }, data: { active: false } });
        }
        return send(input);
      });
      await runtime.webhook(request("DRESELECT", at + 211));
      const reselected = await routeFor("DRESELECT");
      expect(capturedBoth).toBe(true);
      expect(reselected.runs).toHaveLength(1);
      expect(reselected.runs[0]?.trigger).toBe("webhook");
      expect(reselected.runs[0]?.task.prompt).toContain('Run routine "Keep Running":');
      expect(reselected.runs[0]?.task.prompt).not.toContain('Run routine "Process Slack":');
      await db.prisma.routine.delete({ where: { id: anotherRoutine.id } });
      await db.prisma.routine.update({ where: { id: routine.id }, data: { active: true } });

      atRoutineAdmission(async (id) => {
        await db.prisma.externalMessage.update({
          where: { id },
          data: { status: "received", engagementReason: null, nextAttemptAt: null },
        });
        await maintenance();
      });
      expect((await runtime.webhook(request("DRECLAIMED", at + 207))).status).toBe(200);
      await expectOrdinary("DRECLAIMED");

      atRoutineAdmission(() =>
        installs.pause(actor, {
          id: installed.id,
          expectedRevision: installed.revision,
          paused: true,
        }),
      );
      expect((await runtime.webhook(request("DPAUSEDINSTALL", at + 208))).status).toBe(200);
      expect((await routeFor("DPAUSEDINSTALL")).runs).toHaveLength(0);
      intercept.mockRestore();
    } finally {
      await runtime.stop();
      await db.prisma.messagingIdentity.deleteMany({ where: { userId } });
      await db.prisma.messagingInstallSession.deleteMany({ where: { userId } });
      await db.prisma.messagingInstallation.deleteMany({ where: { workspaceId } });
      await db.prisma.organization.deleteMany({ where: { id: org } });
      await db.prisma.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
