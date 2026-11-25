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
import type { Actor, McpServer, VoiceCredential } from "@rakazo/contracts";
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
    // Space discovery follows this user's actual memberships across selections.
    [
      "spaces",
      "EXISTS (SELECT 1 FROM space_members m WHERE m.\"spaceId\" = spaces.id AND m.\"userId\" = NULLIF(current_setting('app.user_id', true), ''))",
    ],
    ["bots", tenantPredicate],
    ["computers", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["boards", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["connections", tenantPredicate],
    ["space_memory_configs", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["messaging_outbound", "false"],
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
  let retryVoiceCreateFor: string | undefined;
  let retryMemorySaveFor: string | undefined;
  let rejectMcpApprovalFor: string | undefined;
  let rejectMcpToolPolicyFor: string | undefined;
  let rejectMcpCredentialRemovalFor: string | undefined;
  let rejectMcpCredentialCreationFor: string | undefined;
  let rejectMcpCredentialUpdateFor: string | undefined;
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
    await owner.pool.query(`GRANT USAGE ON SCHEMA cogine_audit TO "${role}"`);
    await owner.pool.query(`GRANT INSERT ON cogine_audit.audit_events TO "${role}"`);
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
        mcpServer: {
          async create({ args, query }) {
            const row = await query(args);
            if (row.slug === rejectMcpCredentialCreationFor)
              throw new Error("Synthetic MCP server creation rollback");
            return row;
          },
          async update({ args, query }) {
            const row = await query(args);
            if (row.id === rejectMcpCredentialUpdateFor)
              throw new Error("Synthetic MCP credential update rollback");
            if (row.id === rejectMcpApprovalFor && args.data.allowAllTools === true)
              throw new Error("Synthetic MCP approval rollback");
            return row;
          },
          async updateMany({ args, query }) {
            const updated = await query(args);
            if (rejectMcpToolPolicyFor && args.where?.id === rejectMcpToolPolicyFor)
              throw new Error("Synthetic MCP tool policy rollback");
            return updated;
          },
        },
        secret: {
          async deleteMany({ args, query }) {
            const deleted = await query(args);
            if (rejectMcpCredentialRemovalFor && args.where?.id === rejectMcpCredentialRemovalFor)
              throw new Error("Synthetic MCP credential removal rollback");
            return deleted;
          },
        },
        spaceMemoryConfig: {
          async upsert({ args, query }) {
            const row = await query(args);
            if (row.spaceId === retryMemorySaveFor) {
              retryMemorySaveFor = undefined;
              throw Object.assign(new Error("Synthetic memory configuration conflict"), {
                code: "P2034",
              });
            }
            return row;
          },
        },
        userVoiceCredential: {
          async create({ args, query }) {
            const row = await query(args);
            if (row.userId === retryVoiceCreateFor) {
              retryVoiceCreateFor = undefined;
              throw Object.assign(new Error("Synthetic voice credential conflict"), {
                code: "P2034",
              });
            }
            return row;
          },
        },
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
      trustedProxies: ["198.51.100.5"],
      secretStore: store,
      remoteConnectors: {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
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
    const handle = `offline-status-${randomUUID()}`;
    const fixture = {
      kind: "group",
      body: "Synthetic outbound reply",
      status: "sent",
      deliveryState: "accepted",
      providerHandle: handle,
    };
    const expectedKey = `${handle}-same-provider`;
    const otherKey = `${handle}-other-provider`;
    await owner.prisma.messagingOutbound.createMany({
      data: [
        { ...fixture, idempotencyKey: expectedKey, provider: messaging.provider },
        { ...fixture, idempotencyKey: otherKey, provider: "other-context-provider" },
      ],
    });
    const before = inboundContexts.length;
    try {
      await runAsTenant(alien, async () => {
        expect(
          await runtime.prisma.messagingOutbound.count({ where: { providerHandle: handle } }),
        ).toBe(0);
        await sink({ type: "status", provider: messaging.provider, handle, status: "ERROR" });
        expect(currentDbContext()).toEqual({ kind: "tenant", ...alien });
      });
      expect(inboundContexts.slice(before)).toEqual([
        { kind: "system", reason: expect.any(String) },
      ]);
      expect(
        await owner.prisma.messagingOutbound.findUnique({ where: { idempotencyKey: expectedKey } }),
      ).toMatchObject({ status: "failed", deliveryState: "failed" });
      expect(
        await owner.prisma.messagingOutbound.findUnique({ where: { idempotencyKey: otherKey } }),
      ).toMatchObject({ status: "sent", deliveryState: "accepted" });
      expect(runtime.pool.waitingCount).toBe(0);
    } finally {
      await owner.prisma.messagingOutbound.deleteMany({
        where: { idempotencyKey: { in: [expectedKey, otherKey] } },
      });
    }
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

  it("audits actual MCP card decisions and distinguishes shared permission changes", async () => {
    const { actor, cookie } = await account("Mcp-audit");
    const { spaceId, userId } = actor;
    const bot = await owner.prisma.bot.create({
      data: { spaceId, userId, name: "Approval fixture", color: "blue" },
    });
    const thread = await owner.prisma.thread.create({
      data: { spaceId, userId, botId: bot.id },
    });
    const addCard = async (slug: string, seq: number, allowedTools: string[]) => {
      const server = await owner.prisma.mcpServer.create({
        data: {
          spaceId,
          userId,
          slug,
          name: slug,
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/tools",
          allowedTools,
        },
      });
      const block = {
        kind: "mcp_approval",
        serverId: server.id,
        serverRevision: server.revision,
        status: "pending",
        name: slug,
        transport: server.transport,
        endpoint: server.endpoint,
        needsOAuth: false,
      };
      const message = await owner.prisma.message.create({
        data: { threadId: thread.id, botId: bot.id, seq, role: "bot", blocks: [block] },
      });
      const input = {
        botId: bot.id,
        serverId: server.id,
        threadId: thread.id,
        revision: server.revision,
      };
      return { id: server.id, input, message, block };
    };
    const grant = await addCard("fixture-grant", 1, []);
    const existing = await addCard("fixture-existing", 2, ["read"]);
    const dismissed = await addCard("fixture-dismiss", 3, ["read"]);
    const audits = () =>
      owner.prisma.auditEvent.findMany({
        where: { actorId: userId, spaceId, targetType: "mcp_server", action: "approval.decided" },
        select: {
          targetId: true,
          threadId: true,
          metadata: true,
          outcome: true,
          organizationId: true,
        },
      });
    const approve = (input: typeof grant.input) => rpc(cookie, "mcp/assignments/approve", input);
    const dismiss = (
      input: Omit<typeof dismissed.input, "revision" | "threadId"> & { threadId?: string },
    ) => rpc(cookie, "mcp/assignments/dismiss", input);
    expect((await raw(second.cookie, "mcp/assignments/approve", grant.input, spaceId)).status).toBe(
      403,
    );
    rejectMcpApprovalFor = grant.id;
    try {
      expect((await raw(cookie, "mcp/assignments/approve", grant.input)).status).toBe(500);
    } finally {
      rejectMcpApprovalFor = undefined;
    }
    expect(
      (await owner.prisma.message.findUniqueOrThrow({ where: { id: grant.message.id } })).blocks,
    ).toEqual([grant.block]);
    expect(await audits()).toEqual([]);
    await approve(grant.input);
    expect((await raw(cookie, "mcp/assignments/approve", grant.input)).status).toBe(409);

    await Promise.all([approve(existing.input), approve(existing.input)]);
    await dismiss(dismissed.input);
    await dismiss({ botId: bot.id, serverId: dismissed.id });
    expect((await raw(cookie, "mcp/assignments/approve", dismissed.input)).status).toBe(409);

    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    const receipts = await audits();
    const event = (
      targetId: string,
      decision: "allow" | "dismiss",
      sharedPolicyChanged: boolean,
    ) => ({
      targetId,
      threadId: thread.id,
      organizationId,
      metadata: { botId: bot.id, decision, sharedPolicyChanged },
      outcome: decision === "allow" ? "success" : "denied",
    });
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(
      expect.arrayContaining([
        event(grant.id, "allow", true),
        event(existing.id, "allow", false),
        event(dismissed.id, "dismiss", false),
      ]),
    );
    expect(await owner.prisma.mcpServer.findUnique({ where: { id: grant.id } })).toMatchObject({
      allowAllTools: true,
    });
    for (const id of [existing.id, dismissed.id]) {
      expect(await owner.prisma.mcpServer.findUnique({ where: { id } })).toMatchObject({
        allowAllTools: false,
        allowedTools: ["read"],
      });
    }
  });

  it("audits approval settings with only the original request's resolved address", async () => {
    const { actor, cookie } = await account("Approval-IP-audit");
    const { spaceId, userId } = actor;
    async function request<T>(
      procedure: string,
      input: unknown,
      peer?: string,
      forwarded?: string,
    ) {
      const response = await handles.app.request(
        `/rpc/${procedure}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            origin,
            "x-real-ip": "192.0.2.20",
            ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
          },
          body: JSON.stringify({ json: input }),
        },
        peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { json: T }).json;
    }

    const rule = {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "web_fetch",
      requestIp: "192.0.2.25",
    };
    const created = await request<{ id: string }>(
      "approvalRules/set",
      rule,
      "198.51.100.5",
      "192.0.2.21, [2001:db8::12]:3000",
    );
    expect(await request("approvalRules/set", rule, "203.0.113.22")).toMatchObject(created);
    await request("approvalRules/remove", { id: created.id }, undefined, "192.0.2.21");
    await request("approvalRules/remove", { id: created.id }, "203.0.113.24");

    await request("autoReview/set", { enabled: true }, "203.0.113.24", "192.0.2.21");
    await request("autoReview/set", { enabled: true }, "203.0.113.22");
    await request("autoReview/set", { enabled: false }, "198.51.100.5", "198.51.100.30");
    const rows = await owner.prisma.auditEvent.findMany({
      where: { spaceId, actorId: userId },
      select: { action: true, targetId: true, requestIp: true, metadata: true },
    });
    const preference = await owner.prisma.actionAutoReviewPreference.findUniqueOrThrow({
      where: { spaceId_userId: { spaceId, userId } },
    });
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          action: "approval.rule.created",
          targetId: created.id,
          requestIp: "2001:db8::12",
          metadata: { effect: "always_allow", matchKind: "tool" },
        },
        {
          action: "approval.rule.deleted",
          targetId: created.id,
          requestIp: null,
          metadata: { effect: "always_allow", matchKind: "tool" },
        },
        {
          action: "approval.policy.changed",
          targetId: preference.id,
          requestIp: "203.0.113.24",
          metadata: { enabled: true },
        },
        {
          action: "approval.policy.changed",
          targetId: preference.id,
          requestIp: "198.51.100.30",
          metadata: { enabled: false },
        },
      ]),
    );
  });

  it("audits local credential creation only after the MCP server and material commit", async () => {
    const { actor, cookie } = await account("Mcp-create-audit");
    const { spaceId, userId } = actor;
    const procedure = "mcp/servers/create";
    const input = {
      slug: "fixture-mcp-secured",
      name: "MCP creation fixture",
      transport: "streamable_http",
      endpoint: "https://mcp.example.test/tools?mode=synthetic",
      headers: { Authorization: "Bearer fixture-header" },
    };
    const audit = () => owner.prisma.auditEvent.findMany({ where: { spaceId, actorId: userId } });
    const materialCount = () =>
      owner.prisma.secret.count({ where: { spaceId, userId, kind: "mcp" } });
    const { headers: _headers, ...publicServer } = input;
    const plain = await rpc<McpServer>(cookie, procedure, {
      ...publicServer,
      slug: "fixture-mcp-plain",
    });
    expect(plain.hasSecret).toBe(false);
    expect((await raw(second.cookie, procedure, input, spaceId)).status).toBe(403);
    rejectMcpCredentialCreationFor = input.slug;
    try {
      expect((await raw(cookie, procedure, input)).status).toBe(500);
    } finally {
      rejectMcpCredentialCreationFor = undefined;
    }
    expect(await owner.prisma.mcpServer.count({ where: { spaceId, userId } })).toBe(1);
    expect(await materialCount()).toBe(0);
    expect(await audit()).toEqual([]);

    const created = await rpc<McpServer>(cookie, procedure, input);
    expect(created.hasSecret).toBe(true);
    const server = await owner.prisma.mcpServer.findUniqueOrThrow({
      where: { id: created.id },
      include: { secret: true },
    });
    const secret = server.secret!;
    expect(secret).toMatchObject({ userId, spaceId, kind: "mcp" });
    expect(JSON.parse(await store.load(secret.ciphertext, secret.id))).toEqual({
      env: {},
      headers: input.headers,
    });
    expect((await raw(cookie, procedure, input)).ok).toBe(false);
    expect(await materialCount()).toBe(1);

    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    expect(await audit()).toEqual([
      {
        id: expect.any(String),
        createdAt: server.createdAt,
        organizationId,
        spaceId,
        actorType: "user",
        actorId: userId,
        actorLabel: null,
        requestIp: null,
        action: "credential.created",
        targetType: "mcp_server",
        targetId: server.id,
        targetLabel: null,
        outcome: "success",
        runId: null,
        threadId: null,
        metadata: {},
      },
    ]);
  });

  it("audits local credential deletion only after the MCP server removal commits", async () => {
    const { actor, cookie } = await account("Mcp-removal-audit");
    const { spaceId, userId } = actor;
    const stored = await store.put(JSON.stringify({ secret: "fixture-mcp-secret" }), {
      spaceId,
      userId,
      operationId: "mcp-removal-fixture",
      traceId: "mcp-removal-fixture",
      signal: new AbortController().signal,
    });
    const secret = await owner.prisma.secret.create({
      data: { id: stored.id, spaceId, userId, kind: "mcp", ciphertext: stored.ciphertext },
    });
    const createServer = (slug: string, secretId?: string) =>
      owner.prisma.mcpServer.create({
        data: {
          spaceId,
          userId,
          slug,
          name: "MCP removal fixture",
          transport: "streamable_http",
          endpoint: "https://mcp.example.test/tools",
          secretId,
        },
      });
    const server = await createServer("fixture-with-credential", secret.id);
    const credentialFree = await createServer("fixture-without-credential");
    const audit = () =>
      owner.prisma.auditEvent.findMany({
        where: { targetId: { in: [server.id, credentialFree.id] } },
        select: {
          action: true,
          actorType: true,
          actorId: true,
          spaceId: true,
          organizationId: true,
          targetType: true,
          targetId: true,
          outcome: true,
          metadata: true,
        },
      });
    const input = { id: server.id };
    expect((await raw(second.cookie, "mcp/servers/remove", input, spaceId)).status).toBe(403);
    rejectMcpCredentialRemovalFor = secret.id;
    try {
      expect((await raw(cookie, "mcp/servers/remove", input)).status).toBe(500);
    } finally {
      rejectMcpCredentialRemovalFor = undefined;
    }
    expect(await owner.prisma.mcpServer.findUnique({ where: input })).toEqual(server);
    expect(await owner.prisma.secret.findUnique({ where: { id: secret.id } })).toEqual(secret);
    expect(deleted.mock.calls.filter(([ref]) => ref === stored.ciphertext)).toHaveLength(0);
    expect(await audit()).toEqual([]);

    await expect(rpc(cookie, "mcp/servers/remove", input)).resolves.toEqual({ ok: true });
    expect(await owner.prisma.mcpServer.findUnique({ where: input })).toBeNull();
    expect(await owner.prisma.secret.findUnique({ where: { id: secret.id } })).toBeNull();
    expect(deleted.mock.calls.filter(([ref]) => ref === stored.ciphertext)).toHaveLength(1);
    expect((await raw(cookie, "mcp/servers/remove", input)).ok).toBe(false);
    await rpc(cookie, "mcp/servers/remove", { id: credentialFree.id });
    expect(
      await owner.prisma.mcpServer.findUnique({ where: { id: credentialFree.id } }),
    ).toBeNull();

    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    expect(await audit()).toEqual([
      {
        action: "credential.deleted",
        actorType: "user",
        actorId: userId,
        spaceId,
        organizationId,
        targetType: "mcp_server",
        targetId: server.id,
        outcome: "success",
        metadata: {},
      },
    ]);
  });

  it("audits a remote MCP credential change only after the endpoint move commits", async () => {
    const { actor, cookie } = await account("Mcp-endpoint-audit");
    const { spaceId, userId } = actor;
    const stored = await store.put(JSON.stringify({ secret: "fixture-old-key" }), {
      spaceId,
      userId,
      operationId: "mcp-endpoint-fixture",
      traceId: "mcp-endpoint-fixture",
      signal: new AbortController().signal,
    });
    const { id: secretId } = await owner.prisma.secret.create({
      data: { id: stored.id, spaceId, userId, kind: "mcp", ciphertext: stored.ciphertext },
    });
    const server = await owner.prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "fixture-moving-endpoint",
        name: "MCP endpoint fixture",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/tools",
        secretId,
        allowedTools: ["fixture-tool"],
      },
    });
    const input = {
      id: server.id,
      revision: server.revision,
      config: {
        slug: server.slug,
        name: server.name,
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/other?mode=fixture",
        secret: "fixture-new-key",
      },
    };
    const where = { id: server.id };
    const audits = () => owner.prisma.auditEvent.findMany({ where: { targetId: server.id } });
    expect((await raw(second.cookie, "mcp/servers/update", input, spaceId)).status).toBe(403);
    rejectMcpCredentialUpdateFor = server.id;
    try {
      expect((await raw(cookie, "mcp/servers/update", input)).status).toBe(500);
    } finally {
      rejectMcpCredentialUpdateFor = undefined;
    }
    expect(await owner.prisma.mcpServer.findUnique({ where })).toEqual(server);
    expect(await owner.prisma.secret.count({ where: { spaceId, userId } })).toBe(1);
    expect(await audits()).toEqual([]);

    const result = await rpc<McpServer>(cookie, "mcp/servers/update", input);
    expect(result).toMatchObject({ endpoint: input.config.endpoint, oauthStatus: "none" });
    expect(result.allowedTools).toEqual(server.allowedTools);
    const { secret, updatedAt } = await owner.prisma.mcpServer.findUniqueOrThrow({
      where,
      include: { secret: true },
    });
    expect(secret?.id).not.toBe(secretId);
    expect(await store.load(secret!.ciphertext, secret!.id)).toBe(
      JSON.stringify({ secret: input.config.secret }),
    );
    expect(await owner.prisma.secret.findUnique({ where: { id: secretId } })).toBeNull();
    expect((await raw(cookie, "mcp/servers/update", input)).status).toBe(409);
    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    expect(await audits()).toMatchObject([
      {
        createdAt: updatedAt,
        action: "credential.changed",
        actorType: "user",
        actorId: userId,
        spaceId,
        organizationId,
        targetType: "mcp_server",
        targetId: server.id,
        outcome: "success",
        metadata: {},
      },
    ]);
  });

  it("audits committed static credential changes for an existing MCP endpoint", async () => {
    const { actor, cookie } = await account("Mcp-same-endpoint-audit");
    const { spaceId, userId } = actor;
    const server = await owner.prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "fixture-same-endpoint",
        name: "MCP credential fixture",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/tools",
      },
    });
    const where = { id: server.id };
    const read = () =>
      owner.prisma.mcpServer.findUniqueOrThrow({ where, include: { secret: true } });
    const audits = () =>
      owner.prisma.auditEvent.findMany({
        where: { targetType: "mcp_server", targetId: server.id },
        orderBy: [{ createdAt: "asc" }, { action: "asc" }],
      });
    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    const event = (action: string, createdAt: Date) => ({
      action,
      createdAt,
      actorType: "user",
      actorId: userId,
      spaceId,
      organizationId,
      targetType: "mcp_server",
      targetId: server.id,
      outcome: "success",
      metadata: {},
    });
    const first = { id: server.id, secret: "fixture-first-key" };
    expect((await raw(second.cookie, "mcp/servers/update", first, spaceId)).status).toBe(403);
    rejectMcpCredentialUpdateFor = server.id;
    try {
      expect((await raw(cookie, "mcp/servers/update", first)).status).toBe(500);
    } finally {
      rejectMcpCredentialUpdateFor = undefined;
    }
    expect(await read()).toEqual({ ...server, secret: null });
    expect(await owner.prisma.secret.count({ where: { spaceId, userId } })).toBe(0);
    expect(await audits()).toEqual([]);

    await rpc<McpServer>(cookie, "mcp/servers/update", first);
    const created = await read();
    expect(await store.load(created.secret!.ciphertext, created.secret!.id)).toBe(
      JSON.stringify({ secret: first.secret }),
    );
    await rpc<McpServer>(cookie, "mcp/servers/update", first);
    expect((await read()).secretId).toBe(created.secretId);

    const next = { ...first, secret: "fixture-next-key" };
    const prepared = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalPut = store.put.bind(store);
    const put = vi.spyOn(store, "put").mockImplementationOnce(async (...args) => {
      const staged = await originalPut(...args);
      prepared.resolve();
      await resume.promise;
      return staged;
    });
    const slow = rpc<McpServer>(cookie, "mcp/servers/update", next);
    let winner: Awaited<ReturnType<typeof read>>;
    try {
      await Promise.race([
        prepared.promise,
        slow.then(() => {
          throw new Error("Expected the first request to prepare its write before saving");
        }),
      ]);
      await rpc<McpServer>(cookie, "mcp/servers/update", next);
      winner = await read();
    } finally {
      resume.resolve();
      await slow.finally(() => put.mockRestore());
    }
    const updated = await read();
    expect(updated.secretId).toBe(winner.secretId);
    expect(await store.load(updated.secret!.ciphertext, updated.secret!.id)).toBe(
      JSON.stringify({ secret: next.secret }),
    );
    expect(await owner.prisma.secret.count({ where: { spaceId, userId } })).toBe(1);
    const [added, changed] = await audits();
    expect(added).toMatchObject(event("credential.created", created.updatedAt));
    expect(changed).toMatchObject(event("credential.changed", winner.updatedAt));
    expect(await audits()).toHaveLength(2);

    const clear = {
      id: server.id,
      config: {
        slug: server.slug,
        name: server.name,
        transport: "streamable_http",
        endpoint: server.endpoint,
        clearCredential: true,
      },
    };
    await rpc<McpServer>(cookie, "mcp/servers/update", clear);
    const cleared = await read();
    expect(cleared).toMatchObject({ endpoint: server.endpoint, secretId: null, secret: null });
    await rpc<McpServer>(cookie, "mcp/servers/update", clear);
    expect(await owner.prisma.secret.count({ where: { spaceId, userId } })).toBe(0);
    expect(await audits()).toMatchObject([
      added,
      changed,
      event("credential.deleted", cleared.updatedAt),
    ]);
  });

  it("audits only committed changes to the shared MCP tool policy", async () => {
    const { actor, cookie } = await account("Mcp-policy-audit");
    const { spaceId, userId } = actor;
    const server = await owner.prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "fixture-shared-policy",
        name: "Shared policy fixture",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/tools",
        allowedTools: ["fixture-read", "fixture-read", 1],
      },
    });
    const audit = () =>
      owner.prisma.auditEvent.findMany({
        where: { targetId: server.id },
        select: {
          actorType: true,
          actorId: true,
          spaceId: true,
          organizationId: true,
          action: true,
          targetType: true,
          outcome: true,
          metadata: true,
        },
      });
    const input = {
      id: server.id,
      revision: server.revision,
      allowAllTools: false,
      allowedTools: ["fixture-read", "fixture-write"],
    };
    const save = (patch: Partial<typeof input> & { verbatimResults?: boolean } = {}) =>
      rpc<McpServer>(cookie, "mcp/servers/setTools", { ...input, ...patch });
    expect((await raw(second.cookie, "mcp/servers/setTools", input, spaceId)).status).toBe(403);
    rejectMcpToolPolicyFor = server.id;
    try {
      expect((await raw(cookie, "mcp/servers/setTools", input)).status).toBe(500);
    } finally {
      rejectMcpToolPolicyFor = undefined;
    }
    expect(await owner.prisma.mcpServer.findUnique({ where: { id: server.id } })).toEqual(server);
    expect(await audit()).toEqual([]);

    const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
    });
    const event = (allowAllTools: boolean, allowlistCount: number | null) => ({
      actorType: "user",
      actorId: userId,
      spaceId,
      organizationId,
      action: "approval.policy.changed",
      targetType: "mcp_server",
      outcome: "success",
      metadata: { allowAllTools, allowlistCount },
    });
    const equivalent = await save({ allowedTools: ["fixture-read"] });
    expect(await audit()).toEqual([]);
    const saved = await save({ revision: equivalent.revision });
    expect(saved.allowedTools).toEqual(input.allowedTools);
    expect(await audit()).toEqual([event(false, 2)]);
    expect(
      (await raw(cookie, "mcp/servers/setTools", { ...input, allowAllTools: true })).status,
    ).toBe(409);
    const reordered = await save({
      revision: saved.revision,
      allowedTools: ["fixture-write", "fixture-read", "fixture-write"],
      verbatimResults: true,
    });
    expect(reordered).toMatchObject({
      allowedTools: ["fixture-write", "fixture-read"],
      verbatimResults: true,
    });
    expect(await audit()).toEqual([event(false, 2)]);

    const swapped = await save({
      revision: reordered.revision,
      allowedTools: ["fixture-read", "fixture-search"],
    });
    expect(await audit()).toEqual([event(false, 2), event(false, 2)]);
    const unrestricted = await save({ revision: swapped.revision, allowAllTools: true });
    const inert = await save({
      revision: unrestricted.revision,
      allowAllTools: true,
      allowedTools: [],
    });
    await save({ revision: inert.revision, allowedTools: [] });
    const receipts = await audit();
    expect(receipts).toHaveLength(4);
    expect(receipts).toEqual(expect.arrayContaining([event(true, null), event(false, 0)]));
  });

  it("audits only committed memory provider credential changes for the Space", async () => {
    const { actor, cookie } = await account("Memory-audit");
    const config = () =>
      owner.prisma.spaceMemoryConfig.findUnique({
        where: { spaceId: actor.spaceId },
        include: { secret: true },
      });
    const audit = () =>
      owner.prisma.auditEvent.findMany({
        where: { spaceId: actor.spaceId, targetType: "memory_credential" },
        select: {
          action: true,
          actorType: true,
          actorId: true,
          organizationId: true,
          targetId: true,
          outcome: true,
          metadata: true,
        },
        orderBy: { action: "asc" },
      });
    const input = {
      provider: "supermemory",
      settings: { mode: "cloud" },
      credentials: { apiKey: "fixture-memory-key" },
      defaultMemoryScope: "isolated",
    };
    const classify = vi
      .spyOn(adapters, "classifyMemoryProviderSettings")
      .mockResolvedValue(input.settings);
    const prepare = vi
      .spyOn(adapters, "prepareMemoryProviderConnection")
      .mockImplementation(async (draft) => {
        if (draft.credentials.apiKey === "fixture-rejected-key")
          throw new Error("Fixture rejected");
        return {
          provider: draft.provider,
          credentials: draft.credentials,
          settings: draft.settings,
        };
      });
    try {
      expect(
        (await raw(second.cookie, "memory/connectProvider", input, actor.spaceId)).status,
      ).toBe(403);
      expect(prepare).not.toHaveBeenCalled();
      expect(
        (
          await raw(cookie, "memory/connectProvider", {
            ...input,
            credentials: { apiKey: "fixture-rejected-key" },
          })
        ).status,
      ).toBe(400);
      expect(await config()).toBeNull();
      expect(await audit()).toEqual([]);

      retryMemorySaveFor = actor.spaceId;
      await rpc(cookie, "memory/connectProvider", input);
      expect(retryMemorySaveFor).toBeUndefined();
      const saved = (await config())!;
      expect(deleted.mock.calls.some(([ref]) => ref === saved.secret.ciphertext)).toBe(false);
      expect(await store.load(saved.secret.ciphertext, saved.secretId)).toBe(
        JSON.stringify(input.credentials),
      );
      const { organizationId } = await owner.prisma.space.findUniqueOrThrow({
        where: { id: actor.spaceId },
      });
      const expected = (action: string) => ({
        action,
        actorType: "user",
        actorId: actor.userId,
        organizationId,
        targetId: saved.id,
        outcome: "success",
        metadata: {},
      });
      await rpc(cookie, "memory/setDefaultScope", { defaultMemoryScope: "shared" });
      expect((await config())?.secretId).toBe(saved.secretId);
      expect(await audit()).toEqual([expected("credential.created")]);

      const credentials = { apiKey: "fixture-memory-replacement" };
      await rpc(cookie, "memory/connectProvider", { ...input, credentials });
      const replacement = (await config())!;
      expect(replacement.id).toBe(saved.id);
      expect(await store.load(replacement.secret.ciphertext, replacement.secretId)).toBe(
        JSON.stringify(credentials),
      );
      expect(await owner.prisma.secret.findUnique({ where: { id: saved.secretId } })).toBeNull();
      await rpc(cookie, "memory/disconnectProvider");
      await rpc(cookie, "memory/disconnectProvider");
      expect(await config()).toBeNull();
      expect(
        await owner.prisma.secret.findUnique({ where: { id: replacement.secretId } }),
      ).toBeNull();
      expect(await audit()).toEqual([
        expected("credential.changed"),
        expected("credential.created"),
        expected("credential.deleted"),
      ]);
    } finally {
      retryMemorySaveFor = undefined;
      classify.mockRestore();
      prepare.mockRestore();
    }
  });

  it("audits each committed voice credential change in the initiating Space", async () => {
    const caller = await account("Voice-audit");
    const otherSpace = await rpc<{ id: string }>(caller.cookie, "spaces/create", {
      name: "Other voice Space",
    });
    const spaces = await owner.prisma.space.findMany({
      where: { id: { in: [caller.actor.spaceId, otherSpace.id] } },
    });
    const audit = () =>
      owner.prisma.auditEvent.findMany({
        where: { actorId: caller.actor.userId, targetType: "voice_credential" },
        select: {
          action: true,
          actorType: true,
          organizationId: true,
          spaceId: true,
          targetId: true,
          outcome: true,
          metadata: true,
        },
        orderBy: [{ action: "asc" }, { targetId: "asc" }],
      });
    const input = { provider: "openai", apiKey: "fixture-voice-key", voiceId: "alloy" };
    const provider = vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
      verify: async (key: string) => ({ ok: key !== "fixture-rejected-key" }),
    } as never);
    try {
      expect(
        (await raw(caller.cookie, "voice/connect", { ...input, apiKey: "fixture-rejected-key" }))
          .status,
      ).toBe(400);
      expect((await raw(caller.cookie, "voice/connect", input, first.actor.spaceId)).status).toBe(
        403,
      );
      expect(await audit()).toEqual([]);

      retryVoiceCreateFor = caller.actor.userId;
      const saved = await rpc<VoiceCredential>(caller.cookie, "voice/connect", input);
      expect(retryVoiceCreateFor).toBeUndefined();
      const savedRow = await owner.prisma.userVoiceCredential.findUniqueOrThrow({
        where: { id: saved.id },
      });
      const savedSecret = await owner.prisma.secret.findUniqueOrThrow({
        where: { id: savedRow.secretId },
      });
      expect(deleted.mock.calls.some(([ref]) => ref === savedSecret.ciphertext)).toBe(false);
      const expected = (action: string, spaceId = caller.actor.spaceId) => ({
        action,
        actorType: "user",
        organizationId: spaces.find((space) => space.id === spaceId)!.organizationId,
        spaceId,
        targetId: saved.id,
        outcome: "success",
        metadata: {},
      });
      await rpc(caller.cookie, "voice/setVoice", { provider: input.provider, voiceId: "nova" });
      expect(await audit()).toEqual([expected("credential.created")]);

      const replacement = await rpc<VoiceCredential>(
        caller.cookie,
        "voice/connect",
        {
          ...input,
          apiKey: "fixture-voice-replacement",
        },
        otherSpace.id,
      );
      expect(replacement.id).toBe(saved.id);
      expect(await owner.prisma.secret.findUnique({ where: { id: savedRow.secretId } })).toBeNull();
      await rpc(second.cookie, "voice/disconnect", { provider: input.provider });
      expect(
        await owner.prisma.userVoiceCredential.findUnique({ where: { id: saved.id } }),
      ).not.toBeNull();
      await rpc(caller.cookie, "voice/disconnect", { provider: input.provider });
      await rpc(caller.cookie, "voice/disconnect", { provider: input.provider }, otherSpace.id);
      expect(
        await owner.prisma.userVoiceCredential.findUnique({ where: { id: saved.id } }),
      ).toBeNull();
      expect(await audit()).toEqual([
        expected("credential.changed", otherSpace.id),
        expected("credential.created"),
        expected("credential.deleted"),
      ]);
    } finally {
      retryVoiceCreateFor = undefined;
      provider.mockRestore();
    }
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
    await runAsTenant({ ...scope(first.actor), spaceId: target.id }, async () => {
      const visible = await runtime.prisma.space.findMany({ select: { id: true } });
      expect(visible.map((space) => space.id)).toEqual(
        expect.arrayContaining([first.actor.spaceId, target.id]),
      );
      expect(visible.map((space) => space.id)).not.toContain(second.actor.spaceId);
    });
    expect(await runtime.prisma.space.count()).toBe(0);
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
    const events = () =>
      owner.prisma.auditEvent.findMany({
        where: { targetId: { in: rows.map((row) => row.id) } },
        select: { action: true, targetId: true, outcome: true, metadata: true },
      });
    rejectRevocation = true;
    try {
      expect(await client.connections.catalog({})).toHaveLength(1);
      expect(await statuses()).toEqual([{ status: "pending" }, { status: "pending" }]);
      expect(await events()).toEqual([]);
    } finally {
      rejectRevocation = false;
    }
    await Promise.all([client.connections.catalog({}), client.connections.catalog({})]);
    expect(await statuses()).toEqual([{ status: "connected" }, { status: "revoked" }]);
    expect(await events()).toEqual([
      { action: "connection.connected", targetId: rows[0]!.id, outcome: "success", metadata: {} },
    ]);
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
