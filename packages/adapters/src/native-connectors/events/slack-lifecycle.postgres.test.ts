import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withSecretPersistence } from "../../secret-persistence.js";
import { EncryptedSecretStore } from "../../secrets.js";
import { NativeSlackHookStore } from "./slack-hooks.js";
import { applyNativeSlackLifecycle } from "./slack-lifecycle.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const signingSecret = "synthetic-slack-lifecycle-signing-secret";
describePostgres("Slack lifecycle exact-grant receipts (PostgreSQL)", () => {
  let client: ReturnType<typeof createDb>, db: ReturnType<typeof withSecretPersistence>;
  const vault = new EncryptedSecretStore("synthetic-slack-lifecycle-master-key"),
    suffix = randomUUID(),
    org = `slack-lifecycle-org-${suffix}`,
    userId = `slack-lifecycle-owner-${suffix}`,
    spaceId = `slack-lifecycle-space-${suffix}`,
    configIds: string[] = [];
  const context: AdapterContext = {
    userId,
    spaceId,
    operationId: "synthetic-slack-lifecycle",
    traceId: randomUUID(),
    signal: new AbortController().signal,
  };
  beforeAll(async () => {
    client = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "slack-lifecycle-test",
    });
    db = withSecretPersistence(client.prisma, vault);
    await db.organization.create({
      data: { id: org, name: "Synthetic lifecycle organization", slug: org, createdAt: new Date() },
    });
    await db.user.create({
      data: { id: userId, name: "Synthetic lifecycle user", email: `${userId}@example.test` },
    });
    await db.member.create({
      data: { id: randomUUID(), organizationId: org, userId, role: "owner", createdAt: new Date() },
    });
    await db.space.create({
      data: { id: spaceId, organizationId: org, name: "Synthetic lifecycle space" },
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
  async function config(actor = "bot") {
    const id = randomUUID();
    configIds.push(id);
    return db.nativeAppConfig.create({
      data: {
        id,
        appId: "slack",
        label: "Synthetic lifecycle app",
        ownership: "byo",
        credentialKind: actor === "bot" ? "bot_token" : "personal_token",
        callbackUri: "https://api.example.test/api/connectors/oauth/callback",
        config: { actor, scopes: [], capabilities: [], knowledgeBaseIds: [] },
      },
    });
  }
  async function fixture() {
    const cfg = await config(),
      appId = `A${randomUUID().replaceAll("-", "").toUpperCase()}`,
      now = new Date(),
      hooks = new NativeSlackHookStore(db, vault, "https://api.example.test", () => now);
    const hook = await hooks.save(
      {
        configId: cfg.id,
        appId,
        signingSecret,
        botEvents: ["message.channels", "tokens_revoked", "app_uninstalled"],
        botSubscriptionsConfirmed: true,
      },
      context,
      true,
    );
    async function accept(
      type: string,
      tokens?: { bot?: string[]; oauth?: string[] },
      extraEvent = {},
      eventId = `Ev${randomUUID().replaceAll("-", "")}`,
    ) {
      const body = {
          type: "event_callback",
          api_app_id: appId,
          team_id: "T123FIXTURE",
          event_id: eventId,
          event_time: Math.floor(now.getTime() / 1000),
          event: { type, ...(tokens ? { tokens } : {}), ...extraEvent },
        },
        raw = Buffer.from(JSON.stringify(body)),
        timestamp = String(Math.floor(now.getTime() / 1000)),
        signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
      const accepted = await hooks.accept(hook.id, raw, signature, timestamp);
      assert.ok(accepted?.kind === "lifecycle" || accepted?.kind === "event");
      return accepted;
    }
    async function grant(
      subject = "UBOTFIXTURE",
      options: {
        configId?: string;
        actor?: string;
        teamId?: string;
        appId?: string | null;
        fresh?: boolean;
        at?: Date;
      } = {},
    ) {
      const id = randomUUID(),
        connectionId = randomUUID(),
        secretId = randomUUID(),
        material = await vault.put(
          JSON.stringify({ accessToken: "synthetic-access", refreshToken: null }),
          context,
          { recordId: secretId },
        ),
        actor = options.actor ?? "bot",
        at =
          options.at ??
          (options.fresh ? new Date(now.getTime() + 1000) : new Date(now.getTime() - 10000));
      await db.secret.create({
        data: {
          id: secretId,
          ciphertext: material.ciphertext,
          userId,
          spaceId,
          kind: "native_grant",
        },
      });
      const targetConfig = options.configId ?? cfg.id,
        teamId = options.teamId ?? "T123FIXTURE",
        principal = {
          tokenType: actor,
          teamId,
          enterpriseId: null,
          ...(actor === "bot" ? { botUserId: subject } : { userId: subject }),
          ...(options.appId === null ? {} : { appId: options.appId ?? appId }),
        };
      await db.nativeOAuthGrant.create({
        data: {
          id,
          userId,
          spaceId,
          configId: targetConfig,
          configRevision: 1,
          authority: "https://slack.com",
          subject,
          tenant: teamId,
          principal,
          scopes: [],
          secretId,
          createdAt: at,
          updatedAt: at,
        },
      });
      await db.connection.create({
        data: {
          id: connectionId,
          userId,
          spaceId,
          connectorId: "native",
          provider: "slack",
          displayName: "Synthetic lifecycle account",
          status: "connected",
          nativeConfigId: targetConfig,
          nativeConfigRevision: 1,
          oauthGrantId: id,
          providerRef: id,
          metadata: { authRevision: `${id}:1` },
        },
      });
      return { id, connectionId, secretId };
    }
    const payload = (inboxId: string) => ({
      inboxId,
      hookId: hook.id,
      hookRevision: hook.revision,
    });
    return { cfg, appId, now, hooks, hook, accept, grant, payload };
  }
  it("tokens_revoked freezes only exact app/team/actor/subject old-grant snapshots", async () => {
    const f = await fixture(),
      target = await f.grant(),
      sibling = await f.grant("UOTHER"),
      wrongTeam = await f.grant("UBOTFIXTURE", { teamId: "TOTHER" }),
      user = await f.grant("UBOTFIXTURE", { actor: "user" }),
      unrelated = await f.grant("UBOTFIXTURE", { configId: (await config()).id, appId: "AOTHER" });
    const event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    assert.equal(event.kind, "lifecycle");
    const loaded = await f.hooks.loadLifecycleInbox(event.inboxId, f.hook.id, f.hook.revision);
    assert.equal(loaded!.receipt.targets.length, 1);
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 1);
    const revoked = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(revoked.authGeneration, 2);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.secretId, null);
    assert.equal(await db.secret.count({ where: { id: target.secretId } }), 0);
    for (const safe of [sibling, wrongTeam, user, unrelated])
      assert.equal(
        (await db.connection.findUniqueOrThrow({ where: { id: safe.connectionId } })).status,
        "connected",
      );
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
  });
  it("lifecycle worker retry never snapshots or revokes a newly authorized sibling", async () => {
    const f = await fixture();
    await f.grant();
    const event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    const newGrant = await f.grant("UBOTFIXTURE", { fresh: true });
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 1);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: newGrant.connectionId } })).status,
      "connected",
    );
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
  });
  it("tokenVersion CAS preserves a rotated pair after ingress snapshot", async () => {
    const f = await fixture(),
      target = await f.grant(),
      event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    await db.nativeOAuthGrant.update({
      where: { id: target.id },
      data: { tokenVersion: { increment: 1 } },
    });
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
      "connected",
    );
  });
  it("duplicate signed ingress retains its original targets after completion", async () => {
    const f = await fixture(),
      target = await f.grant(),
      eventId = `Ev${randomUUID().replaceAll("-", "")}`,
      event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] }, {}, eventId);
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 1);
    const sibling = await f.grant();
    const replay = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] }, {}, eventId);
    assert.equal(replay.inboxId, event.inboxId);
    const loaded = await f.hooks.loadLifecycleInbox(event.inboxId, f.hook.id, f.hook.revision);
    assert.deepEqual(
      loaded!.receipt.targets.map((item) => item.grantId),
      [target.id],
    );
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(replay.inboxId)), 0);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: sibling.connectionId } })).status,
      "connected",
    );
  });
  it("auth generation or connection binding replacement defeats an old receipt", async () => {
    const f = await fixture(),
      generation = await f.grant(),
      binding = await f.grant(),
      event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    await db.nativeOAuthGrant.update({
      where: { id: generation.id },
      data: { authGeneration: { increment: 1 } },
    });
    await db.connection.update({
      where: { id: generation.connectionId },
      data: { metadata: { authRevision: `${generation.id}:2` } },
    });
    await db.connection.update({
      where: { id: binding.connectionId },
      data: { metadata: { authRevision: "replaced:1" } },
    });
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
    for (const target of [generation, binding]) {
      assert.equal(
        (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
        "connected",
      );
      assert.equal(
        (await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: target.id } })).revokedAt,
        null,
      );
      assert.equal(await db.secret.count({ where: { id: target.secretId } }), 1);
    }
  });
  it("stale hook revision and disabled hook cannot apply a queued lifecycle receipt", async () => {
    const f = await fixture(),
      target = await f.grant(),
      event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    await f.hooks.disable(
      { configId: f.cfg.id, id: f.hook.id, expectedRevision: f.hook.revision },
      context,
      true,
    );
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
      "connected",
    );
  });
  it("app_uninstalled revokes proven app grants across bot/user configs while preserving another app", async () => {
    const f = await fixture(),
      bot = await f.grant(),
      userConfig = await config("user"),
      user = await f.grant("UUSERFIXTURE", { actor: "user", configId: userConfig.id }),
      other = await f.grant("UOTHER", { appId: "AOTHER", configId: (await config()).id });
    const event = await f.accept("app_uninstalled");
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 2);
    for (const target of [bot, user])
      assert.equal(
        (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
        "revoked",
      );
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: other.connectionId } })).status,
      "connected",
    );
  });
  it("static unknown app grant requires signed bot visibility before app-wide uninstall", async () => {
    const f = await fixture(),
      target = await f.grant("UBOTFIXTURE", { appId: null }),
      unknown = await f.accept("app_uninstalled");
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(unknown.inboxId)), 0);

    // Add the signed bot visibility envelope through the regular store parser (authorizations required).
    const body = {
      type: "event_callback",
      api_app_id: f.appId,
      team_id: "T123FIXTURE",
      event_id: `Ev${randomUUID().replaceAll("-", "")}`,
      event_time: Math.floor(f.now.getTime() / 1000),
      event: {
        type: "message",
        channel: "C123FIXTURE",
        channel_type: "channel",
        user: "UUSERFIXTURE",
        ts: `${Math.floor(f.now.getTime() / 1000)}.000001`,
      },
      authorizations: [
        {
          user_id: "UBOTFIXTURE",
          team_id: "T123FIXTURE",
          enterprise_id: null,
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body)),
      timestamp = String(Math.floor(f.now.getTime() / 1000)),
      signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
    await f.hooks.accept(f.hook.id, raw, signature, timestamp);
    const proven = await f.accept("app_uninstalled");
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(proven.inboxId)), 1);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
      "revoked",
    );
  });
  it("provider event timestamp excludes new or ambiguous same-second grants", async () => {
    const f = await fixture(),
      target = await f.grant("UBOTFIXTURE", { fresh: true }),
      ambiguous = await f.grant("UBOTFIXTURE", {
        at: new Date(Math.floor(f.now.getTime() / 1000) * 1000 + 1),
      }),
      boundary = await f.grant("UBOTFIXTURE", {
        at: new Date(Math.floor(f.now.getTime() / 1000) * 1000),
      }),
      event = await f.accept("tokens_revoked", { bot: ["UBOTFIXTURE"] });
    assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
      "connected",
    );
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: ambiguous.connectionId } })).status,
      "connected",
    );
    assert.equal(
      (await db.connection.findUniqueOrThrow({ where: { id: boundary.connectionId } })).status,
      "connected",
    );
  });
  it("uninstall and token revocation delivered in either order remain locally idempotent", async () => {
    for (const order of [
      ["app_uninstalled", "tokens_revoked"],
      ["tokens_revoked", "app_uninstalled"],
    ]) {
      const f = await fixture(),
        target = await f.grant();
      const jobs = [];
      for (const type of order)
        jobs.push(
          await f.accept(type, type === "tokens_revoked" ? { bot: ["UBOTFIXTURE"] } : undefined),
        );
      let total = 0;
      for (const event of jobs)
        total += await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId));
      assert.equal(total, 1);
      assert.equal(
        (await db.connection.findUniqueOrThrow({ where: { id: target.connectionId } })).status,
        "revoked",
      );
      for (const event of jobs)
        assert.equal(await applyNativeSlackLifecycle(db, f.hooks, f.payload(event.inboxId)), 0);
    }
  });
});
