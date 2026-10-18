import type { BackgroundJob } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { NativeEventScope, NativeRoutineEventSpec } from "@rakazo/contracts";
import { NativeNotionSignalJobSchema } from "@rakazo/contracts";
import { expandSkillReferencesInPrompt } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { listAgentSkillRecords } from "../../skill-tools.js";
import { NativeActionError } from "../action.js";
import type { NativeOAuthStore } from "../oauth.js";
import { ensureCalendarChannel } from "./calendar-watch.js";
import type { NativeNotionHookStore } from "./notion-hooks.js";
import {
  readCalendarChanges,
  readCalendarStarting,
  readNotionChanges,
  readNotionWebhook,
} from "./readers.js";
import type { CalendarEventChannel, NotionEventSignal } from "./signals.js";
import { notionSignalCandidate, verifyCalendarSignal, verifyNotionSignal } from "./signals.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  nativeTriggerScope,
} from "./store.js";
import { withNativeCalendarChannelApi, withNativeEventReadApi } from "./transport.js";
import type { NativeSourceReadContext } from "./worker.js";
import {
  dueNativeSources,
  handleNativeSourceJob,
  NativeSourceLeaseLost,
  nativeSignalJobKey,
  nativeSourceJob,
  nativeSourceRetry,
} from "./worker.js";

