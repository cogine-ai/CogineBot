import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AdapterContext, SecretContext, SecretPutOptions } from "@rakazo/adapter-kit";
import type { NativeSlackHook } from "@rakazo/contracts";
import { createDb, Prisma } from "@rakazo/db";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withSecretPersistence } from "../../secret-persistence.js";
import { EncryptedSecretStore } from "../../secrets.js";
import { NativeSlackHookStore } from "./slack-hooks.js";
import { InvalidNativeSlackSignal } from "./slack-signals.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
class RecordingVault extends EncryptedSecretStore {
  readonly live = new Map<string, string>();
  putGate?: { entered: () => void; wait: Promise<void> };
  loadGate?: { entered: () => void; wait: Promise<void> };
  override async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const row = await super.put(value, context, options);
    this.live.set(row.ciphertext, row.id);
    const gate = this.putGate;
    if (gate) {
      gate.entered();
      await gate.wait;
    }
    return row;
  }
  override async load(ciphertext: string, context: SecretContext) {
    assert.ok(this.live.has(ciphertext), "The adopted vault reference must remain available");
    const result = await super.load(ciphertext, context),
      gate = this.loadGate;
    if (gate) {
      this.loadGate = undefined;
      gate.entered();
      await gate.wait;
    }
    return result;
  }
  override async delete(ciphertext: string, context: SecretContext) {
    this.live.delete(ciphertext);
    await super.delete(ciphertext, context);
  }
}
function latch() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
const existing = (hook: NativeSlackHook) => ({
  configId: hook.configId,
  id: hook.id,
  expectedRevision: hook.revision,
});
const secret = "synthetic-slack-signing-secret-only";
function signed(body: unknown, at: Date, key = secret) {
  const raw = Buffer.from(JSON.stringify(body)),
    timestamp = String(Math.floor(at.getTime() / 1000));
  return {
    raw,
    timestamp,
    signature: `v0=${createHmac("sha256", key).update(`v0:${timestamp}:`).update(raw).digest("hex")}`,
  };
}

