import type { BackgroundJob } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { NativeEventScope, NativeRoutineEventSpec } from "@rakazo/contracts";
import {
  type NativeDiscordSignalJobSchema,
  NativeNotionSignalJobSchema,
  NativeSlackLifecycleJobSchema,
  NativeSlackSignalJobSchema,
} from "@rakazo/contracts";
import { expandSkillReferencesInPrompt } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { listAgentSkillRecords } from "../../skill-tools.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import type { NativeOAuthStore } from "../oauth.js";
import { ensureCalendarChannel } from "./calendar-watch.js";
import { ingestDiscordRoutine, processDiscordRoutine } from "./discord-interactions.js";
import { createGmailPushVerifier } from "./google-push.js";
import { readDriveChanges, readGmailChanges } from "./google-readers.js";
import {
  driveWatchChannels,
  ensureDriveChangesWatch,
  ensureGmailWatch,
  verifyDriveWatchSignal,
} from "./google-watch.js";
import type { NativeNotionHookStore } from "./notion-hooks.js";
import {
  readCalendarChanges,
  readCalendarStarting,
  readNotionChanges,
  readNotionWebhook,
} from "./readers.js";
import { readRemainingEvent } from "./remaining-readers.js";
import { withRemainingNativeRead } from "./remaining-transport.js";
import type { CalendarEventChannel, NotionEventSignal } from "./signals.js";
import {
  InvalidNativeEventSignal,
  notionSignalCandidate,
  verifyCalendarSignal,
} from "./signals.js";
import type { NativeSlackHookStore } from "./slack-hooks.js";
import { applyNativeSlackLifecycle } from "./slack-lifecycle.js";
import { readSlackWebhook } from "./slack-reader.js";
import { slackSignalAccessible, slackSignalCandidate } from "./slack-signals.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  nativeTriggerScope,
} from "./store.js";
import {
  nativeGoogleWatchBinding,
  pinnedEventAuthorization,
  withNativeCalendarChannelApi,
  withNativeEventReadApi,
  withNativeGoogleWatchApi,
} from "./transport.js";
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
type NativeSignalJob =
  | {
      name: "native.discord.signal";
      payload: z.infer<typeof NativeDiscordSignalJobSchema>;
      replaceKey?: string;
    }
  | { name: "native.notion.signal"; payload: SignalJob; replaceKey?: string }
  | {
      name: "native.slack.signal";
      payload: z.infer<typeof NativeSlackSignalJobSchema>;
      replaceKey?: string;
    }
  | {
      name: "native.slack.lifecycle";
      payload: z.infer<typeof NativeSlackLifecycleJobSchema>;
      replaceKey?: string;
    };
