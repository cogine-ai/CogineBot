import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { NativeEventAuthorizationProof } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withSecretPersistence } from "../../secret-persistence.js";
import { EncryptedSecretStore } from "../../secrets.js";
import { NativeOAuthAuthorities } from "../authorities.js";
import { NativeConfigStore } from "../config.js";
import { NativeOAuthStore } from "../oauth.js";
import { NativeNotionHookStore } from "./notion-hooks.js";
import type { NativeEventJobPublisher } from "./service.js";
import { NativeRoutineEventService } from "./service.js";
import { NativeSlackHookStore } from "./slack-hooks.js";
import { InvalidNativeSlackSignal } from "./slack-signals.js";
import { saveNativeRoutineTrigger } from "./store.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const signingSecret = "synthetic-slack-delivery-signing-secret";
const scopes = ["channels:read", "channels:history"];
type Queued = Parameters<NativeEventJobPublisher["enqueue"]>[0];

describePostgres("Slack actual service durable delivery (PostgreSQL)", () => {
  let client: ReturnType<typeof createDb>, db: ReturnType<typeof withSecretPersistence>;
  const vault = new EncryptedSecretStore("synthetic-slack-delivery-master-key"),
    suffix = randomUUID(),
    org = `slack-delivery-org-${suffix}`,
    userId = `slack-delivery-owner-${suffix}`,
    spaceId = `slack-delivery-space-${suffix}`,
    configIds: string[] = [],
    services: NativeRoutineEventService[] = [],
    authorities: NativeOAuthAuthorities[] = [];
  const context: AdapterContext = {
    userId,
    spaceId,
    operationId: "synthetic-slack-delivery",
    traceId: randomUUID(),
    signal: new AbortController().signal,
  };
  beforeAll(async () => {
    client = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "slack-delivery-test",
    });
    db = withSecretPersistence(client.prisma, vault);
    await db.organization.create({
      data: { id: org, name: "Synthetic delivery org", slug: org, createdAt: new Date() },
    });
    await db.user.create({
      data: { id: userId, name: "Synthetic delivery user", email: `${userId}@example.test` },
    });
    await db.member.create({
      data: { id: randomUUID(), organizationId: org, userId, role: "owner", createdAt: new Date() },
    });
    await db.space.create({
      data: { id: spaceId, organizationId: org, name: "Synthetic delivery space" },
    });
    await db.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: org,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  });
  afterAll(async () => {
    try {
      await Promise.all(services.map((service) => service.close()));
      await Promise.all(authorities.map((authority) => authority.close()));
      if (db) {
        await db.organization.deleteMany({ where: { id: org } });
        await db.user.deleteMany({ where: { id: userId } });
        await db.nativeAppConfig.deleteMany({ where: { id: { in: configIds } } });
      }
    } finally {
      if (client) {
        await client.prisma.$disconnect();
        await client.pool.end();
      }
      await vault.close();
    }
  });
  async function fixture() {
    const now = new Date(),
      configId = randomUUID(),
      appId = `A${randomUUID().replaceAll("-", "").toUpperCase()}`;
    configIds.push(configId);
    await db.nativeAppConfig.create({
      data: {
        id: configId,
        appId: "slack",
        label: "Synthetic delivery app",
        ownership: "byo",
        credentialKind: "bot_token",
        callbackUri: "https://api.example.test/api/connectors/oauth/callback",
        config: {
          actor: "bot",
          tenantId: "TFIXTURE",
          scopes,
          capabilities: [],
          knowledgeBaseIds: [],
        },
      },
    });
    const requests: string[] = [];
    const network = {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        assert.equal(url.origin, "https://slack.com");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer xoxb-synthetic-delivery",
        );
        requests.push(url.pathname);
        if (url.pathname === "/api/auth.test")
          return Response.json(
            {
              ok: true,
              team_id: "TFIXTURE",
              user_id: "UBOTFIXTURE",
              bot_id: "BFIXTURE",
              user: "synthetic-bot",
            },
            { headers: { "x-oauth-scopes": scopes.join(",") } },
          );
        assert.equal(url.pathname, "/api/conversations.info");
        assert.equal(url.searchParams.get("channel"), "CFIXTURE");
        return Response.json({
          ok: true,
          channel: { id: "CFIXTURE", is_member: true, is_private: false, is_archived: false },
        });
      },
    };
    const authority = new NativeOAuthAuthorities(network);
    authorities.push(authority);
    const configs = new NativeConfigStore(db, vault, "https://api.example.test"),
      oauth = new NativeOAuthStore(db, vault, configs, authority);
    const { connectionId } = await oauth.connectCollaborationToken(
      configId,
      "xoxb-synthetic-delivery",
      context,
    );
    const connection = await db.connection.findUniqueOrThrow({ where: { id: connectionId } }),
      grant = await db.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: connection.oauthGrantId! },
      });
    await db.nativeOAuthGrant.update({
      where: { id: grant.id },
      data: {
        createdAt: new Date(now.getTime() - 10000),
        updatedAt: new Date(now.getTime() - 10000),
      },
    });
    const bot = await db.bot.create({
      data: { userId, spaceId, name: "Synthetic delivery Bot", color: "ink" },
    });
    await db.thread.create({ data: { userId, spaceId, botId: bot.id } });
    const routine = await db.routine.create({
      data: {
        userId,
        spaceId,
        botId: bot.id,
        name: "Synthetic delivery Routine",
        prompt: "Read this explicitly selected Slack thread",
        active: true,
        crons: ["0 9 * * *"],
        nextRunAt: new Date(Date.now() + 86400000),
      },
    });
    const spec = {
      kind: "slack.channel_message" as const,
      channelId: "CFIXTURE",
      threadTs: `${Math.floor(now.getTime() / 1000) - 2}.000001`,
    };
    const proof: NativeEventAuthorizationProof = {
      userId,
      spaceId,
      connectionId,
      authorizationRevision: `${grant.id}:1`,
      grantId: grant.id,
      authGeneration: 1,
      configId,
      configRevision: 1,
      appId: "slack",
      resource: { type: "slack_channel", id: "CFIXTURE" },
      spec,
    };
    const trigger = await saveNativeRoutineTrigger(
      db,
      { userId, spaceId },
      routine.id,
      { input: { connectionId, spec }, proof },
      new Date(now.getTime() - 60000),
    );
    await db.nativeRoutineTrigger.update({
      where: { id: trigger.id },
      data: { nextPollAt: new Date(Date.now() + 86400000) },
    });
    const hooks = new NativeSlackHookStore(db, vault, "https://api.example.test", () => now),
      hook = await hooks.save(
        {
          configId,
          appId,
          signingSecret,
          botEvents: ["message.channels", "tokens_revoked", "app_uninstalled"],
          botSubscriptionsConfirmed: true,
        },
        context,
        true,
      );
    const queued: Queued[] = [],
      attempted: Queued[] = [];
    let rejectQueue = false;
    const jobs: NativeEventJobPublisher = {
      enqueue: async (job) => {
        attempted.push(job);
        if (rejectQueue && job.name.startsWith("native.slack."))
          throw Error("Synthetic queue unavailable");
        queued.push(job);
      },
    };
    const service = new NativeRoutineEventService(
      db,
      oauth,
      new NativeNotionHookStore(db, vault, "https://api.example.test"),
      jobs,
      { append: async () => undefined } as never,
      "https://api.example.test",
      network,
      hooks,
    );
    services.push(service);
    const eventId = `Ev${randomUUID().replaceAll("-", "")}`;
    function signed(type = "message", selectedEventId = eventId) {
      const body = {
        type: "event_callback",
        api_app_id: appId,
        team_id: "TFIXTURE",
        event_id: selectedEventId,
        event_time: Math.floor(now.getTime() / 1000),
        event:
          type === "message"
            ? {
                type,
                channel: "CFIXTURE",
                channel_type: "channel",
                user: "UUSERFIXTURE",
                ts: `${Math.floor(now.getTime() / 1000)}.000001`,
                thread_ts: spec.threadTs,
                text: "Synthetic body must not persist",
              }
            : { type, tokens: { bot: ["UBOTFIXTURE"] } },
        authorizations: [
          {
            user_id: "UBOTFIXTURE",
            team_id: "TFIXTURE",
            enterprise_id: null,
            is_bot: true,
            is_enterprise_install: false,
          },
        ],
      };
      const raw = Buffer.from(JSON.stringify(body)),
        timestamp = String(Math.floor(now.getTime() / 1000)),
        signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
      return { raw, timestamp, signature };
    }
    const ingest = (type = "message") => {
      const value = signed(type);
      return service.ingestSlack(hook.id, value.raw, value.signature, value.timestamp);
    };
    const inbox = async () =>
      db.nativeSlackEventInbox.findFirstOrThrow({ where: { hookId: hook.id, eventId } });
    const signalPayload = async () => ({
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      hookId: hook.id,
      hookRevision: hook.revision,
      inboxId: (await inbox()).id,
    });
    const ownQueued = () =>
      queued.filter(
        (job) =>
          job.name.startsWith("native.slack.") &&
          "hookId" in job.payload &&
          job.payload.hookId === hook.id,
      );
    return {
      now,
      configId,
      appId,
      connectionId,
      grant,
      hook,
      hooks,
      routine,
      trigger,
      service,
      queued,
      attempted,
      requests,
      ingest,
      inbox,
      signed,
      signalPayload,
      ownQueued,
      setQueueFailure: (value: boolean) => {
        rejectQueue = value;
      },
    };
  }
  it("signed message ACK commits sanitized inbox without calling queue, then reconciles and creates an exact thread Run", async () => {
    const f = await fixture();
    assert.deepEqual(await f.ingest(), {});
    assert.equal(f.attempted.length, 0);
    const saved = await f.inbox();
    assert.equal(saved.dispatchedAt, null);
    assert.equal(JSON.stringify(saved.signal).includes("Synthetic body"), false);
    await f.service.reconcile();
    assert.equal(f.ownQueued().length, 1);
    assert.ok((await f.inbox()).dispatchedAt);
    const delivery = f.ownQueued()[0]!;
    assert.equal(delivery.name, "native.slack.signal");
    await f.service.slackSignal(delivery.payload, new AbortController().signal);
    const run = await db.run.findFirstOrThrow({
      where: { routineId: f.routine.id },
      include: { task: true },
    });
    assert.deepEqual(run.task.connectionIds, [f.connectionId]);
    assert.ok(run.task.prompt.includes('"threadTs"'));
    assert.equal(await db.run.count({ where: { routineId: f.routine.id } }), 1);
    await f.service.slackSignal(delivery.payload, new AbortController().signal);
    assert.equal(await db.run.count({ where: { routineId: f.routine.id } }), 1);
  });
  for (const type of ["message", "tokens_revoked"])
    it(`${type} queue failure preserves pending receipt and later reconciliation repairs it`, async () => {
      const f = await fixture();
      f.setQueueFailure(true);
      await f.ingest(type);
      assert.equal(f.attempted.length, 0);
      await assert.rejects(f.service.reconcile(), /Synthetic queue unavailable/);
      assert.equal((await f.inbox()).dispatchedAt, null);
      f.setQueueFailure(false);
      await f.service.reconcile();
      assert.ok((await f.inbox()).dispatchedAt);
      assert.equal(f.ownQueued().length, 1);
      if (type === "tokens_revoked") {
        await f.service.slackLifecycle(f.ownQueued()[0]!.payload);
        assert.equal(
          (await db.connection.findUniqueOrThrow({ where: { id: f.connectionId } })).status,
          "revoked",
        );
        assert.equal(await db.run.count({ where: { routineId: f.routine.id } }), 0);
        await f.service.slackLifecycle(f.ownQueued()[0]!.payload);
      }
    });
  it("duplicate ACK before and after dispatch never enqueues inline or grows inbox", async () => {
    const f = await fixture();
    await f.ingest();
    await f.ingest();
    assert.equal(f.attempted.length, 0);
    assert.equal(await db.nativeSlackEventInbox.count({ where: { hookId: f.hook.id } }), 1);
    await f.service.reconcile();
    const size = f.ownQueued().length;
    await f.ingest();
    assert.equal(f.ownQueued().length, size);
    await f.service.reconcile();
    assert.equal(f.ownQueued().length, size);
  });
  for (const boundary of ["pause", "config", "generation"])
    it(`${boundary} change after durable ingress cannot dispatch or fire the old delivery`, async () => {
      const f = await fixture();
      await f.ingest();
      const payload = await f.signalPayload();
      if (boundary === "pause")
        await db.routine.update({ where: { id: f.routine.id }, data: { active: false } });
      else if (boundary === "config")
        await db.nativeAppConfig.update({
          where: { id: f.configId },
          data: { revision: { increment: 1 } },
        });
      else
        await db.nativeOAuthGrant.update({
          where: { id: f.grant.id },
          data: { authGeneration: { increment: 1 } },
        });
      const count = f.requests.length;
      await f.service.reconcile();
      assert.equal(f.ownQueued().length, 0);
      await f.service.slackSignal(payload, new AbortController().signal);
      assert.equal(f.requests.length, count);
      assert.equal(await db.run.count({ where: { routineId: f.routine.id } }), 0);
    });
  it("disabled hook fences its durable pending message and previously queued payload", async () => {
    const f = await fixture();
    await f.ingest();
    const payload = await f.signalPayload();
    await f.hooks.disable(
      { configId: f.configId, id: f.hook.id, expectedRevision: f.hook.revision },
      context,
      true,
    );
    await f.service.reconcile();
    assert.equal(f.ownQueued().length, 0);
    await f.service.slackSignal(payload, new AbortController().signal);
    assert.equal(await db.run.count({ where: { routineId: f.routine.id } }), 0);
  });
  it("invalid signature has no inbox or queue side effect; signed URL verification ACK remains immediate", async () => {
    const f = await fixture(),
      invalid = f.signed();
    await assert.rejects(
      f.service.ingestSlack(f.hook.id, invalid.raw, `v0=${"0".repeat(64)}`, invalid.timestamp),
      InvalidNativeSlackSignal,
    );
    assert.equal(await db.nativeSlackEventInbox.count({ where: { hookId: f.hook.id } }), 0);
    assert.equal(f.attempted.length, 0);
    const raw = Buffer.from(
        JSON.stringify({ type: "url_verification", challenge: "synthetic-challenge" }),
      ),
      timestamp = invalid.timestamp,
      signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
    assert.deepEqual(await f.service.ingestSlack(f.hook.id, raw, signature, timestamp), {
      challenge: "synthetic-challenge",
    });
    assert.equal(f.attempted.length, 0);
    assert.equal(await db.nativeSlackEventInbox.count({ where: { hookId: f.hook.id } }), 0);
  });
});