describePostgres("Native Slack signed inbox and secret lifecycle (PostgreSQL)", () => {
  let client: ReturnType<typeof createDb>,
    other: ReturnType<typeof createDb>,
    db: ReturnType<typeof withSecretPersistence>,
    peer: ReturnType<typeof withSecretPersistence>;
  const vault = new RecordingVault("synthetic-slack-postgres-master-key");
  const configIds: string[] = [];
  beforeAll(async () => {
    client = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-slack-hook-first",
    });
    other = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-slack-hook-peer",
    });
    db = withSecretPersistence(client.prisma, vault);
    peer = withSecretPersistence(other.prisma, vault);
    await db.$queryRaw`SELECT id FROM native_slack_event_inbox LIMIT 0`;
  });
  afterAll(async () => {
    try {
      if (db) for (const id of configIds) await db.nativeAppConfig.deleteMany({ where: { id } });
      assert.equal(vault.live.size, 0, "Only test-owned hook secret refs must be retired");
    } finally {
      await Promise.all(
        [client, other].filter(Boolean).map(async (c) => {
          try {
            await c.prisma.$disconnect();
          } finally {
            await c.pool.end();
          }
        }),
      );
      await vault.close();
    }
  });
  async function fixture(selectedActor = "bot") {
    const configId = randomUUID(),
      appId = `A${randomUUID().replaceAll("-", "").toUpperCase()}`,
      now = new Date();
    configIds.push(configId);
    const context: AdapterContext = {
      userId: randomUUID(),
      spaceId: randomUUID(),
      operationId: "synthetic-slack-hook",
      traceId: randomUUID(),
      signal: new AbortController().signal,
    };
    await db.nativeAppConfig.create({
      data: {
        id: configId,
        appId: "slack",
        label: "Synthetic Slack app",
        ownership: "byo",
        credentialKind: "bot_token",
        callbackUri: "https://app.example.test/api/connectors/oauth/callback",
        config: {
          actor: selectedActor,
          scopes: ["channels:read", "channels:history"],
          capabilities: [],
          knowledgeBaseIds: [],
        },
      },
    });
    const hooks = new NativeSlackHookStore(db, vault, "https://app.example.test", () => now),
      peerHooks = new NativeSlackHookStore(peer, vault, "https://app.example.test", () => now);
    const input = {
      configId,
      appId,
      signingSecret: secret,
      botEvents: ["app_mention", "message.im", "message.channels", "message.groups"],
      botSubscriptionsConfirmed: true,
    };
    const body = (eventId = `Ev${randomUUID().replaceAll("-", "")}`) => ({
      type: "event_callback",
      api_app_id: appId,
      team_id: "T123FIXTURE",
      event_id: eventId,
      event_time: Math.floor(now.getTime() / 1000),
      event: {
        type: "message",
        channel: "C123FIXTURE",
        channel_type: "channel",
        user: "UUSERFIXTURE",
        text: "Synthetic body should never persist",
        ts: `${Math.floor(now.getTime() / 1000)}.000001`,
        files: [{ url_private: "https://files.slack.com/files-pri/should-not-persist" }],
      },
      authorizations: [
        {
          team_id: "T123FIXTURE",
          enterprise_id: null,
          user_id: "UBOTFIXTURE",
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
    });
    return { configId, appId, now, context, hooks, peerHooks, input, body };
  }
  it("the additive migration backfills existing delivery generations and defaults only new rows", async () => {
    const migration = readFileSync(
      new URL(
        "../../../../db/prisma/migrations/20261018080000_native_slack_delivery_revision/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.prisma.$transaction(async (tx) => {
      // A temporary relation shadows the live table only within this transaction.
      await tx.$executeRawUnsafe(
        "CREATE TEMP TABLE native_slack_hooks (revision INTEGER NOT NULL) ON COMMIT DROP",
      );
      await tx.$executeRawUnsafe("INSERT INTO native_slack_hooks(revision) VALUES(3),(7)");
      for (const statement of migration.split(";").filter((value) => value.trim()))
        await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe("INSERT INTO native_slack_hooks(revision) VALUES(9)");
      assert.deepEqual(
        await tx.$queryRawUnsafe(
          'SELECT revision,"deliveryRevision" FROM native_slack_hooks ORDER BY revision',
        ),
        [
          { revision: 3, deliveryRevision: 3 },
          { revision: 7, deliveryRevision: 7 },
          { revision: 9, deliveryRevision: 1 },
        ],
      );
    });
  });
  it("requires deployment-owner authority and configured bot source", async () => {
    const f = await fixture();
    const size = vault.live.size;
    await assert.rejects(f.hooks.save(f.input, f.context, false));
    assert.equal(vault.live.size, size);
    const user = await fixture("user");
    await assert.rejects(user.hooks.save(user.input, user.context, true));
    assert.equal(vault.live.size, size);
  });
  it("adopts encrypted signing secret without exposing it and verifies signed challenge", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true);
    assert.equal(hook.phase, "waiting_for_verification");
    assert.equal(JSON.stringify(hook).includes(secret), false);
    assert.equal(await f.hooks.load(hook.id), undefined);
    const challenge = signed({ type: "url_verification", challenge: "synthetic-challenge" }, f.now);
    assert.deepEqual(
      await f.hooks.accept(hook.id, challenge.raw, challenge.signature, challenge.timestamp),
      { kind: "challenge", challenge: "synthetic-challenge" },
    );
    assert.equal((await f.hooks.load(hook.id))!.verified, true);
    assert.equal(
      (await f.hooks.status({ configId: f.configId }, f.context, true)).hooks[0]!.phase,
      "active",
    );
  });
  it("concurrent duplicate signed event creates exactly one durable sanitized inbox", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body("EvDUPLICATE"), f.now);
    const results = await Promise.all([
      f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp),
      f.peerHooks.accept(hook.id, event.raw, event.signature, event.timestamp),
    ]);
    assert.ok(results.every((r) => r?.kind === "event"));
    const a = results[0]!,
      b = results[1]!;
    assert.ok(a.kind === "event" && b.kind === "event");
    assert.equal(a.inboxId, b.inboxId);
    const rows = await db.$queryRaw<Array<{ signal: unknown }>>(
      Prisma.sql`SELECT signal FROM native_slack_event_inbox WHERE "hookId"=${hook.id}`,
    );
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes("Synthetic body"), false);
    assert.equal(JSON.stringify(rows).includes("files-pri"), false);
    assert.equal(
      (await f.hooks.pending()).some((r) => r.inboxId === a.inboxId),
      true,
    );
    assert.equal(await f.hooks.markDispatched(a.inboxId, hook.id, hook.revision), true);
    assert.equal(
      (await f.hooks.pending()).some((r) => r.inboxId === a.inboxId),
      false,
    );
    const duplicate = await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    assert.ok(duplicate?.kind === "event");
    assert.equal(duplicate.alreadyDispatched, true);
  });
  it("wrong signature or app cannot create an inbox", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      bad = signed({ ...f.body(), api_app_id: "AOTHER" }, f.now);
    await assert.rejects(
      f.hooks.accept(hook.id, bad.raw, bad.signature, bad.timestamp),
      InvalidNativeSlackSignal,
    );
    const event = signed(f.body(), f.now, "wrong-synthetic-secret");
    await assert.rejects(
      f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp),
      InvalidNativeSlackSignal,
    );
    const count = await db.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*) FROM native_slack_event_inbox WHERE "hookId"=${hook.id}`,
    );
    assert.equal(Number(count[0]!.count), 0);
  });
  it("secret-only rotation preserves acknowledged inbox while retiring the old signing secret", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body(), f.now),
      old = await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    assert.ok(old?.kind === "event");
    const next = await f.hooks.save(
      { ...f.input, ...existing(hook), signingSecret: "new-synthetic-slack-signing-secret" },
      f.context,
      true,
    );
    assert.equal(next.revision, hook.revision + 1);
    assert.equal(next.verified, false);
    assert.equal(await f.hooks.load(hook.id), undefined);
    const loaded = await f.hooks.loadInbox(old.inboxId, hook.id, old.hook.revision);
    assert.equal(loaded?.hook.verified, true);
    assert.equal(loaded?.hook.revision, old.hook.revision);
    assert.ok(
      (await f.hooks.pending()).some(
        (row) => row.inboxId === old.inboxId && row.hookRevision === old.hook.revision,
      ),
    );
    await assert.rejects(
      f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp),
      InvalidNativeSlackSignal,
    );
    assert.equal(await f.hooks.markDispatched(old.inboxId, hook.id, old.hook.revision), true);
  });
  it("rotating an unverified hook does not manufacture verification", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      rotated = await f.hooks.save(
        { ...f.input, ...existing(hook), signingSecret: "new-synthetic-unverified-hook-secret" },
        f.context,
        true,
      );
    assert.equal(rotated.revision, hook.revision + 1);
    assert.equal(rotated.verified, false);
    assert.equal(rotated.lastVerifiedAt, null);
    assert.equal(rotated.phase, "waiting_for_verification");
    assert.equal(await f.hooks.load(hook.id), undefined);
    assert.equal(
      (await f.hooks.pending()).some((row) => row.hookId === hook.id),
      false,
    );
  });
  for (const boundary of ["app", "subscriptions", "config revision", "tenant", "reenable"])
    it(`${boundary} change advances the semantic revision and keeps the old inbox invalid after verification`, async () => {
      const f = await fixture(),
        hook = await f.hooks.save(f.input, f.context, true),
        event = signed(f.body(), f.now),
        accepted = await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
      assert.ok(accepted?.kind === "event");
      let current = hook;
      if (boundary === "config revision")
        await db.nativeAppConfig.update({
          where: { id: f.configId },
          data: { revision: { increment: 1 } },
        });
      else if (boundary === "tenant")
        await db.nativeAppConfig.update({
          where: { id: f.configId },
          data: {
            config: {
              actor: "bot",
              tenantId: "TOTHER",
              scopes: ["channels:read", "channels:history"],
              capabilities: [],
              knowledgeBaseIds: [],
            },
          },
        });
      else if (boundary === "reenable")
        current = await f.hooks.disable(existing(hook), f.context, true);
      const key = "new-synthetic-semantic-change-secret",
        next = await f.hooks.save(
          {
            ...f.input,
            ...existing(current),
            appId: boundary === "app" ? "ACHANGED" : f.appId,
            botEvents: boundary === "subscriptions" ? ["message.channels"] : f.input.botEvents,
            signingSecret: key,
          },
          f.context,
          true,
        );
      assert.equal(next.revision, current.revision + 1);
      assert.equal(next.verified, false);
      const challenge = signed(
        { type: "url_verification", challenge: "new-semantic-hook" },
        f.now,
        key,
      );
      assert.deepEqual(
        await f.hooks.accept(next.id, challenge.raw, challenge.signature, challenge.timestamp),
        { kind: "challenge", challenge: "new-semantic-hook" },
      );
      assert.equal((await f.hooks.load(next.id))!.verified, true);
      assert.equal(
        (await f.hooks.status({ configId: f.configId }, f.context, true)).hooks[0]!.revision,
        next.revision,
      );
      assert.equal(await f.hooks.loadInbox(accepted.inboxId, hook.id, hook.revision), undefined);
      assert.equal(
        (await f.hooks.pending()).some((row) => row.inboxId === accepted.inboxId),
        false,
      );
      assert.equal(await f.hooks.markDispatched(accepted.inboxId, hook.id, hook.revision), false);
    });
  for (const change of ["secret", "subscriptions", "disable"])
    it(`a stale ${change} form cannot overwrite a completed signing-secret rotation`, async () => {
      const f = await fixture(),
        hook = await f.hooks.save(f.input, f.context, true),
        rotated = await f.hooks.save(
          { ...f.input, ...existing(hook), signingSecret: "new-synthetic-stale-form-secret" },
          f.context,
          true,
        );
      const liveBefore = new Set(vault.live.keys());
      await assert.rejects(
        change === "disable"
          ? f.peerHooks.disable(existing(hook), f.context, true)
          : f.peerHooks.save(
              {
                ...f.input,
                ...existing(hook),
                botEvents: change === "subscriptions" ? ["message.channels"] : f.input.botEvents,
              },
              f.context,
              true,
            ),
        { kind: "version_conflict" },
      );
      assert.equal(rotated.revision, hook.revision + 1);
      assert.deepEqual(new Set(vault.live.keys()), liveBefore);
      const current = (await f.hooks.status({ configId: f.configId }, f.context, true)).hooks[0]!;
      assert.equal(current.revision, rotated.revision);
      assert.equal(current.enabled, true);
      assert.deepEqual(current.botEvents, f.input.botEvents);
    });
  it("restoring subscriptions after semantic changes never revives an earlier acknowledged inbox", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body(), f.now),
      accepted = await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    assert.ok(accepted?.kind === "event");
    let current = hook;
    for (const signingSecret of [
      "first-synthetic-repeated-rotation-secret",
      "second-synthetic-repeated-rotation-secret",
    ]) {
      current = await f.hooks.save(
        { ...f.input, ...existing(current), signingSecret },
        f.context,
        true,
      );
      assert.ok(await f.hooks.loadInbox(accepted.inboxId, hook.id, accepted.hook.revision));
    }
    current = await f.hooks.save(
      {
        ...f.input,
        ...existing(current),
        botEvents: ["message.channels"],
        signingSecret: "synthetic-changed-subscriptions-secret",
      },
      f.context,
      true,
    );
    current = await f.hooks.save(
      {
        ...f.input,
        ...existing(current),
        signingSecret: "synthetic-restored-subscriptions-secret",
      },
      f.context,
      true,
    );
    const finalSecret = "synthetic-final-repeated-rotation-secret";
    current = await f.hooks.save(
      { ...f.input, ...existing(current), signingSecret: finalSecret },
      f.context,
      true,
    );
    const challenge = signed(
      { type: "url_verification", challenge: "restored-hook" },
      f.now,
      finalSecret,
    );
    await f.hooks.accept(hook.id, challenge.raw, challenge.signature, challenge.timestamp);
    assert.equal((await f.hooks.load(hook.id))!.verified, true);
    const row = (
      await db.$queryRaw<Array<{ revision: number; deliveryRevision: number }>>(
        Prisma.sql`SELECT revision,"deliveryRevision" FROM native_slack_hooks WHERE id=${hook.id}`,
      )
    )[0]!;
    assert.equal(current.revision, hook.revision + 5);
    assert.equal(row.revision, current.revision);
    assert.equal(row.deliveryRevision, accepted.hook.revision + 2);
    assert.equal(
      await f.hooks.loadInbox(accepted.inboxId, hook.id, accepted.hook.revision),
      undefined,
    );
    assert.equal(
      (await f.hooks.pending()).some((item) => item.inboxId === accepted.inboxId),
      false,
    );
    assert.equal(
      await f.hooks.markDispatched(accepted.inboxId, hook.id, accepted.hook.revision),
      false,
    );
  });
  it("a backfilled legacy delivery generation above one remains bound after secret rotation", async () => {
    const f = await fixture(),
      created = await f.hooks.save(f.input, f.context, true);
    // Model the migration's revision-to-deliveryRevision backfill, without creating a new receipt.
    await db.$executeRaw(
      Prisma.sql`UPDATE native_slack_hooks SET revision=7,"deliveryRevision"=7 WHERE id=${created.id}`,
    );
    const legacy = (await f.hooks.status({ configId: f.configId }, f.context, true)).hooks[0]!,
      body = f.body(),
      event = signed(body, f.now),
      accepted = await f.hooks.accept(legacy.id, event.raw, event.signature, event.timestamp);
    assert.ok(accepted?.kind === "event");
    assert.equal(accepted.hook.revision, 7);
    const key = "synthetic-backfilled-generation-rotation-secret",
      rotated = await f.hooks.save(
        { ...f.input, ...existing(legacy), signingSecret: key },
        f.context,
        true,
      );
    assert.equal(rotated.revision, 8);
    assert.equal(await f.hooks.load(legacy.id), undefined);
    const queuedPayload = { inboxId: accepted.inboxId, hookId: legacy.id, hookRevision: 7 },
      loaded = await f.hooks.loadInbox(
        queuedPayload.inboxId,
        queuedPayload.hookId,
        queuedPayload.hookRevision,
      );
    assert.equal(loaded?.hook.revision, 7);
    assert.equal(loaded?.hook.verified, true);
    assert.ok(
      (await f.hooks.pending()).some(
        (item) => item.inboxId === accepted.inboxId && item.hookRevision === 7,
      ),
    );
    assert.equal(await f.hooks.markDispatched(accepted.inboxId, legacy.id, 7), true);
    const replay = signed(body, f.now, key),
      duplicate = await f.hooks.accept(legacy.id, replay.raw, replay.signature, replay.timestamp);
    assert.ok(duplicate?.kind === "event");
    assert.equal(duplicate.inboxId, accepted.inboxId);
    assert.equal(duplicate.alreadyDispatched, true);
    assert.equal(duplicate.hook.revision, 7);
    assert.equal(
      (await f.hooks.status({ configId: f.configId }, f.context, true)).hooks[0]!.revision,
      8,
    );
  });
  it("concurrent secret-only saves adopt one prepared reference and retire the losing reference", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      before = await db.nativeSlackHook.findUniqueOrThrow({ where: { id: hook.id } }),
      liveBefore = new Set(vault.live.keys()),
      gate = latch();
    let writes = 0;
    vault.putGate = {
      entered: () => {
        if (++writes === 2) gate.enter();
      },
      wait: gate.wait,
    };
    const pending = Promise.allSettled([
      f.hooks.save(
        { ...f.input, ...existing(hook), signingSecret: "first-synthetic-concurrent-secret" },
        f.context,
        true,
      ),
      f.peerHooks.save(
        { ...f.input, ...existing(hook), signingSecret: "second-synthetic-concurrent-secret" },
        f.context,
        true,
      ),
    ]);
    try {
      // Both saves have read the same hook and prepared their new secret before either can adopt it.
      await gate.entered;
      assert.equal(vault.live.size, liveBefore.size + 2);
      assert.equal(
        (await db.nativeSlackHook.findUniqueOrThrow({ where: { id: hook.id } })).secretRecordId,
        before.secretRecordId,
      );
    } finally {
      vault.putGate = undefined;
      gate.release();
    }
    const results = await pending,
      successes = results.filter((result) => result.status === "fulfilled"),
      failures = results.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.reason.kind, "version_conflict");
    assert.equal(successes[0]!.value.revision, hook.revision + 1);
    const adopted = await db.nativeSlackHook.findUniqueOrThrow({ where: { id: hook.id } });
    assert.notEqual(adopted.secretRecordId, before.secretRecordId);
    assert.equal(vault.live.has(before.ciphertext!), false);
    assert.deepEqual(
      [...vault.live.keys()].filter((ciphertext) => !liveBefore.has(ciphertext)),
      [adopted.ciphertext],
    );
    assert.equal(vault.live.size, liveBefore.size);
  });
  it("secret-only rotation during SecretStore load rejects the stale signed callback", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body(), f.now),
      gate = latch();
    vault.loadGate = { entered: gate.enter, wait: gate.wait };
    const pending = f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    await gate.entered;
    try {
      const rotated = await f.peerHooks.save(
        { ...f.input, ...existing(hook), signingSecret: "new-synthetic-load-race-secret" },
        f.context,
        true,
      );
      assert.equal(rotated.revision, hook.revision + 1);
      assert.equal(rotated.verified, false);
    } finally {
      gate.release();
    }
    assert.equal(await pending, undefined);
    assert.equal(await db.nativeSlackEventInbox.count({ where: { hookId: hook.id } }), 0);
  });
  it("disable and config revision fence stop old deliveries without remote revocation", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body(), f.now),
      accepted = await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    assert.ok(accepted?.kind === "event");
    const disabled = await f.hooks.disable(existing(hook), f.context, true);
    assert.equal(disabled.phase, "disabled");
    assert.equal(disabled.configured, false);
    assert.equal(
      await f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp),
      undefined,
    );
    assert.equal(await f.hooks.loadInbox(accepted.inboxId, hook.id, hook.revision), undefined);
    const other = await fixture(),
      current = await other.hooks.save(other.input, other.context, true);
    await db.nativeAppConfig.update({
      where: { id: other.configId },
      data: { revision: { increment: 1 } },
    });
    assert.equal(
      (await other.hooks.status({ configId: other.configId }, other.context, true)).hooks[0]!.phase,
      "invalidated",
    );
    assert.equal(await other.hooks.load(current.id), undefined);
  });
  it("configuration change during SecretStore load cannot accept a stale signed callback", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true),
      event = signed(f.body(), f.now),
      gate = latch();
    vault.loadGate = { entered: gate.enter, wait: gate.wait };
    const pending = f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp);
    await gate.entered;
    try {
      await peer.nativeAppConfig.update({
        where: { id: f.configId },
        data: { revision: { increment: 1 } },
      });
    } finally {
      gate.release();
    }
    assert.equal(await pending, undefined);
  });
  it("configuration cascade retires only its adopted hook secret", async () => {
    const f = await fixture(),
      hook = await f.hooks.save(f.input, f.context, true);
    const row = (
      await db.$queryRaw<Array<{ ciphertext: string }>>(
        Prisma.sql`SELECT ciphertext FROM native_slack_hooks WHERE id=${hook.id}`,
      )
    )[0]!;
    assert.equal(vault.live.has(row.ciphertext), true);
    await db.nativeAppConfig.delete({ where: { id: f.configId } });
    assert.equal(vault.live.has(row.ciphertext), false);
  });
});
