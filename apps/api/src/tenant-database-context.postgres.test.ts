import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import * as adapters from "@rakazo/adapters";
import {
  BillingEmulator,
  createDeploymentTransferPeer,
  EncryptedSecretStore,
  InMemoryRealtimeFanout,
  MessagingTeamChatEmulator,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import {
  boardEventTopic,
  createBoardEvents,
  createDb,
  currentDbContext,
  requireMembership,
  rlsBypassKey,
  runAsTenant,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { actorFromMembership, createApp } from "./app.js";
import { BILLING_RETURN_PATH, createBillingService } from "./billing.js";
import { BILLING_WEBHOOK_PATH, mountBillingRoutes } from "./billing-webhook.js";
import { createDeploymentTransferService } from "./deployment-transfer.js";
import { mountDeploymentTransferHttp } from "./deployment-transfer-http.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { addScreenProxyCapability } from "./screen-proxy.js";
import { voiceContext } from "./voice.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const origin = "https://context.example.test";

describePostgres("trusted request contexts on a restricted single-connection pool", () => {
  const suffix = randomBytes(10).toString("hex");
  const role = `context_api_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const policy = `context_api_${suffix}`;
  const tenantPredicate =
    "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '') AND \"userId\" = NULLIF(current_setting('app.user_id', true), '')";
  // These controlled fixtures exercise the actual ingress composition. They do
  // not enable the product's complete policy set or switch its runtime role.
  const policies = new Map([
    ["user", "id = NULLIF(current_setting('app.user_id', true), '')"],
    ["session", "\"userId\" = NULLIF(current_setting('app.user_id', true), '')"],
    ["space_members", "\"userId\" = NULLIF(current_setting('app.user_id', true), '')"],
    ["bots", tenantPredicate],
    ["computers", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["boards", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["connections", tenantPredicate],
    ["ai_data_consents", tenantPredicate],
    ["deployment_identities", "false"],
    ["deployment_transfer_sessions", "false"],
    ["deployment_transfer_items", "false"],
    [
      "billing_accounts",
      'EXISTS (SELECT 1 FROM space_members m WHERE m."organizationId" = billing_accounts."organizationId" AND m."userId" = NULLIF(current_setting(\'app.user_id\', true), \'\'))',
    ],
    [
      "secrets",
      "\"userId\" = NULLIF(current_setting('app.user_id', true), '') AND (\"spaceId\" IS NULL OR \"spaceId\" = NULLIF(current_setting('app.space_id', true), ''))",
    ],
  ]);
  const previousRls = new Map<string, boolean>();
  const store = new EncryptedSecretStore("offline-request-context-key");
  const realtime = new InMemoryRealtimeFanout();
  const messaging = new MessagingTeamChatEmulator({
    provider: "context-messaging",
    capabilities: { groups: false },
  });
  const registeredInbound = vi.spyOn(messaging, "onInbound");
  const inboundContexts: unknown[] = [];
  const deleted = vi.spyOn(store, "delete");
  const screenSecret = "offline-screen-context-secret";
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb>;
  let runtimeUrl: string;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let first: { cookie: string; actor: Actor };
  let second: { cookie: string; actor: Actor };
  let rejectConsent: string | undefined;
  let rejectRevocation = false;
  let botReads = 0;

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    const target = new URL(databaseUrl!);
    target.username = role;
    target.password = password;
    target.searchParams.delete("user");
    target.searchParams.delete("password");
    runtimeUrl = target.toString();
    await owner.pool.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${password}'`,
    );
    const database = await owner.pool.query<{ name: string }>("SELECT current_database() AS name");
    await owner.pool.query(
      `GRANT CONNECT ON DATABASE "${database.rows[0]!.name.replaceAll('"', '""')}" TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys (digest) VALUES (sha256(convert_to($1, 'UTF8'))) ON CONFLICT DO NOTHING",
      [rlsBypassKey(runtimeUrl)],
    );
    for (const [table, predicate] of policies) {
      const state = await owner.pool.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass",
        [table],
      );
      previousRls.set(table, state.rows[0]!.relrowsecurity);
      await owner.pool.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await owner.pool.query(
        `CREATE POLICY "${policy}" ON "${table}" USING ((SELECT app_rls_bypass()) OR (${predicate}))`,
      );
    }
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    const instrumented = runtime.prisma.$extends({
      query: {
        messagingOutbound: {
          async updateMany({ args, query }) {
            inboundContexts.push(currentDbContext());
            return query(args);
          },
        },
        bot: {
          async findFirst({ args, query }) {
            botReads++;
            return query(args);
          },
        },
        aiDataConsent: {
          async upsert({ args, query }) {
            if (args.create.recipientKey === rejectConsent)
              throw new Error("Consent write rejected");
            return query(args);
          },
        },
        connection: {
          async updateMany({ args, query }) {
            if (rejectRevocation && args.data.status === "revoked")
              throw new Error("Revocation rejected");
            return query(args);
          },
        },
      },
    });
    dataDir = await mkdtemp(join(tmpdir(), "trusted-request-context-"));
    handles = await createApp({
      prisma: instrumented as unknown as typeof runtime.prisma,
      databaseUrl: runtimeUrl,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      ticketBoardEnabled: true,
      secretStore: store,
      realtime,
      messaging,
      screenProxySecret: screenSecret,
      webOrigin: origin,
      authUrl: origin,
    });
    first = await account("First");
    second = await account("Second");
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => handles?.stop());
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      for (const table of policies.keys()) {
        await cleanup(() => owner.pool.query(`DROP POLICY IF EXISTS "${policy}" ON "${table}"`));
        if (previousRls.get(table) === false)
          await cleanup(() =>
            owner.pool.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`),
          );
      }
      if (runtimeUrl)
        await cleanup(() =>
          owner.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest = sha256(convert_to($1, 'UTF8'))",
            [rlsBypassKey(runtimeUrl)],
          ),
        );
      await cleanup(() => owner.pool.query(`DROP OWNED BY "${role}"`));
      await cleanup(() => owner.pool.query(`DROP ROLE IF EXISTS "${role}"`));
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (dataDir) await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    deleted.mockRestore();
    if (failures.length)
      throw new AggregateError(failures, "Request context fixture cleanup failed");
  });

  function scope(actor: Actor) {
    return { userId: actor.userId, spaceId: actor.spaceId };
  }
  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await raw(cookie, procedure, input, spaceId);
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: T }).json;
  }
  async function account(name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${name.toLowerCase()}-${suffix}@example.test`,
        password: "offline-password-123",
        name,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    return { cookie, actor: await rpc<Actor>(cookie, "me") };
  }

  it("authenticates and interleaves requests without leaking the owner role or prior tenant", async () => {
    expect(
      await runtime.prisma
        .$queryRaw`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ).toEqual([{ name: role, rolsuper: false, rolbypassrls: false }]);
    expect(await runtime.prisma.user.findMany()).toEqual([]);
    const responses = await runAsTenant({ spaceId: "forged-space", userId: "forged-user" }, () =>
      Promise.all(
        [first, second, first, second].map(async (caller) => {
          const me = await rpc<Actor>(caller.cookie, "me");
          expect(me.userId).toBe(caller.actor.userId);
          expect(me.spaceId).toBe(caller.actor.spaceId);
          return me;
        }),
      ),
    );
    expect(responses).toHaveLength(4);
    expect((await raw("", "me")).status).toBe(401);
    expect((await raw(first.cookie, "me", {}, second.actor.spaceId)).status).toBe(403);
    expect(await runtime.prisma.user.findMany()).toEqual([]);
    expect(runtime.pool.totalCount).toBe(1);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("syncs signed billing events and verified checkout returns through their real account scope", async () => {
    const provider = new BillingEmulator();
    const billing = createBillingService({ prisma: runtime.prisma, provider, webOrigin: origin });
    await runAsTenant(first.actor, () => billing.checkout(first.actor));
    const space = await owner.prisma.space.findUniqueOrThrow({
      where: { id: first.actor.spaceId },
    });
    const account = await owner.prisma.billingAccount.findUniqueOrThrow({
      where: { organizationId: space.organizationId },
    });
    provider.completeCheckout(account.customerId);
    const fetched = vi.spyOn(provider, "getCustomerSubscription");
    const app = new Hono();
    mountBillingRoutes(app, {
      billing,
      provider,
      webOrigin: origin,
      authenticate: async (request, spaceId) => {
        if (request.headers.get("cookie") !== first.cookie) return null;
        return actorFromMembership(
          requireMembership(runtime.prisma, first.actor.userId, spaceId ?? first.actor.spaceId),
        );
      },
    });
    const signed = provider.signWebhook({
      type: "customer.subscription.updated",
      data: { object: { customer: account.customerId } },
    });
    expect(
      (
        await app.request(BILLING_WEBHOOK_PATH, {
          method: "POST",
          headers: { "stripe-signature": "invalid" },
          body: signed.body,
        })
      ).status,
    ).toBe(400);
    expect(fetched).not.toHaveBeenCalled();
    const alien = { spaceId: "space-billing-alien", userId: "user-billing-alien" };
    await runAsTenant(alien, async () => {
      expect((await app.request(BILLING_WEBHOOK_PATH, { method: "POST", ...signed })).status).toBe(
        200,
      );
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    expect(
      await owner.prisma.billingAccount.findUnique({
        where: { organizationId: space.organizationId },
      }),
    ).toMatchObject({ status: "trialing" });
    fetched.mockClear();
    provider.completeCheckout(account.customerId, "active");
    await app.request(`${BILLING_RETURN_PATH}?space=${second.actor.spaceId}`, {
      headers: { cookie: first.cookie },
    });
    expect(fetched).not.toHaveBeenCalled();
    await runAsTenant(alien, async () => {
      const response = await app.request(`${BILLING_RETURN_PATH}?space=${first.actor.spaceId}`, {
        headers: { cookie: first.cookie },
      });
      expect(response.status).toBe(303);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    expect(fetched).toHaveBeenCalledOnce();
    expect(
      await owner.prisma.billingAccount.findUnique({
        where: { organizationId: space.organizationId },
      }),
    ).toMatchObject({ status: "active" });
    expect(await runtime.prisma.billingAccount.count()).toBe(0);
    expect(runtime.pool.waitingCount).toBe(0);
    fetched.mockRestore();
  });

  it("owns the messaging status callback context independently of its caller", async () => {
    const sink = registeredInbound.mock.calls[0]![0];
    const alien = { spaceId: "space-inbound-alien", userId: "user-inbound-alien" };
    const before = inboundContexts.length;
    await runAsTenant(alien, async () => {
      await sink({
        type: "status",
        provider: messaging.provider,
        handle: "offline-status",
        status: "ERROR",
      });
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    expect(inboundContexts.slice(before)).toEqual([{ kind: "system", reason: expect.any(String) }]);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("resolves the public peer identity in system context without borrowing a caller's tenant", async () => {
    const ambient = { spaceId: "space-unrelated", userId: "user-unrelated" };
    const unscoped = new Hono();
    const service = createDeploymentTransferService({
      prisma: handles.prisma,
      secrets: store,
      origin,
      peer: createDeploymentTransferPeer(),
    });
    mountDeploymentTransferHttp(unscoped, service);
    try {
      expect(
        (await runAsTenant(ambient, () => unscoped.request("/api/deployment-transfer/v1/identity")))
          .status,
      ).toBe(400);
    } finally {
      await service.close();
    }
    await runAsTenant(ambient, async () => {
      const response = await handles.app.request("/api/deployment-transfer/v1/identity");
      expect(response.status).toBe(200);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(await owner.prisma.deploymentIdentity.count()).toBe(1);
    expect(await runtime.prisma.deploymentIdentity.count()).toBe(0);
    const before = await owner.prisma.deploymentTransferSession.count();
    const invalid = await runAsTenant(ambient, () =>
      handles.app.request("/api/deployment-transfer/v1/item", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${"a".repeat(43)}` },
        body: JSON.stringify({ unsigned: "sensitive-marker" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("sensitive-marker");
    expect(await owner.prisma.deploymentTransferSession.count()).toBe(before);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("recovers transfer receipts through persisted ownership while enforcing real sessions and revisions", async () => {
    const caller = await account("Transfer");
    const bot = await owner.prisma.bot.create({
      data: { ...scope(caller.actor), name: "Transfer context", color: "blue" },
    });
    const otherBot = await owner.prisma.bot.create({
      data: { ...scope(caller.actor), name: "Other transfer context", color: "green" },
    });
    const clientNonce = randomUUID();
    const input = { targetBotId: bot.id, sourceOrigin: "https://source.example.test", clientNonce };
    const created = await rpc<{ transferId: string; revision: number; phase: string }>(
      caller.cookie,
      "transfer/start",
      input,
    );
    expect(created.phase).toBe("created");
    const statusInput = { transferId: created.transferId };
    const nonceInput = { side: "target", clientNonce };
    expect(await rpc(caller.cookie, "transfer/status", nonceInput)).toEqual(created);
    expect(
      await rpc(caller.cookie, "transfer/status", statusInput, "missing-selected-space"),
    ).toEqual(created);
    const otherSpace = await rpc<{ id: string }>(caller.cookie, "spaces/create", {
      name: "Other transfer Space",
    });
    expect(await rpc(caller.cookie, "transfer/status", statusInput, otherSpace.id)).toEqual(
      created,
    );
    const recent = await rpc<Array<{ transferId: string }>>(
      caller.cookie,
      "transfer/recent",
      { botId: bot.id },
      caller.actor.spaceId,
    );
    expect(recent.map((item) => item.transferId)).toContain(created.transferId);
    const before = await owner.prisma.deploymentTransferSession.findUniqueOrThrow({
      where: { id: created.transferId },
    });
    expect((await raw("", "transfer/status", statusInput)).status).toBe(401);
    expect((await raw(second.cookie, "transfer/status", statusInput)).status).toBe(404);
    expect(
      (await raw(caller.cookie, "transfer/start", input, "missing-selected-space")).status,
    ).toBe(403);
    expect(
      (
        await raw(
          caller.cookie,
          "transfer/start",
          { ...input, targetBotId: otherBot.id },
          caller.actor.spaceId,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await raw(
          caller.cookie,
          "transfer/cancel",
          {
            transferId: created.transferId,
            expectedRevision: created.revision + 1,
          },
          caller.actor.spaceId,
        )
      ).status,
    ).toBe(409);
    const membership = await owner.prisma.spaceMember.findFirstOrThrow({
      where: scope(caller.actor),
    });
    await owner.prisma.spaceMember.delete({ where: { id: membership.id } });
    try {
      // The existing Space lifecycle lock rejects missing membership before
      // the protocol session check; its sanitized public response is 400.
      expect((await raw(caller.cookie, "transfer/status", statusInput, otherSpace.id)).status).toBe(
        400,
      );
    } finally {
      await owner.prisma.spaceMember.create({ data: membership });
    }
    const session = await owner.prisma.session.findUniqueOrThrow({
      where: { id: before.localSessionId },
    });
    await owner.prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(0) },
    });
    try {
      expect((await raw(caller.cookie, "transfer/status", statusInput, otherSpace.id)).status).toBe(
        401,
      );
    } finally {
      await owner.prisma.session.upsert({
        where: { id: session.id },
        create: session,
        update: { expiresAt: session.expiresAt },
      });
    }
    expect(
      await owner.prisma.deploymentTransferSession.findUniqueOrThrow({
        where: { id: created.transferId },
      }),
    ).toEqual(before);
    expect(await runtime.prisma.deploymentTransferSession.count()).toBe(0);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("resolves sealed screen capabilities after authentication while preserving lifecycle fences", async () => {
    const botId = randomUUID();
    const computer = await owner.prisma.computer.create({
      data: {
        ...scope(first.actor),
        scope: "dedicated",
        scopeKey: `context-screen-${suffix}`,
        homeKey: `context-screen-home-${suffix}`,
        kind: "fake",
        state: "running",
        providerRef: `offline-screen-${suffix}`,
        controlHolder: "user",
        controlLeaseId: "screen-lease",
        controlBotId: botId,
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const bot = await owner.prisma.bot.create({
      data: {
        id: botId,
        ...scope(first.actor),
        name: "Screen",
        color: "blue",
        computerId: computer.id,
      },
    });
    const path = new URL(
      addScreenProxyCapability(
        "http://127.0.0.1:49152/embed.html?view_only=false",
        screenSecret,
        origin,
        {
          botId: bot.id,
          computerId: computer.id,
          botGeneration: bot.screenGeneration,
          computerGeneration: computer.screenGeneration,
          controlLeaseId: "screen-lease",
        },
      ),
    ).pathname;
    const request = (credential: string, capability = path) =>
      handles.app.request(SCREEN_TARGET_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ path: capability }),
      });
    const before = botReads;
    expect((await request("wrong")).status).toBe(403);
    expect((await request(screenSecret, "invalid-capability")).status).toBe(403);
    expect(botReads).toBe(before);
    const alien = { spaceId: "space-alien", userId: "user-alien" };
    await runAsTenant(alien, async () => {
      expect(await runtime.prisma.bot.findUnique({ where: { id: bot.id } })).toBeNull();
      expect((await request(screenSecret)).status).toBe(200);
      expect(botReads).toBeGreaterThan(before);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
    });
    await owner.prisma.computer.update({
      where: { id: computer.id },
      data: { controlLeaseId: "replacement-lease" },
    });
    expect((await request(screenSecret)).status).toBe(403);
    await owner.prisma.bot.update({
      where: { id: bot.id },
      data: { screenGeneration: { increment: 1 } },
    });
    expect((await request(screenSecret)).status).toBe(403);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it.each(["speak", "transcribe"])(
    "uses the real session actor for voice %s and rejects foreign access before the provider",
    async (route) => {
      const caller = await account(`Voice-${route}`);
      const secretId = randomUUID();
      const sealed = await store.put("offline-voice-key", voiceContext(caller.actor), {
        recordId: secretId,
      });
      await owner.prisma.secret.create({
        data: {
          id: secretId,
          userId: caller.actor.userId,
          spaceId: null,
          kind: "voice",
          ciphertext: sealed.ref,
        },
      });
      const credential = await owner.prisma.userVoiceCredential.create({
        data: { userId: caller.actor.userId, provider: "openai", secretId },
      });
      await owner.prisma.spaceVoicePreference.create({
        data: {
          ...scope(caller.actor),
          credentialId: credential.id,
          voiceId: "alloy",
          isDefault: true,
        },
      });
      const bot = await owner.prisma.bot.create({
        data: { ...scope(first.actor), name: "Other voice", color: "blue" },
      });
      const providerCall = vi.fn(async () => {
        expect(currentDbContext()).toEqual({ kind: "tenant", ...scope(caller.actor) });
      });
      const provider = vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
        synthesize: async () => {
          await providerCall();
          return { bytes: new Uint8Array([1]), mimeType: "audio/wav" };
        },
        transcribe: async () => {
          await providerCall();
          return { text: "Recorded" };
        },
      } as never);
      const request = (cookie: string, body: Record<string, unknown>, spaceId?: string) =>
        handles.app.request(`/api/voice/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin,
            ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
          },
          body: JSON.stringify(body),
        });
      const input =
        route === "speak" ? { text: "Hello" } : { audioBase64: "AQ==", mimeType: "audio/wav" };
      const alien = { spaceId: "space-alien", userId: "user-alien" };
      try {
        await runAsTenant(alien, async () => {
          const response = await request(caller.cookie, {
            ...input,
            userId: "forged-user",
            spaceId: "forged-space",
          });
          expect(response.status).toBe(200);
          expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
        });
        expect(providerCall).toHaveBeenCalledOnce();
        expect((await request("", input)).status).toBe(401);
        expect((await request(caller.cookie, input, first.actor.spaceId)).status).toBe(403);
        if (route === "speak")
          expect((await request(caller.cookie, { ...input, botId: bot.id })).status).toBe(404);
        else {
          const outsider = await account("Voice-outsider");
          expect(
            (await request(outsider.cookie, { ...input, credentialId: credential.id })).status,
          ).toBe(409);
        }
        expect(providerCall).toHaveBeenCalledOnce();
        expect(await runtime.prisma.secret.count()).toBe(0);
        expect(runtime.pool.waitingCount).toBe(0);
      } finally {
        provider.mockRestore();
      }
    },
  );

  it("keeps Board sharing by Space and Bot access private to the authenticated owner", async () => {
    const space = await owner.prisma.space.findUniqueOrThrow({
      where: { id: first.actor.spaceId },
    });
    await owner.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: second.actor.userId } },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: space.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const firstBoards = await rpc<Array<{ id: string }>>(first.cookie, "boards/list");
    const sharedBoards = await rpc<Array<{ id: string }>>(
      second.cookie,
      "boards/list",
      {},
      space.id,
    );
    expect(sharedBoards.map((board) => board.id)).toEqual(firstBoards.map((board) => board.id));
    const bot = await owner.prisma.bot.create({
      data: { userId: first.actor.userId, spaceId: space.id, name: "Private", color: "blue" },
    });
    expect(
      await runAsTenant({ userId: second.actor.userId, spaceId: space.id }, () =>
        runtime.prisma.bot.findUnique({ where: { id: bot.id } }),
      ),
    ).toBeNull();
    expect(
      await runAsTenant(first.actor, () =>
        runtime.prisma.bot.findUnique({ where: { id: bot.id } }),
      ),
    ).toMatchObject({ id: bot.id });
  });

  it("switches to a verified target Space while retaining owner and deletion checks", async () => {
    const target = await rpc<{ id: string }>(first.cookie, "spaces/create", { name: "Draft" });
    expect(
      await rpc(first.cookie, "spaces/rename", { spaceId: target.id, name: "Renamed" }),
    ).toEqual({ id: target.id, name: "Renamed" });
    const space = await owner.prisma.space.findUniqueOrThrow({ where: { id: target.id } });
    await owner.prisma.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: space.organizationId,
          userId: second.actor.userId,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: target.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    for (const procedure of ["spaces/rename", "spaces/remove"]) {
      expect(
        (
          await raw(
            second.cookie,
            procedure,
            { spaceId: target.id, ...(procedure.endsWith("rename") ? { name: "Stolen" } : {}) },
            target.id,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (await raw(first.cookie, "spaces/rename", { spaceId: "missing-space", name: "Missing" }))
        .status,
    ).toBe(404);
    expect(await rpc(first.cookie, "spaces/remove", { spaceId: target.id })).toMatchObject({
      ok: true,
      activeSpaceId: first.actor.spaceId,
    });
    expect(await owner.prisma.space.findUnique({ where: { id: target.id } })).toBeNull();
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("deletes the selected empty Space and restores another verified membership", async () => {
    const target = await rpc<{ id: string }>(first.cookie, "spaces/create", { name: "Selected" });
    expect(
      await rpc(first.cookie, "spaces/remove", { spaceId: target.id }, target.id),
    ).toMatchObject({ ok: true, activeSpaceId: first.actor.spaceId });
    expect((await raw(first.cookie, "me", {}, target.id)).status).toBe(403);
    expect(await rpc(first.cookie, "me")).toMatchObject({
      userId: first.actor.userId,
      spaceId: first.actor.spaceId,
    });
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("rechecks actual membership before delivering another frame on an open stream", async () => {
    const target = await rpc<{ id: string }>(first.cookie, "spaces/create", { name: "Stream" });
    const space = await owner.prisma.space.findUniqueOrThrow({ where: { id: target.id } });
    await owner.prisma.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: space.organizationId,
          userId: second.actor.userId,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: target.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const subscribed = vi.spyOn(realtime, "subscribe");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const readUntil = async (expected: string) => {
      const decoder = new TextDecoder();
      let text = "";
      for (let index = 0; index < 8; index++) {
        const next = await reader!.read();
        text += decoder.decode(next.value, { stream: !next.done });
        if (text.includes(expected)) return text;
        if (next.done) break;
      }
      throw new Error(`Stream closed without the expected frame: ${expected}`);
    };
    try {
      const response = await handles.app.request("/rpc/boards/subscribe", {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
          origin,
          "x-rakazo-space-id": target.id,
        },
        body: JSON.stringify({ json: {} }),
      });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const firstFrame = readUntil(target.id);
      await vi.waitFor(() =>
        expect(subscribed.mock.calls.some(([topic]) => topic === boardEventTopic(target.id))).toBe(
          true,
        ),
      );
      const events = createBoardEvents(realtime);
      await events.notify(target.id);
      expect(await firstFrame).toContain(target.id);
      await owner.prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      });
      clock += 10_001;
      const deniedFrame = readUntil("UNAUTHORIZED");
      await events.notify(target.id);
      expect(await deniedFrame).toContain("UNAUTHORIZED");
      expect(runtime.pool.waitingCount).toBe(0);
    } finally {
      abort.abort();
      clearTimeout(timeout);
      await reader?.cancel();
      subscribed.mockRestore();
      now.mockRestore();
    }
  }, 10_000);

  it("rolls back both consent writes when a later recipient fails, then commits them together", async () => {
    const secret = await owner.prisma.secret.create({
      data: { ...scope(first.actor), kind: "memory", ciphertext: "offline-memory-reference" },
    });
    await owner.prisma.spaceMemoryConfig.create({
      data: { ...scope(first.actor), provider: "supermemory", settings: {}, secretId: secret.id },
    });
    const credential = await owner.prisma.userVoiceCredential.create({
      data: { userId: first.actor.userId, provider: "openai", secretId: "offline-voice-reference" },
    });
    await owner.prisma.spaceVoicePreference.create({
      data: { ...scope(first.actor), credentialId: credential.id, voiceId: "alloy" },
    });
    const status = await rpc<{
      scope: string;
      version: string;
      recipients: Array<{ key: string }>;
    }>(first.cookie, "aiConsent/status");
    const keys = status.recipients.map((recipient) => recipient.key);
    expect(keys).toHaveLength(2);
    rejectConsent = keys[1];
    try {
      expect(
        (
          await raw(first.cookie, "aiConsent/allow", {
            scope: status.scope,
            version: status.version,
            keys,
          })
        ).status,
      ).toBe(500);
      expect(
        await owner.prisma.aiDataConsent.count({
          where: { userId: first.actor.userId, spaceId: first.actor.spaceId },
        }),
      ).toBe(0);
    } finally {
      rejectConsent = undefined;
    }
    await rpc(first.cookie, "aiConsent/allow", {
      scope: status.scope,
      version: status.version,
      keys,
    });
    expect(
      await owner.prisma.aiDataConsent.count({
        where: { userId: first.actor.userId, spaceId: first.actor.spaceId },
      }),
    ).toBe(2);
    expect(await runtime.prisma.aiDataConsent.count()).toBe(0);
  });

  it("keeps catalog reconciliation atomic even when the RPC logs a later write failure", async () => {
    const rows = await Promise.all(
      [0, 1].map((index) =>
        owner.prisma.connection.create({
          data: {
            ...scope(first.actor),
            connectorId: "fixture",
            provider: "MAIL",
            displayName: `Mail ${index}`,
            status: "pending",
            createdAt: new Date(index),
          },
        }),
      ),
    );
    const client = createRouterClient(
      createRouter({
        prisma: handles.prisma,
        env: {},
        connectors: {
          managedProviders: () => [
            {
              describe: () => ({ id: "fixture" }),
              catalog: async () => [
                {
                  connectorId: "fixture",
                  slug: "MAIL",
                  name: "Mail",
                  logo: null,
                  connected: true,
                  noAuth: false,
                },
              ],
            },
          ],
        },
      } as unknown as RouterDeps),
      { context: { actor: first.actor } },
    );
    const statuses = () =>
      owner.prisma.connection.findMany({
        where: { id: { in: rows.map((row) => row.id) } },
        select: { status: true },
        orderBy: { createdAt: "asc" },
      });
    rejectRevocation = true;
    try {
      expect(await client.connections.catalog({})).toHaveLength(1);
      expect(await statuses()).toEqual([{ status: "pending" }, { status: "pending" }]);
    } finally {
      rejectRevocation = false;
    }
    await client.connections.catalog({});
    expect(await statuses()).toEqual([{ status: "connected" }, { status: "revoked" }]);
  });

  it("checks references across tenants after commit and releases its sole connection before cleanup", async () => {
    const ciphertext = `offline-shared-${suffix}`;
    const a = await owner.prisma.secret.create({
      data: { userId: first.actor.userId, spaceId: null, kind: "model", ciphertext },
    });
    const b = await owner.prisma.secret.create({
      data: {
        userId: second.actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext,
      },
    });
    deleted.mockClear();
    await runAsTenant(first.actor, () =>
      handles.prisma.$transaction(async (tx) => {
        await tx.secret.delete({ where: { id: a.id } });
        expect(deleted).not.toHaveBeenCalled();
      }),
    );
    expect(deleted).not.toHaveBeenCalled();
    expect(await owner.prisma.secret.findUnique({ where: { id: b.id } })).toMatchObject({
      ciphertext,
    });
    await runAsTenant(second.actor, () =>
      handles.prisma.$transaction(async (tx) => {
        await tx.secret.delete({ where: { id: b.id } });
        expect(deleted).not.toHaveBeenCalled();
      }),
    );
    expect(deleted).toHaveBeenCalledExactlyOnceWith(ciphertext, b.id);
    expect(runtime.pool.waitingCount).toBe(0);
    expect(await runtime.prisma.secret.count()).toBe(0);
  });
});
