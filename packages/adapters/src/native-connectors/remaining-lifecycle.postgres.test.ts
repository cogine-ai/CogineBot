import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import type { NativeAppConfig } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "../infisical-secret-store.js";
import { PostgresRealtimeFanout } from "../realtime.js";
import { withSecretPersistence } from "../secret-persistence.js";
import { ComposedSecretStore } from "../secret-store-factory.js";
import { infisicalFake } from "../secret-store-fake.js";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeActionError } from "./action.js";
import type { NativeAuthorization } from "./authorities.js";
import { NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigSettingsSchema, NativeConfigStore } from "./config.js";
import { enterpriseConfigSecret } from "./enterprise-config-secret.js";
import { NativeOAuthStore } from "./oauth.js";

function remainingLifecycleDatabaseTarget(
  url: URL,
  mode: string | undefined,
  harnessDatabase: string | undefined,
): string {
  const database = url.pathname.slice(1);
  const isolated =
    mode === "isolated" &&
    url.hostname === "127.0.0.1" &&
    /^native_remaining_[a-z0-9_]+$/.test(database);
  const harness =
    mode === "harness_isolated" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    /^integration_(0|[1-9][0-9]*)$/.test(database) &&
    database === harnessDatabase;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    Number(url.port) <= 1024 ||
    (!isolated && !harness)
  )
    throw new Error("Remaining lifecycle tests require an explicitly isolated local database");
  return database;
}

// Explicit opt-in plus an isolated database name protects this independent canary.
const describeIsolated =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.DATABASE_URL &&
  ["isolated", "harness_isolated"].includes(process.env.VERIFY_NATIVE_REMAINING_LIFECYCLE ?? "")
    ? describe.sequential
    : describe.skip;
