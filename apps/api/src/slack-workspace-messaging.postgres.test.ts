import { createHmac, randomUUID } from "node:crypto";
import type { ArtifactStore, MessagingInboundEvent, MessagingSurface } from "@rakazo/adapter-kit";
import {
  EncryptedSecretStore,
  MessagingInstallations,
  SLACK_INSTALL_SCOPES,
  SlackInstallProvider,
} from "@rakazo/adapters";
import { createDb, createThreadEvents, createThreadMessage } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { SlackWorkspaceMessaging } from "./slack-workspace-messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

postgres("installed Slack through the durable TeamChat bridge", () => {
  it("routes one verified DM into a run and posts its reply to the same workspace", async () => {
    const db = createDb(databaseUrl!);
    const org = randomUUID();
    const spaceId = randomUUID();
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const workspaceId = `T${org.replaceAll("-", "").toUpperCase()}`;
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
          : Response.json({
              ok: true,
              token_type: "bot",
              access_token: "synthetic-slack-token",
              scope: SLACK_INSTALL_SCOPES.join(","),
              team: { id: workspaceId, name: "Fixture Workspace" },
              authed_user: { id: "UOWNER" },
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
        const envelope = (await request.json()) as { event: { ts: string; text: string } };
        await sink({
          type: "message",
          provider: "slack",
          workspaceId,
          handle: envelope.event.ts,
          from: "UOWNER",
          fromLabel: "Fixture Installer",
          threadId: "slack:DFIXTURE:123",
          isDirect: true,
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
    const runtime = new SlackWorkspaceMessaging(installs, provider, {
      prisma: db.prisma,
      artifacts: {} as ArtifactStore,
      events: createThreadEvents(db.prisma),
      jobs: { enqueue: vi.fn(async () => undefined) },
    });
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
      const providerTime = (at / 1000).toFixed(3);
      const body = JSON.stringify({
        type: "event_callback",
        team_id: workspaceId,
        event_time: Math.floor(at / 1000),
        event: { type: "message", event_ts: providerTime, ts: providerTime, text: "Hello fixture" },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      const request = () =>
        new Request("https://app.example.test/api/v1/messaging/install/slack/events", {
          method: "POST",
          body,
          headers: {
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": `v0=${signature}`,
          },
        });
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
    } finally {
      await runtime.stop();
      await db.prisma.messagingInstallSession.deleteMany({ where: { userId } });
      await db.prisma.messagingInstallation.deleteMany({ where: { workspaceId } });
      await db.prisma.organization.deleteMany({ where: { id: org } });
      await db.prisma.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
