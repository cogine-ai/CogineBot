import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import type { NativeAuthorization } from "./authorities.js";
import { NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import type { NativeMcpPending } from "./mcp.js";
import { NativeOAuthStore } from "./oauth.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const origin = "https://bot.example.test",
  endpoint = "https://mcp.example.test/mcp";
const contextValue = {
  schemaVersion: 2,
  resource: endpoint,
  accountIssuer: "account.example.test",
  accountSubject: "11111111-1111-4111-8111-111111111111",
  principal: "fixture",
  organizationId: 42,
  teamContext: { state: "none" },
};
function auth(version: number): NativeAuthorization {
  return {
    tokens: {
      accessToken: `synthetic-access-${version}`,
      refreshToken: `synthetic-refresh-${version}`,
      mcp: {
        oauth: {
          tokens: {
            access_token: `synthetic-access-${version}`,
            refresh_token: `synthetic-refresh-${version}`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "mcp",
          },
          obtainedAt: Date.now(),
          clientInformation: { client_id: "synthetic-client" },
        },
      },
    },
    identity: {
      authority: "https://mcp.example.test",
      subject: contextValue.accountSubject,
      tenant: "42",
      displayName: "CogineX",
      context: {
        xConnectionContext: contextValue,
        allowedEntityTypes: ["document"],
      },
    },
    scopes: ["mcp"],
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describePostgres("native MCP launch and refresh DB fences", () => {
  const suffix = randomUUID(),
    organizationId = `native-mcp-org-${suffix}`,
    userId = `native-mcp-user-${suffix}`,
    peerId = `native-mcp-peer-${suffix}`,
    spaceId = `native-mcp-space-${suffix}`;
  let a: ReturnType<typeof createDb>, b: ReturnType<typeof createDb>;
  const configs: string[] = [];
  const context = (): AdapterContext => ({
    userId,
    spaceId,
    operationId: "native.mcp.test",
    traceId: suffix,
    signal: new AbortController().signal,
  });
  beforeAll(async () => {
    a = createDb(process.env.DATABASE_URL!, { poolMax: 3 });
    b = createDb(process.env.DATABASE_URL!, { poolMax: 3 });
    const version = await a.prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(version[0]?.version).toContain("PostgreSQL");
    await a.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic MCP",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const id of [userId, peerId]) {
      await a.prisma.user.create({
        data: { id, name: "Synthetic", email: `${id}@example.test` },
      });
      await a.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    await a.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Synthetic MCP" },
    });
    for (const id of [userId, peerId])
      await a.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          spaceId,
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
  });
  afterAll(async () => {
    if (a) {
      await a.prisma.organization.deleteMany({ where: { id: organizationId } });
      await a.prisma.nativeAppConfig.deleteMany({
        where: { id: { in: configs } },
      });
      await a.prisma.user.deleteMany({
        where: { id: { in: [userId, peerId] } },
      });
      await a.prisma.$disconnect();
      await a.pool.end();
    }
    if (b) {
      await b.prisma.$disconnect();
      await b.pool.end();
    }
  });
  async function fixture() {
    const secrets = new EncryptedSecretStore("synthetic-native-mcp-master");
    const network = {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    const configA = new NativeConfigStore(a.prisma, secrets, origin, network),
      configB = new NativeConfigStore(b.prisma, secrets, origin, network);
    const config = await configA.save(
      {
        appId: "coginex",
        label: "Synthetic X",
        ownership: "byo",
        credentialKind: "mcp_oauth",
        endpoint,
        enabled: true,
        scopes: [],
        capabilities: [],
        knowledgeBaseIds: [],
      },
      context(),
      true,
    );
    configs.push(config.id);
    const upstream = new NativeOAuthAuthorities(network);
    const begin = vi.spyOn(upstream.mcp, "begin").mockImplementation(
      async (_config, state): Promise<NativeMcpPending> => ({
        authorizationUrl: `https://mcp.example.test/authorize?state=${state}`,
        material: {
          oauth: {
            codeVerifier: "synthetic-pkce",
            clientInformation: { client_id: "synthetic-client" },
          },
        },
      }),
    );
    vi.spyOn(upstream.mcp, "pendingUrl").mockImplementation(
      (_config, pending) => pending.authorizationUrl,
    );
    const exchange = vi
      .spyOn(upstream, "exchange")
      .mockImplementation(async (_config, secret, _code, _verifier, _signal, pending, state) => {
        expect(secret).toBe("");
        expect(pending?.material.oauth?.codeVerifier).toBe("synthetic-pkce");
        expect(pending?.authorizationUrl).toContain(state!);
        return auth(1);
      });
    const refresh = vi
      .spyOn(upstream, "refresh")
      .mockImplementation(async (_config, secret, previous) => {
        expect(secret).toBe("");
        expect(previous.tokens.mcp?.oauth?.clientInformation?.client_id).toBe("synthetic-client");
        return auth(2);
      });
    const first = new NativeOAuthStore(a.prisma, secrets, configA, upstream),
      second = new NativeOAuthStore(b.prisma, secrets, configB, upstream);
    const started = await first.begin(config.id, context());
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const connected = async () => {
      await first.launch(state, userId, context().signal);
      await second.callback({ state, code: "synthetic-code" }, context().signal, userId);
      return first.authorization(started.connectionId, context());
    };
    return {
      secrets,
      upstream,
      begin,
      exchange,
      refresh,
      first,
      second,
      config,
      started,
      state,
      connected,
    };
  }
  it("saves DCR material under the original pending Secret before redirect and survives another process", async () => {
    const f = await fixture();
    await expect(f.first.launch(f.state, peerId, context().signal)).rejects.toBeInstanceOf(Error);
    expect(f.begin).not.toHaveBeenCalled();
    const old = await a.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: f.started.connectionId },
    });
    const url = await f.first.launch(f.state, userId, context().signal);
    expect(await f.second.launch(f.state, userId, context().signal)).toBe(url);
    expect(f.begin).toHaveBeenCalledTimes(1);
    const session = await a.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: f.started.connectionId },
      include: { secret: true },
    });
    expect(session.secretId).not.toBe(old.secretId);
    expect(session.secret?.ciphertext).not.toContain("synthetic-pkce");
    expect(await a.prisma.secret.findUnique({ where: { id: old.secretId! } })).toBeNull();
    await f.second.callback({ state: f.state, code: "synthetic-code" }, context().signal, userId);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    const live = await f.first.authorization(f.started.connectionId, context());
    expect(live.auth.tokens.mcp?.oauth?.clientInformation?.client_id).toBe("synthetic-client");
    expect(live.grant.scopes).toEqual(["mcp"]);
    await expect(
      f.first.callback({ state: f.state, code: "synthetic-code" }, context().signal, userId),
    ).rejects.toBeInstanceOf(Error);
    expect(f.exchange).toHaveBeenCalledTimes(1);
    await f.upstream.close();
  });
  it("keeps public-client refresh under the same cross-process lease and stable authorization generation", async () => {
    const f = await fixture(),
      live = await f.connected();
    await a.prisma.nativeOAuthGrant.update({
      where: { id: live.grant.id },
      data: { accessExpiresAt: new Date(Date.now() - 1000) },
    });
    const entered = deferred(),
      release = deferred();
    f.refresh.mockImplementation(async (_config, secret, previous) => {
      expect(secret).toBe("");
      expect(previous.tokens.refreshToken).toBe("synthetic-refresh-1");
      entered.resolve();
      await release.promise;
      return auth(2);
    });
    const first = f.first.authorization(f.started.connectionId, context());
    await entered.promise;
    const second = f.second.authorization(f.started.connectionId, context());
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(one.grant.tokenVersion).toBe(2);
    expect(two.grant.tokenVersion).toBe(2);
    expect(one.grant.authGeneration).toBe(live.grant.authGeneration);
    expect(one.connection.metadata).toEqual(live.connection.metadata);
    expect(two.auth.tokens.mcp?.oauth?.tokens?.refresh_token).toBe("synthetic-refresh-2");
    await f.upstream.close();
  });
  it("does not publish a DCR continuation after the exact pending connection is disconnected", async () => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    f.begin.mockImplementation(async (_config, state) => {
      entered.resolve();
      await release.promise;
      return {
        authorizationUrl: `https://mcp.example.test/authorize?state=${state}`,
        material: { oauth: { codeVerifier: "synthetic-orphan-verifier" } },
      };
    });
    const launching = f.first.launch(f.state, userId, context().signal);
    await entered.promise;
    await f.second.disconnect(f.started.connectionId, context());
    release.resolve();
    await expect(launching).rejects.toBeInstanceOf(Error);
    expect(
      (
        await a.prisma.connection.findUniqueOrThrow({
          where: { id: f.started.connectionId },
        })
      ).status,
    ).toBe("revoked");
    expect(f.exchange).not.toHaveBeenCalled();
    const orphan = await a.prisma.secret.findMany({
      where: { userId, spaceId, kind: "native_session" },
    });
    for (const row of orphan)
      expect(await f.secrets.load(row.ciphertext, { recordId: row.id })).not.toContain(
        "synthetic-orphan-verifier",
      );
    await f.upstream.close();
  });
  it("does not retry a rotating MCP token after an unknown worker lease expires", async () => {
    const f = await fixture(),
      live = await f.connected();
    await a.prisma.nativeOAuthGrant.update({
      where: { id: live.grant.id },
      data: {
        accessExpiresAt: new Date(0),
        refreshLeaseId: randomUUID(),
        refreshLeaseUntil: new Date(Date.now() - 1_000),
      },
    });
    await expect(f.second.authorization(f.started.connectionId, context())).rejects.toBeInstanceOf(
      Error,
    );
    expect(f.refresh).not.toHaveBeenCalled();
    const stopped = await a.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: live.grant.id },
    });
    expect(stopped.revokedAt).not.toBeNull();
    expect(stopped.secretId).toBeNull();
    expect(stopped.tokenVersion).toBe(live.grant.tokenVersion);
    expect(await a.prisma.secret.findUnique({ where: { id: live.grant.secretId! } })).toBeNull();
    await f.upstream.close();
  });
});