const SECRET = "synthetic-owner-managed-credential";
const KEY = "synthetic-remaining-lifecycle-encryption-key";
const ORIGIN = "https://api.example.test";
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describeIsolated("remaining native lifecycle and binding fences (isolated PostgreSQL)", () => {
  const suffix = randomUUID(),
    organizationId = `remaining-org-${suffix}`;
  const users = [
    `remaining-owner-${suffix}`,
    `remaining-member-${suffix}`,
    `remaining-peer-${suffix}`,
  ];
  const spaces = [`remaining-space-a-${suffix}`, `remaining-space-b-${suffix}`];
  const configIds = new Set<string>();
  let first: ReturnType<typeof createDb>,
    second: ReturnType<typeof createDb>,
    sequence = 0;
  const context = (spaceId = spaces[0]!, userId = users[0]!): AdapterContext => ({
    spaceId,
    userId,
    operationId: `remaining.${suffix}`,
    traceId: suffix,
    signal: new AbortController().signal,
  });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const database = remainingLifecycleDatabaseTarget(
      url,
      process.env.VERIFY_NATIVE_REMAINING_LIFECYCLE,
      process.env.VERIFY_NATIVE_REMAINING_LIFECYCLE_DATABASE,
    );
    if (process.env.VERIFY_NATIVE_REMAINING_LIFECYCLE === "isolated") {
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toMatch(/^\/native_remaining_[a-z0-9_]+$/);
    } else {
      expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
      expect(url.pathname).toMatch(/^\/integration_(0|[1-9][0-9]*)$/);
      expect(database).toBe(process.env.VERIFY_NATIVE_REMAINING_LIFECYCLE_DATABASE);
    }
    expect(Number(url.port)).toBeGreaterThan(1024);
    first = createDb(url.toString(), { poolMax: 3, applicationName: "remaining-lifecycle-first" });
    second = createDb(url.toString(), {
      poolMax: 3,
      applicationName: "remaining-lifecycle-second",
    });
    const proof = await first.prisma.$queryRaw<
      Array<{ version: string; database: string }>
    >`SELECT version(), current_database() AS database`;
    expect(proof[0]!.version).toContain("PostgreSQL");
    expect(proof[0]!.database).toBe(database);
    await first.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic remaining native organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const [index, userId] of users.entries()) {
      await first.prisma.user.create({
        data: { id: userId, name: "Synthetic lifecycle user", email: `${userId}@example.test` },
      });
      await first.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: index === 0 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    }
    for (const spaceId of spaces) {
      await first.prisma.space.create({
        data: { id: spaceId, organizationId, name: "Synthetic lifecycle Space" },
      });
      for (const [index, userId] of users.entries())
        await first.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId,
            organizationId,
            userId,
            role: index === 0 ? "owner" : "member",
            createdAt: new Date(),
          },
        });
    }
  });
  afterAll(async () => {
    if (first) {
      try {
        await first.prisma.organization.deleteMany({ where: { id: organizationId } });
        await first.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configIds] } } });
        await first.prisma.user.deleteMany({ where: { id: { in: users } } });
      } finally {
        await first.prisma.$disconnect();
        await first.pool.end();
      }
    }
    if (second) {
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });
  function fixture(primary = first, secondary = second) {
    const n = ++sequence,
      botId = String(600000 + n),
      applicationId = String(700000 + n),
      guildId = String(800000 + n);
    const vaultA = new EncryptedSecretStore(KEY),
      vaultB = new EncryptedSecretStore(KEY);
    const configsA = new NativeConfigStore(primary.prisma, vaultA, ORIGIN),
      configsB = new NativeConfigStore(secondary.prisma, vaultB, ORIGIN);
    const calls: Array<{
      kind: string;
      configId: string;
      credential?: string;
      previous?: NativeAuthorization;
      enterprisePending?: Record<string, unknown>;
      state?: string;
    }> = [];
    const auth = (config: NativeAppConfig, subject = botId, version = 1): NativeAuthorization => {
      const settings = NativeConfigSettingsSchema.parse(config.config),
        bot = ["telegram-bot", "discord"].includes(config.appId),
        oauth = config.credentialKind === "oauth";
      return {
        tokens: {
          accessToken: `synthetic-${n}-access-${version}`,
          refreshToken: config.appId === "figma" ? `synthetic-${n}-refresh-${version}` : null,
          ...(config.appId === "wecom" && oauth
            ? {
                enterpriseInstallation: {
                  kind: "wecom_suite" as const,
                  suiteId: settings.clientId!,
                  corpId: settings.tenantId!,
                  agentId: settings.agentId!,
                  permanentCode: "synthetic-permanent-code",
                },
              }
            : {}),
        },
        scopes: config.appId === "figma" ? ["current_user:read", "file_content:read"] : [],
        expiresAt: bot ? null : new Date(Date.now() + 3600000),
        identity: {
          authority: `https://synthetic.${config.appId}.example.test`,
          subject,
          tenant:
            config.appId === "discord" || ["wecom", "dingtalk"].includes(config.appId)
              ? settings.tenantId!
              : null,
          displayName: "Synthetic actual identity",
          context: {
            actorType: bot ? "bot" : config.appId === "figma" ? "user" : "app",
            credentialType: config.credentialKind,
            scopeAuthority: "provider_enforced",
            ...(bot
              ? {
                  botId: subject,
                  boundSpaceId: settings.boundSpaceId,
                  configRevision: config.revision,
                  verifiedTargets: settings.targetIds!.map((id) => ({
                    id,
                    ...(config.appId === "discord" ? { guildId: settings.tenantId } : {}),
                  })),
                  ...(config.appId === "discord"
                    ? {
                        applicationId,
                        bindingNamespace: "guild",
                        interactionPublicKey: "1".repeat(64),
                      }
                    : {}),
                }
              : {}),
          },
        },
      };
    };
    const control = {
      verify: async (config: NativeAppConfig, _credential: string): Promise<NativeAuthorization> =>
        auth(config),
      exchange: async (
        config: NativeAppConfig,
        _credential: string,
        code: string,
        _enterprisePending?: Record<string, unknown>,
      ): Promise<NativeAuthorization> =>
        auth(config, code === "other-subject" ? String(900000 + n) : botId),
      beginEnterprise: async (config: NativeAppConfig, _credential: string, state: string) => ({
        authorizationUrl: `https://install.example.test/?state=${encodeURIComponent(state)}`,
        pending: {
          protocol: "wecom_suite",
          suiteId: NativeConfigSettingsSchema.parse(config.config).clientId!,
          preAuthCode: "synthetic-pre-auth-code",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        } as Record<string, unknown>,
      }),
      refresh: async (
        config: NativeAppConfig,
        _credential: string,
        previous: NativeAuthorization,
      ): Promise<NativeAuthorization> => ({
        ...auth(config, previous.identity.subject, 2),
        identity: previous.identity,
      }),
    };
    // The only stub is the upstream authority boundary. No DB client, delegate, query or transaction is mocked.
    const upstream = {
      authorizationUrl: (_config: NativeAppConfig, state: string) =>
        `https://authorize.example.test/?state=${encodeURIComponent(state)}`,
      verifyRemainingStatic: async (config: NativeAppConfig, credential: string) => {
        calls.push({ kind: "verify", configId: config.id, credential });
        return control.verify(config, credential);
      },
      exchange: async (
        config: NativeAppConfig,
        credential: string,
        code: string,
        _verifier: string,
        _signal: AbortSignal,
        _mcp: unknown,
        state: string,
        _private: boolean,
        enterprisePending?: Record<string, unknown>,
      ) => {
        calls.push({ kind: "exchange", configId: config.id, credential, enterprisePending, state });
        return control.exchange(config, credential, code, enterprisePending);
      },
      refresh: async (
        config: NativeAppConfig,
        credential: string,
        previous: NativeAuthorization,
      ) => {
        calls.push({ kind: "refresh", configId: config.id, credential, previous });
        return control.refresh(config, credential, previous);
      },
      enterprise: {
        begin: async (config: NativeAppConfig, credential: string, state: string) => {
          calls.push({ kind: "enterprise.begin", configId: config.id, credential, state });
          return control.beginEnterprise(config, credential, state);
        },
      },
      close: async () => {},
    } as unknown as NativeOAuthAuthorities;
    const a = new NativeOAuthStore(primary.prisma, vaultA, configsA, upstream),
      b = new NativeOAuthStore(secondary.prisma, vaultB, configsB, upstream);
    async function save(
      appId: "telegram-bot" | "discord" | "feishu-lark" | "dingtalk" | "wecom" | "figma",
      ctx = context(),
      extra: Record<string, unknown> = {},
    ) {
      const bot = ["telegram-bot", "discord"].includes(appId),
        figma = appId === "figma";
      const input = NativeConfigInputSchema.parse({
        appId,
        ownership: appId === "feishu-lark" ? "byo" : "official",
        credentialKind: bot ? "bot_token" : figma ? "oauth" : "machine_key",
        actor: bot ? "bot" : figma ? "user" : "app",
        label: `Synthetic ${appId} ${randomUUID()}`,
        clientSecret: SECRET,
        ...(bot
          ? {
              targetIds: [appId === "telegram-bot" ? "-1001234567890" : "100004"],
              capabilities: ["read", "send"],
            }
          : {
              clientId: figma
                ? `synthetic-figma-client-${n}`
                : appId === "wecom"
                  ? "synthetic-corp"
                  : `synthetic-app-${n}`,
            }),
        ...(appId === "discord"
          ? { tenantId: guildId }
          : ["wecom", "dingtalk"].includes(appId)
            ? { tenantId: "synthetic-corp" }
            : {}),
        ...(appId === "wecom" ? { agentId: "1" } : {}),
        ...(appId === "feishu-lark" ? { region: "feishu" } : {}),
        ...(figma ? { scopes: ["current_user:read", "file_content:read"] } : {}),
        ...extra,
      });
      const saved = await configsA.save(input, ctx, true);
      configIds.add(saved.id);
      return { saved, input };
    }
    async function connect(configId: string, ctx = context(), credential?: string, store = a) {
      const connected = await store.connectRemainingToken(configId, credential, ctx);
      return first.prisma.connection.findUniqueOrThrow({
        where: { id: connected.connectionId },
        include: { oauthGrant: true },
      });
    }
    async function browser(configId: string, ctx = context(), code = "synthetic-code", store = a) {
      const started = await store.begin(configId, ctx),
        state = new URL(started.authorizationUrl).searchParams.get("state")!;
      await store.launch(state, ctx.userId, ctx.signal);
      await store.callback(
        { state, ...(code === "wecom-install" ? { enterpriseCode: code } : { code }) },
        ctx.signal,
        ctx.userId,
      );
      return first.prisma.connection.findUniqueOrThrow({
        where: { id: started.connectionId },
        include: { oauthGrant: true },
      });
    }
    return {
      a,
      b,
      configsA,
      configsB,
      control,
      calls,
      save,
      connect,
      browser,
      auth,
      vaultA,
      vaultB,
      botId,
      applicationId,
      guildId,
      upstream,
    };
  }

  function feishuUserFixture(offlineAccess: boolean) {
    const f = fixture();
    const tokenRequests: Array<Record<string, unknown>> = [];
    const scopes = ["contact:user.base:readonly", "offline_access"];
    const authorities = new NativeOAuthAuthorities({
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (url, init) => {
        const target = new URL(String(url));
        if (target.href === "https://accounts.feishu.cn/oauth/v3/token") {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          tokenRequests.push(request);
          const refresh = request.grant_type === "refresh_token";
          return new Response(
            JSON.stringify({
              code: 0,
              token_type: "Bearer",
              access_token: refresh ? "synthetic-next-user-access" : "synthetic-user-access",
              ...(!refresh ? { refresh_token: "synthetic-one-time-user-refresh" } : {}),
              expires_in: refresh && !offlineAccess ? 45 : 3600,
              scope: refresh && !offlineAccess ? scopes[0] : scopes.join(" "),
            }),
          );
        }
        expect(target.href).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              open_id: "synthetic-feishu-user",
              tenant_key: "synthetic-feishu-tenant",
              name: "Synthetic Feishu user",
            },
          }),
        );
      },
    });
    const store = new NativeOAuthStore(first.prisma, f.vaultA, f.configsA, authorities);
    const save = () =>
      f.save("feishu-lark", context(), { credentialKind: "oauth", actor: "user", scopes });
    return { ...f, store, authorities, tokenRequests, save };
  }

  it("Feishu user missing replacement retires only its consumed grant through the actual authority and Store", async () => {
    const f = feishuUserFixture(true);
    try {
      const { saved } = await f.save();
      const connected = await f.browser(saved.id, context(), "synthetic-code", f.store);
      const peerContext = context(spaces[1]);
      const peer = await f.browser(saved.id, peerContext, "synthetic-peer-code", f.store);
      const originalSecretId = connected.oauthGrant!.secretId!;
      await expect(f.store.authorization(connected.id, context(), true)).rejects.toMatchObject({
        kind: "result_unknown",
        options: { uncertain: true },
      });
      const retired = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: connected.oauthGrantId! },
      });
      expect(retired).toMatchObject({
        secretId: null,
        revokedAt: expect.any(Date),
        refreshLeaseId: null,
        refreshLeaseUntil: null,
      });
      expect(await first.prisma.secret.findUnique({ where: { id: originalSecretId } })).toBeNull();
      expect(
        await first.prisma.connection.findUnique({ where: { id: connected.id } }),
      ).toMatchObject({
        status: "error",
      });
      await expect(f.store.authorization(connected.id, context(), true)).rejects.toBeInstanceOf(
        NativeActionError,
      );
      expect(
        f.tokenRequests.filter((request) => request.grant_type === "refresh_token"),
      ).toHaveLength(1);
      const peerAuthorization = await f.store.authorization(peer.id, peerContext);
      expect(peerAuthorization.connection.status).toBe("connected");
      expect(peerAuthorization.grant.revokedAt).toBeNull();
      expect(peerAuthorization.grant.secretId).toBe(peer.oauthGrant!.secretId);
    } finally {
      await f.authorities.close();
    }
  });

  it("Feishu access-only refresh remains usable inside 60 seconds and expires without replaying its consumed token", async () => {
    const f = feishuUserFixture(false);
    try {
      const { saved } = await f.save();
      const connected = await f.browser(saved.id, context(), "synthetic-code", f.store);
      const refreshed = await f.store.authorization(connected.id, context(), true);
      expect(refreshed.auth.tokens).toEqual({
        accessToken: "synthetic-next-user-access",
        refreshToken: null,
      });
      expect(refreshed.auth.scopes).toEqual(["contact:user.base:readonly"]);
      expect(refreshed.auth.expiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(refreshed.auth.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 45_000);
      expect(refreshed.connection.status).toBe("connected");
      expect(refreshed.grant.revokedAt).toBeNull();
      expect(refreshed.grant.tokenVersion).toBe(connected.oauthGrant!.tokenVersion + 1);
      const again = await f.store.authorization(connected.id, context());
      expect(again.auth.tokens).toEqual(refreshed.auth.tokens);
      expect(again.auth.expiresAt).toEqual(refreshed.auth.expiresAt);
      expect(
        f.tokenRequests.filter((request) => request.grant_type === "refresh_token"),
      ).toHaveLength(1);
      await first.prisma.nativeOAuthGrant.update({
        where: { id: connected.oauthGrantId! },
        data: { accessExpiresAt: new Date(Date.now() - 1) },
      });
      await expect(f.store.authorization(connected.id, context())).rejects.toMatchObject({
        kind: "authorization_expired",
      });
      expect(
        f.tokenRequests.filter((request) => request.grant_type === "refresh_token"),
      ).toHaveLength(1);
      expect(
        await first.prisma.nativeOAuthGrant.findUnique({ where: { id: connected.oauthGrantId! } }),
      ).toMatchObject({ secretId: null, revokedAt: expect.any(Date) });
    } finally {
      await f.authorities.close();
    }
  });

  it("Feishu access-only grants still honor explicit rejected-credential refresh", async () => {
    const f = feishuUserFixture(false);
    try {
      const { saved } = await f.save();
      const connected = await f.browser(saved.id, context(), "synthetic-code", f.store);
      await f.store.authorization(connected.id, context(), true);
      await expect(f.store.authorization(connected.id, context(), true)).rejects.toMatchObject({
        kind: "authorization_expired",
      });
      expect(
        f.tokenRequests.filter((request) => request.grant_type === "refresh_token"),
      ).toHaveLength(1);
    } finally {
      await f.authorities.close();
    }
  });

  it("other providers retain their existing early-expiry policy for grants without refresh tokens", async () => {
    const f = fixture();
    const { saved } = await f.save("figma");
    f.control.exchange = async (config) => ({
      ...f.auth(config),
      tokens: { accessToken: "synthetic-access-only-control", refreshToken: null },
      expiresAt: new Date(Date.now() + 45_000),
    });
    const connected = await f.browser(saved.id);
    await expect(f.a.authorization(connected.id, context())).rejects.toMatchObject({
      kind: "authorization_expired",
    });
    expect(f.calls.filter((call) => call.kind === "refresh")).toHaveLength(0);
  });

  for (const app of ["feishu-lark", "dingtalk"] as const)
    it(`${app} machine credentials retain their existing 60-second reissue window`, async () => {
      const f = fixture();
      const { saved } = await f.save(app);
      const connected = await f.connect(saved.id);
      await first.prisma.nativeOAuthGrant.update({
        where: { id: connected.oauthGrantId! },
        data: { accessExpiresAt: new Date(Date.now() + 45_000) },
      });
      const refreshed = await f.a.authorization(connected.id, context());
      expect(refreshed.grant.tokenVersion).toBe(connected.oauthGrant!.tokenVersion + 1);
      expect(refreshed.auth.tokens.accessToken).toContain("access-2");
      expect(f.calls.filter((call) => call.kind === "refresh")).toHaveLength(1);
    });

  for (const appId of ["telegram-bot", "discord", "feishu-lark", "dingtalk", "wecom"] as const)
    it(`${appId} statuses, owner configuration and connect are bound to the configuring Space`, async () => {
      const f = fixture(),
        { saved, input } = await f.save(appId);
      expect((await f.configsA.statuses(spaces[0])).some((row) => row.id === saved.id)).toBe(true);
      expect((await f.configsA.statuses(spaces[1])).some((row) => row.id === saved.id)).toBe(false);
      expect((await f.configsA.statuses()).some((row) => row.id === saved.id)).toBe(false);
      expect(await f.configsA.configuration(saved.id, true, spaces[0])).toMatchObject({
        id: saved.id,
        hasClientSecret: true,
      });
      await expect(f.configsA.configuration(saved.id, true, spaces[1])).rejects.toThrow();
      await expect(f.configsA.configuration(saved.id, false, spaces[0])).rejects.toThrow();
      await expect(f.configsA.save(input, context(), false)).rejects.toThrow();
      await expect(
        f.configsA.save(
          { ...input, id: saved.id, expectedRevision: saved.revision },
          context(spaces[1]),
          true,
        ),
      ).rejects.toThrow();
      await expect(
        f.a.connectRemainingToken(saved.id, undefined, context(spaces[1], users[1])),
      ).rejects.toBeInstanceOf(NativeActionError);
      expect(f.calls).toHaveLength(0);
      const safe = JSON.stringify(await f.configsA.configuration(saved.id, true, spaces[0]));
      expect(safe).not.toContain(SECRET);
      expect(NativeConfigInputSchema.safeParse({ ...input, boundSpaceId: spaces[1] }).success).toBe(
        false,
      );
    });

  it("official bot secret is write-only and cannot be overridden by a member; BYO uses that member's own token", async () => {
    const f = fixture(),
      official = await f.save("telegram-bot"),
      ctx = context(spaces[0], users[1]);
    await expect(
      f.a.connectRemainingToken(official.saved.id, "synthetic-member-override", ctx),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(f.calls).toHaveLength(0);
    const connected = await f.connect(official.saved.id, ctx);
    expect(f.calls[0]!.credential).toBe(SECRET);
    const own = await f.a.authorization(connected.id, ctx);
    expect(own.auth.tokens.refreshToken).toBeNull();
    expect(own.grant.userId).toBe(ctx.userId);
    expect(own.grant.spaceId).toBe(ctx.spaceId);
    await expect(f.a.authorization(connected.id, context())).rejects.toBeInstanceOf(
      NativeActionError,
    );
    const byo = await f.save("telegram-bot", context(), {
      ownership: "byo",
      clientSecret: undefined,
    });
    expect(await f.configsA.configuration(byo.saved.id, true, spaces[0])).toMatchObject({
      hasClientSecret: false,
    });
    expect(
      (await f.configsA.statuses(spaces[0])).find((row) => row.id === byo.saved.id)!
        .usesConfiguredCredential,
    ).toBe(false);
    await expect(f.a.connectRemainingToken(byo.saved.id, undefined, ctx)).rejects.toBeInstanceOf(
      NativeActionError,
    );
    await f.connect(byo.saved.id, ctx, "synthetic-members-own-bot-token");
    expect(f.calls.at(-1)!.credential).toBe("synthetic-members-own-bot-token");
  });

  for (const appId of ["telegram-bot", "discord"] as const)
    it(`${appId} concurrent cross-Space adoption has exactly one DB-fenced winner`, async () => {
      const f = fixture(),
        ca = await f.save(appId),
        cb = await f.save(
          appId,
          context(spaces[1]),
          appId === "discord" ? { targetIds: ["100099"] } : {},
        );
      const ready = deferred();
      let arrivals = 0;
      f.control.verify = async (config) => {
        if (++arrivals === 2) ready.resolve();
        await ready.promise;
        return f.auth(config);
      };
      const results = await Promise.allSettled([
        f.a.connectRemainingToken(ca.saved.id, undefined, context(spaces[0], users[1])),
        f.b.connectRemainingToken(cb.saved.id, undefined, context(spaces[1], users[2])),
      ]);
      expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
      const grants = await first.prisma.nativeOAuthGrant.findMany({
        where: {
          subject: f.botId,
          configId: { in: [ca.saved.id, cb.saved.id] },
          revokedAt: null,
          secretId: { not: null },
        },
      });
      expect(grants).toHaveLength(1);
      const connections = await first.prisma.connection.findMany({
        where: { nativeConfigId: { in: [ca.saved.id, cb.saved.id] } },
      });
      expect(connections.filter((row) => row.status === "connected")).toHaveLength(1);
      expect(connections.filter((row) => row.status === "error")).toHaveLength(1);
      expect(await first.prisma.secret.count({ where: { id: grants[0]!.secretId! } })).toBe(1);
    });

  it("same Space keeps multiple bot accounts; distinct actual bot or guild bindings remain isolated", async () => {
    const f = fixture(),
      ca = await f.save("telegram-bot"),
      one = await f.connect(ca.saved.id, context(spaces[0], users[1])),
      two = await f.connect(ca.saved.id, context(spaces[0], users[2]), undefined, f.b);
    expect(one.id).not.toBe(two.id);
    expect(one.oauthGrantId).not.toBe(two.oauthGrantId);
    expect(one.oauthGrant!.secretId).not.toBe(two.oauthGrant!.secretId);
    const cb = await f.save("telegram-bot", context(spaces[1]));
    f.control.verify = async (config) => f.auth(config, "999001");
    const otherBot = await f.connect(cb.saved.id, context(spaces[1], users[1]));
    expect(otherBot.status).toBe("connected");
    await expect(f.b.authorization(one.id, context(spaces[0], users[2]))).rejects.toBeInstanceOf(
      NativeActionError,
    );
    const da = await f.save("discord"),
      db = await f.save("discord", context(spaces[1]), { tenantId: "999002" });
    const left = await f.connect(da.saved.id),
      right = await f.connect(db.saved.id, context(spaces[1]));
    expect(left.oauthGrant!.tenant).not.toBe(right.oauthGrant!.tenant);
    expect(left.status).toBe("connected");
    expect(right.status).toBe("connected");
  });

  it("Figma new OAuth for same actual app/subject retires old local grant+secret without copying across Spaces", async () => {
    const f = fixture(),
      ca = await f.save("figma"),
      cb = await f.save("figma", context(spaces[1]), { clientId: ca.input.clientId });
    const distinct = await f.browser(ca.saved.id, context(spaces[0], users[2]), "other-subject");
    const old = await f.browser(ca.saved.id, context(spaces[0], users[1])),
      oldSecret = old.oauthGrant!.secretId!;
    const next = await f.browser(cb.saved.id, context(spaces[1], users[1]));
    const retired = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: old.oauthGrantId! },
    });
    expect(retired.revokedAt).not.toBeNull();
    expect(retired.secretId).toBeNull();
    expect(retired.authGeneration).toBe(old.oauthGrant!.authGeneration + 1);
    expect(await first.prisma.secret.findUnique({ where: { id: oldSecret } })).toBeNull();
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: old.id } })).status,
    ).toBe("error");
    expect(next.oauthGrant!.spaceId).toBe(spaces[1]);
    expect(next.oauthGrant!.secretId).not.toBe(oldSecret);
    expect(
      await first.prisma.nativeOAuthGrant.count({
        where: { subject: f.botId, configId: { in: [ca.saved.id, cb.saved.id] }, revokedAt: null },
      }),
    ).toBe(1);
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: distinct.id } })).status,
    ).toBe("connected");
    await expect(f.a.authorization(next.id, context(spaces[0], users[1]))).rejects.toBeInstanceOf(
      NativeActionError,
    );
    await expect(f.a.authorization(old.id, context(spaces[0], users[1]))).rejects.toBeInstanceOf(
      NativeActionError,
    );
  });

  it("Figma concurrent issuance never publishes an earlier token after its successor", async () => {
    const f = fixture(),
      ca = await f.save("figma"),
      cb = await f.save("figma", context(spaces[1]), { clientId: ca.input.clientId });
    const started = deferred(),
      releaseEarlier = deferred();
    let providerLiveToken = "";
    f.control.exchange = async (config, _credential, code) => {
      const result = f.auth(config);
      result.tokens.accessToken =
        code === "earlier-delayed"
          ? "synthetic-figma-earlier-token"
          : "synthetic-figma-successor-token";
      providerLiveToken = result.tokens.accessToken;
      // Identity was verified at issuance; a suspended worker resumes only after the other callback can adopt.
      if (code === "earlier-delayed") {
        started.resolve();
        await releaseEarlier.promise;
      }
      return result;
    };
    const earlier = f.browser(ca.saved.id, context(spaces[0], users[1]), "earlier-delayed").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await started.promise;
    const successor = f.browser(cb.saved.id, context(spaces[1], users[1]), "successor").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    // A correct issuance fence may keep the successor waiting until the first worker resumes.
    await Promise.race([successor, delay(1000)]);
    releaseEarlier.resolve();
    await Promise.all([earlier, successor]);
    const live = await first.prisma.connection.findMany({
      where: {
        nativeConfigId: { in: [ca.saved.id, cb.saved.id] },
        status: "connected",
        oauthGrant: { revokedAt: null, secretId: { not: null } },
      },
      include: { oauthGrant: { include: { secret: true } } },
    });
    expect(live.length).toBeLessThanOrEqual(1);
    for (const connection of live) {
      const secret = connection.oauthGrant!.secret!;
      const tokens = JSON.parse(await f.vaultA.load(secret.ciphertext, { recordId: secret.id }));
      expect(tokens.accessToken).toBe(providerLiveToken);
    }
  });

  for (const firstOperation of ["refresh", "exchange"] as const)
    it(`Figma ${firstOperation} issuance serializes against an older grant's competing token operation`, async () => {
      const f = fixture(),
        ca = await f.save("figma"),
        cb = await f.save("figma", context(spaces[1]), { clientId: ca.input.clientId });
      const oldContext = context(spaces[0], users[1]),
        nextContext = context(spaces[1], users[1]);
      const old = await f.browser(ca.saved.id, oldContext);
      await first.prisma.nativeOAuthGrant.update({
        where: { id: old.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      const started = deferred(),
        release = deferred();
      let providerLiveToken = "synthetic-initial-token";
      f.control.refresh = async (config, _credential, previous) => {
        if (firstOperation === "refresh") {
          started.resolve();
          await release.promise;
        }
        const result = {
          ...f.auth(config, previous.identity.subject, 2),
          identity: previous.identity,
        };
        result.tokens.accessToken = "synthetic-figma-race-refresh-token";
        providerLiveToken = result.tokens.accessToken;
        return result;
      };
      f.control.exchange = async (config) => {
        const result = f.auth(config);
        result.tokens.accessToken = "synthetic-figma-race-exchange-token";
        providerLiveToken = result.tokens.accessToken;
        if (firstOperation === "exchange") {
          started.resolve();
          await release.promise;
        }
        return result;
      };
      const refresh = () =>
        f.a.authorization(old.id, oldContext, true).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const exchange = () =>
        f.browser(cb.saved.id, nextContext, "new-race-authorization", f.b).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const held = firstOperation === "refresh" ? refresh() : exchange();
      await started.promise;
      const competing = firstOperation === "refresh" ? exchange() : refresh();
      await Promise.race([competing, delay(1000)]);
      release.resolve();
      await Promise.all([held, competing]);
      const live = await first.prisma.connection.findMany({
        where: {
          nativeConfigId: { in: [ca.saved.id, cb.saved.id] },
          status: "connected",
          oauthGrant: { revokedAt: null, secretId: { not: null } },
        },
        include: { oauthGrant: { include: { secret: true } } },
      });
      expect(live).toHaveLength(1);
      for (const connection of live) {
        const secret = connection.oauthGrant!.secret!;
        const tokens = JSON.parse(await f.vaultA.load(secret.ciphertext, { recordId: secret.id }));
        expect(tokens.accessToken).toBe(providerLiveToken);
      }
      if (firstOperation === "exchange")
        expect(f.calls.filter((call) => call.kind === "refresh")).toHaveLength(0);
    });

  it("three Figma callbacks with a three-connection pool serialize issuance without starving inner CAS commits", async () => {
    const f = fixture(),
      config = await f.save("figma");
    let active = 0,
      maxActive = 0,
      issued = 0;
    f.control.exchange = async (cfg) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(100);
      active--;
      const result = f.auth(cfg);
      result.tokens.accessToken = `synthetic-pool-token-${++issued}`;
      return result;
    };
    const results = await Promise.all([
      f.browser(config.saved.id, context(spaces[0], users[1])),
      f.browser(config.saved.id, context(spaces[1], users[1])),
      f.browser(config.saved.id, context(spaces[0], users[2])),
    ]);
    expect(results).toHaveLength(3);
    expect(issued).toBe(3);
    expect(maxActive).toBe(1);
    const live = await first.prisma.nativeOAuthGrant.findMany({
      where: { configId: config.saved.id, revokedAt: null, secretId: { not: null } },
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.refreshLeaseId).toBeNull();
  });

  it("Figma different OAuth clients do not block one another or retire each other's grant", async () => {
    const f = fixture(),
      ca = await f.save("figma"),
      cb = await f.save("figma", context(spaces[1]), { clientId: "synthetic-independent-client" });
    const started = deferred(),
      release = deferred();
    f.control.exchange = async (config) => {
      if (config.id === ca.saved.id) {
        started.resolve();
        await release.promise;
      }
      return f.auth(config);
    };
    const a = f.browser(ca.saved.id, context(spaces[0], users[1]));
    await started.promise;
    const b = f.browser(cb.saved.id, context(spaces[1], users[1]));
    const independent = await Promise.race([b.then(() => true), delay(1000).then(() => false)]);
    release.resolve();
    await Promise.all([a, b]);
    expect(independent).toBe(true);
    expect(
      await first.prisma.nativeOAuthGrant.count({
        where: {
          configId: { in: [ca.saved.id, cb.saved.id] },
          revokedAt: null,
          secretId: { not: null },
        },
      }),
    ).toBe(2);
  });

  for (const appId of ["feishu-lark", "dingtalk", "wecom"] as const)
    it(`${appId} machine credentials reissue without refreshToken and concurrent refreshes share the CAS winner`, async () => {
      const f = fixture(),
        saved = await f.save(appId),
        ctx = context(spaces[0], users[1]);
      await expect(
        f.a.connectRemainingToken(saved.saved.id, "synthetic-member-override", ctx),
      ).rejects.toMatchObject({ kind: "invalid_input" });
      const connected = await f.connect(saved.saved.id, ctx),
        grant = connected.oauthGrant!;
      expect(grant.secretId).not.toBeNull();
      const initial = await f.a.authorization(connected.id, ctx);
      expect(initial.auth.tokens.refreshToken).toBeNull();
      await first.prisma.nativeOAuthGrant.update({
        where: { id: grant.id },
        data: { accessExpiresAt: new Date(0) },
      });
      const started = deferred(),
        release = deferred();
      f.control.refresh = async (config, credential, previous) => {
        expect(enterpriseConfigSecret(credential).clientSecret).toBe(SECRET);
        expect(previous.tokens.refreshToken).toBeNull();
        started.resolve();
        await release.promise;
        return { ...f.auth(config, previous.identity.subject, 2), identity: previous.identity };
      };
      const pendingA = f.a.authorization(connected.id, ctx, true);
      await started.promise;
      const pendingB = f.b.authorization(connected.id, ctx, true);
      await delay(150);
      expect(f.calls.filter((c) => c.kind === "refresh")).toHaveLength(1);
      release.resolve();
      const [a, b] = await Promise.all([pendingA, pendingB]);
      expect(a.grant.tokenVersion).toBe(grant.tokenVersion + 1);
      expect(b.grant.tokenVersion).toBe(a.grant.tokenVersion);
      expect(a.auth.tokens.accessToken).toBe(b.auth.tokens.accessToken);
      expect(a.auth.tokens.refreshToken).toBeNull();
      const current = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(current.revokedAt).toBeNull();
      expect(current.refreshLeaseId).toBeNull();
      expect(await first.prisma.secret.findUnique({ where: { id: grant.secretId! } })).toBeNull();
    });

  it("expired enterprise lease can reissue safely; late old lease cannot retire the committed winner", async () => {
    const f = fixture(),
      saved = await f.save("wecom"),
      ctx = context(spaces[0], users[1]),
      connected = await f.connect(saved.saved.id, ctx),
      grant = connected.oauthGrant!;
    await first.prisma.nativeOAuthGrant.update({
      where: { id: grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    const started = deferred(),
      release = deferred();
    let count = 0;
    f.control.refresh = async (config, _credential, previous) => {
      if (++count === 1) {
        started.resolve();
        await release.promise;
        return { ...f.auth(config, previous.identity.subject, 99), identity: previous.identity };
      }
      return { ...f.auth(config, previous.identity.subject, 2), identity: previous.identity };
    };
    const stale = f.a.authorization(connected.id, ctx, true),
      staleFailure = expect(stale).rejects.toBeInstanceOf(NativeActionError);
    await started.promise;
    await second.prisma.nativeOAuthGrant.update({
      where: { id: grant.id },
      data: { refreshLeaseUntil: new Date(Date.now() - 1000) },
    });
    const winner = await f.b.authorization(connected.id, ctx, true);
    release.resolve();
    await staleFailure;
    const current = await f.a.authorization(connected.id, ctx);
    expect(current.grant.tokenVersion).toBe(grant.tokenVersion + 1);
    expect(current.grant.revokedAt).toBeNull();
    expect(current.auth.tokens.accessToken).toBe(winner.auth.tokens.accessToken);
    expect(current.auth.tokens.accessToken).not.toContain("99");
  });

  it("owner configRevision change during enterprise issuance blocks stale token commit", async () => {
    const f = fixture(),
      saved = await f.save("dingtalk"),
      ctx = context(spaces[0], users[1]),
      connected = await f.connect(saved.saved.id, ctx),
      grant = connected.oauthGrant!;
    await first.prisma.nativeOAuthGrant.update({
      where: { id: grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    const started = deferred(),
      release = deferred();
    f.control.refresh = async (config, _credential, previous) => {
      started.resolve();
      await release.promise;
      return { ...f.auth(config, previous.identity.subject, 2), identity: previous.identity };
    };
    const pending = f.a.authorization(connected.id, ctx, true),
      failure = expect(pending).rejects.toBeInstanceOf(NativeActionError);
    await started.promise;
    const updated = await f.configsB.save(
      {
        ...saved.input,
        id: saved.saved.id,
        expectedRevision: saved.saved.revision,
        clientSecret: "synthetic-owner-replaced-credential",
      },
      context(),
      true,
    );
    expect(updated.revision).toBe(saved.saved.revision + 1);
    release.resolve();
    await failure;
    const after = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    expect(after.tokenVersion).toBe(grant.tokenVersion);
    expect(after.configRevision).toBe(saved.saved.revision);
    await expect(f.a.authorization(connected.id, ctx)).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((c) => c.kind === "refresh")).toHaveLength(1);
  });

  it("WeCom installation retains encrypted permanent code and renews without refreshToken", async () => {
    const f = fixture(),
      saved = await f.save("wecom", context(), {
        credentialKind: "oauth",
        clientId: "synthetic-suite",
        tenantId: "synthetic-corp",
        verificationToken: "synthetic-verification-token",
        encryptionKey: "A".repeat(43),
      });
    await f.configsA.recordEnterpriseTicket(
      saved.saved.id,
      "synthetic-suite",
      saved.saved.revision,
      { platform: "wecom", value: "synthetic-suite-ticket", issuedAt: 1 },
      context().signal,
    );
    const ctx = context(spaces[0], users[1]),
      connected = await f.browser(saved.saved.id, ctx, "wecom-install"),
      grant = connected.oauthGrant!;
    const initial = await f.a.authorization(connected.id, ctx);
    expect(initial.auth.tokens.refreshToken).toBeNull();
    expect(initial.auth.tokens.enterpriseInstallation).toMatchObject({
      kind: "wecom_suite",
      permanentCode: "synthetic-permanent-code",
    });
    expect(JSON.stringify(initial.grant)).not.toContain("synthetic-permanent-code");
    expect(
      (await first.prisma.secret.findUniqueOrThrow({ where: { id: grant.secretId! } })).ciphertext,
    ).not.toContain("synthetic-permanent-code");
    await first.prisma.nativeOAuthGrant.update({
      where: { id: grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    f.control.refresh = async (config, _credential, previous) => {
      expect(previous.tokens.refreshToken).toBeNull();
      expect(previous.tokens.enterpriseInstallation).toMatchObject({
        kind: "wecom_suite",
        permanentCode: "synthetic-permanent-code",
      });
      return { ...f.auth(config, previous.identity.subject, 2), identity: previous.identity };
    };
    const renewed = await f.b.authorization(connected.id, ctx);
    expect(renewed.grant.tokenVersion).toBe(grant.tokenVersion + 1);
    expect(renewed.auth.tokens.refreshToken).toBeNull();
    expect(renewed.auth.tokens.enterpriseInstallation).toMatchObject({
      kind: "wecom_suite",
      permanentCode: "synthetic-permanent-code",
    });
  });
  async function readyWecom(f: ReturnType<typeof fixture>) {
    const saved = await f.save("wecom", context(), {
      credentialKind: "oauth",
      clientId: "synthetic-suite",
      tenantId: "synthetic-corp",
      verificationToken: "synthetic-verification-token",
      encryptionKey: "A".repeat(43),
    });
    await f.configsA.recordEnterpriseTicket(
      saved.saved.id,
      "synthetic-suite",
      saved.saved.revision,
      { platform: "wecom", value: "synthetic-suite-ticket", issuedAt: 1 },
      context().signal,
    );
    return saved;
  }

  it("WeCom launch persists exact encrypted pre-auth pending; duplicate launch reuses it and callback passes ninth exchange argument", async () => {
    const f = fixture(),
      saved = await readyWecom(f),
      ctx = context(spaces[0], users[1]);
    const pending = {
      protocol: "wecom_suite",
      suiteId: "synthetic-suite",
      preAuthCode: "synthetic-distinct-pre-auth",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    f.control.beginEnterprise = async (config, credential, state) => {
      expect(config.id).toBe(saved.saved.id);
      expect(config.revision).toBe(saved.saved.revision);
      expect(enterpriseConfigSecret(credential).suiteTicket!.value).toBe("synthetic-suite-ticket");
      return {
        authorizationUrl: `https://install.example.test/?state=${state}&pre_auth_code=${pending.preAuthCode}`,
        pending,
      };
    };
    const start = await f.a.begin(saved.saved.id, ctx),
      state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const original = await first.prisma.nativeOAuthSession.findFirstOrThrow({
      where: { connectionId: start.connectionId },
      include: { secret: true },
    });
    await expect(f.a.launch(state, users[2]!, ctx.signal)).rejects.toBeInstanceOf(
      NativeActionError,
    );
    expect(f.calls.filter((call) => call.kind === "enterprise.begin")).toHaveLength(0);
    const firstUrl = await f.a.launch(state, ctx.userId, ctx.signal),
      duplicateUrl = await f.b.launch(state, ctx.userId, ctx.signal);
    expect(firstUrl).toBe(duplicateUrl);
    expect(f.calls.filter((call) => call.kind === "enterprise.begin")).toHaveLength(1);
    const staged = await first.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { stateHash: createHash("sha256").update(state).digest("hex") },
      include: { secret: true },
    });
    expect(staged).toMatchObject({
      userId: ctx.userId,
      spaceId: ctx.spaceId,
      configId: saved.saved.id,
      configRevision: saved.saved.revision,
      consumedAt: null,
    });
    expect(staged.secret!.kind).toBe("native_session");
    expect(staged.secret!.ciphertext).not.toContain(pending.preAuthCode);
    const decoded = JSON.parse(
      await f.vaultA.load(staged.secret!.ciphertext, { recordId: staged.secret!.id }),
    );
    expect(decoded.enterprise.pending).toEqual(pending);
    expect(staged.secretId).not.toBe(original.secretId);
    expect(await first.prisma.secret.findUnique({ where: { id: original.secretId! } })).toBeNull();
    f.control.exchange = async (config, _credential, code, suppliedPending) => {
      expect(config.id).toBe(saved.saved.id);
      expect(config.revision).toBe(saved.saved.revision);
      expect(code).toBe("synthetic-install-auth-code");
      expect(suppliedPending).toEqual(pending);
      return f.auth(config);
    };
    await expect(
      f.a.callback({ state, enterpriseCode: "synthetic-install-auth-code" }, ctx.signal, users[2]!),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((call) => call.kind === "exchange")).toHaveLength(0);
    const adopted = await f.b.callback(
      { state, enterpriseCode: "synthetic-install-auth-code" },
      ctx.signal,
      ctx.userId,
    );
    expect(adopted.connectionId).toBe(start.connectionId);
    const call = f.calls.find((call) => call.kind === "exchange")!;
    expect(call.state).toBe(state);
    expect(call.enterprisePending).toEqual(pending);
    const connection = await first.prisma.connection.findUniqueOrThrow({
      where: { id: adopted.connectionId },
      include: { oauthGrant: true },
    });
    expect(connection.status).toBe("connected");
    expect(connection.oauthGrant).toMatchObject({
      userId: ctx.userId,
      spaceId: ctx.spaceId,
      configRevision: saved.saved.revision,
    });
    expect(await first.prisma.secret.findUnique({ where: { id: staged.secretId! } })).toBeNull();
    await expect(
      f.a.callback(
        { state, enterpriseCode: "synthetic-install-auth-code" },
        ctx.signal,
        ctx.userId,
      ),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((call) => call.kind === "exchange")).toHaveLength(1);
  });

  it("WeCom auth_code cannot be mixed with ordinary code or used for a non-WeCom OAuth source", async () => {
    const f = fixture(),
      wc = await readyWecom(f),
      ctx = context(spaces[0], users[1]);
    const start = await f.a.begin(wc.saved.id, ctx),
      state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await f.a.launch(state, ctx.userId, ctx.signal);
    await expect(
      f.a.callback(
        { state, code: "synthetic-ordinary-code", enterpriseCode: "synthetic-auth-code" },
        ctx.signal,
        ctx.userId,
      ),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((call) => call.kind === "exchange")).toHaveLength(0);
    const figma = await f.save("figma"),
      other = await f.a.begin(figma.saved.id, ctx),
      otherState = new URL(other.authorizationUrl).searchParams.get("state")!;
    await expect(
      f.a.callback(
        { state: otherState, enterpriseCode: "synthetic-auth-code" },
        ctx.signal,
        ctx.userId,
      ),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((call) => call.kind === "exchange")).toHaveLength(0);
    expect(
      await first.prisma.nativeOAuthGrant.count({
        where: { configId: { in: [wc.saved.id, figma.saved.id] } },
      }),
    ).toBe(0);
  });

  it("WeCom pre-auth pending cannot cross an owner configRevision change", async () => {
    const f = fixture(),
      saved = await readyWecom(f),
      ctx = context(spaces[0], users[1]);
    const start = await f.a.begin(saved.saved.id, ctx),
      state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await f.a.launch(state, ctx.userId, ctx.signal);
    await f.configsB.save(
      {
        ...saved.input,
        id: saved.saved.id,
        expectedRevision: saved.saved.revision,
        clientSecret: "synthetic-new-suite-secret",
      },
      context(),
      true,
    );
    await expect(
      f.a.callback({ state, enterpriseCode: "synthetic-auth-code" }, ctx.signal, ctx.userId),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.calls.filter((call) => call.kind === "exchange")).toHaveLength(0);
    expect(await first.prisma.nativeOAuthGrant.count({ where: { configId: saved.saved.id } })).toBe(
      0,
    );
  });
  it("Figma pool-one OAuth callback completes without acquiring a second database connection", async () => {
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-pool-one-callback",
    });
    try {
      const f = fixture(single),
        saved = await f.save("figma");
      const connected = await f.browser(saved.saved.id, context(spaces[0], users[1]));
      expect(connected.status).toBe("connected");
      expect(connected.oauthGrant!.secretId).not.toBeNull();
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma pool-one refresh commits its exact CAS without acquiring a second database connection", async () => {
    const f = fixture(),
      saved = await f.save("figma"),
      ctx = context(spaces[0], users[1]);
    const connected = await f.browser(saved.saved.id, ctx);
    await first.prisma.nativeOAuthGrant.update({
      where: { id: connected.oauthGrantId! },
      data: { accessExpiresAt: new Date(0) },
    });
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-pool-one-refresh",
    });
    try {
      const store = new NativeOAuthStore(
        single.prisma,
        f.vaultA,
        new NativeConfigStore(single.prisma, f.vaultA, ORIGIN),
        f.upstream,
      );
      const refreshed = await store.authorization(connected.id, ctx, true);
      expect(refreshed.grant.tokenVersion).toBe(connected.oauthGrant!.tokenVersion + 1);
      expect(refreshed.grant.revokedAt).toBeNull();
      expect(refreshed.grant.refreshLeaseId).toBeNull();
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma pool-four different clients complete four simultaneous issuers without starving inner commits", async () => {
    const four = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "remaining-figma-pool-four-independent",
    });
    try {
      const f = fixture(four, four),
        configs = [];
      for (let index = 0; index < 4; index++)
        configs.push(
          await f.save("figma", context(), {
            clientId: `synthetic-pool-four-client-${randomUUID()}`,
          }),
        );
      const allIssued = deferred();
      let entered = 0,
        active = 0,
        maxActive = 0;
      f.control.exchange = async (config) => {
        entered++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (entered === 4) allIssued.resolve();
        await allIssued.promise;
        active--;
        return f.auth(config);
      };
      const results = await Promise.all(
        configs.map((config, index) =>
          f.browser(config.saved.id, context(spaces[index % 2], users[index < 2 ? 1 : 2])),
        ),
      );
      expect(entered).toBe(4);
      expect(maxActive).toBe(4);
      expect(results.every((row) => row.status === "connected")).toBe(true);
      expect(
        await first.prisma.nativeOAuthGrant.count({
          where: {
            configId: { in: configs.map((row) => row.saved.id) },
            revokedAt: null,
            secretId: { not: null },
          },
        }),
      ).toBe(4);
    } finally {
      await four.prisma.$disconnect();
      await four.pool.end();
    }
  });
  it("Figma scoped adopt savepoint rolls back its secret and grant when the pending connection update loses", async () => {
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-savepoint-adopt-failure",
    });
    try {
      const f = fixture(single),
        saved = await f.save("figma"),
        ctx = context(spaces[0], users[1]);
      const before = await first.prisma.secret.findMany({
        where: { userId: ctx.userId, spaceId: ctx.spaceId, kind: "native_grant" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      let stoppedConnection = "";
      f.control.exchange = async (config) => {
        const pending = await first.prisma.connection.findFirstOrThrow({
          where: {
            nativeConfigId: config.id,
            userId: ctx.userId,
            spaceId: ctx.spaceId,
            status: "pending",
          },
        });
        stoppedConnection = pending.id;
        await first.prisma.connection.update({
          where: { id: pending.id },
          data: { status: "revoked" },
        });
        return f.auth(config);
      };
      await expect(f.browser(saved.saved.id, ctx)).rejects.toBeInstanceOf(NativeActionError);
      expect(stoppedConnection).not.toBe("");
      expect(
        await first.prisma.nativeOAuthGrant.count({ where: { configId: saved.saved.id } }),
      ).toBe(0);
      expect(
        await first.prisma.secret.findMany({
          where: { userId: ctx.userId, spaceId: ctx.spaceId, kind: "native_grant" },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      const connection = await first.prisma.connection.findUniqueOrThrow({
        where: { id: stoppedConnection },
      });
      expect(connection.status).toBe("revoked");
      expect(connection.oauthGrantId).toBeNull();
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma scoped refresh expiry commits intentional grant retirement while returning its error", async () => {
    const f = fixture(),
      saved = await f.save("figma"),
      ctx = context(spaces[0], users[1]),
      old = await f.browser(saved.saved.id, ctx);
    await first.prisma.nativeOAuthGrant.update({
      where: { id: old.oauthGrantId! },
      data: { accessExpiresAt: new Date(0) },
    });
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-savepoint-refresh-expired",
    });
    try {
      f.control.refresh = async () => {
        throw new NativeActionError(
          "authorization_expired",
          "Synthetic provider rejected the old refresh token",
        );
      };
      const store = new NativeOAuthStore(
        single.prisma,
        f.vaultA,
        new NativeConfigStore(single.prisma, f.vaultA, ORIGIN),
        f.upstream,
      );
      await expect(store.authorization(old.id, ctx, true)).rejects.toMatchObject({
        kind: "authorization_expired",
      });
      const retired = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: old.oauthGrantId! },
      });
      expect(retired.revokedAt).not.toBeNull();
      expect(retired.secretId).toBeNull();
      expect(retired.refreshLeaseId).toBeNull();
      expect(retired.tokenVersion).toBe(old.oauthGrant!.tokenVersion);
      expect(
        await first.prisma.secret.findUnique({ where: { id: old.oauthGrant!.secretId! } }),
      ).toBeNull();
      expect(
        (await first.prisma.connection.findUniqueOrThrow({ where: { id: old.id } })).status,
      ).toBe("error");
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma production secret persistence publishes after pool-one transactions and cleans only unreferenced remote refs", async () => {
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-production-composed",
    });
    const fake = infisicalFake(),
      published: string[] = [],
      received: string[] = [],
      ready = deferred();
    const realtime = new PostgresRealtimeFanout({
      connectionString: process.env.DATABASE_URL!,
      publisher: {
        query: async (sql, values) => {
          // This is the very same pool, with no extra publisher connection allowance.
          const result = await single.pool.query(sql, values);
          published.push(JSON.parse(JSON.parse(String(values[1])).payload).ref);
          return result;
        },
      },
    });
    const unsubscribe = await realtime.subscribe("secret-store-change", (payload) => {
      if (!payload) ready.resolve();
      else received.push(JSON.parse(payload).ref);
    });
    const secrets = new ComposedSecretStore(
      new EncryptedSecretStore(KEY),
      new InfisicalSecretStore(fake.options),
      realtime,
    );
    try {
      await secrets.start();
      await ready.promise;
      const database = withSecretPersistence(single.prisma, secrets),
        configs = new NativeConfigStore(database, secrets, ORIGIN),
        f = fixture(single),
        oauth = new NativeOAuthStore(database, secrets, configs, f.upstream),
        ctx = context(spaces[0], users[1]);
      const saved = await configs.save(
        NativeConfigInputSchema.parse({
          appId: "figma",
          ownership: "official",
          credentialKind: "oauth",
          actor: "user",
          label: "Synthetic production composition",
          clientId: `synthetic-production-client-${randomUUID()}`,
          clientSecret: SECRET,
          scopes: ["current_user:read", "file_content:read"],
        }),
        context(),
        true,
      );
      configIds.add(saved.id);
      const connected = await f.browser(saved.id, ctx, "synthetic-code", oauth);
      expect(connected.status).toBe("connected");
      const initialSecret = await first.prisma.secret.findUniqueOrThrow({
        where: { id: connected.oauthGrant!.secretId! },
      });
      expect(initialSecret.ciphertext).toMatch(/^infisical:v1:/);
      expect(fake.values.size).toBe(2); // Owner credential and actual grant; consumed session is gone.
      const beforeRefresh = new Set(fake.values.keys());
      await first.prisma.nativeOAuthGrant.update({
        where: { id: connected.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      const refreshed = await oauth.authorization(connected.id, ctx, true);
      expect(refreshed.grant.tokenVersion).toBe(2);
      expect(refreshed.grant.secretId).not.toBe(initialSecret.id);
      expect(await first.prisma.secret.findUnique({ where: { id: initialSecret.id } })).toBeNull();
      expect(fake.values.size).toBe(2);
      expect([...beforeRefresh].filter((key) => !fake.values.has(key))).toHaveLength(1);
      expect([...fake.values.keys()].filter((key) => !beforeRefresh.has(key))).toHaveLength(1);

      const stableRemote = new Map(fake.values),
        stableSecretId = refreshed.grant.secretId!;
      let stoppedConnection = "";
      f.control.exchange = async (config) => {
        const pending = await first.prisma.connection.findFirstOrThrow({
          where: { nativeConfigId: config.id, userId: ctx.userId, status: "pending" },
        });
        stoppedConnection = pending.id;
        await first.prisma.connection.update({
          where: { id: pending.id },
          data: { status: "revoked" },
        });
        return f.auth(config);
      };
      await expect(f.browser(saved.id, ctx, "synthetic-code", oauth)).rejects.toBeInstanceOf(
        NativeActionError,
      );
      expect(stoppedConnection).not.toBe("");
      expect(new Map(fake.values)).toEqual(stableRemote);
      expect(
        await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
          where: { id: connected.oauthGrantId! },
        }),
      ).toMatchObject({ secretId: stableSecretId, revokedAt: null, tokenVersion: 2 });
      expect(await first.prisma.nativeOAuthGrant.count({ where: { configId: saved.id } })).toBe(1);

      await first.prisma.nativeOAuthGrant.update({
        where: { id: connected.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      f.control.refresh = async () => {
        throw new NativeActionError("authorization_expired", "Synthetic refresh rejection");
      };
      await expect(oauth.authorization(connected.id, ctx, true)).rejects.toMatchObject({
        kind: "authorization_expired",
      });
      expect(
        await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
          where: { id: connected.oauthGrantId! },
        }),
      ).toMatchObject({ secretId: null, revokedAt: expect.any(Date), refreshLeaseId: null });
      expect(await first.prisma.secret.findUnique({ where: { id: stableSecretId } })).toBeNull();
      expect(fake.values.size).toBe(1); // Failed grant and retired grant refs have really been deleted.
      expect([...fake.values.values()]).toEqual([SECRET]);
      await vi.waitFor(() => expect(received).toEqual(published));
      expect(published).toContain(initialSecret.ciphertext);
      expect(published.length).toBeGreaterThanOrEqual(8);
      const created = new Set(
        fake.fetcher.mock.calls
          .filter(([url, init]) => init?.method === "POST" && String(url).includes("/secrets/raw/"))
          .map(([url]) => new URL(String(url)).pathname.split("/").at(-1)!),
      );
      const deleted = new Set(
        fake.fetcher.mock.calls
          .filter(([, init]) => init?.method === "DELETE")
          .map(([url]) => new URL(String(url)).pathname.split("/").at(-1)!),
      );
      expect(deleted).toEqual(new Set([...created].filter((key) => !fake.values.has(key))));
      expect(deleted.size).toBe(5); // Two consumed sessions and the old, failed and expired grant refs.
    } finally {
      await secrets.close();
      await unsubscribe();
      await realtime.close();
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma an actual outer transaction disconnect retains its committed refresh lease and never replays the rotated token", async () => {
    const applicationName = `remaining-figma-abort-${randomUUID().slice(0, 8)}`,
      single = createDb(process.env.DATABASE_URL!, { poolMax: 1, applicationName });
    try {
      const f = fixture(single),
        saved = await f.save("figma"),
        ctx = context(spaces[0], users[1]),
        old = await f.browser(saved.saved.id, ctx);
      await first.prisma.nativeOAuthGrant.update({
        where: { id: old.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      let dispatched = 0;
      f.control.refresh = async (config, _credential, previous) => {
        dispatched++;
        const rotated = f.auth(config, previous.identity.subject, 2);
        // A separate real connection forcibly drops the holder AFTER the upstream token rotated.
        const killed = await first.prisma.$queryRaw<Array<{ terminated: boolean }>>`
          SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
          WHERE application_name = ${applicationName} AND state = 'idle in transaction'`;
        expect(killed).toEqual([{ terminated: true }]);
        return rotated;
      };
      await expect(f.a.authorization(old.id, ctx, true)).rejects.toThrow();
      const stranded = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: old.oauthGrantId! },
      });
      expect(dispatched).toBe(1);
      expect(stranded.tokenVersion).toBe(old.oauthGrant!.tokenVersion);
      expect(stranded.secretId).toBe(old.oauthGrant!.secretId);
      expect(stranded.refreshLeaseId).not.toBeNull();
      expect(stranded.revokedAt).toBeNull();
      await expect(f.a.authorization(old.id, ctx, true)).rejects.toMatchObject({
        kind: "temporarily_unavailable",
      });
      expect(dispatched).toBe(1);
      await first.prisma.nativeOAuthGrant.update({
        where: { id: old.oauthGrantId! },
        data: { refreshLeaseUntil: new Date(0) },
      });
      await expect(f.a.authorization(old.id, ctx, true)).rejects.toMatchObject({
        kind: "authorization_required",
      });
      expect(dispatched).toBe(1);
      expect(
        await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
          where: { id: old.oauthGrantId! },
        }),
      ).toMatchObject({ secretId: null, revokedAt: expect.any(Date), refreshLeaseId: null });
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma public disconnect completes during a paused refresh and the late refresh cannot resurrect its grant", async () => {
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-disconnect-paused-refresh",
    });
    const issued = deferred(),
      resume = deferred();
    try {
      const f = fixture(single),
        saved = await f.save("figma"),
        ctx = context(spaces[0], users[1]),
        old = await f.browser(saved.saved.id, ctx);
      const beforeSecrets = await first.prisma.secret.findMany({
        where: { userId: ctx.userId, spaceId: ctx.spaceId, kind: "native_grant" },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      await first.prisma.nativeOAuthGrant.update({
        where: { id: old.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      f.control.refresh = async (config, _credential, previous) => {
        issued.resolve();
        await resume.promise;
        return f.auth(config, previous.identity.subject, 2);
      };
      const refreshing = f.a.authorization(old.id, ctx, true);
      // Register the rejection immediately: PostgreSQL may pick either transaction as victim.
      const refreshResult = refreshing.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await issued.promise;
      const disconnectResult = f.b.disconnect(old.id, ctx).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      const beforeProviderResumes = await Promise.race([
        disconnectResult,
        delay(2_000).then(() => ({ status: "blocked" as const })),
      ]);
      resume.resolve();
      const [disconnected, refreshed] = await Promise.all([disconnectResult, refreshResult]);
      expect(beforeProviderResumes).toEqual({ status: "fulfilled" });
      expect(disconnected).toEqual({ status: "fulfilled" });
      expect(refreshed.status).toBe("rejected");
      expect(
        await first.prisma.connection.findUniqueOrThrow({ where: { id: old.id } }),
      ).toMatchObject({ status: "revoked" });
      expect(
        await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
          where: { id: old.oauthGrantId! },
        }),
      ).toMatchObject({ revokedAt: expect.any(Date), secretId: null, refreshLeaseId: null });
      expect(
        await first.prisma.secret.findMany({
          where: { userId: ctx.userId, spaceId: ctx.spaceId, kind: "native_grant" },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(beforeSecrets.filter((row) => row.id !== old.oauthGrant!.secretId));
    } finally {
      resume.resolve();
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });

  it("Figma callback peer retirement and public disconnect share connection-before-grant ordering", async () => {
    const id = randomUUID().replaceAll("-", ""),
      callbackName = `remaining-figma-callback-${id.slice(0, 8)}`,
      disconnectName = `remaining-figma-disconnect-${id.slice(0, 8)}`,
      triggerName = `remaining_figma_gate_${id}`,
      functionName = `${triggerName}_fn`,
      gateKey = createHash("sha256").update(id).digest().readInt32BE(0),
      callbackDb = createDb(process.env.DATABASE_URL!, {
        poolMax: 1,
        applicationName: callbackName,
      }),
      disconnectDb = createDb(process.env.DATABASE_URL!, {
        poolMax: 1,
        applicationName: disconnectName,
      }),
      gate = await first.pool.connect();
    let callbackResult: Promise<unknown> | undefined,
      disconnectResult: Promise<unknown> | undefined;
    try {
      const f = fixture(callbackDb, disconnectDb),
        saved = await f.save("figma"),
        ctx = context(spaces[0], users[1]),
        old = await f.browser(saved.saved.id, ctx);
      await gate.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [634886, gateKey]);
      // Test-owned trigger in this pristine clone only. All application SQL is unchanged and real.
      await first.prisma.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF OLD.id = TG_ARGV[0] AND current_setting('application_name') = TG_ARGV[1]
            AND NEW."revokedAt" IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(634886, ${gateKey});
          END IF;
          RETURN NEW;
        END $body$`);
      await first.prisma.$executeRawUnsafe(`
        CREATE TRIGGER ${triggerName} BEFORE UPDATE ON native_oauth_grants
        FOR EACH ROW EXECUTE FUNCTION ${functionName}('${old.oauthGrantId!}', '${callbackName}')`);
      callbackResult = f.browser(saved.saved.id, ctx).then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      await vi.waitFor(async () => {
        const waiting = await first.prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${callbackName}
            AND wait_event_type = 'Lock' AND wait_event = 'advisory') AS waiting`;
        expect(waiting[0]!.waiting).toBe(true);
      });
      disconnectResult = f.b.disconnect(old.id, ctx).then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      await vi.waitFor(async () => {
        const waiting = await first.prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${disconnectName}
            AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting`;
        expect(waiting[0]!.waiting).toBe(true);
      });
      await gate.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [634886, gateKey]);
      const [callback, disconnected] = await Promise.all([callbackResult, disconnectResult]);
      expect(disconnected).toEqual({ status: "fulfilled" });
      expect(callback).toMatchObject({ status: "fulfilled", value: { status: "connected" } });
      expect(
        await first.prisma.connection.findUniqueOrThrow({ where: { id: old.id } }),
      ).toMatchObject({ status: "revoked" });
      expect(
        await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
          where: { id: old.oauthGrantId! },
        }),
      ).toMatchObject({ revokedAt: expect.any(Date), secretId: null });
      expect(
        await first.prisma.secret.findUnique({ where: { id: old.oauthGrant!.secretId! } }),
      ).toBeNull();
      expect(
        await first.prisma.nativeOAuthGrant.count({
          where: { configId: saved.saved.id, revokedAt: null, secretId: { not: null } },
        }),
      ).toBe(1);
    } finally {
      await gate.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [634886, gateKey]);
      await Promise.all([callbackResult, disconnectResult]);
      await first.prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON native_oauth_grants`,
      );
      await first.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
      gate.release();
      await callbackDb.prisma.$disconnect();
      await callbackDb.pool.end();
      await disconnectDb.prisma.$disconnect();
      await disconnectDb.pool.end();
    }
  });

  it("Figma a local pre-dispatch credential-load failure releases only its own durable lease", async () => {
    const single = createDb(process.env.DATABASE_URL!, {
      poolMax: 1,
      applicationName: "remaining-figma-preflight-lease-release",
    });
    try {
      const f = fixture(single),
        saved = await f.save("figma"),
        ctx = context(spaces[0], users[1]),
        old = await f.browser(saved.saved.id, ctx),
        config = await first.prisma.nativeAppConfig.findUniqueOrThrow({
          where: { id: saved.saved.id },
        });
      await first.prisma.nativeOAuthGrant.update({
        where: { id: old.oauthGrantId! },
        data: { accessExpiresAt: new Date(0) },
      });
      const load = f.vaultA.load.bind(f.vaultA);
      let configurationLoads = 0;
      const fault = vi.spyOn(f.vaultA, "load").mockImplementation(async (ref, context) => {
        if (ref === config.ciphertext && ++configurationLoads === 2)
          throw new NativeActionError("temporarily_unavailable", "Synthetic local vault outage");
        return load(ref, context);
      });
      try {
        await expect(f.a.authorization(old.id, ctx, true)).rejects.toMatchObject({
          kind: "temporarily_unavailable",
        });
        expect(configurationLoads).toBe(2);
        expect(f.calls.filter((call) => call.kind === "refresh")).toHaveLength(0);
        expect(
          await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
            where: { id: old.oauthGrantId! },
          }),
        ).toMatchObject({
          revokedAt: null,
          secretId: old.oauthGrant!.secretId,
          tokenVersion: old.oauthGrant!.tokenVersion,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
        });
      } finally {
        fault.mockRestore();
      }
      const recovered = await f.a.authorization(old.id, ctx, true);
      expect(recovered.grant.tokenVersion).toBe(old.oauthGrant!.tokenVersion + 1);
      expect(f.calls.filter((call) => call.kind === "refresh")).toHaveLength(1);
    } finally {
      await single.prisma.$disconnect();
      await single.pool.end();
    }
  });
});
