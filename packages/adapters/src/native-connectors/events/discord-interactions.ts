import { runContinueJob } from "@rakazo/adapter-kit";
import {
  type NativeDiscordSignalJob,
  NativeDiscordSignalJobSchema,
  type NativeEventScope,
  NativeRoutineEventSpecSchema,
  nativeEventResource,
} from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "@rakazo/db";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import { verifyDiscordInteraction } from "../bot-platforms/interactions.js";
import { NativeConfigSettingsSchema } from "../config.js";
import type { NativeOAuthStore } from "../oauth.js";
import { verifyRemainingEventResource } from "./remaining-resources.js";
import { withRemainingNativeRead } from "./remaining-transport.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
} from "./store.js";
import { pinnedEventAuthorization } from "./transport.js";
import { NativeSourceLeaseLost, nativeSignalJobKey } from "./worker.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const invalid = (): never => {
  throw new NativeActionError(
    "authorization_required",
    "The Discord interaction could not be authenticated.",
  );
};
export type DiscordSignalJob = {
  name: "native.discord.signal";
  payload: NativeDiscordSignalJob;
  replaceKey?: string;
};
interface Publisher {
  enqueue(job: DiscordSignalJob | ReturnType<typeof runContinueJob>): Promise<void>;
}
interface ActiveDiscordGrant {
  connectionId: string;
  userId: string;
  spaceId: string;
  configRevision: number;
  grantId: string;
  authGeneration: number;
  authorizationRevision: string;
  principal: unknown;
  config: unknown;
}
/** Only DB reads and durable existing-queue publication run before Discord's 3-second acknowledgement. */
export async function ingestDiscordRoutine(
  prisma: PrismaClient,
  jobs: Publisher,
  configId: string,
  raw: Uint8Array,
  headers: Headers | Record<string, string>,
): Promise<{ type: 1 } | { type: 4; data: { content: string; flags: 64 } }> {
  if (!configId || configId.length > 1024 || raw.byteLength > 262144) return invalid();
  let applicationId: unknown;
  try {
    applicationId = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    ).application_id;
  } catch {
    return invalid();
  }
  if (typeof applicationId !== "string" || !/^[1-9][0-9]{5,20}$/.test(applicationId))
    return invalid();
  // Candidate application_id selects an already verified grant; it is never the authority itself.
  const authorities = await prisma.$queryRaw<ActiveDiscordGrant[]>(
    Prisma.sql`/*native-event:discord-authority*/ SELECT c.id AS "connectionId",c."userId",c."spaceId",a.revision AS "configRevision",g.id AS "grantId",g."authGeneration",c.metadata->>'authRevision' AS "authorizationRevision",g.principal,a.config FROM native_app_configs a JOIN native_oauth_grants g ON g."configId"=a.id JOIN connections c ON c."oauthGrantId"=g.id WHERE a.id=${configId} AND a."appId"='discord' AND a.enabled=true AND a."credentialKind"='bot_token' AND a.revision=g."configRevision" AND c."nativeConfigId"=a.id AND c."nativeConfigRevision"=a.revision AND c."connectorId"='native' AND c.provider='discord' AND c.status='connected' AND c."userId"=g."userId" AND c."spaceId"=g."spaceId" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND g.principal->>'applicationId'=${applicationId} AND a.config->>'boundSpaceId'=g."spaceId" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=g."userId" AND m."spaceId"=g."spaceId") ORDER BY c.id LIMIT 1`,
  );
  const authority = authorities[0];
  if (!authority) return invalid();
  const principal = object(authority.principal),
    settings = NativeConfigSettingsSchema.parse(authority.config);
  if (
    principal.actorType !== "bot" ||
    principal.credentialType !== "bot_token" ||
    principal.scopeAuthority !== "provider_enforced" ||
    principal.applicationId !== applicationId ||
    typeof principal.interactionPublicKey !== "string" ||
    principal.boundSpaceId !== authority.spaceId ||
    settings.boundSpaceId !== authority.spaceId
  )
    return invalid();
  const interaction = verifyDiscordInteraction(raw, headers, {
    key: principal.interactionPublicKey,
    applicationId,
  });
  if (interaction.kind === "ping") return { type: 1 };
  if (
    interaction.guildId !== settings.tenantId ||
    !settings.targetIds?.includes(interaction.channelId) ||
    !settings.capabilities.includes("commands")
  )
    return invalid();
  const rows = await prisma.$queryRaw<
    Array<ActiveDiscordGrant & { id: string; version: number; spec: unknown }>
  >(
    Prisma.sql`/*native-event:discord-command-targets*/ SELECT t.id,t.version,t.spec,t."connectionId",r."userId",r."spaceId",t."configRevision",t."grantId",t."authGeneration",t."authorizationRevision",g.principal,a.config FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t."configId"=${configId} AND t."configRevision"=${authority.configRevision} AND t.kind='discord.command.invoked' AND t.spec->>'guildId'=${interaction.guildId} AND t.spec->>'channelId'=${interaction.channelId} AND t.spec->>'commandId'=${interaction.commandId} AND t.spec->>'commandName'=${interaction.commandName} AND r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.provider='discord' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=g.id AND c."nativeConfigId"=a.id AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=a.id AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND g.principal->>'applicationId'=${applicationId} AND g.principal->>'interactionPublicKey'=${principal.interactionPublicKey} AND a."appId"='discord' AND a.enabled=true AND a.revision=t."configRevision" AND a.config->>'boundSpaceId'=r."spaceId" AND r."spaceId"=${authority.spaceId} AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") LIMIT 1001`,
  );
  if (rows.length > 1000)
    throw new NativeActionError(
      "temporarily_unavailable",
      "The configured Routine fanout exceeds this bounded delivery.",
    );
  let count = 0;
  for (const row of rows) {
    const current = object(row.principal);
    if (
      row.spaceId !== authority.spaceId ||
      row.configRevision !== authority.configRevision ||
      current.applicationId !== applicationId ||
      current.interactionPublicKey !== principal.interactionPublicKey
    )
      continue;
    const parsed = NativeRoutineEventSpecSchema.safeParse(row.spec);
    if (
      !parsed.success ||
      parsed.data.kind !== "discord.command.invoked" ||
      parsed.data.guildId !== interaction.guildId ||
      parsed.data.channelId !== interaction.channelId ||
      parsed.data.commandId !== interaction.commandId ||
      parsed.data.commandName !== interaction.commandName
    )
      continue;
    const { kind: _kind, ...facts } = interaction;
    const payload = NativeDiscordSignalJobSchema.parse({
      triggerId: row.id,
      triggerVersion: row.version,
      userId: row.userId,
      spaceId: row.spaceId,
      configId,
      configRevision: row.configRevision,
      connectionId: row.connectionId,
      authorizationRevision: row.authorizationRevision,
      grantId: row.grantId,
      authGeneration: row.authGeneration,
      interaction: facts,
    });
    await jobs.enqueue({
      name: "native.discord.signal",
      payload,
      replaceKey: nativeSignalJobKey(row.id, row.version, `${applicationId}:${interaction.id}`),
    });
    count++;
  }
  return count
    ? { type: 4, data: { content: "Routine queued.", flags: 64 } }
    : { type: 4, data: { content: "No Routine is enabled for this command here.", flags: 64 } };
}
export async function processDiscordRoutine(
  prisma: PrismaClient,
  oauth: Pick<NativeOAuthStore, "authorization">,
  jobs: Publisher,
  raw: unknown,
  signal: AbortSignal,
  preparePrompt: (scope: NativeEventScope) => Promise<(prompt: string) => string>,
  onCreated: (runId: string) => Promise<void>,
  network?: RemoteTransportDependencies,
): Promise<void> {
  const payload = NativeDiscordSignalJobSchema.parse(raw),
    scope = { userId: payload.userId, spaceId: payload.spaceId };
  const row = await leaseNativeEventSource(
    prisma,
    scope,
    payload.triggerId,
    payload.triggerVersion,
  );
  if (!row?.leaseId) {
    const busy = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`/*native-event:discord-busy*/ SELECT t.id FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t.id=${payload.triggerId} AND t.version=${payload.triggerVersion} AND r."userId"=${scope.userId} AND r."spaceId"=${scope.spaceId} AND r.active=true AND t."configId"=${payload.configId} AND t."configRevision"=${payload.configRevision} AND t."grantId"=${payload.grantId} AND t."authGeneration"=${payload.authGeneration} AND c.status='connected' AND c."oauthGrantId"=g.id AND c.metadata->>'authRevision'=t."authorizationRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND t."leaseUntil">now()`,
    );
    if (busy.length)
      throw new NativeActionError(
        "temporarily_unavailable",
        "The exact command source is processing another delivery.",
      );
    return;
  }
  let checkpointState = object(row.state);
  const leaseId = row.leaseId,
    spec = NativeRoutineEventSpecSchema.parse(row.spec),
    context = {
      scope,
      row,
      signal,
      heartbeat: async () => {
        if (
          !(await checkpointNativeEventSource(prisma, scope, {
            triggerId: row.id,
            triggerVersion: row.version,
            leaseId,
            state: object(row.state),
            nextPollAt: row.nextPollAt,
            release: false,
          }))
        )
          throw new NativeSourceLeaseLost();
      },
      emit: async () => false,
    };
  try {
    if (
      row.configId !== payload.configId ||
      row.configRevision !== payload.configRevision ||
      row.connectionId !== payload.connectionId ||
      row.authorizationRevision !== payload.authorizationRevision ||
      row.grantId !== payload.grantId ||
      row.authGeneration !== payload.authGeneration ||
      spec.kind !== "discord.command.invoked" ||
      spec.guildId !== payload.interaction.guildId ||
      spec.channelId !== payload.interaction.channelId ||
      spec.commandId !== payload.interaction.commandId ||
      spec.commandName !== payload.interaction.commandName
    )
      return;
    const occurredAt = new Date(
      Number((BigInt(payload.interaction.id) >> 22n) + 1420070400000n),
    ).toISOString();
    if (
      Date.parse(occurredAt) < row.armedAt.getTime() ||
      Date.parse(occurredAt) > Date.now() + 300000
    )
      return;
    const revalidate = pinnedEventAuthorization(oauth, context),
      bound = await revalidate();
    const identity = bound.auth.identity.context;
    if (identity.applicationId !== payload.interaction.applicationId) return;
    await withRemainingNativeRead(
      bound,
      revalidate,
      signal,
      async (api, principal) => verifyRemainingEventResource(spec, api, principal),
      network,
    );
    // Enrollment may race the first ordinary poll. Persist only verified readiness, never an unverified command receipt.
    const ready = { ...object(row.state), ready: true };
    if (
      !(await checkpointNativeEventSource(prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: ready,
        nextPollAt: row.nextPollAt,
        release: false,
      }))
    )
      throw new NativeSourceLeaseLost();
    checkpointState = ready;
    await revalidate();
    const claim = await claimNativeRoutineEvent(
      prisma,
      scope,
      {
        triggerId: row.id,
        triggerVersion: row.version,
        connectionId: row.connectionId,
        authorizationRevision: row.authorizationRevision,
        kind: spec.kind,
        resource: nativeEventResource(spec),
        eventIdentity: `discord:interaction:${payload.interaction.applicationId}:${payload.interaction.id}`,
        observedVersion: payload.interaction.id,
        occurredAt,
        evidence: "discord_interaction",
        interactionId: payload.interaction.id,
        guildId: payload.interaction.guildId,
        channelId: payload.interaction.channelId,
        commandId: payload.interaction.commandId,
        commandName: payload.interaction.commandName,
        sourceMetadata: {
          userId: payload.interaction.userId,
          options: payload.interaction.options,
        },
      },
      leaseId,
      await preparePrompt(scope),
    );
    if (!claim) throw new NativeSourceLeaseLost();
    await jobs.enqueue(runContinueJob(claim.runId));
    if (claim.created) await onCreated(claim.runId);
  } finally {
    await checkpointNativeEventSource(prisma, scope, {
      triggerId: row.id,
      triggerVersion: row.version,
      leaseId,
      state: checkpointState,
      nextPollAt: row.nextPollAt,
      release: true,
    });
  }
}