type SignalJob = z.infer<typeof NativeNotionSignalJobSchema>;
type NativeSignalJob = { name: "native.notion.signal"; payload: SignalJob; replaceKey?: string };
export interface NativeEventJobPublisher {
  enqueue(job: BackgroundJob | ReturnType<typeof nativeSourceJob> | NativeSignalJob): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Exact Routine bridge. No Bot webhook/fanout, new approval system, or independent outbox. */
export class NativeRoutineEventService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauth: Pick<NativeOAuthStore, "authorization">,
    readonly hooks: NativeNotionHookStore,
    private readonly jobs: NativeEventJobPublisher,
    private readonly events: Pick<ThreadEvents, "append">,
    private readonly apiUrl: string,
    private readonly network?: RemoteTransportDependencies,
  ) {}
  async reconcile(): Promise<void> {
    for (const row of await dueNativeSources(this.prisma))
      await this.jobs.enqueue(nativeSourceJob(row.id, row.version));
  }
  private async prompt(scope: NativeEventScope) {
    const skills = await listAgentSkillRecords(this.prisma, scope);
    return (value: string) => expandSkillReferencesInPrompt(value, skills);
  }
  private async fired(runId: string): Promise<void> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { spaceId: true, threadId: true, botId: true, routineId: true, createdAt: true },
    });
    if (!run?.routineId) return;
    await this.events
      .append({
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId,
        type: "routine.fired",
        payload: { routineId: run.routineId, scheduledFor: run.createdAt.toISOString() },
      })
      .catch(() => undefined);
  }
  async poll(payload: unknown, signal: AbortSignal): Promise<void> {
    const parsed = z
        .object({ triggerId: z.string(), triggerVersion: z.number().int().positive() })
        .strict()
        .parse(payload),
      scope = await nativeTriggerScope(this.prisma, parsed.triggerId);
    if (!scope) return;
    const preparePrompt = await this.prompt(scope);
    await handleNativeSourceJob(
      this.prisma,
      this.jobs,
      {
        calendar: async (context) => {
          await withNativeCalendarChannelApi(
            this.oauth,
            context,
            (api) =>
              ensureCalendarChannel(context, api, this.apiUrl, async (state) => {
                if (
                  !context.row.leaseId ||
                  !(await checkpointNativeEventSource(this.prisma, context.scope, {
                    triggerId: context.row.id,
                    triggerVersion: context.row.version,
                    leaseId: context.row.leaseId,
                    state,
                    nextPollAt: context.row.nextPollAt,
                    release: false,
                  }))
                )
                  throw new NativeSourceLeaseLost();
                context.row.state = state;
              }),
            this.network,
          );
          return withNativeEventReadApi(
            this.oauth,
            context,
            async (api) => {
              return context.row.kind === "calendar.event_starting"
                ? readCalendarStarting(context, api)
                : readCalendarChanges(context, api);
            },
            this.network,
          );
        },
        notion: async (context) =>
          withNativeEventReadApi(
            this.oauth,
            context,
            (api) => readNotionChanges(context, api),
            this.network,
          ),
      },
      parsed,
      signal,
      preparePrompt,
      async (row, result) =>
        this.jobs.enqueue(nativeSourceJob(row.id, row.version, result.nextPollAt)),
      async (runId) => this.fired(runId),
    );
  }
  /** HTTP has already bounded raw bytes; acknowledge only after all matching durable Graphile jobs are accepted. */
  async ingestNotion(hookId: string, raw: Uint8Array, signature: string | null): Promise<number> {
    if (!signature) {
      await this.hooks.captureChallenge(hookId, raw);
      return 0;
    }
    const accepted = await this.hooks.acceptSigned(hookId, raw, signature);
    if (!accepted?.event) return 0;
    const { hook, event } = accepted;
    const bots =
      event.accessibleBy?.filter((entry) => entry.type === "bot").map((entry) => entry.id) ?? [];
    if (!bots.length) return 0;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; version: number; spec: unknown }>>(
      Prisma.sql`SELECT t.id,t.version,t.spec FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t."configId"=${hook.configId} AND r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.provider='notion' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=g.id AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND g.tenant=${event.workspaceId} AND g.principal->>'credentialKind'='oauth' AND g.principal->>'botId' IN (${Prisma.join(bots)}) AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId")`,
    );
    let count = 0;
    for (const row of rows) {
      if (!notionSignalCandidate(row.spec as NativeRoutineEventSpec, event)) continue;
      await this.jobs.enqueue({
        name: "native.notion.signal",
        payload: {
          triggerId: row.id,
          triggerVersion: row.version,
          hookId: hook.id,
          hookRevision: hook.revision,
          signal: event,
        },
        replaceKey: nativeSignalJobKey(
          row.id,
          row.version,
          `${event.integrationId}:${event.subscriptionId}:${event.id}`,
        ),
      });
      count++;
    }
    return count;
  }
  async notionSignal(raw: unknown, signal: AbortSignal): Promise<void> {
    const payload = NativeNotionSignalJobSchema.parse(raw),
      hook = await this.hooks.load(payload.hookId, payload.hookRevision);
    if (
      !hook ||
      payload.signal.integrationId !== hook.integrationId ||
      payload.signal.subscriptionId !== hook.subscriptionId
    )
      return;
    const scope = await nativeTriggerScope(this.prisma, payload.triggerId);
    if (!scope) return;
    const row = await leaseNativeEventSource(
      this.prisma,
      scope,
      payload.triggerId,
      payload.triggerVersion,
    );
    if (!row?.leaseId) {
      // A signal job must retry a CURRENT busy source, not disappear behind a concurrent compensation poll.
      const busy = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT t.id FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=g.id AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") AND t.id=${payload.triggerId} AND t.version=${payload.triggerVersion} AND r."userId"=${scope.userId} AND r."spaceId"=${scope.spaceId} AND t."configId"=${hook.configId} AND c.provider='notion' AND t."leaseUntil">now()`,
      );
      if (busy.length)
        throw new NativeActionError(
          "temporarily_unavailable",
          "This exact event source is processing another delivery.",
        );
      return;
    }
    const leaseId = row.leaseId,
      preparePrompt = await this.prompt(scope);
    if (row.configId !== hook.configId || !row.kind.startsWith("notion.")) {
      await checkpointNativeEventSource(this.prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: object(row.state),
        nextPollAt: row.nextPollAt,
        release: true,
      });
      return;
    }
    const blockedUntil = object(row.state).retryAfterAt;
    if (typeof blockedUntil === "string" && Date.parse(blockedUntil) > Date.now()) {
      await checkpointNativeEventSource(this.prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: object(row.state),
        nextPollAt: new Date(blockedUntil),
        release: true,
      });
      throw new NativeActionError(
        "temporarily_unavailable",
        "The event source is respecting the service retry interval.",
        { retryAfterSeconds: Math.ceil((Date.parse(blockedUntil) - Date.now()) / 1000) },
      );
    }
    const context: NativeSourceReadContext = {
      scope,
      row,
      signal,
      heartbeat: async () => {
        if (
          !(await checkpointNativeEventSource(this.prisma, scope, {
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
      emit: async (event) => {
        const claimed = await claimNativeRoutineEvent(
          this.prisma,
          scope,
          event,
          leaseId,
          preparePrompt,
          new Date(),
          { id: hook.id, revision: hook.revision, configId: hook.configId },
        );
        if (!claimed) throw new NativeSourceLeaseLost();
        await this.jobs.enqueue(runContinueJob(claimed.runId));
        if (claimed.created) await this.fired(claimed.runId);
        return claimed.created;
      },
    };
    try {
      const result = await withNativeEventReadApi(
        this.oauth,
        context,
        async (api, principal) => {
          if (!principal)
            throw new NativeActionError(
              "authorization_required",
              "This webhook requires the exact configured public Notion OAuth connection.",
            );
          return readNotionWebhook(context, api, payload.signal as NotionEventSignal, principal);
        },
        this.network,
      );
      const state = { ...result.state };
      delete state.retryAfterAt;
      delete state.lastErrorCode;
      await checkpointNativeEventSource(this.prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state,
        nextPollAt: result.nextPollAt,
        release: true,
      });
    } catch (error) {
      const retry = nativeSourceRetry(object(row.state), error);
      await checkpointNativeEventSource(this.prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: retry.state,
        nextPollAt: retry.nextPollAt,
        release: true,
      }).catch(() => false);
      if (!(error instanceof NativeSourceLeaseLost)) throw error;
    }
  }
  async ingestCalendar(headers: Headers): Promise<number> {
    const channelId = headers.get("x-goog-channel-id");
    if (!channelId || channelId.length > 64) return 0;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; version: number; state: unknown }>
    >(
      Prisma.sql`SELECT t.id,t.version,t.state FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=g.id AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") AND c.provider='google-calendar' AND t.kind IN ('calendar.event_changed','calendar.event_starting') AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.state->'calendarChannels')='array' THEN t.state->'calendarChannels' ELSE '[]'::jsonb END) ch WHERE ch->>'id'=${channelId})`,
    );
    let count = 0;
    for (const row of rows) {
      const channels = object(row.state).calendarChannels;
      const channel = Array.isArray(channels)
        ? (channels.find((candidate) => object(candidate).id === channelId) as
            | CalendarEventChannel
            | undefined)
        : undefined;
      if (!channel) continue;
      const verified = verifyCalendarSignal(headers, channel);
      if (verified.phase === "early_sync") continue;
      await this.jobs.enqueue(nativeSourceJob(row.id, row.version));
      count++;
    }
    return count;
  }
}
