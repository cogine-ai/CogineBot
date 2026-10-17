import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type {
  Connection,
  NativeAppConfig,
  NativeOAuthGrant,
  Prisma,
  PrismaClient,
} from "@rakazo/db";
import { asRecord } from "../connector-http.js";
import { actorMayUsePrivateEndpoint } from "../private-endpoint.js";
import { persistPreparedSecret } from "../secret-persistence.js";
import { NativeActionError } from "./action.js";
import type {
  NativeAuthorization,
  NativeIdentity,
  NativeOAuthAuthorities,
  NativeTokenMaterial,
} from "./authorities.js";
import { NativeConfigSettingsSchema, type NativeConfigStore } from "./config.js";
import type { NativeMcpPending } from "./mcp.js";

const TTL = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = (context: Pick<AdapterContext, "userId" | "spaceId">) => ({
  userId: context.userId,
  spaceId: context.spaceId,
});
const unavailable = () =>
  new NativeActionError(
    "authorization_required",
    "This authorization attempt is no longer available. Start a new connection.",
  );
type Material = { id: string; ciphertext: string };

/** SaaS account lifecycle. OAuth app configuration and user grant lifetimes differ. */
export class NativeOAuthStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly configs: NativeConfigStore,
    private readonly authorities: NativeOAuthAuthorities,
    private readonly allowPrivateEndpoint = false,
  ) {}

  async begin(
    configId: string,
    context: AdapterContext,
    previousConnectionId?: string,
  ): Promise<{ connectionId: string; authorizationUrl: string }> {
    const config = await this.configs.require(configId);
    if (!["oauth", "mcp_oauth"].includes(config.credentialKind))
      throw new NativeActionError("invalid_input", "Choose an OAuth connection source.");
    await this.member(this.prisma, context);
    await this.expireSessions(context);
    if (
      (await this.prisma.nativeOAuthSession.count({
        where: {
          ...scope(context),
          consumedAt: null,
          cancelledAt: null,
          expiresAt: { gt: new Date() },
        },
      })) >= 100
    )
      throw new NativeActionError(
        "rate_limited",
        "Too many authorization attempts are waiting. Finish or cancel an existing attempt first.",
      );
    if (previousConnectionId) {
      const previous = await this.prisma.connection.findFirst({
        where: {
          id: previousConnectionId,
          ...scope(context),
          connectorId: "native",
          provider: config.appId,
        },
      });
      if (!previous) throw unavailable();
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const sessionId = randomUUID();
    const connectionId = randomUUID();
    const material = await this.prepare({ verifier, previousConnectionId }, context);
    await persistPreparedSecret(this.prisma, this.secrets, material, () =>
      this.prisma.$transaction(async (tx) => {
        await this.fenceConfig(tx, config);
        await this.member(tx, context, true);
        await tx.secret.create({
          data: { ...material, ...scope(context), kind: "native_session" },
        });
        await tx.connection.create({
          data: {
            id: connectionId,
            ...scope(context),
            connectorId: "native",
            provider: config.appId,
            displayName: config.label,
            status: "pending",
            nativeConfigId: config.id,
            nativeConfigRevision: config.revision,
            metadata: { authRevision: randomUUID() },
          },
        });
        await tx.nativeOAuthSession.create({
          data: {
            id: sessionId,
            stateHash: hash(state),
            ...scope(context),
            connectionId,
            configId: config.id,
            configRevision: config.revision,
            secretId: material.id,
            requestedScopes: NativeConfigSettingsSchema.parse(config.config).scopes,
            expiresAt: new Date(Date.now() + TTL),
          },
        });
      }),
    );
    const launch = new URL("/api/connectors/oauth/start", this.configs.callbackUri);
    launch.searchParams.set("state", state);
    return { connectionId, authorizationUrl: launch.toString() };
  }

  /** The browser must belong to the same signed-in user before leaving this API. */
  async launch(state: string, actorUserId: string, signal: AbortSignal): Promise<string> {
    if (!actorUserId || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw unavailable();
    const session = await this.prisma.nativeOAuthSession.findFirst({
      where: {
        stateHash: hash(state),
        userId: actorUserId,
        consumedAt: null,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
        connection: { status: "pending" },
      },
      include: { secret: true },
    });
    if (!session?.secret) throw unavailable();
    const config = await this.configs.require(session.configId);
    if (config.revision !== session.configRevision) throw unavailable();
    await this.member(this.prisma, {
      userId: session.userId,
      spaceId: session.spaceId,
    });
    const value = asRecord(
      JSON.parse(
        await this.secrets.load(session.secret.ciphertext, {
          recordId: session.secret.id,
          signal,
        }),
      ),
    );
    if (typeof value?.verifier !== "string") throw unavailable();
    if (config.credentialKind === "mcp_oauth") {
      if (value.mcp)
        return this.authorities.mcp.pendingUrl(config, this.mcpPending(value.mcp), state);
      // Discovery/DCR is outside the transaction. Only a DB-fenced winner may
      // publish an authorization URL; its matching verifier/client is encrypted
      // before the browser is redirected. Duplicate DCR creates no user grant.
      const pending = await this.authorities.mcp.begin(
        config,
        state,
        signal,
        await this.privateEndpoint(session.userId),
      );
      const material = await this.prepare(
        { ...value, mcp: pending },
        {
          userId: session.userId,
          spaceId: session.spaceId,
          operationId: "native.mcp.launch",
          traceId: session.id,
          signal,
        },
      );
      const committed = await persistPreparedSecret(this.prisma, this.secrets, material, () =>
        this.prisma.$transaction(async (tx) => {
          await this.fenceConfig(tx, config);
          await this.member(tx, session, true);
          await this.lockConnections(tx, [session.connectionId], session);
          await tx.$queryRaw`SELECT id FROM native_oauth_sessions WHERE id = ${session.id} FOR UPDATE`;
          const current = await tx.nativeOAuthSession.findFirst({
            where: {
              id: session.id,
              userId: actorUserId,
              consumedAt: null,
              cancelledAt: null,
              expiresAt: { gt: new Date() },
              secretId: session.secret!.id,
              connection: { status: "pending" },
            },
          });
          if (!current) return false;
          await tx.secret.create({
            data: { ...material, ...scope(session), kind: "native_session" },
          });
          await tx.nativeOAuthSession.update({
            where: { id: session.id },
            data: { secretId: material.id },
          });
          await tx.secret.deleteMany({
            where: {
              id: session.secret!.id,
              ...scope(session),
              kind: "native_session",
            },
          });
          return true;
        }),
      );
      if (!committed) return this.launch(state, actorUserId, signal);
      return pending.authorizationUrl;
    }
    return this.authorities.authorizationUrl(config, state, value.verifier);
  }

  /** Bind the one-use state to its initiating browser user; never trust a request origin. */
  async callback(
    input: { state: string; code?: string; denied?: boolean },
    signal: AbortSignal,
    actorUserId: string,
  ): Promise<{ connectionId: string }> {
    if (!actorUserId || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) throw unavailable();
    const session = await this.prisma.nativeOAuthSession.findUnique({
      where: { stateHash: hash(input.state) },
      include: { secret: true },
    });
    if (!session?.secret || session.userId !== actorUserId) throw unavailable();
    const context: AdapterContext = {
      userId: session.userId,
      spaceId: session.spaceId,
      operationId: "native.oauth.callback",
      traceId: session.id,
      signal,
    };
    const claimed = await this.prisma.nativeOAuthSession.updateMany({
      where: {
        id: session.id,
        consumedAt: null,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
        connection: {
          status: "pending",
          userId: session.userId,
          spaceId: session.spaceId,
        },
        config: {
          enabled: true,
          revision: session.configRevision,
          callbackUri: this.configs.callbackUri,
        },
      },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw unavailable();
    try {
      if (input.denied || !input.code) throw unavailable();
      const config = await this.configs.require(session.configId);
      if (config.revision !== session.configRevision) throw unavailable();
      await this.member(this.prisma, context);
      const pending = asRecord(
        JSON.parse(
          await this.secrets.load(session.secret.ciphertext, {
            recordId: session.secret.id,
          }),
        ),
      );
      if (typeof pending?.verifier !== "string") throw unavailable();
      const auth = await this.authorities.exchange(
        config,
        await this.clientSecret(config),
        input.code,
        pending.verifier,
        signal,
        pending.mcp ? this.mcpPending(pending.mcp) : undefined,
        input.state,
        await this.privateEndpoint(context.userId),
      );
      await this.adopt(
        config,
        session.connectionId,
        auth,
        context,
        session.id,
        typeof pending.previousConnectionId === "string" ? pending.previousConnectionId : undefined,
      );
      return { connectionId: session.connectionId };
    } catch (error) {
      await this.prisma.connection.updateMany({
        where: {
          id: session.connectionId,
          ...scope(context),
          status: "pending",
        },
        data: { status: "error" },
      });
      throw error instanceof NativeActionError ? error : unavailable();
    } finally {
      await this.prisma.secret.deleteMany({
        where: {
          id: session.secret.id,
          ...scope(context),
          kind: "native_session",
        },
      });
    }
  }

  async connectNotionToken(
    configId: string,
    credential: string,
    context: AdapterContext,
    previousConnectionId?: string,
  ): Promise<{ connectionId: string }> {
    const config = await this.configs.require(configId);
    if (
      config.appId !== "notion" ||
      (config.credentialKind !== "internal_token" && config.credentialKind !== "personal_token")
    )
      throw new NativeActionError("invalid_input", "Choose a Notion token connection source.");
    await this.member(this.prisma, context);
    const identity = await this.authorities.verifyNotionToken(
      credential,
      config.credentialKind,
      context.signal,
    );
    return this.connectStatic(config, credential, identity, context, previousConnectionId);
  }

  async connectKnowaiMachine(
    config: NativeAppConfig,
    credential: string,
    identity: NativeIdentity,
    context: AdapterContext,
    previousConnectionId?: string,
  ): Promise<{ connectionId: string }> {
    if (
      config.appId !== "knowai" ||
      config.credentialKind !== "machine_key" ||
      identity.tenant !== NativeConfigSettingsSchema.parse(config.config).tenantId
    )
      throw new NativeActionError(
        "invalid_input",
        "A tenant-bound Knowai machine connection is required.",
      );
    await this.member(this.prisma, context);
    return this.connectStatic(config, credential, identity, context, previousConnectionId);
  }

  private async connectStatic(
    config: NativeAppConfig,
    credential: string,
    identity: NativeIdentity,
    context: AdapterContext,
    previousConnectionId?: string,
  ): Promise<{ connectionId: string }> {
    const connectionId = randomUUID();
    // No intermediate browser state or token is sent back to the client.
    await this.prisma.$transaction(async (tx) => {
      await this.fenceConfig(tx, config);
      await this.member(tx, context, true);
      await tx.connection.create({
        data: {
          id: connectionId,
          ...scope(context),
          connectorId: "native",
          provider: config.appId,
          displayName: identity.displayName,
          status: "pending",
          nativeConfigId: config.id,
          nativeConfigRevision: config.revision,
          metadata: { authRevision: randomUUID() },
        },
      });
    });
    try {
      await this.adopt(
        config,
        connectionId,
        {
          identity,
          tokens: { accessToken: credential, refreshToken: null },
          scopes: [],
          expiresAt: null,
        },
        context,
        undefined,
        previousConnectionId,
      );
      return { connectionId };
    } catch (error) {
      await this.prisma.connection.updateMany({
        where: { id: connectionId, ...scope(context), status: "pending" },
        data: { status: "error" },
      });
      throw error;
    }
  }

  /** Exact owner+Space+connection fence is checked on every outgoing request. */
  async authorization(
    connectionId: string,
    context: AdapterContext,
    forceRefresh = false,
  ): Promise<{
    connection: Connection;
    config: NativeAppConfig;
    grant: NativeOAuthGrant;
    auth: NativeAuthorization;
  }> {
    const deadline = Date.now() + 12_000;
    let refreshVersion: number | undefined;
    while (true) {
      context.signal.throwIfAborted();
      const { connection, config, grant } = await this.bound(connectionId, context);
      refreshVersion ??= grant.tokenVersion;
      if (grant.tokenVersion > refreshVersion) forceRefresh = false;
      if (
        grant.refreshLeaseId &&
        (!grant.refreshLeaseUntil || grant.refreshLeaseUntil.getTime() <= Date.now())
      ) {
        // An expired lease may have issued a successor token before its worker
        // stopped. Retrying the old rotating token can revoke the whole family.
        // Exact lease/version CAS cannot retire a pair already committed by the winner.
        await this.failGrant(connection, grant, grant.refreshLeaseId);
        continue;
      }
      const auth = await this.readGrant(grant);
      if (
        !forceRefresh &&
        (!grant.accessExpiresAt || grant.accessExpiresAt.getTime() > Date.now() + 60_000)
      )
        return { connection, config, grant, auth };
      if (!auth.tokens.refreshToken) {
        await this.failGrant(connection, grant);
        throw new NativeActionError(
          "authorization_expired",
          "This account requires a new authorization.",
        );
      }
      // Failures reading deployment material happen before any refresh request;
      // they must not retire a working user grant or occupy its refresh lease.
      const clientSecret = await this.clientSecret(config);
      const leaseId = randomUUID();
      const claimed = await this.prisma.nativeOAuthGrant.updateMany({
        where: {
          id: grant.id,
          tokenVersion: grant.tokenVersion,
          authGeneration: grant.authGeneration,
          revokedAt: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          connections: {
            some: { id: connectionId, status: "connected", ...scope(context) },
          },
        },
        data: {
          refreshLeaseId: leaseId,
          refreshLeaseUntil: new Date(Date.now() + 60_000),
        },
      });
      if (!claimed.count) {
        if (Date.now() >= deadline)
          throw new NativeActionError(
            "temporarily_unavailable",
            "Another process is renewing this authorization. Try the read again shortly.",
          );
        await delay(75, undefined, { signal: context.signal });
        // A winner's tokenVersion advance satisfies this 401 refresh request too.
        const current = await this.prisma.nativeOAuthGrant.findUnique({
          where: { id: grant.id },
        });
        if (current && current.tokenVersion > grant.tokenVersion) forceRefresh = false;
        continue;
      }
      let next: NativeAuthorization;
      try {
        next = await this.authorities.refresh(
          config,
          clientSecret,
          auth,
          context.signal,
          await this.privateEndpoint(context.userId),
        );
      } catch (error) {
        // A lost rotating-token response cannot safely be retried with the old
        // refresh token. A stale loser cannot retire the winner's newer pair.
        if (
          error instanceof NativeActionError &&
          (error.kind === "authorization_expired" || error.options.uncertain)
        )
          await this.failGrant(connection, grant, leaseId);
        else
          await this.prisma.nativeOAuthGrant.updateMany({
            where: {
              id: grant.id,
              tokenVersion: grant.tokenVersion,
              refreshLeaseId: leaseId,
              revokedAt: null,
            },
            data: { refreshLeaseId: null, refreshLeaseUntil: null },
          });
        throw error;
      }
      try {
        const material = await this.prepare(next.tokens, context);
        await persistPreparedSecret(this.prisma, this.secrets, material, () =>
          this.prisma.$transaction(async (tx) => {
            await this.fenceConfig(tx, config);
            await this.member(tx, context, true);
            await this.lockConnections(tx, [connectionId], context);
            const live = await tx.connection.findFirst({
              where: {
                id: connectionId,
                ...scope(context),
                status: "connected",
                oauthGrantId: grant.id,
              },
            });
            if (!live) throw unavailable();
            await tx.secret.create({
              data: { ...material, ...scope(context), kind: "native_grant" },
            });
            const saved = await tx.nativeOAuthGrant.updateMany({
              where: {
                id: grant.id,
                revokedAt: null,
                refreshLeaseId: leaseId,
                tokenVersion: grant.tokenVersion,
                authGeneration: grant.authGeneration,
              },
              data: {
                secretId: material.id,
                scopes: next.scopes,
                accessExpiresAt: next.expiresAt,
                tokenVersion: { increment: 1 },
                refreshLeaseId: null,
                refreshLeaseUntil: null,
              },
            });
            if (!saved.count) throw unavailable();
            if (grant.secretId)
              await tx.secret.deleteMany({
                where: { id: grant.secretId, ...scope(context) },
              });
          }),
        );
      } catch (error) {
        await this.failGrant(connection, grant, leaseId);
        throw error;
      }
      forceRefresh = false;
    }
  }

  /** Local stop is authoritative and precedes any optional upstream revocation. */
  async expireSessions(context: AdapterContext): Promise<void> {
    const expired = await this.prisma.nativeOAuthSession.findMany({
      where: {
        ...scope(context),
        expiresAt: { lte: new Date() },
        secretId: { not: null },
      },
      select: { id: true, connectionId: true },
      take: 100,
    });
    if (!expired.length) return;
    await this.prisma.$transaction(async (tx) => {
      await this.lockConnections(
        tx,
        expired.map((session) => session.connectionId),
        context,
      );
      const current = await tx.nativeOAuthSession.findMany({
        where: {
          id: { in: expired.map((session) => session.id) },
          ...scope(context),
          expiresAt: { lte: new Date() },
          secretId: { not: null },
        },
      });
      await tx.connection.updateMany({
        where: {
          id: { in: current.map((session) => session.connectionId) },
          ...scope(context),
          connectorId: "native",
          status: "pending",
        },
        data: { status: "error" },
      });
      await tx.nativeOAuthSession.updateMany({
        where: {
          id: { in: current.map((session) => session.id) },
          ...scope(context),
        },
        data: { cancelledAt: new Date(), secretId: null },
      });
      await tx.secret.deleteMany({
        where: {
          id: {
            in: current.flatMap((session) => (session.secretId ? [session.secretId] : [])),
          },
          ...scope(context),
          kind: "native_session",
        },
      });
    });
  }

  /** Local stop is authoritative and precedes any optional upstream revocation. */
  async disconnect(connectionId: string, context: AdapterContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockConnections(tx, [connectionId], context);
      const connection = await tx.connection.findFirst({
        where: { id: connectionId, ...scope(context), connectorId: "native" },
      });
      if (!connection) throw unavailable();
      const sessions = await tx.nativeOAuthSession.findMany({
        where: { connectionId, ...scope(context) },
        select: { secretId: true },
      });
      const grant = connection.oauthGrantId
        ? await tx.nativeOAuthGrant.findUnique({
            where: { id: connection.oauthGrantId },
          })
        : null;
      await tx.nativeOAuthSession.updateMany({
        where: { connectionId, ...scope(context) },
        data: { cancelledAt: new Date() },
      });
      await tx.connection.updateMany({
        where: { id: connectionId, ...scope(context) },
        data: { status: "revoked" },
      });
      if (grant)
        await tx.nativeOAuthGrant.updateMany({
          where: { id: grant.id, ...scope(context) },
          data: {
            revokedAt: new Date(),
            secretId: null,
            authGeneration: { increment: 1 },
            refreshLeaseId: null,
            refreshLeaseUntil: null,
          },
        });
      await tx.secret.deleteMany({
        where: {
          id: {
            in: [...sessions.map((session) => session.secretId), grant?.secretId].filter(
              (id): id is string => Boolean(id),
            ),
          },
          ...scope(context),
        },
      });
    });
  }

  private async adopt(
    config: NativeAppConfig,
    connectionId: string,
    auth: NativeAuthorization,
    context: AdapterContext,
    sessionId?: string,
    previousConnectionId?: string,
  ): Promise<void> {
    const material = await this.prepare(auth.tokens, context);
    await persistPreparedSecret(this.prisma, this.secrets, material, () =>
      this.prisma.$transaction(async (tx) => {
        await this.fenceConfig(tx, config);
        await this.member(tx, context, true);
        await this.lockConnections(
          tx,
          [connectionId, ...(previousConnectionId ? [previousConnectionId] : [])],
          context,
        );
        if (sessionId) {
          const session = await tx.nativeOAuthSession.findFirst({
            where: {
              id: sessionId,
              ...scope(context),
              cancelledAt: null,
              consumedAt: { not: null },
              expiresAt: { gt: new Date() },
              configRevision: config.revision,
            },
          });
          if (!session) throw unavailable();
        }
        await tx.secret.create({
          data: { ...material, ...scope(context), kind: "native_grant" },
        });
        const grant = await tx.nativeOAuthGrant.create({
          data: {
            id: randomUUID(),
            ...scope(context),
            configId: config.id,
            configRevision: config.revision,
            authority: auth.identity.authority,
            subject: auth.identity.subject,
            tenant: auth.identity.tenant,
            principal: auth.identity.context as Prisma.InputJsonObject,
            scopes: auth.scopes,
            secretId: material.id,
            accessExpiresAt: auth.expiresAt,
          },
        });
        const changed = await tx.connection.updateMany({
          where: {
            id: connectionId,
            ...scope(context),
            connectorId: "native",
            status: "pending",
            nativeConfigId: config.id,
            nativeConfigRevision: config.revision,
          },
          data: {
            status: "connected",
            oauthGrantId: grant.id,
            providerRef: grant.id,
            displayName: auth.identity.displayName,
            metadata: {
              authRevision: `${grant.id}:${grant.authGeneration}`,
              credentialKind: config.credentialKind,
            },
          },
        });
        if (!changed.count) throw unavailable();
        // Reauthorization always creates a new connection/grant. Old tasks retain
        // the revoked old ID; no task/approval is silently rebound to the new one.
        if (previousConnectionId) {
          const previous = await tx.connection.findFirst({
            where: {
              id: previousConnectionId,
              ...scope(context),
              connectorId: "native",
              provider: config.appId,
            },
          });
          if (!previous) throw unavailable();
          await tx.connection.updateMany({
            where: { id: previous.id, ...scope(context) },
            data: { status: "revoked" },
          });
          if (previous.oauthGrantId) {
            const old = await tx.nativeOAuthGrant.findUnique({
              where: { id: previous.oauthGrantId },
            });
            if (old) {
              await tx.nativeOAuthGrant.updateMany({
                where: { id: old.id, ...scope(context) },
                data: { revokedAt: new Date(), secretId: null },
              });
              if (old.secretId)
                await tx.secret.deleteMany({
                  where: { id: old.secretId, ...scope(context) },
                });
            }
          }
        }
      }),
    );
  }

  private async bound(
    connectionId: string,
    context: AdapterContext,
  ): Promise<{
    connection: Connection;
    grant: NativeOAuthGrant;
    config: NativeAppConfig;
  }> {
    await this.member(this.prisma, context);
    const connection = await this.prisma.connection.findFirst({
      where: {
        id: connectionId,
        ...scope(context),
        connectorId: "native",
        status: "connected",
      },
      include: { oauthGrant: true },
    });
    const grant = connection?.oauthGrant;
    if (!connection || !grant || grant.revokedAt || !grant.secretId) throw unavailable();
    if (grant.userId !== context.userId || grant.spaceId !== context.spaceId) throw unavailable();
    const config = await this.configs.require(grant.configId);
    if (
      config.revision !== grant.configRevision ||
      connection.nativeConfigRevision !== config.revision
    )
      throw new NativeActionError(
        "not_configured",
        "The application configuration changed. Reauthorize this account using the current configuration.",
      );
    return { connection, grant, config };
  }
  private async failGrant(
    connection: Connection,
    grant: NativeOAuthGrant,
    leaseId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockConnections(tx, [connection.id], grant);
      const current = await tx.nativeOAuthGrant.findUnique({
        where: { id: grant.id },
      });
      const changed = await tx.nativeOAuthGrant.updateMany({
        where: {
          id: grant.id,
          tokenVersion: grant.tokenVersion,
          revokedAt: null,
          ...(leaseId ? { refreshLeaseId: leaseId } : {}),
        },
        data: {
          revokedAt: new Date(),
          secretId: null,
          refreshLeaseId: null,
          refreshLeaseUntil: null,
        },
      });
      if (changed.count) {
        await tx.connection.updateMany({
          where: {
            id: connection.id,
            oauthGrantId: grant.id,
            status: "connected",
            userId: grant.userId,
            spaceId: grant.spaceId,
          },
          data: { status: "error" },
        });
        if (current?.secretId)
          await tx.secret.deleteMany({
            where: {
              id: current.secretId,
              userId: grant.userId,
              spaceId: grant.spaceId,
            },
          });
      }
    });
  }
  private async readGrant(grant: NativeOAuthGrant): Promise<NativeAuthorization> {
    if (!grant.secretId) throw unavailable();
    const secret = await this.prisma.secret.findFirst({
      where: {
        id: grant.secretId,
        userId: grant.userId,
        spaceId: grant.spaceId,
        kind: "native_grant",
      },
    });
    if (!secret) throw unavailable();
    const value = asRecord(
      JSON.parse(await this.secrets.load(secret.ciphertext, { recordId: secret.id })),
    );
    if (
      typeof value?.accessToken !== "string" ||
      (value.refreshToken !== null && typeof value.refreshToken !== "string")
    )
      throw unavailable();
    const identity: NativeIdentity = {
      authority: grant.authority,
      subject: grant.subject,
      tenant: grant.tenant,
      displayName: "",
      context: asRecord(grant.principal) ?? {},
    };
    return {
      tokens: value as unknown as NativeTokenMaterial,
      identity,
      scopes: grant.scopes,
      expiresAt: grant.accessExpiresAt,
    };
  }
  private async privateEndpoint(userId: string): Promise<boolean> {
    return actorMayUsePrivateEndpoint(this.prisma, userId, this.allowPrivateEndpoint);
  }
  private mcpPending(value: unknown): NativeMcpPending {
    const pending = asRecord(value),
      material = asRecord(pending?.material);
    if (!material || typeof pending?.authorizationUrl !== "string") throw unavailable();
    return pending as unknown as NativeMcpPending;
  }
  private async clientSecret(config: NativeAppConfig): Promise<string> {
    if (config.credentialKind === "mcp_oauth") return "";
    if (!config.ciphertext || !config.secretRecordId)
      throw new NativeActionError("not_configured", "This OAuth application has no client secret.");
    return this.secrets.load(config.ciphertext, {
      recordId: config.secretRecordId,
    });
  }
  private async prepare(value: unknown, context: AdapterContext): Promise<Material> {
    const id = randomUUID();
    const stored = await this.secrets.put(JSON.stringify(value), context, {
      recordId: id,
    });
    return { id, ciphertext: stored.ciphertext };
  }
  private async member(
    tx: Prisma.TransactionClient | PrismaClient,
    context: Pick<AdapterContext, "userId" | "spaceId">,
    lock = false,
  ): Promise<void> {
    if (lock)
      await tx.$queryRaw`SELECT id FROM space_members WHERE "spaceId" = ${context.spaceId} AND "userId" = ${context.userId} FOR UPDATE`;
    if (
      !(await tx.spaceMember.findUnique({
        where: { spaceId_userId: scope(context) },
        select: { userId: true },
      }))
    )
      throw unavailable();
  }
  private async lockConnections(
    tx: Prisma.TransactionClient,
    ids: string[],
    context: Pick<AdapterContext, "userId" | "spaceId">,
  ): Promise<void> {
    for (const id of [...new Set(ids)].sort())
      await tx.$queryRaw`SELECT id FROM connections WHERE id = ${id} AND "userId" = ${context.userId} AND "spaceId" = ${context.spaceId} FOR UPDATE`;
  }
  private async fenceConfig(tx: Prisma.TransactionClient, config: NativeAppConfig): Promise<void> {
    await tx.$queryRaw`SELECT id FROM native_app_configs WHERE id = ${config.id} FOR UPDATE`;
    const current = await tx.nativeAppConfig.findFirst({
      where: {
        id: config.id,
        enabled: true,
        revision: config.revision,
        callbackUri: this.configs.callbackUri,
      },
    });
    if (!current) throw unavailable();
  }
}
