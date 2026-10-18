import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { AdapterContext, SecretContext, SecretPutOptions } from "@rakazo/adapter-kit";
import type { NativeNotionHook } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, it } from "vitest";
import { withSecretPersistence } from "../../secret-persistence.js";
import { EncryptedSecretStore } from "../../secrets.js";
import { NativeNotionHookStore } from "./notion-hooks.js";
import { NativeRoutineEventService } from "./service.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  saveNativeRoutineTrigger,
} from "./store.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function latch() {
  let release!: () => void;
  let enter!: () => void;
  return {
    wait: new Promise<void>((done) => {
      release = done;
    }),
    entered: new Promise<void>((done) => {
      enter = done;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}

/** Only the external vault boundary is simulated; encryption, AAD and DB calls remain real. */
class RecordingVault extends EncryptedSecretStore {
  readonly live = new Map<string, string>();
  readonly contexts: Array<{ operationId: string; traceId: string }> = [];
  loadGate?: ReturnType<typeof latch>;
  putGate?: ReturnType<typeof latch>;

  override async put(value: string, context: AdapterContext, options: SecretPutOptions = {}) {
    const row = await super.put(value, context, options);
    this.live.set(row.ciphertext, row.id);
    this.contexts.push({ operationId: context.operationId, traceId: context.traceId });
    const gate = this.putGate;
    if (gate) {
      this.putGate = undefined;
      gate.enter();
      await gate.wait;
    }
    return row;
  }

  override async load(ref: string, context: SecretContext) {
    assert.ok(this.live.has(ref), "The persistent vault ref must still exist");
    const value = await super.load(ref, context);
    const gate = this.loadGate;
    if (gate) {
      this.loadGate = undefined;
      gate.enter();
      await gate.wait;
    }
    return value;
  }

  override async delete(ref: string, context: SecretContext) {
    this.live.delete(ref);
    return super.delete(ref, context);
  }
}

const token = (n = 1) => `synthetic-notion-verification-token-${n}`;
const challenge = (n = 1) => Buffer.from(JSON.stringify({ verification_token: token(n) }));
const existing = (hook: NativeNotionHook) => ({
  configId: hook.configId,
  id: hook.id,
  expectedRevision: hook.revision,
});

describePostgres("Native Notion setup and credential lifecycle (PostgreSQL)", () => {
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let db: ReturnType<typeof withSecretPersistence>;
  let peer: ReturnType<typeof withSecretPersistence>;
  const vault = new RecordingVault("synthetic-hook-postgres-master-key");
  const fixtures: Array<{
    configId: string;
    organizationId: string;
    userIds: string[];
    context: AdapterContext;
    hooks: NativeNotionHookStore;
  }> = [];

  beforeAll(async () => {
    first = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-hook-first",
    });
    second = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-hook-second",
    });
    db = withSecretPersistence(first.prisma, vault);
    peer = withSecretPersistence(second.prisma, vault);
    const version = await db.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    assert.match(version[0]!.version, /PostgreSQL/);
    // Missing migrations fail this suite; tests never create or silently skip the table.
    await db.$queryRaw`SELECT id FROM native_notion_hooks LIMIT 0`;
  });

  afterAll(async () => {
    try {
      if (db)
        for (const fixture of fixtures) {
          const config = await db.nativeAppConfig.findUnique({ where: { id: fixture.configId } });
          if (config) {
            const status = await fixture.hooks.status(
              { configId: config.id },
              fixture.context,
              true,
            );
            for (const hook of status.hooks)
              if (hook.configured || hook.enabled) {
                await fixture.hooks.disable(existing(hook), fixture.context, true);
              }
          }
          // Delete account grants before their application; only test-owned identities are selected.
          await db.organization.deleteMany({ where: { id: fixture.organizationId } });
          await db.user.deleteMany({ where: { id: { in: fixture.userIds } } });
          await db.nativeAppConfig.deleteMany({ where: { id: fixture.configId } });
        }
      assert.equal(vault.live.size, 0);
    } finally {
      await Promise.all(
        [first, second].filter(Boolean).map(async (client) => {
          try {
            await client.prisma.$disconnect();
          } finally {
            await client.pool.end();
          }
        }),
      );
      await vault.close();
    }
  });

  async function fixture() {
    const organizationId = randomUUID(),
      owner = randomUUID(),
      other = randomUUID(),
      spaceA = randomUUID(),
      spaceB = randomUUID();
    let clock = new Date();
    const context = (userId = owner, spaceId = spaceA): AdapterContext => ({
      userId,
      spaceId,
      operationId: "native-hook-postgres",
      traceId: randomUUID(),
      signal: new AbortController().signal,
    });
    const hooks = new NativeNotionHookStore(db, vault, "https://app.example.test", () => clock);
    const peerHooks = new NativeNotionHookStore(
      peer,
      vault,
      "https://app.example.test",
      () => clock,
    );
    await db.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic hook organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const id of [owner, other]) {
      await db.user.create({ data: { id, name: "Synthetic user", email: `${id}@example.test` } });
      await db.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "owner",
          createdAt: new Date(),
        },
      });
    }
    for (const [id, userId] of [
      [spaceA, owner],
      [spaceB, other],
    ]) {
      await db.space.create({ data: { id: id!, organizationId, name: "Synthetic Space" } });
      await db.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId: id!,
          userId: userId!,
          organizationId,
          role: "owner",
          createdAt: new Date(),
        },
      });
    }
    const recordId = randomUUID();
    const material = await vault.put("synthetic-application-secret", context(), { recordId });
    const config = await db.nativeAppConfig.create({
      data: {
        appId: "notion",
        label: "Synthetic global Notion app",
        ownership: "byo",
        credentialKind: "oauth",
        callbackUri: "https://app.example.test/api/connectors/oauth/callback",
        config: {
          clientId: "synthetic-client",
          scopes: [],
          capabilities: ["read_content"],
          knowledgeBaseIds: [],
        },
        ciphertext: material.ciphertext,
        secretRecordId: recordId,
      },
    });
    fixtures.push({
      configId: config.id,
      organizationId,
      userIds: [owner, other],
      context: context(other, spaceB),
      hooks,
    });
    const integration = randomUUID(),
      subscription = randomUUID(),
      page = randomUUID(),
      botIdentity = randomUUID(),
      workspace = randomUUID();
    const status = async (id: string) =>
      (await hooks.status({ configId: config.id }, context(), true)).hooks.find(
        (row) => row.id === id,
      )!;
    const signed = (key = token(), subscriptionId = subscription, integrationId = integration) => {
      const raw = Buffer.from(
        JSON.stringify({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          workspace_id: workspace,
          integration_id: integrationId,
          subscription_id: subscriptionId,
          type: "page.content_updated",
          accessible_by: [{ id: botIdentity, type: "bot" }],
          entity: { id: page, type: "page" },
          data: {},
        }),
      );
      return { raw, signature: `sha256=${createHmac("sha256", key).update(raw).digest("hex")}` };
    };
    return {
      organizationId,
      owner,
      other,
      spaceA,
      spaceB,
      config,
      context,
      hooks,
      peerHooks,
      status,
      signed,
      integration,
      subscription,
      page,
      botIdentity,
      workspace,
      now: () => clock,
      advance: (next: Date) => {
        clock = next;
      },
    };
  }

  async function pending(f: Awaited<ReturnType<typeof fixture>>) {
    const begin = await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now());
    assert.equal(await f.hooks.captureChallenge(begin.id, challenge(), f.now()), true);
    return f.status(begin.id);
  }

  async function active(f: Awaited<ReturnType<typeof fixture>>) {
    const row = await pending(f);
    await f.hooks.confirm(
      { ...existing(row), integrationId: f.integration, verifiedInNotion: true },
      f.context(),
      true,
      f.now(),
    );
    const delivery = f.signed();
    const accepted = await f.hooks.acceptSigned(row.id, delivery.raw, delivery.signature, f.now());
    assert.ok(accepted?.event);
    return f.status(row.id);
  }

  async function source(f: Awaited<ReturnType<typeof fixture>>) {
    const scope = { userId: f.other, spaceId: f.spaceB },
      recordId = randomUUID();
    const material = await vault.put("synthetic-account-grant", f.context(f.other, f.spaceB), {
      recordId,
    });
    await db.secret.create({
      data: { id: recordId, ...scope, kind: "native_grant", ciphertext: material.ciphertext },
    });
    const grant = await db.nativeOAuthGrant.create({
      data: {
        id: randomUUID(),
        ...scope,
        configId: f.config.id,
        configRevision: 1,
        authority: "https://api.notion.com",
        subject: "synthetic-subject",
        tenant: f.workspace,
        principal: { credentialKind: "oauth", botId: f.botIdentity },
        secretId: recordId,
      },
    });
    const revision = `${grant.id}:${grant.authGeneration}`;
    const connection = await db.connection.create({
      data: {
        ...scope,
        connectorId: "native",
        provider: "notion",
        providerRef: grant.id,
        displayName: "Synthetic account",
        status: "connected",
        oauthGrantId: grant.id,
        nativeConfigId: f.config.id,
        nativeConfigRevision: 1,
        metadata: { authRevision: revision },
      },
    });
    const bot = await db.bot.create({ data: { ...scope, name: "Synthetic Bot", color: "ink" } });
    await db.thread.create({ data: { ...scope, botId: bot.id } });
    const routine = await db.routine.create({
      data: {
        ...scope,
        botId: bot.id,
        name: "Synthetic Routine",
        prompt: "Original instruction",
        crons: [],
        active: true,
      },
    });
    const spec = {
      kind: "notion.page_content_changed" as const,
      target: { type: "page" as const, pageId: f.page },
    };
    const trigger = await saveNativeRoutineTrigger(
      db,
      scope,
      routine.id,
      {
        input: { connectionId: connection.id, spec },
        proof: {
          ...scope,
          connectionId: connection.id,
          authorizationRevision: revision,
          grantId: grant.id,
          authGeneration: 1,
          configId: f.config.id,
          configRevision: 1,
          appId: "notion",
          resource: { type: "page", id: f.page },
          spec,
        },
      },
      new Date(Date.now() - 60_000),
    );
    const lease = await leaseNativeEventSource(db, scope, trigger.id, trigger.version);
    assert.ok(lease?.leaseId);
    await checkpointNativeEventSource(db, scope, {
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      leaseId: lease.leaseId,
      state: { ready: true },
      nextPollAt: new Date(),
      release: false,
    });
    const observation = {
      triggerId: trigger.id,
      triggerVersion: trigger.version,
      connectionId: connection.id,
      authorizationRevision: revision,
      kind: spec.kind,
      resource: { type: "page" as const, id: f.page },
      eventIdentity: randomUUID(),
      observedVersion: "synthetic-visible-version",
      occurredAt: new Date().toISOString(),
      evidence: "notion_webhook" as const,
    };
    return { scope, routine, leaseId: lease.leaseId, observation };
  }

  it("requires an owner and reuses only the current app-bound pending URL", async () => {
    const f = await fixture();
    await assert.rejects(f.hooks.begin({ configId: f.config.id }, f.context(), false, f.now()));
    const row = await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now());
    assert.equal(row.enabled, false);
    assert.equal(row.phase, "waiting_for_challenge");
    assert.match(row.id, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now())).id,
      row.id,
    );
  });

  it("captures one untrusted encrypted challenge without activation, replacement or DTO disclosure", async () => {
    const f = await fixture(),
      before = vault.live.size,
      row = await pending(f);
    assert.equal(row.enabled, false);
    assert.equal(row.subscriptionId, null);
    assert.equal(row.lastVerifiedAt, null);
    assert.equal(await f.hooks.load(row.id), undefined);
    assert.equal(vault.live.size, before + 1);
    assert.equal(await f.hooks.captureChallenge(row.id, challenge(2), f.now()), false);
    assert.equal(JSON.stringify(row).includes(token()), false);
    assert.equal(JSON.stringify(row).includes("ciphertext"), false);
  });

  it("reveals a pending token only to its exact app/revision/setup owner", async () => {
    const f = await fixture(),
      row = await pending(f);
    await assert.rejects(
      f.hooks.reveal(existing(row), f.context(f.other, f.spaceB), true, f.now()),
    );
    await assert.rejects(
      f.hooks.reveal({ ...existing(row), configId: randomUUID() }, f.context(), true, f.now()),
    );
    await assert.rejects(
      f.hooks.reveal(
        { ...existing(row), expectedRevision: row.revision + 1 },
        f.context(),
        true,
        f.now(),
      ),
    );
    assert.equal(
      (await f.hooks.reveal(existing(row), f.context(), true, f.now())).verificationToken,
      token(),
    );
  });

  it("records a signed pre-confirm integration candidate without subscribing or activating", async () => {
    const f = await fixture(),
      row = await pending(f),
      delivery = f.signed();
    assert.equal(
      await f.hooks.acceptSigned(row.id, delivery.raw, delivery.signature, f.now()),
      undefined,
    );
    const candidate = await f.status(row.id);
    assert.equal(candidate.candidateIntegrationId, f.integration);
    assert.ok(candidate.lastVerifiedAt);
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.subscriptionId, null);
  });

  it("requires explicit Notion confirmation and retains the identical callback", async () => {
    const f = await fixture(),
      row = await pending(f);
    await assert.rejects(
      f.hooks.confirm(
        { ...existing(row), integrationId: f.integration, verifiedInNotion: false },
        f.context(),
        true,
        f.now(),
      ),
    );
    const confirmed = await f.hooks.confirm(
      { ...existing(row), integrationId: f.integration, verifiedInNotion: true },
      f.context(),
      true,
      f.now(),
    );
    assert.equal(confirmed.webhookUrl, row.webhookUrl);
    assert.equal(confirmed.phase, "waiting_for_signed_identity");
    assert.equal(await f.hooks.load(row.id), undefined);
    assert.equal(await f.hooks.captureChallenge(row.id, challenge(2), f.now()), false);
  });

  it("pins subscription only from the confirmed integration's valid signature", async () => {
    const f = await fixture(),
      row = await active(f),
      wrong = f.signed(token(), randomUUID());
    assert.equal(row.subscriptionId, f.subscription);
    assert.equal(row.phase, "active");
    await assert.rejects(f.hooks.acceptSigned(row.id, wrong.raw, wrong.signature, f.now()));
    assert.ok(await f.hooks.load(row.id, row.revision));
  });

  it("keeps hook setup and replacement independent of OAuth config revision", async () => {
    const f = await fixture(),
      row = await active(f);
    await f.hooks.disable(existing(row), f.context(), true, f.now());
    await pending(f);
    assert.equal(
      (await db.nativeAppConfig.findUniqueOrThrow({ where: { id: f.config.id } })).revision,
      1,
    );
  });

  it("protects the deployed token with real AES-GCM record AAD", async () => {
    const f = await fixture(),
      row = await pending(f);
    const records = await db.$queryRaw<
      Array<{ ciphertext: string }>
    >`SELECT ciphertext FROM native_notion_hooks WHERE id=${row.id}`;
    await assert.rejects(vault.load(records[0]!.ciphertext, { recordId: randomUUID() }));
  });

  it("survives setup admin and setup Space deletion while another user's exact Routine runs", async () => {
    const f = await fixture(),
      row = await active(f),
      s = await source(f);
    await db.space.delete({ where: { id: f.spaceA } });
    await db.user.delete({ where: { id: f.owner } });
    assert.ok(await f.hooks.load(row.id, row.revision));
    assert.ok(await db.routine.findUnique({ where: { id: s.routine.id } }));
    const delivery = f.signed(),
      accepted = await f.hooks.acceptSigned(row.id, delivery.raw, delivery.signature, f.now());
    assert.ok(accepted?.event);
    assert.ok(
      (
        await claimNativeRoutineEvent(
          db,
          s.scope,
          {
            ...s.observation,
            eventIdentity: accepted.event.id,
            occurredAt: accepted.event.timestamp,
          },
          s.leaseId,
          undefined,
          new Date(),
          { id: row.id, revision: row.revision, configId: row.configId },
        )
      )?.created,
    );
  });

  it("keeps a live pair on stale stop CAS, then deletes its ref and rejects late old-hook work", async () => {
    const f = await fixture(),
      row = await active(f),
      s = await source(f);
    await assert.rejects(
      f.hooks.disable(
        { ...existing(row), expectedRevision: row.revision - 1 },
        f.context(),
        true,
        f.now(),
      ),
    );
    assert.ok(await f.hooks.load(row.id, row.revision));
    const count = vault.live.size,
      stopped = await f.hooks.disable(existing(row), f.context(), true, f.now());
    assert.equal(stopped.configured, false);
    assert.equal(vault.live.size, count - 1);
    assert.equal(
      await claimNativeRoutineEvent(db, s.scope, s.observation, s.leaseId, undefined, new Date(), {
        id: row.id,
        revision: row.revision,
        configId: row.configId,
      }),
      undefined,
    );
  });

  it("lets competing stores capture one pair and cleans the loser's prepared ref", async () => {
    const f = await fixture(),
      row = await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now()),
      before = vault.live.size;
    const results = await Promise.all([
      f.hooks.captureChallenge(row.id, challenge(), f.now()),
      f.peerHooks.captureChallenge(row.id, challenge(2), f.now()),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(vault.live.size, before + 1);
  });

  it("cannot reveal a token after a slow vault read crosses setup expiry", async () => {
    const f = await fixture(),
      row = await pending(f),
      gate = latch();
    vault.loadGate = gate;
    const delayed = f.hooks.reveal(existing(row), f.context(), true, f.now());
    await gate.entered;
    f.advance(new Date(Date.parse(row.setupExpiresAt!) + 1));
    gate.release();
    await assert.rejects(delayed);
  });

  it("cannot reveal a token removed during a slow vault read", async () => {
    const f = await fixture(),
      row = await pending(f),
      gate = latch();
    vault.loadGate = gate;
    const delayed = f.hooks.reveal(existing(row), f.context(), true, f.now());
    await gate.entered;
    await f.peerHooks.disable(existing(row), f.context(), true, f.now());
    gate.release();
    await assert.rejects(delayed);
  });

  it("retains a committed global ref when only the transaction reply is lost", async () => {
    const f = await fixture(),
      row = await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now()),
      before = vault.live.size;
    const lostReply = new Proxy(db, {
      get(target, key, receiver) {
        if (key === "$transaction")
          return async (work: unknown) => {
            await Reflect.apply(target.$transaction, target, [work]);
            throw new Error("Synthetic lost commit reply");
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const store = new NativeNotionHookStore(lostReply, vault, "https://app.example.test", f.now);
    await assert.rejects(store.captureChallenge(row.id, challenge(), f.now()), /lost commit reply/);
    const committed = await f.status(row.id);
    assert.equal(vault.live.size, before + 1);
    assert.equal(
      (await f.hooks.reveal(existing(committed), f.context(), true, f.now())).verificationToken,
      token(),
    );
  });

  it("cleans a prepared ref if capture crosses setup expiry before its transaction", async () => {
    const f = await fixture(),
      row = await f.hooks.begin({ configId: f.config.id }, f.context(), true, f.now()),
      before = vault.live.size,
      gate = latch();
    vault.putGate = gate;
    const delayed = f.hooks.captureChallenge(row.id, challenge(), f.now());
    await gate.entered;
    f.advance(new Date(Date.parse(row.setupExpiresAt!) + 1));
    gate.release();
    assert.equal(await delayed, false);
    assert.equal(vault.live.size, before);
  });

  it("keeps the pending callback nonce out of vault operation and trace identifiers", async () => {
    const f = await fixture(),
      row = await pending(f),
      recorded = vault.contexts.at(-1)!;
    assert.equal(recorded.operationId, "native-hook-challenge");
    assert.match(recorded.traceId, /^[a-f0-9-]{36}$/);
    assert.equal(JSON.stringify(recorded).includes(row.id), false);
  });

  it("preserves the existing account Secret Space constraint", async () => {
    const f = await fixture();
    await assert.rejects(
      db.secret.create({
        data: {
          id: randomUUID(),
          userId: f.other,
          spaceId: null,
          kind: "native_grant",
          ciphertext: "synthetic-invalid-scope",
        },
      }),
    );
  });

  it("accepts a signed hook without waking a Bot when its exact Routine is inactive", async () => {
    const f = await fixture(),
      hook = await active(f),
      s = await source(f);
    await db.routine.update({ where: { id: s.routine.id }, data: { active: false } });
    const counts = async () => ({
      tasks: await db.task.count({ where: s.scope }),
      runs: await db.run.count({ where: s.scope }),
      messages: await db.message.count({
        where: { thread: { ...s.scope, botId: s.routine.botId } },
      }),
      events: await db.event.count({
        where: { spaceId: s.scope.spaceId, botId: s.routine.botId },
      }),
    });
    const before = await counts();
    let enqueued = 0,
      authorizations = 0,
      appended = 0;
    const service = new NativeRoutineEventService(
      db,
      {
        authorization: async () => {
          authorizations++;
          throw new Error("No-rule ingress must not read an upstream resource");
        },
      },
      f.hooks,
      {
        enqueue: async () => {
          enqueued++;
        },
      },
      {
        append: async () => {
          appended++;
          throw new Error("No-rule ingress must not append a thread event");
        },
      },
      "https://app.example.test",
    );
    const delivery = f.signed();
    assert.equal(await service.ingestNotion(hook.id, delivery.raw, delivery.signature), 0);
    assert.equal(enqueued, 0);
    assert.equal(authorizations, 0);
    assert.equal(appended, 0);
    assert.deepEqual(await counts(), before);
  });

  it("cleans hook and application refs when their configuration is explicitly deleted", async () => {
    const f = await fixture(),
      row = await active(f),
      before = vault.live.size;
    await db.nativeAppConfig.delete({ where: { id: f.config.id } });
    assert.equal(vault.live.size, before - 2);
    assert.equal(await f.hooks.load(row.id), undefined);
    const records = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM native_notion_hooks WHERE id=${row.id}`;
    assert.equal(records[0]!.count, 0n);
  });
});
