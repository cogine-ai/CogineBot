import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { withSecretPersistence } from "../secret-persistence.js";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeActionError } from "./action.js";
import { NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import { NativeOAuthStore } from "./oauth.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const CLIENT_SECRET = "synthetic-collaboration-oauth-client-secret",
  KEY = "synthetic-collaboration-oauth-encryption-key";
const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
function gate() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((r) => {
      enter = r;
    }),
    wait: new Promise<void>((r) => {
      release = r;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
const rejected = (e: unknown) => e instanceof NativeActionError;

describePostgres("Collaboration OAuth actual protocol with PostgreSQL fences", () => {
  let first: ReturnType<typeof createDb>,
    second: ReturnType<typeof createDb>,
    db: PrismaClient,
    peer: PrismaClient;
  const vault = new EncryptedSecretStore(KEY),
    suffix = randomUUID(),
    org = `collaboration-org-${suffix}`,
    owner = `collaboration-owner-${suffix}`,
    other = `collaboration-other-${suffix}`,
    spaceA = `collaboration-a-${suffix}`,
    spaceB = `collaboration-b-${suffix}`;
  const configs = new Set<string>(),
    authorities: NativeOAuthAuthorities[] = [];
  const ctx = (spaceId = spaceA, userId = owner): AdapterContext => ({
    userId,
    spaceId,
    operationId: "synthetic-collaboration-oauth",
    traceId: randomUUID(),
    signal: new AbortController().signal,
  });
  beforeAll(async () => {
    first = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "collaboration-oauth-first",
    });
    second = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "collaboration-oauth-peer",
    });
    db = withSecretPersistence(first.prisma, vault);
    peer = withSecretPersistence(second.prisma, vault);
    await db.organization.create({
      data: { id: org, name: "Synthetic collaboration org", slug: org, createdAt: new Date() },
    });
    for (const id of [owner, other]) {
      await db.user.create({
        data: { id, name: "Synthetic collaboration user", email: `${id}@example.test` },
      });
      await db.member.create({
        data: {
          id: randomUUID(),
          organizationId: org,
          userId: id,
          role: id === owner ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    }
    for (const id of [spaceA, spaceB]) {
      await db.space.create({
        data: { id, organizationId: org, name: "Synthetic collaboration space" },
      });
      for (const userId of [owner, other])
        await db.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId: org,
            spaceId: id,
            userId,
            role: userId === owner ? "owner" : "member",
            createdAt: new Date(),
          },
        });
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (db) {
        await db.organization.deleteMany({ where: { id: org } });
        await db.user.deleteMany({ where: { id: { in: [owner, other] } } });
        await db.nativeAppConfig.deleteMany({ where: { id: { in: [...configs] } } });
      }
    } finally {
      await Promise.all(authorities.map((a) => a.close()));
      await Promise.all(
        [first, second].filter(Boolean).map(async (c) => {
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
  async function fixture(
    app: "github" | "linear" | "slack",
    actor = app === "slack" ? "bot" : "user",
    kind = "oauth",
  ) {
    const control = {
      tokenVersion: 0,
      tokenCalls: 0,
      refreshCalls: 0,
      lostRefreshes: 0,
      rejectRefreshes: 0,
      identitySubject:
        app === "github" ? "123" : app === "linear" ? "fixture-viewer" : "UBOTFIXTURE",
      blockRefresh: undefined as ReturnType<typeof gate> | undefined,
      lastRefreshToken: "",
      calls: [] as string[],
    };
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        control.calls.push(url);
        let body: unknown;
        if (url === "https://api.github.com/app") body = { id: 42 };
        else if (url === "https://api.github.com/app/installations/88")
          body = {
            id: 88,
            app_id: 42,
            account: { id: 77, login: "fixture-org" },
            suspended_at: null,
          };
        else if (url.endsWith("/app/installations/88/access_tokens")) {
          control.tokenCalls++;
          const blocker = control.blockRefresh;
          if (blocker) {
            control.blockRefresh = undefined;
            blocker.enter();
            await blocker.wait;
          }
          body = {
            token: `ghs_fixture-${++control.tokenVersion}`,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { metadata: "read", issues: "write" },
          };
        } else if (
          [
            "https://github.com/login/oauth/access_token",
            "https://api.linear.app/oauth/token",
            "https://slack.com/api/oauth.v2.access",
          ].includes(url)
        ) {
          control.tokenCalls++;
          const params = new URLSearchParams(String(init?.body)),
            refresh = params.get("grant_type") === "refresh_token";
          if (refresh) {
            control.refreshCalls++;
            control.lastRefreshToken = params.get("refresh_token")!;
            if (control.rejectRefreshes > 0) {
              control.rejectRefreshes--;
              return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
            }
            if (control.lostRefreshes > 0) {
              control.lostRefreshes--;
              throw Error("Synthetic lost refresh response");
            }
            const blocker = control.blockRefresh;
            if (blocker) {
              control.blockRefresh = undefined;
              blocker.enter();
              await blocker.wait;
            }
          }
          const v = ++control.tokenVersion;
          body =
            app === "github"
              ? {
                  access_token: `ghu_fixture-${v}`,
                  refresh_token: `ghr_fixture-${v}`,
                  token_type: "bearer",
                  scope: "",
                  expires_in: 28800,
                }
              : app === "linear"
                ? {
                    access_token: `fixture-linear-${v}`,
                    refresh_token: `fixture-linear-refresh-${v}`,
                    token_type: "Bearer",
                    scope: "read write",
                    expires_in: 86399,
                  }
                : {
                    ok: true,
                    access_token: `xoxe.xoxb-fixture-${v}`,
                    refresh_token: `fixture-slack-refresh-${v}`,
                    token_type: "bot",
                    scope: "channels:read,channels:history,chat:write",
                    expires_in: 43200,
                    bot_user_id: "UBOTFIXTURE",
                    app_id: "A123FIXTURE",
                    team: { id: "T123FIXTURE" },
                  };
        } else if (url === "https://api.github.com/user")
          body = { id: Number(control.identitySubject), login: "fixture-user", type: "User" };
        else if (url === "https://api.linear.app/graphql") {
          const authorization = new Headers(init?.headers).get("authorization");
          assert.ok(authorization?.startsWith("Bearer "));
          body = {
            data: {
              viewer: {
                id: control.identitySubject,
                name: "Fixture",
                app: actor === "app",
                organization: { id: "fixture-org", name: "Fixture" },
              },
            },
          };
        } else if (url === "https://slack.com/api/auth.test")
          body = {
            ok: true,
            team_id: "T123FIXTURE",
            user_id: control.identitySubject,
            user: "fixture-bot",
            bot_id: "B123FIXTURE",
          };
        else throw Error("Unexpected collaboration protocol URL");
        return new Response(JSON.stringify(body));
      },
    );
    function upstream() {
      const a = new NativeOAuthAuthorities({
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      });
      authorities.push(a);
      return a;
    }
    const configStore = new NativeConfigStore(db, vault, "https://api.example.test"),
      peerConfig = new NativeConfigStore(peer, vault, "https://api.example.test");
    const config = await configStore.save(
      NativeConfigInputSchema.parse({
        appId: app,
        actor,
        ownership: "byo",
        credentialKind: kind,
        label: "Synthetic collaboration app",
        ...(kind === "oauth" ? { clientId: "fixture-client", clientSecret: CLIENT_SECRET } : {}),
        ...(kind === "github_app_installation"
          ? { githubAppId: "42", githubInstallationId: "88" }
          : {}),
        scopes:
          app === "github"
            ? ["offline_access"]
            : app === "linear"
              ? ["read", "write"]
              : ["channels:read", "channels:history", "chat:write"],
      }),
      ctx(),
      true,
    );
    configs.add(config.id);
    const a = new NativeOAuthStore(db, vault, configStore, upstream()),
      b = new NativeOAuthStore(peer, vault, peerConfig, upstream());
    async function connected(actorContext = ctx(), previousConnectionId?: string) {
      let connectionId: string;
      if (kind === "github_app_installation")
        connectionId = (
          await a.connectCollaborationToken(
            config.id,
            JSON.stringify({ appId: "42", installationId: "88", privateKeyPem }),
            actorContext,
            previousConnectionId,
          )
        ).connectionId;
      else {
        const started = await a.begin(config.id, actorContext, previousConnectionId),
          state = new URL(started.authorizationUrl).searchParams.get("state")!;
        await a.callback({ state, code: "fixture-code" }, actorContext.signal, actorContext.userId);
        connectionId = started.connectionId;
      }
      const connection = await db.connection.findUniqueOrThrow({
        where: { id: connectionId },
        include: { oauthGrant: true },
      });
      assert.ok(connection.oauthGrant);
      return { connectionId, connection, grant: connection.oauthGrant };
    }
    return { a, b, control, config, connected, fetch };
  }
  async function expire(id: string) {
    await db.nativeOAuthGrant.update({ where: { id }, data: { accessExpiresAt: new Date(0) } });
  }
  it("GitHub installation secret stays encrypted and expired token remints without refresh_token", async () => {
    const f = await fixture("github", "installation", "github_app_installation"),
      c = await f.connected();
    assert.equal(
      c.grant.principal && JSON.stringify(c.grant.principal).includes("PRIVATE KEY"),
      false,
    );
    assert.ok(c.grant.secretId);
    const stored = await db.secret.findUniqueOrThrow({ where: { id: c.grant.secretId! } });
    assert.equal(stored.ciphertext.includes("PRIVATE KEY"), false);
    await expire(c.grant.id);
    const next = await f.b.authorization(c.connectionId, ctx());
    assert.equal(next.auth.tokens.refreshToken, null);
    assert.equal(next.auth.tokens.githubInstallation!.installationId, "88");
    assert.equal(next.grant.tokenVersion, 2);
    assert.equal(f.control.tokenCalls, 2);
  });
  it("GitHub and Slack rotate real protocol pairs once across two store instances", async () => {
    for (const app of ["github", "slack"] as const) {
      const f = await fixture(app),
        c = await f.connected();
      await expire(c.grant.id);
      const blocker = gate();
      f.control.blockRefresh = blocker;
      const firstRefresh = f.a.authorization(c.connectionId, ctx(), true);
      await blocker.entered;
      const secondRefresh = f.b.authorization(c.connectionId, ctx(), true);
      blocker.release();
      const results = await Promise.all([firstRefresh, secondRefresh]);
      assert.equal(f.control.refreshCalls, 1);
      assert.equal(results[0]!.grant.tokenVersion, 2);
      assert.equal(results[1]!.grant.tokenVersion, 2);
      assert.equal(results[0]!.auth.tokens.refreshToken, results[1]!.auth.tokens.refreshToken);
      assert.equal(await db.secret.count({ where: { id: c.grant.secretId! } }), 0);
    }
  });
  it("Linear inside original 30-minute grace recovers exact old refresh pair and persists successor", async () => {
    const f = await fixture("linear"),
      c = await f.connected();
    await expire(c.grant.id);
    await db.nativeOAuthGrant.update({
      where: { id: c.grant.id },
      data: {
        refreshLeaseId: randomUUID(),
        refreshLeaseUntil: new Date(Date.now() - 28 * 60000),
        refreshRecoveryUntil: new Date(Date.now() + 60000),
      },
    });
    const current = await f.a.authorization(c.connectionId, ctx(), true);
    assert.equal(current.grant.revokedAt, null);
    assert.equal(current.grant.tokenVersion, 2);
    assert.equal(f.control.lastRefreshToken, "fixture-linear-refresh-1");
  });
  it("Linear unknown refresh holds lease then retries within grace without changing actor", async () => {
    const f = await fixture("linear"),
      c = await f.connected();
    await expire(c.grant.id);
    f.control.lostRefreshes = 1;
    await assert.rejects(
      f.a.authorization(c.connectionId, ctx(), true),
      (e) => e instanceof NativeActionError && e.options.uncertain === true,
    );
    const uncertain = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: c.grant.id } });
    assert.ok(uncertain.refreshLeaseId);
    assert.equal(uncertain.revokedAt, null);
    assert.equal(uncertain.tokenVersion, 1);
    await db.nativeOAuthGrant.update({
      where: { id: c.grant.id },
      data: { refreshLeaseUntil: new Date(Date.now() - 1000) },
    });
    const next = await f.b.authorization(c.connectionId, ctx(), true);
    assert.equal(next.grant.tokenVersion, 2);
    assert.equal(next.auth.identity.subject, "fixture-viewer");
    assert.equal(f.control.refreshCalls, 2);
    assert.equal(f.control.lastRefreshToken, "fixture-linear-refresh-1");
  });
  it("Linear outside grace and GitHub uncertain lease do not reuse old rotating pair", async () => {
    for (const app of ["linear", "github"] as const) {
      const f = await fixture(app),
        c = await f.connected();
      await expire(c.grant.id);
      await db.nativeOAuthGrant.update({
        where: { id: c.grant.id },
        data: {
          refreshLeaseId: randomUUID(),
          refreshLeaseUntil: new Date(Date.now() - 30 * 60000),
          refreshRecoveryUntil: app === "linear" ? new Date(Date.now() - 60000) : null,
        },
      });
      await assert.rejects(f.a.authorization(c.connectionId, ctx(), true), rejected);
      assert.equal(f.control.refreshCalls, 0);
      assert.ok(
        (await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: c.grant.id } })).revokedAt,
      );
    }
  });
  it("disconnect one Slack connection keeps sibling account live and never calls remote uninstall/revoke", async () => {
    const f = await fixture("slack"),
      a = await f.connected(),
      b = await f.connected();
    await f.a.disconnect(a.connectionId, ctx());
    await assert.rejects(f.a.authorization(a.connectionId, ctx()), rejected);
    assert.equal((await f.b.authorization(b.connectionId, ctx())).connection.status, "connected");
    assert.equal(
      f.control.calls.some((url) => url.includes("revoke") || url.includes("uninstall")),
      false,
    );
    await assert.rejects(f.a.authorization(b.connectionId, ctx(spaceB)), rejected);
    await assert.rejects(f.a.authorization(b.connectionId, ctx(spaceA, other)), rejected);
  });
  it("disconnect during actual Slack refresh prevents late pair adoption and preserves sibling", async () => {
    const f = await fixture("slack"),
      c = await f.connected(),
      sibling = await f.connected();
    await expire(c.grant.id);
    const blocker = gate();
    f.control.blockRefresh = blocker;
    const pending = f.a.authorization(c.connectionId, ctx(), true);
    const checked = assert.rejects(pending, rejected);
    await blocker.entered;
    await f.b.disconnect(c.connectionId, ctx());
    blocker.release();
    await checked;
    const stopped = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: c.grant.id } });
    assert.equal(stopped.authGeneration, c.grant.authGeneration + 1);
    assert.equal(stopped.secretId, null);
    assert.equal(
      (await f.b.authorization(sibling.connectionId, ctx())).connection.status,
      "connected",
    );
  });
  it("new Linear authorization never silently revives old generation", async () => {
    const f = await fixture("linear"),
      old = await f.connected(),
      sibling = await f.connected(),
      next = await f.connected(ctx(), old.connectionId);
    await assert.rejects(f.a.authorization(old.connectionId, ctx()), rejected);
    assert.equal(
      (await f.b.authorization(next.connectionId, ctx())).connection.status,
      "connected",
    );
    assert.equal(
      (await f.b.authorization(sibling.connectionId, ctx())).connection.status,
      "connected",
    );
    assert.notEqual(next.grant.id, old.grant.id);
    assert.ok(
      (await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: old.grant.id } })).revokedAt,
    );
  });
  it("Linear repeated lost refresh cannot extend the original provider grace window", async () => {
    const f = await fixture("linear"),
      c = await f.connected();
    await expire(c.grant.id);
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      f.control.lostRefreshes = 1;
      await assert.rejects(
        f.a.authorization(c.connectionId, ctx(), true),
        (e) => e instanceof NativeActionError && e.options.uncertain === true,
      );
      clock = start + 29 * 60_000;
      f.control.lostRefreshes = 1;
      await assert.rejects(
        f.b.authorization(c.connectionId, ctx(), true),
        (e) => e instanceof NativeActionError && e.options.uncertain === true,
      );
      assert.equal(f.control.refreshCalls, 2);
      clock = start + 31 * 60_000;
      await assert.rejects(f.a.authorization(c.connectionId, ctx(), true), rejected);
      assert.equal(
        f.control.refreshCalls,
        2,
        "The original thirty-minute provider grace cannot be renewed by another failed attempt",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("Linear definitive rejection of a replay cannot reset an earlier unknown rotation deadline", async () => {
    const f = await fixture("linear"),
      c = await f.connected();
    await expire(c.grant.id);
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      f.control.lostRefreshes = 1;
      await assert.rejects(
        f.a.authorization(c.connectionId, ctx(), true),
        (e) => e instanceof NativeActionError && e.options.uncertain === true,
      );
      const original = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: c.grant.id } });
      clock = start + 29 * 60_000;
      f.control.rejectRefreshes = 1;
      await assert.rejects(
        f.b.authorization(c.connectionId, ctx(), true),
        (e) => e instanceof NativeActionError && e.kind === "rate_limited",
      );
      const after = await db.nativeOAuthGrant.findUniqueOrThrow({ where: { id: c.grant.id } });
      assert.equal(after.refreshRecoveryUntil?.getTime(), original.refreshRecoveryUntil?.getTime());
      clock = start + 31 * 60_000;
      await assert.rejects(f.a.authorization(c.connectionId, ctx(), true), rejected);
      assert.equal(f.control.refreshCalls, 2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
