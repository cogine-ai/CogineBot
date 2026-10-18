import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
  loadGate?: { entered: () => void; wait: Promise<void> };
  override async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const row = await super.put(value, context, options);
    this.live.set(row.ciphertext, row.id);
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
  it("rotation changes revision, retires old secret and invalidates old queued inbox", async () => {
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
    assert.equal(await f.hooks.loadInbox(old.inboxId, hook.id, hook.revision), undefined);
    await assert.rejects(
      f.hooks.accept(hook.id, event.raw, event.signature, event.timestamp),
      InvalidNativeSlackSignal,
    );
    assert.equal(await f.hooks.markDispatched(old.inboxId, hook.id, hook.revision), false);
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
