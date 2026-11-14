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
    const db = createDb(databaseUrl!, { applicationName: "slack-first-delivery" });
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

      // Make both first deliveries reach the INSERT before either can commit.
      const blocker = await db.pool.connect();
      let deliveries: Promise<PromiseSettledResult<Response>[]> | undefined;
      let completed: PromiseSettledResult<Response>[] | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE external_conversations IN SHARE MODE");
        deliveries = Promise.allSettled([
          runtime.webhook(request("DROUTINE", at + 200)),
          runtime.webhook(request("DROUTINE", at + 200)),
        ]);
        await vi.waitFor(
          async () => {
            const waiting = await db.pool.query<{ waiting: number }>(`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE application_name = 'slack-first-delivery'
              AND wait_event_type = 'Lock' AND query LIKE '%INSERT%external_conversations%'
          `);
            expect(waiting.rows[0]?.waiting).toBe(2);
          },
          { timeout: 5_000 },
        );
      } finally {
        blocker.release(true);
        completed = await deliveries;
      }
      const duplicates = completed!.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      expect(duplicates.map(({ status }) => status)).toEqual([200, 200]);
      expect(
        await db.prisma.externalConversation.count({
          where: { workspaceId, externalKey: "DROUTINE" },
        }),
      ).toBe(1);
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

  it("keeps matching external IDs, sender authorization, and replies isolated across workspaces", async () => {
    const fixture = slackGrantFixture();
    try {
      const north = await fixture.createScope(fixture.fixtures[0]!);
      const south = await fixture.createScope(fixture.fixtures[1]!);
      const at =
        Math.max(north.installed.acceptAfter.getTime(), south.installed.acceptAfter.getTime()) + 20;
      const attempt = await fixture.installs.start(north.actor, north.bot.id);
      const state = new URL(attempt.url).searchParams.get("state")!;
      await expect(
        fixture.installs.complete(south.actor.userId, state, "fixture-North-1"),
      ).rejects.toThrow("Invalid Slack authorization");
      await fixture.installs.cancel(north.actor, attempt.attemptId);

      await fixture.deliver(north, at, { appId: "AOTHER" });
      await fixture.deliver(north, at, { workspaceId: "TUNKNOWN" });
      await fixture.deliver(north, at, { workspaceId: south.workspaceId });
      await fixture.deliver(north, at, { normalizedWorkspaceId: south.workspaceId });
      await fixture.deliver(north, at, { installerId: "UOTHER" });
      expect(await fixture.messages(north)).toEqual([]);
      expect(await fixture.messages(south)).toEqual([]);
      expect(
        await fixture.db.prisma.run.count({
          where: { botId: { in: [north.bot.id, south.bot.id] } },
        }),
      ).toBe(0);
      expect(
        await fixture.db.prisma.externalConversation.count({
          where: { botId: { in: [north.bot.id, south.bot.id] } },
        }),
      ).toBe(0);

      for (const scope of [north, south]) {
        await fixture.deliver(scope, at);
        await fixture.deliver(scope, at);
      }
      const threads = new Set<string>();
      for (const scope of [north, south]) {
        const rows = await fixture.messages(scope);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row).toMatchObject({
          providerEventId: fixture.eventId(at),
          senderId: scope.installerId,
          externalConversation: {
            externalKey: fixture.channel,
            workspaceId: scope.workspaceId,
            botId: scope.bot.id,
          },
          run: {
            botId: scope.bot.id,
            spaceId: scope.actor.spaceId,
            userId: scope.actor.userId,
            trigger: "messaging",
          },
        });
        expect(row.run!.threadId).toBe(row.externalConversation.thread?.id);
        threads.add(row.run!.threadId);
        await fixture.finish(row.run!, `Reply for ${scope.name}`);
      }
      expect(threads.size).toBe(2);

      await fixture.restart();
      await fixture.maintain();
      await fixture.maintain();
      expect(fixture.send).toHaveBeenCalledTimes(2);
      for (const scope of [north, south]) {
        const credential = `fixture-${scope.name}-1`;
        expect(fixture.send).toHaveBeenCalledWith(
          credential,
          expect.objectContaining({ threadId: fixture.thread, body: `Reply for ${scope.name}` }),
        );
        expect(await fixture.messages(scope)).toMatchObject([
          { status: "delivered", providerReplyHandle: `receipt-${credential}` },
        ]);
        expect(await fixture.db.prisma.run.count({ where: { botId: scope.bot.id } })).toBe(1);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("recovers an existing receipt but never transfers an old pending reply to a replacement grant", async () => {
    const fixture = slackGrantFixture();
    try {
      const scope = await fixture.createScope(fixture.fixtures[0]!);
      const firstAt = scope.installed.acceptAfter.getTime() + 20;
      await fixture.deliver(scope, firstAt);
      await fixture.deliver(scope, firstAt + 1);
      const before = await fixture.messages(scope);
      expect(before).toHaveLength(2);
      const [receipted, old] = before as [(typeof before)[number], (typeof before)[number]];
      expect(receipted.run).not.toBeNull();
      expect(old.run).not.toBeNull();
      await fixture.finish(receipted.run!, "Already accepted");
      await fixture.db.prisma.externalMessage.update({
        where: { id: receipted.id },
        data: {
          status: "delivering",
          providerReplyHandle: "saved-receipt",
          nextAttemptAt: new Date(0),
        },
      });
      await fixture.restart();
      await fixture.maintain();
      const unchanged = await fixture.installs.activeByWorkspace(scope.workspaceId);
      expect(unchanged).toMatchObject({
        id: scope.installed.id,
        revision: scope.installed.revision,
        acceptAfter: scope.installed.acceptAfter,
      });
      expect((await fixture.messages(scope))[0]).toMatchObject({
        id: receipted.id,
        status: "delivered",
        providerReplyHandle: "saved-receipt",
      });
      expect(fixture.send).not.toHaveBeenCalled();

      const staleReceivedAt = firstAt + 2;
      const previouslyUnseen = firstAt + 3;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(previouslyUnseen));
      await fixture.installs.pause(scope.actor, {
        id: scope.installed.id,
        expectedRevision: scope.installed.revision,
        paused: true,
      });
      expect((await fixture.installs.list(scope.actor))[0]).toMatchObject({
        status: "paused",
        revision: scope.installed.revision + 1,
      });
      // A process may have persisted an inbound event before dispatching it.
      const unclaimed = await fixture.db.prisma.externalMessage.create({
        data: {
          externalConversationId: old.externalConversationId,
          providerEventId: fixture.eventId(staleReceivedAt),
          senderId: scope.installerId,
          senderName: "Fixture Installer",
          content: "Interrupted before dispatch",
          status: "received",
          createdAt: new Date(staleReceivedAt),
        },
      });
      await fixture.finish(old.run!, "Old result");
      await fixture.maintain();
      expect(fixture.send).not.toHaveBeenCalled();
      await fixture.deliver(scope, Date.now() + 10, { type: "app_uninstalled" });
      const [revoked] = await fixture.installs.list(scope.actor);
      expect(revoked).toMatchObject({
        id: scope.installed.id,
        status: "revoked",
        revision: scope.installed.revision + 2,
      });

      const newGrant = await fixture.connect(scope, scope.bot.id, 2, {
        id: revoked!.id,
        expectedRevision: revoked!.revision,
      });
      expect(newGrant.revision).toBe(revoked!.revision + 1);
      expect(newGrant.acceptAfter.getTime()).toBeGreaterThan(previouslyUnseen);
      await fixture.deliver(scope, firstAt + 1);
      await fixture.deliver(scope, previouslyUnseen);
      await fixture.deliver(scope, newGrant.acceptAfter.getTime());
      await fixture.maintain();
      expect((await fixture.messages(scope)).map(({ id }) => id)).toEqual([
        receipted.id,
        old.id,
        unclaimed.id,
      ]);
      expect(fixture.send).not.toHaveBeenCalled();

      const freshAt = newGrant.acceptAfter.getTime() + 20;
      await fixture.deliver(scope, freshAt);
      const all = await fixture.messages(scope);
      expect(all).toHaveLength(4);
      const fresh = all[3]!;
      expect(fresh.run).not.toBeNull();
      expect(fresh.run!.id).not.toBe(old.run!.id);
      expect(fresh.run!.threadId).toBe(old.run!.threadId);
      await fixture.finish(fresh.run!, "Fresh result");
      await fixture.maintain();
      expect(fixture.send).toHaveBeenCalledExactlyOnceWith(
        "fixture-North-2",
        expect.objectContaining({ threadId: fixture.thread, body: "Fresh result" }),
      );
      expect(await fixture.messages(scope)).toMatchObject([
        { id: receipted.id, status: "delivered", providerReplyHandle: "saved-receipt" },
        { id: old.id, runId: old.run!.id, providerReplyHandle: null },
        { id: unclaimed.id, runId: null, providerReplyHandle: null },
        { id: fresh.id, status: "delivered", providerReplyHandle: "receipt-fixture-North-2" },
      ]);
      expect(await fixture.db.prisma.run.count({ where: { botId: scope.bot.id } })).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });
  it("delivers pending replies in receive order when Slack timestamps arrive out of order", async () => {
    const fixture = slackGrantFixture();
    try {
      const scope = await fixture.createScope(fixture.fixtures[0]!);
      const earlyEvent = scope.installed.acceptAfter.getTime() + 20;
      const lateEvent = earlyEvent + 1;
      await fixture.deliver(scope, lateEvent);
      await fixture.deliver(scope, earlyEvent);
      const rows = await fixture.messages(scope);
      expect(rows).toHaveLength(2);
      const receivedFirst = rows.find((row) => row.providerEventId === fixture.eventId(lateEvent))!;
      const receivedSecond = rows.find(
        (row) => row.providerEventId === fixture.eventId(earlyEvent),
      )!;
      expect(receivedFirst.receiveSeq).not.toBeNull();
      expect(receivedSecond.receiveSeq).not.toBeNull();
      expect(receivedFirst.receiveSeq! < receivedSecond.receiveSeq!).toBe(true);
      expect(receivedFirst.createdAt.getTime()).toBeGreaterThan(receivedSecond.createdAt.getTime());
      await fixture.finish(receivedFirst.run!, "Received first");
      await fixture.finish(receivedSecond.run!, "Received second");
      await fixture.restart();
      await fixture.maintain();
      await fixture.maintain();
      expect(fixture.send.mock.calls.map(([, outbound]) => outbound.body)).toEqual([
        "Received first",
        "Received second",
      ]);
      await fixture.deliver(scope, lateEvent);
      expect(
        (await fixture.messages(scope)).find(({ id }) => id === receivedFirst.id)?.receiveSeq,
      ).toBe(receivedFirst.receiveSeq);
      expect(fixture.send).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("drains older backlog before new replies without treating an expired grant as pending", async () => {
    const fixture = slackGrantFixture();
    try {
      const scope = await fixture.createScope(fixture.fixtures[0]!);
      const at = scope.installed.acceptAfter.getTime();
      await fixture.deliver(scope, at + 30);
      await fixture.deliver(scope, at + 20);
      await fixture.deliver(scope, at + 10);
      const rows = await fixture.messages(scope);
      const fresh = rows.find((row) => row.providerEventId === fixture.eventId(at + 30));
      const legacyEarlier = rows.find((row) => row.providerEventId === fixture.eventId(at + 10));
      const legacyLater = rows.find((row) => row.providerEventId === fixture.eventId(at + 20));
      expect(fresh?.run).not.toBeNull();
      expect(legacyEarlier?.run).not.toBeNull();
      expect(legacyLater?.run).not.toBeNull();
      await fixture.db.prisma.externalMessage.updateMany({
        where: { id: { in: [legacyEarlier!.id, legacyLater!.id] } },
        data: { receiveSeq: null },
      });
      await fixture.db.prisma.externalMessage.create({
        data: {
          externalConversationId: fresh!.externalConversationId,
          providerEventId: fixture.eventId(at),
          senderId: scope.installerId,
          senderName: "Fixture Installer",
          content: "Previous grant",
          status: "received",
          createdAt: new Date(at),
          receiveSeq: null,
        },
      });
      await fixture.finish(fresh!.run!, "New reply");
      await fixture.finish(legacyLater!.run!, "Later backlog");
      await fixture.finish(legacyEarlier!.run!, "Earlier backlog");
      await fixture.restart();
      for (let pass = 0; pass < 3; pass++) await fixture.maintain();
      expect(fixture.send.mock.calls.map(([, outbound]) => outbound.body)).toEqual([
        "Earlier backlog",
        "Later backlog",
        "New reply",
      ]);
      expect((await fixture.messages(scope))[0]).toMatchObject({ status: "received", runId: null });
      expect(await fixture.db.prisma.run.count({ where: { botId: scope.bot.id } })).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });
  it("serializes durable receipt allocation in one Slack conversation across processes", async () => {
    const beforeCommit = Promise.withResolvers<void>();
    const allowCommit = Promise.withResolvers<void>();
    let heldEventId: string | undefined;
    const fixture = slackGrantFixture(async (eventId) => {
      if (eventId === heldEventId) {
        beforeCommit.resolve();
        await allowCommit.promise;
      }
    });
    const peer = fixture.secondRuntime();
    const pending: Promise<void>[] = [];
    try {
      const scope = await fixture.createScope(fixture.fixtures[0]!);
      const at = scope.installed.acceptAfter.getTime() + 20;
      await fixture.deliver(scope, at);
      heldEventId = fixture.eventId(at + 2);
      pending.push(fixture.deliver(scope, at + 2));
      void pending[0]!.catch(() => undefined);
      await Promise.race([
        beforeCommit.promise,
        pending[0]!.then(() => {
          throw new Error("First receipt did not wait before commit");
        }),
      ]);
      pending.push(fixture.deliver(scope, at + 1, undefined, peer));
      void pending[1]!.catch(() => undefined);
      await vi.waitFor(async () => {
        const { rows } = await fixture.db.pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE application_name = 'slack-grant-recovery-peer'
             AND wait_event_type = 'Lock'`,
        );
        expect(rows).toHaveLength(1);
      });
      expect(await fixture.messages(scope)).toHaveLength(1);
      allowCommit.resolve();
      await Promise.all(pending);
      const rows = await fixture.messages(scope);
      const first = rows.find((row) => row.providerEventId === heldEventId);
      const second = rows.find((row) => row.providerEventId === fixture.eventId(at + 1));
      expect(first?.run).not.toBeNull();
      expect(second?.run).not.toBeNull();
      expect(first!.receiveSeq! < second!.receiveSeq!).toBe(true);
    } finally {
      allowCommit.resolve();
      await Promise.allSettled(pending);
      try {
        await peer.stop();
      } finally {
        await fixture.cleanup();
      }
    }
  });
});

function slackGrantFixture(afterPersist?: (eventId: string) => Promise<void>) {
  const db = createDb(databaseUrl!, { applicationName: "slack-grant-recovery" });
  const fixtures = ["North", "South"].map((name) => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    return {
      name,
      organizationId,
      workspaceId: `T${organizationId.replaceAll("-", "").toUpperCase()}`,
      installerId: name === "North" ? "UNORTH" : "USOUTH",
      actor: {
        userId,
        spaceId: randomUUID(),
        email: `${userId}@example.test`,
        isDeploymentOwner: false,
      },
    };
  });
  const signingSecret = "synthetic-workspace-signature";
  const credentialFor = (name: string, version: number) => `fixture-${name}-${version}`;
  const grants = new Map(
    fixtures.flatMap((scope) =>
      [1, 2].map((version) => [credentialFor(scope.name, version), scope] as const),
    ),
  );
  const provider = new SlackInstallProvider(
    {
      clientId: "fixture-client",
      clientSecret: "fixture-client-secret",
      signingSecret,
      redirectUri: "https://app.example.test/api/v1/messaging/install/slack/callback",
    },
    async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/users.info"))
        return Response.json({ user: { real_name: "Fixture Installer" } });
      if (path.endsWith("/auth.test")) {
        const key = new Headers(options?.headers).get("authorization")?.slice("Bearer ".length);
        return Response.json({ ok: true, team_id: grants.get(key!)?.workspaceId, user_id: "UBOT" });
      }
      expect(path).toBe("/api/oauth.v2.access");
      if (!(options?.body instanceof URLSearchParams)) throw new Error("Missing fixture code");
      const key = options.body.get("code")!;
      const scope = grants.get(key)!;
      return Response.json({
        ok: true,
        token_type: "bot",
        app_id: "AFIXTURE",
        access_token: key,
        scope: SLACK_INSTALL_SCOPES.join(","),
        team: { id: scope.workspaceId, name: scope.name },
        authed_user: { id: scope.installerId },
        bot_user_id: "UBOT",
      });
    },
  );
  const send = vi.fn(
    async (credential: string, outbound: Parameters<MessagingSurface["sendToThread"]>[0]) => {
      expect(await outbound.beforeSubmit?.()).toBe(true);
      return { handle: `receipt-${credential}` };
    },
  );
  const channel = "DFIXTURE";
  const thread = `slack:${channel}:123`;
  let normalizedWorkspaceId: string | undefined;
  vi.spyOn(provider, "surface").mockImplementation((credential) => {
    let sink: (event: MessagingInboundEvent) => Promise<void>;
    return {
      describe: vi.fn(),
      platforms: vi.fn(),
      openDirectThread: vi.fn(),
      sendTyping: vi.fn(),
      onInbound: (callback) => {
        sink = callback;
      },
      handleWebhook: async (platform, request) => {
        expect(platform).toBe("slack");
        const envelope = (await request.json()) as {
          team_id: string;
          event: { ts: string; text: string; channel: string; user: string };
        };
        await sink({
          type: "message",
          provider: "slack",
          workspaceId: normalizedWorkspaceId ?? envelope.team_id,
          handle: envelope.event.ts,
          from: envelope.event.user,
          fromLabel: null,
          threadId: thread,
          conversationKey: envelope.event.channel,
          isDirect: true,
          content: envelope.event.text,
          mediaUrl: null,
          channelName: null,
          participants: [],
        });
        return new Response(null, { status: 200 });
      },
      sendToThread: (outbound) => send(credential, outbound),
    };
  });
  const store = new EncryptedSecretStore("synthetic-workspace-key");
  const put = store.put.bind(store);
  const credentials = new Set<string>();
  vi.spyOn(store, "put").mockImplementation((secret, context, options) => {
    credentials.add(context.operationId);
    return put(secret, context, options);
  });
  const installs = new MessagingInstallations(db.prisma, store, provider);
  const instrumented = afterPersist
    ? db.prisma.$extends({
        query: {
          externalMessage: {
            async upsert({ args, query }) {
              const row = await query(args);
              await afterPersist(row.providerEventId);
              return row;
            },
          },
        },
      })
    : db.prisma;
  const deps = {
    prisma: instrumented as typeof db.prisma,
    artifacts: {} as ArtifactStore,
    events: createThreadEvents(db.prisma),
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  let runtime = new SlackWorkspaceMessaging(installs, provider, deps);
  let peerDb: typeof db | undefined;
  // Half a millisecond avoids floating point rounding below the intended boundary.
  const eventId = (at: number) => `${(at / 1000).toFixed(3)}5`;
  async function deliver(
    scope: (typeof fixtures)[number],
    at: number,
    overrides?: {
      workspaceId?: string;
      normalizedWorkspaceId?: string;
      installerId?: string;
      appId?: string;
      type?: "app_uninstalled";
    },
    instance = runtime,
  ) {
    const stamp = eventId(at);
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: overrides?.appId ?? "AFIXTURE",
      team_id: overrides?.workspaceId ?? scope.workspaceId,
      event_time: Math.floor(at / 1000),
      event: {
        type: overrides?.type ?? "message",
        event_ts: stamp,
        ts: stamp,
        text: "Fixture task",
        user: overrides?.installerId ?? scope.installerId,
        channel,
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    normalizedWorkspaceId = overrides?.normalizedWorkspaceId;
    try {
      const response = await instance.webhook(
        new Request("https://app.example.test/slack/events", {
          method: "POST",
          body,
          headers: {
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": `v0=${signature}`,
          },
        }),
      );
      expect(response.status).toBe(200);
    } finally {
      normalizedWorkspaceId = undefined;
    }
  }
  async function connect(
    scope: (typeof fixtures)[number],
    botId: string,
    version: number,
    reconnect?: { id: string; expectedRevision: number },
  ) {
    const attempt = await installs.start(scope.actor, botId, reconnect);
    const state = new URL(attempt.url).searchParams.get("state")!;
    expect(
      await installs.complete(scope.actor.userId, state, credentialFor(scope.name, version)),
    ).toBe(true);
    const row = await installs.activeByWorkspace(scope.workspaceId);
    expect(row).not.toBeNull();
    return row!;
  }
  async function createScope(scope: (typeof fixtures)[number]) {
    const {
      actor: { userId, spaceId, email },
      organizationId,
    } = scope;
    const member = { userId, organizationId, role: "owner" as const, createdAt: new Date() };
    await db.prisma.user.create({ data: { id: userId, email, name: scope.name } });
    await db.prisma.organization.create({
      data: { id: organizationId, name: scope.name, slug: organizationId, createdAt: new Date() },
    });
    await db.prisma.member.create({ data: { ...member, id: randomUUID() } });
    await db.prisma.space.create({ data: { id: spaceId, organizationId, name: scope.name } });
    await db.prisma.spaceMember.create({ data: { ...member, id: randomUUID(), spaceId } });
    const bot = await db.prisma.bot.create({
      data: { userId, spaceId, name: scope.name, color: "slate" },
    });
    const installed = await connect(scope, bot.id, 1);
    return { ...scope, bot, installed };
  }
  const messages = (scope: (typeof fixtures)[number]) =>
    db.prisma.externalMessage.findMany({
      where: { externalConversation: { workspaceId: scope.workspaceId } },
      include: {
        run: true,
        externalConversation: { include: { thread: { select: { id: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });
  async function finish(
    run: NonNullable<Awaited<ReturnType<typeof messages>>[number]["run"]>,
    text: string,
  ) {
    await createThreadMessage(db.prisma, {
      runId: run.id,
      threadId: run.threadId,
      botId: run.botId,
      role: "bot",
      blocks: [{ kind: "text", text }],
    });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: new Date() },
    });
  }
  async function cleanup() {
    const users = fixtures.map((scope) => scope.actor.userId);
    try {
      await runtime.stop();
      await db.prisma.messagingInstallSession.deleteMany({ where: { userId: { in: users } } });
      await db.prisma.messagingCredentialCleanup.deleteMany({
        where: { id: { in: [...credentials] } },
      });
      await db.prisma.messagingInstallation.deleteMany({
        where: { workspaceId: { in: fixtures.map((scope) => scope.workspaceId) } },
      });
      await db.prisma.organization.deleteMany({
        where: { id: { in: fixtures.map((scope) => scope.organizationId) } },
      });
      await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      try {
        await peerDb?.prisma.$disconnect();
        await peerDb?.pool.end();
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  }
  return {
    db,
    fixtures,
    installs,
    connect,
    createScope,
    deliver,
    eventId,
    messages,
    finish,
    send,
    channel,
    thread,
    cleanup,
    maintain: () => (runtime as unknown as { maintain(): Promise<void> }).maintain(),
    secondRuntime: () => {
      peerDb = createDb(databaseUrl!, { applicationName: "slack-grant-recovery-peer" });
      return new SlackWorkspaceMessaging(
        new MessagingInstallations(peerDb.prisma, store, provider),
        provider,
        { ...deps, prisma: peerDb.prisma, events: createThreadEvents(peerDb.prisma) },
      );
    },
    restart: async () => {
      await runtime.stop();
      runtime = new SlackWorkspaceMessaging(installs, provider, deps);
    },
  };
}
