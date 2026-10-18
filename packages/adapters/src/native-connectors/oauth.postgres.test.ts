import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSecretPersistence } from "../secret-persistence.js";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeActionError } from "./action.js";
import type { NativeAuthorization } from "./authorities.js";
import { NativeOAuthAuthorities } from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import { NativeOAuthStore } from "./oauth.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const CLIENT_SECRET = "fixture-application-secret-never-public";
const ENCRYPTION_KEY = "fixture-native-oauth-postgres-master-key";
const TOKEN_MARKER = "fixture-native-token-never-public";
const API_ORIGIN = "https://api.example.test";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"];

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authorization(version: number, subject = "synthetic-subject"): NativeAuthorization {
  return {
    tokens: {
      accessToken: `${TOKEN_MARKER}-access-${version}`,
      refreshToken: `${TOKEN_MARKER}-refresh-${version}`,
    },
    identity: {
      authority: "google",
      subject,
      tenant: null,
      displayName: `Synthetic account ${subject}`,
      context: { email: "synthetic@example.test" },
    },
    scopes: SCOPES,
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

/** Fault injection is limited to the existing vault boundary; DB calls remain real. */
function secretsWith(base: SecretStore, overrides: Partial<SecretStore>): SecretStore {
  return {
    describe: () => base.describe(),
    put: (...args) => base.put(...args),
    load: (...args) => base.load(...args),
    delete: (...args) => base.delete(...args),
    redact: (value) => base.redact(value),
    onChange: (listener) => base.onChange(listener),
    start: () => base.start(),
    close: () => base.close(),
    ...overrides,
  };
}

describePostgres("native OAuth DB fences and competing stores (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `native-oauth-org-${suffix}`;
  const userIds = [`native-oauth-owner-${suffix}`, `native-oauth-peer-${suffix}`];
  const spaceA = `native-oauth-space-a-${suffix}`;
  const spaceB = `native-oauth-space-b-${suffix}`;
  const configIds = new Set<string>();
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  function context(spaceId = spaceA, userId = userIds[0]!): AdapterContext {
    return {
      userId,
      spaceId,
      operationId: `native.oauth.test.${suffix}`,
      traceId: `native.oauth.test.${suffix}`,
      signal: new AbortController().signal,
    };
  }

  beforeAll(async () => {
    first = createDb(process.env.DATABASE_URL!, {
      poolMax: 3,
      applicationName: "native-oauth-draft-first",
    });
    second = createDb(process.env.DATABASE_URL!, {
      poolMax: 3,
      applicationName: "native-oauth-draft-second",
    });
    // Assert an actual PostgreSQL connection; no Prisma delegate or DB call is mocked.
    const version = await first.prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(version[0]?.version).toContain("PostgreSQL");
    await first.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic OAuth organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const [index, id] of userIds.entries()) {
      await first.prisma.user.create({
        data: { id, name: "Synthetic OAuth user", email: `${id}@example.test` },
      });
      await first.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: index === 0 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    }
    for (const id of [spaceA, spaceB]) {
      await first.prisma.space.create({
        data: { id, organizationId, name: "Synthetic OAuth Space" },
      });
      for (const userId of userIds)
        await first.prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            spaceId: id,
            organizationId,
            userId,
            role: userId === userIds[0] ? "owner" : "member",
            createdAt: new Date(),
          },
        });
    }
  }, 20_000);

  afterAll(async () => {
    if (first) {
      try {
        // Test-owned identities only. Space cascades remove grants/sessions/connections/tasks/secrets.
        await first.prisma.organization.deleteMany({ where: { id: organizationId } });
        await first.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configIds] } } });
        await first.prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

  async function fixture() {
    const secretsA = new EncryptedSecretStore(ENCRYPTION_KEY);
    const secretsB = new EncryptedSecretStore(ENCRYPTION_KEY);
    const configsA = new NativeConfigStore(first.prisma, secretsA, API_ORIGIN);
    const configsB = new NativeConfigStore(second.prisma, secretsB, API_ORIGIN);
    const control = {
      exchanges: 0,
      refreshes: 0,
      exchange: async (code: string): Promise<NativeAuthorization> =>
        authorization(
          1,
          code === "other-synthetic-identity" ? "synthetic-other-subject" : "synthetic-subject",
        ),
      refresh: async (previous: NativeAuthorization): Promise<NativeAuthorization> =>
        authorization(2, previous.identity.subject),
    };
    function authority(): NativeOAuthAuthorities {
      const fake: Pick<
        NativeOAuthAuthorities,
        "authorizationUrl" | "exchange" | "refresh" | "close"
      > = {
        authorizationUrl: (_config, state, verifier) => {
          const url = new URL("https://accounts.example.test/authorize");
          url.searchParams.set("state", state);
          url.searchParams.set(
            "code_challenge",
            createHash("sha256").update(verifier).digest("base64url"),
          );
          return url.toString();
        },
        exchange: async (_config, secret, code, verifier, signal) => {
          signal.throwIfAborted();
          if (secret !== CLIENT_SECRET || !/^[A-Za-z0-9_-]{64}$/.test(verifier))
            throw new Error("Fixture secret or PKCE verifier mismatch");
          control.exchanges++;
          return control.exchange(code);
        },
        refresh: async (_config, secret, previous, signal) => {
          signal.throwIfAborted();
          if (secret !== CLIENT_SECRET) throw new Error("Fixture application secret mismatch");
          control.refreshes++;
          return control.refresh(previous);
        },
        close: async () => {},
      };
      // Only the upstream authority boundary is fake. Private fetch makes its class nominal.
      return fake as unknown as NativeOAuthAuthorities;
    }
    const makeFirst = (
      secrets: SecretStore = secretsA,
      prisma: PrismaClient = first.prisma,
      upstream: NativeOAuthAuthorities = authority(),
    ) => new NativeOAuthStore(prisma, secrets, configsA, upstream);
    const a = makeFirst();
    const makeSecond = (prisma: PrismaClient = second.prisma) =>
      new NativeOAuthStore(prisma, secretsB, configsB, authority());
    const b = makeSecond();
    const config = await configsA.save(
      NativeConfigInputSchema.parse({
        appId: "google-calendar",
        ownership: "byo",
        credentialKind: "oauth",
        label: `Synthetic OAuth source ${randomUUID()}`,
        clientId: "synthetic-client-id",
        clientSecret: CLIENT_SECRET,
        scopes: SCOPES,
      }),
      context(),
      true,
    );
    configIds.add(config.id);
    async function begin(store = a, previousId?: string) {
      const started = await store.begin(config.id, context(), previousId);
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("Missing fixture OAuth state");
      return { ...started, state };
    }
    async function connected() {
      const started = await begin();
      await a.callback(
        { state: started.state, code: "synthetic-code" },
        context().signal,
        context().userId,
      );
      const connection = await first.prisma.connection.findUniqueOrThrow({
        where: { id: started.connectionId },
        include: { oauthGrant: true },
      });
      if (!connection.oauthGrant) throw new Error("Missing fixture OAuth grant");
      return { ...started, connection, grant: connection.oauthGrant };
    }
    return {
      a,
      b,
      makeFirst,
      makeSecond,
      authority,
      secretsA,
      secretsB,
      control,
      config,
      configsA,
      configsB,
      begin,
      connected,
    };
  }

  it("requires the initiating browser user before launching or exchanging an authorization", async () => {
    const f = await fixture();
    const started = await f.begin();
    const kickoff = new URL(started.authorizationUrl);
    expect(kickoff.origin).toBe(API_ORIGIN);
    expect(kickoff.pathname).toBe("/api/connectors/oauth/start");
    await expect(f.a.launch(started.state, userIds[1]!, context().signal)).rejects.toBeInstanceOf(
      NativeActionError,
    );
    const upstream = new URL(await f.a.launch(started.state, context().userId, context().signal));
    expect(upstream.origin).toBe("https://accounts.example.test");
    expect(upstream.searchParams.get("state")).toBe(started.state);
    expect(upstream.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const actor of ["", userIds[1]!]) {
      await expect(
        f.b.callback({ state: started.state, code: "synthetic-code" }, context().signal, actor),
      ).rejects.toBeInstanceOf(NativeActionError);
    }
    expect(f.control.exchanges).toBe(0);
    const pending = await first.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: started.connectionId },
    });
    expect(pending.consumedAt).toBeNull();
    expect(pending.secretId).not.toBeNull();
    await expect(
      f.a.callback(
        { state: started.state, code: "synthetic-code" },
        context().signal,
        context().userId,
      ),
    ).resolves.toEqual({ connectionId: started.connectionId });
    expect(f.control.exchanges).toBe(1);
    await expect(
      f.a.launch(started.state, context().userId, context().signal),
    ).rejects.toBeInstanceOf(NativeActionError);
  });

  it("one-use callback has one DB winner and exchanges exactly once across two stores", async () => {
    const f = await fixture();
    const started = await f.begin();
    const exchangeStarted = deferred();
    const finishExchange = deferred();
    f.control.exchange = async () => {
      exchangeStarted.resolve();
      await finishExchange.promise;
      return authorization(1);
    };
    const winner = f.a.callback(
      { state: started.state, code: "synthetic-code" },
      context().signal,
      context().userId,
    );
    await exchangeStarted.promise;
    try {
      await expect(
        f.b.callback(
          { state: started.state, code: "same-synthetic-code" },
          context().signal,
          context().userId,
        ),
      ).rejects.toBeInstanceOf(NativeActionError);
    } finally {
      finishExchange.resolve();
    }
    await expect(winner).resolves.toEqual({ connectionId: started.connectionId });
    expect(f.control.exchanges).toBe(1);
    await expect(
      f.b.callback({ state: started.state, code: "again" }, context().signal, context().userId),
    ).rejects.toBeInstanceOf(NativeActionError);
    expect(f.control.exchanges).toBe(1);
    const session = await first.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: started.connectionId },
    });
    expect(session.consumedAt).not.toBeNull();
    expect(session.secretId).toBeNull();
    expect(session.stateHash).toBe(createHash("sha256").update(started.state).digest("hex"));
    expect(JSON.stringify(session)).not.toContain(started.state);
    expect(await first.prisma.nativeOAuthGrant.count({ where: { configId: f.config.id } })).toBe(1);
  }, 15_000);

  it.each(["cancel", "ttl", "config_revision", "connection_space"] as const)(
    "rejects %s before any upstream exchange",
    async (change: "cancel" | "ttl" | "config_revision" | "connection_space") => {
      const f = await fixture();
      const started = await f.begin();
      if (change === "cancel") await f.a.disconnect(started.connectionId, context());
      else if (change === "ttl")
        await first.prisma.nativeOAuthSession.update({
          where: { connectionId: started.connectionId },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });
      else if (change === "config_revision")
        await f.configsA.save(
          NativeConfigInputSchema.parse({
            id: f.config.id,
            expectedRevision: f.config.revision,
            appId: "google-calendar",
            ownership: "byo",
            credentialKind: "oauth",
            label: "Changed synthetic source",
            clientId: "changed-synthetic-client-id",
            clientSecret: CLIENT_SECRET,
            scopes: SCOPES,
          }),
          context(),
          true,
        );
      else
        await first.prisma.connection.update({
          where: { id: started.connectionId },
          data: { spaceId: spaceB },
        });
      await expect(
        f.b.callback(
          { state: started.state, code: "synthetic-code" },
          context().signal,
          context().userId,
        ),
      ).rejects.toBeInstanceOf(NativeActionError);
      expect(f.control.exchanges).toBe(0);
      expect(await first.prisma.nativeOAuthGrant.count({ where: { configId: f.config.id } })).toBe(
        0,
      );
      if (change === "cancel")
        expect(
          (await first.prisma.connection.findUniqueOrThrow({ where: { id: started.connectionId } }))
            .status,
        ).toBe("revoked");
    },
  );

  it("owner and Space fences reject existing-grant use, stop and reauthorization targeting another scope", async () => {
    const f = await fixture();
    const connected = await f.connected();
    for (const other of [context(spaceB), context(spaceA, userIds[1]!)]) {
      await expect(f.b.authorization(connected.connectionId, other)).rejects.toBeInstanceOf(
        NativeActionError,
      );
      await expect(f.b.disconnect(connected.connectionId, other)).rejects.toBeInstanceOf(
        NativeActionError,
      );
      await expect(f.b.begin(f.config.id, other, connected.connectionId)).rejects.toBeInstanceOf(
        NativeActionError,
      );
    }
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("connected");
    expect(f.control.refreshes).toBe(0);
  });

  it("two stores with independent clients refresh one grant once; generation stays stable and tokenVersion advances", async () => {
    const f = await fixture();
    const connected = await f.connected();
    await first.prisma.nativeOAuthGrant.update({
      where: { id: connected.grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    const upstreamStarted = deferred();
    const finishUpstream = deferred();
    const loserClaimed = deferred();
    f.control.refresh = async (previous) => {
      upstreamStarted.resolve();
      await finishUpstream.promise;
      return authorization(2, previous.identity.subject);
    };
    // Observe the actual losing PostgreSQL UPDATE, without replacing that query or its result.
    const observedPrisma = second.prisma.$extends({
      query: {
        nativeOAuthGrant: {
          async updateMany({ args, query }) {
            const result = await query(args);
            if (typeof args.data.refreshLeaseId === "string" && result.count === 0)
              loserClaimed.resolve();
            return result;
          },
        },
      },
    });
    const b = f.makeSecond(observedPrisma as unknown as PrismaClient);
    const firstRefresh = f.a.authorization(connected.connectionId, context(), true);
    await upstreamStarted.promise;
    const secondRefresh = b.authorization(connected.connectionId, context(), true);
    try {
      await loserClaimed.promise;
    } finally {
      finishUpstream.resolve();
    }
    const [one, two] = await Promise.all([firstRefresh, secondRefresh]);
    expect(one.auth.tokens.accessToken).toBe(`${TOKEN_MARKER}-access-2`);
    expect(two.auth.tokens.accessToken).toBe(one.auth.tokens.accessToken);
    expect(f.control.refreshes).toBe(1);
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(grant.authGeneration).toBe(connected.grant.authGeneration);
    expect(grant.tokenVersion).toBe(connected.grant.tokenVersion + 1);
    expect(grant.revokedAt).toBeNull();
    expect(grant.refreshLeaseId).toBeNull();
    expect(grant.refreshLeaseUntil).toBeNull();
    expect(grant.secretId).not.toBe(connected.grant.secretId);
    expect(
      await first.prisma.secret.findUnique({ where: { id: connected.grant.secretId! } }),
    ).toBeNull();
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .metadata,
    ).toEqual(connected.connection.metadata);
  }, 15_000);

  it("an expired refresh lease retires the unknown old pair instead of replaying its token", async () => {
    const f = await fixture();
    const connected = await f.connected();
    await first.prisma.nativeOAuthGrant.update({
      where: { id: connected.grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    const staleStarted = deferred(),
      finishStale = deferred();
    f.control.refresh = async () => {
      staleStarted.resolve();
      await finishStale.promise;
      throw new NativeActionError("authorization_expired", "Synthetic stale token rejected");
    };
    const stale = f.a.authorization(connected.connectionId, context(), true);
    const staleResult = expect(stale).rejects.toBeInstanceOf(NativeActionError);
    await staleStarted.promise;
    await second.prisma.nativeOAuthGrant.update({
      where: { id: connected.grant.id },
      data: { refreshLeaseUntil: new Date(Date.now() - 1_000) },
    });
    try {
      await expect(
        f.b.authorization(connected.connectionId, context(), true),
      ).rejects.toBeInstanceOf(NativeActionError);
    } finally {
      finishStale.resolve();
    }
    await staleResult;
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(f.control.refreshes).toBe(1);
    expect(grant.tokenVersion).toBe(connected.grant.tokenVersion);
    expect(grant.revokedAt).not.toBeNull();
    expect(grant.secretId).toBeNull();
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("error");
    expect(
      await first.prisma.secret.findUnique({ where: { id: connected.grant.secretId! } }),
    ).toBeNull();
    await expect(f.b.authorization(connected.connectionId, context())).rejects.toBeInstanceOf(
      NativeActionError,
    );
    expect(f.control.refreshes).toBe(1);
  }, 15_000);

  it("a delayed old-version failure cannot retire an already committed newer pair or its lease", async () => {
    const f = await fixture(),
      connected = await f.connected();
    await first.prisma.nativeOAuthGrant.update({
      where: { id: connected.grant.id },
      data: { accessExpiresAt: new Date(0) },
    });
    const staleStarted = deferred(),
      finishStale = deferred();
    f.control.refresh = async () => {
      staleStarted.resolve();
      await finishStale.promise;
      throw new NativeActionError("authorization_expired", "Synthetic delayed old response");
    };
    const stale = f.a.authorization(connected.connectionId, context(), true);
    const staleResult = expect(stale).rejects.toBeInstanceOf(NativeActionError);
    await staleStarted.promise;
    const current = await second.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    const successor = authorization(2),
      materialId = randomUUID();
    const material = await f.secretsB.put(JSON.stringify(successor.tokens), context(), {
      recordId: materialId,
    });
    const newerLease = randomUUID();
    // Inject an already committed successor, not a second request with the old RT.
    // Every database mutation is real and fences the exact in-flight version/lease.
    await second.prisma.$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: materialId,
          spaceId: context().spaceId,
          userId: context().userId,
          kind: "native_grant",
          ciphertext: material.ciphertext,
        },
      });
      const committed = await tx.nativeOAuthGrant.updateMany({
        where: {
          id: current.id,
          tokenVersion: current.tokenVersion,
          refreshLeaseId: current.refreshLeaseId,
          revokedAt: null,
        },
        data: {
          tokenVersion: { increment: 1 },
          secretId: materialId,
          accessExpiresAt: successor.expiresAt,
          refreshLeaseId: newerLease,
          refreshLeaseUntil: new Date(Date.now() + 60_000),
        },
      });
      expect(committed.count).toBe(1);
      await tx.secret.deleteMany({ where: { id: connected.grant.secretId! } });
    });
    finishStale.resolve();
    await staleResult;
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: current.id },
    });
    expect(f.control.refreshes).toBe(1);
    expect(grant.tokenVersion).toBe(connected.grant.tokenVersion + 1);
    expect(grant.revokedAt).toBeNull();
    expect(grant.secretId).toBe(materialId);
    expect(grant.refreshLeaseId).toBe(newerLease);
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("connected");
    expect(
      (await f.b.authorization(connected.connectionId, context())).auth.tokens.accessToken,
    ).toBe(`${TOKEN_MARKER}-access-2`);
  }, 15_000);

  it("disconnect during callback exchange cannot resurrect the pending account", async () => {
    const f = await fixture();
    const started = await f.begin();
    const exchangeStarted = deferred();
    const finishExchange = deferred();
    f.control.exchange = async () => {
      exchangeStarted.resolve();
      await finishExchange.promise;
      return authorization(1);
    };
    const callback = f.a.callback(
      { state: started.state, code: "synthetic-code" },
      context().signal,
      context().userId,
    );
    const rejected = expect(callback).rejects.toBeInstanceOf(NativeActionError);
    await exchangeStarted.promise;
    try {
      await f.b.disconnect(started.connectionId, context());
    } finally {
      finishExchange.resolve();
    }
    await rejected;
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: started.connectionId } }))
        .status,
    ).toBe("revoked");
    expect(await first.prisma.nativeOAuthGrant.count({ where: { configId: f.config.id } })).toBe(0);
    expect(
      (
        await first.prisma.nativeOAuthSession.findUniqueOrThrow({
          where: { connectionId: started.connectionId },
        })
      ).cancelledAt,
    ).not.toBeNull();
  }, 15_000);

  it("disconnect during refresh keeps the retired generation and rejects the late token pair", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const refreshStarted = deferred();
    const finishRefresh = deferred();
    f.control.refresh = async (previous) => {
      refreshStarted.resolve();
      await finishRefresh.promise;
      return authorization(2, previous.identity.subject);
    };
    const refresh = f.a.authorization(connected.connectionId, context(), true);
    const rejected = expect(refresh).rejects.toBeInstanceOf(NativeActionError);
    await refreshStarted.promise;
    try {
      await f.b.disconnect(connected.connectionId, context());
    } finally {
      finishRefresh.resolve();
    }
    await rejected;
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(grant.revokedAt).not.toBeNull();
    expect(grant.secretId).toBeNull();
    expect(grant.authGeneration).toBe(connected.grant.authGeneration + 1);
    expect(grant.tokenVersion).toBe(connected.grant.tokenVersion);
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("revoked");
  }, 15_000);

  it("reconnect makes a new grant/connection even for another identity; the old task remains bound to its retired ID", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const bot = await first.prisma.bot.create({
      data: { spaceId: spaceA, userId: userIds[0]!, name: "Synthetic OAuth Bot", color: "ink" },
    });
    const thread = await first.prisma.thread.create({
      data: { spaceId: spaceA, userId: userIds[0]!, botId: bot.id },
    });
    const task = await first.prisma.task.create({
      data: {
        spaceId: spaceA,
        userId: userIds[0]!,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Synthetic task retaining its explicit account",
        status: "completed",
        connectionIds: [connected.connectionId],
      },
    });
    await f.a.disconnect(connected.connectionId, context());
    const next = await f.begin(f.b, connected.connectionId);
    expect(next.connectionId).not.toBe(connected.connectionId);
    await f.b.callback(
      { state: next.state, code: "other-synthetic-identity" },
      context().signal,
      context().userId,
    );
    const newConnection = await first.prisma.connection.findUniqueOrThrow({
      where: { id: next.connectionId },
      include: { oauthGrant: true },
    });
    expect(newConnection.status).toBe("connected");
    expect(newConnection.oauthGrantId).not.toBe(connected.grant.id);
    expect(newConnection.oauthGrant?.subject).toBe("synthetic-other-subject");
    expect(newConnection.displayName).toContain("synthetic-other-subject");
    expect(
      (await first.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).connectionIds,
    ).toEqual([connected.connectionId]);
    await expect(f.a.authorization(connected.connectionId, context())).rejects.toBeInstanceOf(
      NativeActionError,
    );
    expect((await f.a.authorization(next.connectionId, context())).grant.id).toBe(
      newConnection.oauthGrantId,
    );
  });

  it("newly reauthorized grant remains usable when an older grant's in-flight refresh fails", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const refreshStarted = deferred();
    const finishRefresh = deferred();
    f.control.refresh = async () => {
      refreshStarted.resolve();
      await finishRefresh.promise;
      throw new NativeActionError("authorization_expired", "Synthetic old grant rejected");
    };
    const stale = f.a.authorization(connected.connectionId, context(), true);
    const rejected = expect(stale).rejects.toBeInstanceOf(NativeActionError);
    await refreshStarted.promise;
    await f.b.disconnect(connected.connectionId, context());
    const next = await f.begin(f.b, connected.connectionId);
    try {
      await f.b.callback(
        { state: next.state, code: "other-synthetic-identity" },
        context().signal,
        context().userId,
      );
    } finally {
      finishRefresh.resolve();
    }
    await rejected;
    const current = await f.b.authorization(next.connectionId, context());
    expect(current.connection.status).toBe("connected");
    expect(current.grant.revokedAt).toBeNull();
    expect(current.grant.subject).toBe("synthetic-other-subject");
    expect(current.grant.id).not.toBe(connected.grant.id);
  }, 15_000);

  it("configuration/status/account records contain no plaintext client secret, token, code or verifier", async () => {
    const f = await fixture();
    const started = await f.begin();
    const pending = await first.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: started.connectionId },
      include: { secret: true },
    });
    expect(pending.secret?.ciphertext).toBeTruthy();
    const callbackResult = await f.a.callback(
      { state: started.state, code: "synthetic-code-never-persist" },
      context().signal,
      context().userId,
    );
    const connection = await first.prisma.connection.findUniqueOrThrow({
      where: { id: started.connectionId },
    });
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connection.oauthGrantId! },
    });
    const tokenSecret = await first.prisma.secret.findUniqueOrThrow({
      where: { id: grant.secretId! },
    });
    const config = await first.prisma.nativeAppConfig.findUniqueOrThrow({
      where: { id: f.config.id },
    });
    for (const value of [
      started.authorizationUrl,
      pending,
      callbackResult,
      connection,
      grant,
      tokenSecret,
      config,
      await f.configsA.statuses(),
    ]) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(TOKEN_MARKER);
      expect(serialized).not.toContain("synthetic-code-never-persist");
      expect(serialized).not.toMatch(/"verifier"\s*:/);
    }
    expect(await first.prisma.secret.findUnique({ where: { id: pending.secretId! } })).toBeNull();
    const another = await f.begin();
    f.control.exchange = async () => {
      throw new Error(`Synthetic transport error ${CLIENT_SECRET} ${TOKEN_MARKER}`);
    };
    try {
      await f.a.callback(
        { state: another.state, code: "synthetic-rejected-code" },
        context().signal,
        context().userId,
      );
      throw new Error("Expected callback rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(NativeActionError);
      expect(String(error)).not.toContain(CLIENT_SECRET);
      expect(String(error)).not.toContain(TOKEN_MARKER);
    }
  });

  it("configuration SecretStore.load failure makes zero refresh calls and leaves the live grant and lease unchanged", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const config = await first.prisma.nativeAppConfig.findUniqueOrThrow({
      where: { id: f.config.id },
    });
    const before = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    let failedLoads = 0;
    const unavailableConfigSecret = secretsWith(f.secretsA, {
      load: async (ref, secretContext) => {
        const recordId = typeof secretContext === "string" ? secretContext : secretContext.recordId;
        if (recordId === config.secretRecordId) {
          failedLoads++;
          throw new Error("Synthetic configuration vault unavailable");
        }
        return f.secretsA.load(ref, secretContext);
      },
    });
    await expect(
      f.makeFirst(unavailableConfigSecret).authorization(connected.connectionId, context(), true),
    ).rejects.toThrow("Synthetic configuration vault unavailable");
    expect(failedLoads).toBe(1);
    expect(f.control.refreshes).toBe(0);
    expect(
      await first.prisma.nativeOAuthGrant.findUniqueOrThrow({ where: { id: before.id } }),
    ).toMatchObject({
      authGeneration: before.authGeneration,
      tokenVersion: before.tokenVersion,
      secretId: before.secretId,
      revokedAt: before.revokedAt,
      refreshLeaseId: before.refreshLeaseId,
      refreshLeaseUntil: before.refreshLeaseUntil,
    });
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("connected");
    // Repairing deployment secret access can refresh the same still-working grant.
    await f.b.authorization(connected.connectionId, context(), true);
    expect(f.control.refreshes).toBe(1);
  });

  it("SecretStore.put failure after the provider rotates stops the old pair permanently rather than only holding its lease", async () => {
    const f = await fixture();
    const connected = await f.connected();
    let attemptedSecretId: string | undefined;
    const failingPut = secretsWith(f.secretsA, {
      put: async (_plaintext, _context, options) => {
        attemptedSecretId = options?.recordId;
        throw new Error("Synthetic vault rejected the new pair");
      },
    });
    await expect(
      f.makeFirst(failingPut).authorization(connected.connectionId, context(), true),
    ).rejects.toThrow("Synthetic vault rejected the new pair");
    expect(f.control.refreshes).toBe(1);
    const stopped = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(stopped.revokedAt).not.toBeNull();
    expect(stopped.secretId).toBeNull();
    expect(stopped.refreshLeaseId).toBeNull();
    expect(stopped.refreshLeaseUntil).toBeNull();
    expect(stopped.tokenVersion).toBe(connected.grant.tokenVersion);
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("error");
    expect(
      await first.prisma.secret.findUnique({ where: { id: connected.grant.secretId! } }),
    ).toBeNull();
    expect(attemptedSecretId).toBeTruthy();
    expect(await first.prisma.secret.findUnique({ where: { id: attemptedSecretId! } })).toBeNull();
    // A lease expiry cannot make a revoked grant eligible, even with a healthy vault in another process.
    const resetLease = await second.prisma.nativeOAuthGrant.updateMany({
      where: { id: stopped.id, revokedAt: null },
      data: { refreshLeaseUntil: new Date(0) },
    });
    expect(resetLease.count).toBe(0);
    await expect(f.b.authorization(connected.connectionId, context(), true)).rejects.toBeInstanceOf(
      NativeActionError,
    );
    expect(f.control.refreshes).toBe(1);
  });

  it("disconnect first, while the new pair is prepared, cleans the rejected R2 and cannot adopt it later", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const prepared = deferred();
    const releasePrepared = deferred();
    let material: { id: string; ref: string } | undefined;
    const deleted = new Set<string>();
    const tracked = secretsWith(f.secretsA, {
      put: async (...args) => {
        const stored = await f.secretsA.put(...args);
        material = stored;
        prepared.resolve();
        await releasePrepared.promise;
        return stored;
      },
      delete: async (ref, secretContext) => {
        deleted.add(ref);
        await f.secretsA.delete(ref, secretContext);
      },
    });
    const a = f.makeFirst(tracked, withSecretPersistence(first.prisma, tracked));
    const b = new NativeOAuthStore(
      withSecretPersistence(second.prisma, tracked),
      tracked,
      f.configsB,
      f.authority(),
    );
    const refresh = a.authorization(connected.connectionId, context(), true);
    const rejected = expect(refresh).rejects.toBeInstanceOf(NativeActionError);
    await prepared.promise;
    try {
      await b.disconnect(connected.connectionId, context());
    } finally {
      releasePrepared.resolve();
    }
    await rejected;
    expect(material).toBeTruthy();
    expect(deleted.has(material!.ref)).toBe(true);
    expect(await first.prisma.secret.findUnique({ where: { id: material!.id } })).toBeNull();
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(grant.secretId).toBeNull();
    expect(grant.revokedAt).not.toBeNull();
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("revoked");
  }, 15_000);

  it("refresh first holds the connection lock; a waiting disconnect removes the committed R2, not a stale R1 snapshot", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const rotatedInTransaction = deferred();
    const allowRefreshCommit = deferred();
    const disconnectLockAttempted = deferred();
    let material: { id: string; ref: string } | undefined;
    const deleted = new Set<string>();
    const tracked = secretsWith(f.secretsA, {
      put: async (...args) => {
        const stored = await f.secretsA.put(...args);
        material = stored;
        return stored;
      },
      delete: async (ref, secretContext) => {
        deleted.add(ref);
        await f.secretsA.delete(ref, secretContext);
      },
    });
    const observedRefresh = first.prisma.$extends({
      query: {
        nativeOAuthGrant: {
          async updateMany({ args, query }) {
            const result = await query(args);
            const version = args.data.tokenVersion;
            if (
              typeof version === "object" &&
              version &&
              version.increment === 1 &&
              result.count === 1
            ) {
              rotatedInTransaction.resolve();
              await allowRefreshCommit.promise;
            }
            return result;
          },
        },
      },
    });
    const observedDisconnect = second.prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // This is the actual row-lock SQL; do not replace it with a mocked result.
          disconnectLockAttempted.resolve();
          return query(args);
        },
      },
    });
    const a = f.makeFirst(
      tracked,
      withSecretPersistence(observedRefresh as unknown as PrismaClient, tracked),
    );
    const b = new NativeOAuthStore(
      withSecretPersistence(observedDisconnect as unknown as PrismaClient, tracked),
      tracked,
      f.configsB,
      f.authority(),
    );
    const refresh = a.authorization(connected.connectionId, context(), true);
    const observedResult = refresh.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await rotatedInTransaction.promise;
    const stop = b.disconnect(connected.connectionId, context());
    try {
      await disconnectLockAttempted.promise;
    } finally {
      allowRefreshCommit.resolve();
    }
    await stop;
    const outcome = await observedResult;
    if (outcome.error) expect(outcome.error).toBeInstanceOf(NativeActionError);
    else expect(outcome.value?.auth.tokens.accessToken).toBe(`${TOKEN_MARKER}-access-2`);
    expect(material).toBeTruthy();
    expect(deleted.has(material!.ref)).toBe(true);
    expect(await first.prisma.secret.findUnique({ where: { id: material!.id } })).toBeNull();
    const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
      where: { id: connected.grant.id },
    });
    expect(grant.tokenVersion).toBe(connected.grant.tokenVersion + 1);
    expect(grant.secretId).toBeNull();
    expect(grant.revokedAt).not.toBeNull();
    expect(
      (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
        .status,
    ).toBe("revoked");
  }, 15_000);

  it("a successful token rotation followed by identity GET 503 retires the old pair and is never refreshed again", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const calls: Array<{ url: string; method: string }> = [];
    const authority = new NativeOAuthAuthorities({
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url === "https://oauth2.googleapis.com/token") {
          expect((init!.body as URLSearchParams).get("refresh_token")).toBe(
            `${TOKEN_MARKER}-refresh-1`,
          );
          return new Response(
            JSON.stringify({
              access_token: `${TOKEN_MARKER}-access-2`,
              refresh_token: `${TOKEN_MARKER}-refresh-2`,
              token_type: "bearer",
              expires_in: 3600,
              scope: SCOPES.join(" "),
            }),
          );
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${TOKEN_MARKER}-access-2`,
          );
          return new Response(
            JSON.stringify({
              error: "synthetic_service_unavailable",
              private_details: TOKEN_MARKER,
            }),
            { status: 503 },
          );
        }
        throw new Error("Unexpected fixture OAuth URL");
      },
    });
    try {
      await expect(
        f
          .makeFirst(f.secretsA, first.prisma, authority)
          .authorization(connected.connectionId, context(), true),
      ).rejects.toMatchObject({ kind: "temporarily_unavailable", options: { uncertain: true } });
      const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: connected.grant.id },
      });
      expect(grant.revokedAt).not.toBeNull();
      expect(grant.secretId).toBeNull();
      expect(grant.refreshLeaseId).toBeNull();
      expect(grant.refreshLeaseUntil).toBeNull();
      expect(
        (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
          .status,
      ).toBe("error");
      await expect(
        f.b.authorization(connected.connectionId, context(), true),
      ).rejects.toBeInstanceOf(NativeActionError);
      expect(calls).toEqual([
        { url: "https://oauth2.googleapis.com/token", method: "POST" },
        { url: "https://openidconnect.googleapis.com/v1/userinfo", method: "GET" },
      ]);
      expect(f.control.refreshes).toBe(0);
    } finally {
      await authority.close();
    }
  });

  it("invalid_client on HTTP 401 is a deployment-config error, preserving the still-valid account and releasing its lease", async () => {
    const f = await fixture();
    const connected = await f.connected();
    let calls = 0;
    const authority = new NativeOAuthAuthorities({
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: "invalid_client", error_description: CLIENT_SECRET }),
          { status: 401 },
        );
      },
    });
    try {
      await expect(
        f
          .makeFirst(f.secretsA, first.prisma, authority)
          .authorization(connected.connectionId, context(), true),
      ).rejects.toMatchObject({ kind: "not_configured" });
      const grant = await first.prisma.nativeOAuthGrant.findUniqueOrThrow({
        where: { id: connected.grant.id },
      });
      expect(grant.revokedAt).toBeNull();
      expect(grant.secretId).toBe(connected.grant.secretId);
      expect(grant.tokenVersion).toBe(connected.grant.tokenVersion);
      expect(grant.refreshLeaseId).toBeNull();
      expect(grant.refreshLeaseUntil).toBeNull();
      expect(
        (await first.prisma.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))
          .status,
      ).toBe("connected");
      expect(calls).toBe(1);
    } finally {
      await authority.close();
    }
  });

  it("no-op and label-only config saves preserve revision, ciphertext and existing pending/live authorizations", async () => {
    const f = await fixture();
    const connected = await f.connected();
    const pending = await f.begin();
    const before = await first.prisma.nativeAppConfig.findUniqueOrThrow({
      where: { id: f.config.id },
    });
    for (const label of [before.label, "Renamed synthetic source"]) {
      const saved = await f.configsA.save(
        NativeConfigInputSchema.parse({
          id: before.id,
          expectedRevision: before.revision,
          appId: "google-calendar",
          ownership: "byo",
          credentialKind: "oauth",
          label,
          clientId: "synthetic-client-id",
          scopes: [...SCOPES].reverse(),
        }),
        context(),
        true,
      );
      expect(saved.revision).toBe(before.revision);
      expect(saved.label).toBe(label);
      const current = await first.prisma.nativeAppConfig.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(current.ciphertext).toBe(before.ciphertext);
      expect(current.secretRecordId).toBe(before.secretRecordId);
      expect((await f.b.authorization(connected.connectionId, context())).grant.id).toBe(
        connected.grant.id,
      );
    }
    await expect(
      f.b.callback(
        { state: pending.state, code: "synthetic-code" },
        context().signal,
        context().userId,
      ),
    ).resolves.toEqual({ connectionId: pending.connectionId });
    expect(f.control.refreshes).toBe(0);
  });
});