export interface NativeEventJobPublisher {
  enqueue(job: BackgroundJob | ReturnType<typeof nativeSourceJob> | NativeSignalJob): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Exact Routine bridge. No Bot webhook/fanout, new approval system, or independent outbox. */
export class NativeRoutineEventService {
  private readonly gmailPush: ReturnType<typeof createGmailPushVerifier>;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauth: Pick<NativeOAuthStore, "authorization"> &
      Partial<Pick<NativeOAuthStore, "rejectCredential">>,
    readonly hooks: NativeNotionHookStore,
    private readonly jobs: NativeEventJobPublisher,
    private readonly events: Pick<ThreadEvents, "append">,
    private readonly apiUrl: string,
    private readonly network?: RemoteTransportDependencies,
    readonly slackHooks?: NativeSlackHookStore,
  ) {
    this.gmailPush = createGmailPushVerifier({ network });
  }
  ingestDiscord(
    configId: string,
    raw: Uint8Array,
    headers: Headers | Record<string, string>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return ingestDiscordRoutine(this.prisma, this.jobs, configId, raw, headers);
  }
  discordSignal(raw: unknown, signal: AbortSignal): Promise<void> {
    return processDiscordRoutine(
      this.prisma,
      this.oauth,
      this.jobs,
      raw,
      signal,
      (scope) => this.prompt(scope),
      (runId) => this.fired(runId),
      this.network,
    );
  }
  async close(): Promise<void> {
    await this.gmailPush.close();
  }
  async reconcile(): Promise<void> {
    if (this.slackHooks)
      for (const item of await this.slackHooks.pending())
        await this.dispatchSlackInbox(item.inboxId, item.hookId, item.hookRevision);
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
        sharepoint: async (context) => this.readRemaining(context),
        excel: async (context) => this.readRemaining(context),
        planner: async (context) => this.readRemaining(context),
        teams: async (context) => this.readRemaining(context),
        feishu: async (context) => this.readRemaining(context),
        dingtalk: async (context) => this.readRemaining(context),
        wecom: async (context) => this.readRemaining(context),
        telegram: async (context) => this.readRemaining(context),
        discord: async (context) => this.readRemaining(context),
        gmail: async (context) => this.readGoogle(context, "gmail"),
        drive: async (context) => this.readGoogle(context, "google-drive"),
        slack: async (context) =>
          withNativeEventReadApi(
            this.oauth,
            context,
            async (api, _notion, principal) => {
              if (!principal)
                throw new NativeActionError(
                  "authorization_required",
                  "Slack events require the selected bot connection.",
                );
              const spec = context.row.spec as Extract<
                NativeRoutineEventSpec,
                { channelId: string }
              >;
              const channel = object(
                object(await api.get("/conversations.info", { channel: spec.channelId })).channel,
              );
              if (
                channel.id !== spec.channelId ||
                (channel.is_im !== true && channel.is_member !== true)
              )
                throw new NativeActionError(
                  "insufficient_scope",
                  "The selected bot is no longer a member of this channel.",
                );
              return {
                state: { ...object(context.row.state), ready: true },
                nextPollAt: new Date(Date.now() + 24 * 60 * 60_000),
              };
            },
            this.network,
          ),
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
  private async readRemaining(context: NativeSourceReadContext) {
    const revalidate = pinnedEventAuthorization(this.oauth, context),
      bound = await revalidate();
    return withRemainingNativeRead(
      bound,
      revalidate,
      context.signal,
      (api, principal) =>
        readRemainingEvent(
          {
            ...context,
            emit: async (event) => {
              await revalidate();
              return context.emit(event);
            },
          },
          api,
          principal,
        ),
      this.network,
      (version) =>
        this.oauth.rejectCredential?.(
          context.row.connectionId,
          {
            ...context.scope,
            operationId: `native-source:${context.row.id}:${context.row.version}`,
            traceId: "native-source",
            signal: context.signal,
          },
          version,
        ) ?? Promise.resolve(),
    );
  }
  private async readGoogle(context: NativeSourceReadContext, app: "gmail" | "google-drive") {
    const result = await withNativeEventReadApi(
      this.oauth,
      context,
      (api) =>
        app === "gmail"
          ? readGmailChanges(context, api)
          : readDriveChanges(context, api, undefined, {
              driveFileOnly: api.driveFileOnly !== false,
            }),
      this.network,
    );
    context.row.state = result.state;
    await withNativeGoogleWatchApi(
      this.oauth,
      context,
      async (request, settings, subject) => {
        const persistState = async (state: Record<string, unknown>) => {
          if (
            !context.row.leaseId ||
            !(await checkpointNativeEventSource(this.prisma, context.scope, {
              triggerId: context.row.id,
              triggerVersion: context.row.version,
              leaseId: context.row.leaseId,
              state,
              nextPollAt: result.nextPollAt,
              release: false,
            }))
          )
            throw new NativeSourceLeaseLost();
          context.row.state = state;
        };
        const watchContext = {
          bindingKey: nativeGoogleWatchBinding(context),
          state: object(context.row.state),
          request,
          persistState,
        };
        if (app === "gmail") {
          if (!settings.googleWatch) return;
          // Gmail has one watch per developer project/mailbox. A stable active source manages a fixed full-mailbox topic.
          const leaders = await this.prisma.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT t.id FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" JOIN bots b ON b.id=r."botId" WHERE t."configId"=${context.row.configId} AND t."configRevision"=${context.row.configRevision} AND g.subject=${subject} AND g."authGeneration"=t."authGeneration" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND c.provider='gmail' AND c."connectorId"='native' AND c.status='connected' AND c."oauthGrantId"=g.id AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND a.enabled=true AND a.revision=t."configRevision" AND t.kind LIKE 'gmail.%' AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") ORDER BY t.id LIMIT 1`,
          );
          if (leaders[0]?.id === context.row.id)
            await ensureGmailWatch(watchContext, settings.googleWatch);
        } else {
          const pageToken = object(object(context.row.state).driveChanged).pageToken;
          if (typeof pageToken === "string")
            await ensureDriveChangesWatch(watchContext, { apiUrl: this.apiUrl, pageToken });
        }
      },
      this.network,
    );
    return { ...result, state: object(context.row.state) };
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
  async ingestSlack(
    hookId: string,
    raw: Uint8Array,
    signature: string | null,
    timestamp: string | null,
  ): Promise<{ challenge?: string }> {
    if (!this.slackHooks)
      throw new NativeActionError("not_configured", "Slack event subscriptions are unavailable.");
    const accepted = await this.slackHooks.accept(hookId, raw, signature, timestamp);
    if (!accepted || accepted.kind === "ignored") return {};
    if (accepted.kind === "challenge") return { challenge: accepted.challenge };
    // The signed metadata inbox is the durable ACK boundary. Existing reconciliation fans out jobs;
    // waiting for every matching Routine's queue write would exceed Slack's response budget.
    return {};
  }
  private async dispatchSlackInbox(
    inboxId: string,
    hookId: string,
    hookRevision: number,
  ): Promise<void> {
    const accepted = await this.slackHooks?.loadInbox(inboxId, hookId, hookRevision);
    if (!accepted) {
      const lifecycle = await this.slackHooks?.loadLifecycleInbox(inboxId, hookId, hookRevision);
      if (lifecycle) {
        await this.jobs.enqueue({
          name: "native.slack.lifecycle",
          payload: { inboxId, hookId, hookRevision },
          replaceKey: `native-slack-lifecycle:${hookId}:${hookRevision}:${inboxId}`,
        });
        await this.slackHooks!.markDispatched(inboxId, hookId, hookRevision);
      }
      return;
    }
    const { hook, signal } = accepted;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        version: number;
        spec: unknown;
        subject: string;
        principal: unknown;
        scopes: string[];
        config: unknown;
      }>
    >(
      Prisma.sql`SELECT t.id,t.version,t.spec,g.subject,g.principal,g.scopes,a.config FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t."configId"=${hook.configId} AND t."configRevision"=${hook.configRevision} AND r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.provider='slack' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=g.id AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") AND t.kind LIKE 'slack.%'`,
    );
    for (const row of rows) {
      const context = object(row.principal),
        settings = NativeConfigSettingsSchema.parse(row.config);
      if (context.tokenType !== "bot" || typeof context.teamId !== "string") continue;
      const principal = {
        tokenType: "bot" as const,
        subject: row.subject,
        teamId: context.teamId,
        enterpriseId: typeof context.enterpriseId === "string" ? context.enterpriseId : null,
        scopes: row.scopes.filter((scope) => settings.scopes.includes(scope)),
      };
      if (
        !slackSignalCandidate(row.spec as NativeRoutineEventSpec, signal) ||
        !slackSignalAccessible(signal, principal)
      )
        continue;
      await this.jobs.enqueue({
        name: "native.slack.signal",
        payload: { triggerId: row.id, triggerVersion: row.version, inboxId, hookId, hookRevision },
        replaceKey: nativeSignalJobKey(row.id, row.version, `${hook.appId}:${signal.eventId}`),
      });
    }
    await this.slackHooks!.markDispatched(inboxId, hookId, hookRevision);
  }
  async slackLifecycle(raw: unknown): Promise<void> {
    if (!this.slackHooks)
      throw new NativeActionError("not_configured", "Slack lifecycle processing is unavailable.");
    await applyNativeSlackLifecycle(
      this.prisma,
      this.slackHooks,
      NativeSlackLifecycleJobSchema.parse(raw),
    );
  }
  async slackSignal(raw: unknown, signal: AbortSignal): Promise<void> {
    const payload = NativeSlackSignalJobSchema.parse(raw),
      accepted = await this.slackHooks?.loadInbox(
        payload.inboxId,
        payload.hookId,
        payload.hookRevision,
      );
    if (!accepted) return;
    const { hook, signal: event } = accepted,
      scope = await nativeTriggerScope(this.prisma, payload.triggerId);
    if (!scope) return;
    const row = await leaseNativeEventSource(
      this.prisma,
      scope,
      payload.triggerId,
      payload.triggerVersion,
    );
    if (!row?.leaseId) {
      const busy = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT t.id FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t.id=${payload.triggerId} AND t.version=${payload.triggerVersion} AND t."configId"=${hook.configId} AND t."configRevision"=${hook.configRevision} AND r.active=true AND c.status='connected' AND c."oauthGrantId"=g.id AND c.metadata->>'authRevision'=t."authorizationRevision" AND g."authGeneration"=t."authGeneration" AND g."revokedAt" IS NULL AND a.enabled=true AND a.revision=t."configRevision" AND t."leaseUntil">now()`,
      );
      if (busy.length)
        throw new NativeActionError(
          "temporarily_unavailable",
          "This exact Slack source is processing another delivery.",
        );
      return;
    }
    const leaseId = row.leaseId,
      preparePrompt = await this.prompt(scope);
    const checkpoint = async (
      state: Record<string, unknown>,
      nextPollAt: Date | null,
      release: boolean,
    ) =>
      checkpointNativeEventSource(this.prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state,
        nextPollAt,
        release,
      });
    if (
      row.configId !== hook.configId ||
      row.configRevision !== hook.configRevision ||
      !row.kind.startsWith("slack.")
    ) {
      await checkpoint(object(row.state), row.nextPollAt, true);
      return;
    }
    const context: NativeSourceReadContext = {
      scope,
      row,
      signal,
      heartbeat: async () => {
        if (!(await checkpoint(object(row.state), row.nextPollAt, false)))
          throw new NativeSourceLeaseLost();
      },
      emit: async (observation) => {
        if (signal.aborted) throw signal.reason;
        const claimed = await claimNativeRoutineEvent(
          this.prisma,
          scope,
          observation,
          leaseId,
          preparePrompt,
          new Date(),
          {
            id: hook.id,
            revision: hook.revision,
            configId: hook.configId,
            provider: "slack",
            inboxId: payload.inboxId,
            eventId: event.eventId,
          },
        );
        if (!claimed) throw new NativeSourceLeaseLost();
        await this.jobs.enqueue(runContinueJob(claimed.runId));
        if (claimed.created) await this.fired(claimed.runId);
        return claimed.created;
      },
    };
    try {
      const retryAfter = object(row.state).retryAfterAt;
      if (typeof retryAfter === "string" && Date.parse(retryAfter) > Date.now())
        throw new NativeActionError(
          "temporarily_unavailable",
          "The Slack source is respecting its retry interval.",
          { retryAfterSeconds: Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) },
        );
      const result = await withNativeEventReadApi(
        this.oauth,
        context,
        async (api, _notion, principal) => {
          if (!principal)
            throw new NativeActionError(
              "authorization_required",
              "Slack events require the exact configured bot account.",
            );
          // Slack never scans history: a verified live event needs no historic-message baseline.
          row.state = { ...object(row.state), ready: true };
          await context.heartbeat();
          return readSlackWebhook(context, api, event, principal, hook);
        },
        this.network,
      );
      const state = { ...result.state };
      delete state.retryAfterAt;
      delete state.lastErrorCode;
      await checkpoint(state, result.nextPollAt, true);
    } catch (error) {
      const retry = nativeSourceRetry(object(row.state), error);
      await checkpoint(retry.state, retry.nextPollAt, true).catch(() => false);
      if (!(error instanceof NativeSourceLeaseLost)) throw error;
    }
  }
  async ingestGmail(rawBody: Uint8Array, authorization: string | null): Promise<number> {
    if (!authorization?.startsWith("Bearer ") || rawBody.byteLength > 64 * 1024)
      throw new InvalidNativeEventSignal();
    let subscription: unknown;
    try {
      subscription = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
      ).subscription;
    } catch {
      throw new InvalidNativeEventSignal();
    }
    if (typeof subscription !== "string") throw new InvalidNativeEventSignal();
    const configs = await this.prisma.nativeAppConfig.findMany({
      where: { appId: "gmail", enabled: true },
      select: { id: true, revision: true, config: true },
    });
    let count = 0,
      matched = false;
    for (const config of configs) {
      const watch = NativeConfigSettingsSchema.parse(config.config).googleWatch;
      if (!watch || watch.subscriptionName !== subscription) continue;
      const expected = new URL("/api/connectors/events/gmail", this.apiUrl);
      if (expected.protocol !== "https:" || watch.callbackAudience !== expected.href) continue;
      const event = await this.gmailPush.verify({ authorization, rawBody }, watch);
      matched = true;
      // The signed push is a hint only. Never move a Gmail cursor from a notification historyId.
      const rows = await this.prisma.$queryRaw<Array<{ id: string; version: number }>>(
        Prisma.sql`SELECT t.id,t.version FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE t."configId"=${config.id} AND t."configRevision"=${config.revision} AND t.kind LIKE 'gmail.%' AND r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c.provider='gmail' AND c."connectorId"='native' AND c.status='connected' AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."oauthGrantId"=g.id AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g.principal->>'email'=${event.emailAddress} AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId")`,
      );
      for (const row of rows) {
        await this.jobs.enqueue(nativeSourceJob(row.id, row.version));
        count++;
      }
    }
    if (
      !matched &&
      configs.some(
        (config) =>
          NativeConfigSettingsSchema.parse(config.config).googleWatch?.subscriptionName ===
          subscription,
      )
    )
      throw new InvalidNativeEventSignal();
    return count;
  }
  async ingestDrive(headers: Headers): Promise<number> {
    const id = headers.get("x-goog-channel-id");
    if (!id || id.length > 128) return 0;
    const rows = await this.prisma.$queryRaw<
      Array<import("./store.js").NativeRoutineTriggerRow & { userId: string; spaceId: string }>
    >(
      Prisma.sql`SELECT t.*,r."userId",r."spaceId" FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN connections c ON c.id=t."connectionId" WHERE t.kind LIKE 'drive.%' AND r.active=true AND c.provider='google-drive' AND c.status='connected' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.state->'driveWatch'->'channels')='array' THEN t.state->'driveWatch'->'channels' ELSE '[]'::jsonb END) ch WHERE ch->>'id'=${id})`,
    );
    let count = 0;
    for (const row of rows) {
      const channels = driveWatchChannels(
        object(row.state),
        nativeGoogleWatchBinding({ row, scope: { userId: row.userId, spaceId: row.spaceId } }),
      );
      const channel = channels.find((candidate) => candidate.id === id);
      if (!channel) continue;
      const verified = verifyDriveWatchSignal(headers, channel);
      if (!verified || verified.phase === "early_sync") continue;
      await this.jobs.enqueue(nativeSourceJob(row.id, row.version));
      count++;
    }
    return count;
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
