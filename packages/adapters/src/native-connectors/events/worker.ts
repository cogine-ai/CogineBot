import { createHash } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { NativeEventObservation, NativeEventScope } from "@rakazo/contracts";
import { NativeSourceJobPayloadSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import { NativeActionError } from "../action.js";
import type { NativeRoutineTriggerRow } from "./store.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  nativeTriggerScope,
} from "./store.js";

export type { NativeSourceJobPayload } from "@rakazo/contracts";
export { NativeSourceJobPayloadSchema } from "@rakazo/contracts";
/** Merge this literal into existing BackgroundJobPayloads/payloadSchemas/handlers, not a second worker. */
export function nativeSourceJob(
  triggerId: string,
  triggerVersion: number,
  availableAt = new Date(),
) {
  return {
    name: "native.source.poll" as const,
    payload: NativeSourceJobPayloadSchema.parse({ triggerId, triggerVersion }),
    availableAt,
    replaceKey: `native-source:${triggerId}:${triggerVersion}`,
  };
}
export interface NativeSourceReadContext {
  scope: NativeEventScope;
  row: NativeRoutineTriggerRow;
  signal: AbortSignal;
  /** A source emits only authoritative, exact-resource observations. Every emit rechecks DB authorization. */
  emit(event: NativeEventObservation): Promise<boolean>;
  /** Keep the current cursor until every emitted Run has a durable receipt. */
  heartbeat(): Promise<void>;
}
export interface NativeSourceReadResult {
  state: Record<string, unknown>;
  nextPollAt: Date;
}
/** These are the two real provider boundaries, not user-selectable executors or arbitrary jobs. */
export interface NativeEventReaders {
  calendar(context: NativeSourceReadContext): Promise<NativeSourceReadResult>;
  notion(context: NativeSourceReadContext): Promise<NativeSourceReadResult>;
}
export class NativeSourceLeaseLost extends Error {
  constructor() {
    super("Native event source changed or its lease expired.");
  }
}
export function nativeSourceRetry(
  state: Record<string, unknown>,
  error: unknown,
  now = new Date(),
): NativeSourceReadResult {
  const seconds =
    error instanceof NativeActionError && error.options.retryAfterSeconds !== undefined
      ? error.options.retryAfterSeconds
      : 60;
  const nextPollAt = new Date(now.getTime() + Math.max(60, seconds) * 1000);
  return {
    state: {
      ...state,
      retryAfterAt: nextPollAt.toISOString(),
      lastErrorCode: error instanceof NativeActionError ? error.kind : "temporarily_unavailable",
    },
    nextPollAt,
  };
}

/** Reuses the existing queue and queued-Run reconciler; never calls wakeRoutine/sendUserMessage. */
export async function handleNativeSourceJob(
  prisma: PrismaClient,
  jobs: Pick<JobPublisher, "enqueue">,
  readers: NativeEventReaders,
  raw: unknown,
  signal: AbortSignal,
  preparePrompt: (prompt: string) => string = (prompt) => prompt,
  afterCommit?: (row: NativeRoutineTriggerRow, result: NativeSourceReadResult) => Promise<void>,
  onCreated?: (runId: string) => Promise<void>,
): Promise<"ignored" | "processed"> {
  const payload = NativeSourceJobPayloadSchema.parse(raw);
  const scope = await nativeTriggerScope(prisma, payload.triggerId);
  if (!scope) return "ignored";
  const row = await leaseNativeEventSource(
    prisma,
    scope,
    payload.triggerId,
    payload.triggerVersion,
  );
  if (!row?.leaseId) return "ignored";
  const leaseId = row.leaseId;
  const original =
    row.state && typeof row.state === "object" && !Array.isArray(row.state)
      ? (row.state as Record<string, unknown>)
      : {};
  const blockedUntil =
    typeof original.retryAfterAt === "string" ? new Date(original.retryAfterAt) : undefined;
  if (blockedUntil && blockedUntil.getTime() > Date.now()) {
    const result = { state: original, nextPollAt: blockedUntil };
    if (
      await checkpointNativeEventSource(prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: original,
        nextPollAt: blockedUntil,
        release: true,
      })
    )
      await afterCommit?.(row, result);
    return "processed";
  }
  const heartbeat = async () => {
    const state =
      row.state && typeof row.state === "object" && !Array.isArray(row.state)
        ? (row.state as Record<string, unknown>)
        : {};
    if (
      !(await checkpointNativeEventSource(prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state,
        nextPollAt: row.nextPollAt,
        release: false,
      }))
    )
      throw new NativeSourceLeaseLost();
  };
  try {
    const read = row.kind.startsWith("calendar.") ? readers.calendar : readers.notion;
    const result = await read({
      scope,
      row,
      signal,
      heartbeat,
      emit: async (event) => {
        if (signal.aborted) throw signal.reason;
        const claimed = await claimNativeRoutineEvent(prisma, scope, event, leaseId, preparePrompt);
        if (!claimed) throw new NativeSourceLeaseLost();
        // Enqueue BOTH new and replayed queued receipts. If enqueue fails, the ordinary Run reconciler also repairs it.
        await jobs.enqueue(runContinueJob(claimed.runId));
        if (claimed.created) await onCreated?.(claimed.runId).catch(() => undefined);
        return claimed.created;
      },
    });
    const committedState = { ...result.state };
    delete committedState.retryAfterAt;
    delete committedState.lastErrorCode;
    if (
      !(await checkpointNativeEventSource(prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: committedState,
        nextPollAt: result.nextPollAt,
        release: true,
      }))
    )
      return "ignored";
    await afterCommit?.(row, result);
    return "processed";
  } catch (error) {
    if (error instanceof NativeSourceLeaseLost) return "ignored";
    // Keep the OLD cursor and let Graphile retry. The 120s lease eventually expires if release cannot commit.
    const old =
      row.state && typeof row.state === "object" && !Array.isArray(row.state)
        ? (row.state as Record<string, unknown>)
        : {};
    const retry = nativeSourceRetry(old, error);
    if (
      await checkpointNativeEventSource(prisma, scope, {
        triggerId: row.id,
        triggerVersion: row.version,
        leaseId,
        state: retry.state,
        nextPollAt: retry.nextPollAt,
        release: true,
      }).catch(() => false)
    )
      await afterCommit?.(row, retry).catch(() => undefined);
    throw error;
  }
}
/** Existing leader reconciler calls this and enqueues nativeSourceJob for each result. */
export async function dueNativeSources(
  prisma: PrismaClient,
  now = new Date(),
): Promise<Array<{ id: string; version: number }>> {
  return prisma.$queryRaw<Array<{ id: string; version: number }>>(
    Prisma.sql`/*native-event:due*/ SELECT t.id,t.version FROM native_routine_triggers t JOIN routines r ON r.id=t."routineId" JOIN bots b ON b.id=r."botId" JOIN connections c ON c.id=t."connectionId" JOIN native_oauth_grants g ON g.id=t."grantId" JOIN native_app_configs a ON a.id=t."configId" WHERE r.active=true AND b."archivedAt" IS NULL AND b."userId"=r."userId" AND b."spaceId"=r."spaceId" AND c."userId"=r."userId" AND c."spaceId"=r."spaceId" AND c."connectorId"='native' AND c.status='connected' AND c.metadata->>'authRevision'=t."authorizationRevision" AND c."oauthGrantId"=t."grantId" AND c."nativeConfigId"=t."configId" AND c."nativeConfigRevision"=t."configRevision" AND g."userId"=r."userId" AND g."spaceId"=r."spaceId" AND g."authGeneration"=t."authGeneration" AND g."configId"=t."configId" AND g."configRevision"=t."configRevision" AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND a.enabled=true AND a.revision=t."configRevision" AND EXISTS(SELECT 1 FROM space_members m WHERE m."userId"=r."userId" AND m."spaceId"=r."spaceId") AND t."nextPollAt"<=${now} AND (t."leaseUntil" IS NULL OR t."leaseUntil"<=${now}) ORDER BY t."nextPollAt",t.id LIMIT 100`,
  );
}
/** Notion verified envelopes get distinct durable Graphile jobs; jobKey is NOT the permanent Run receipt. */
export function nativeSignalJobKey(
  triggerId: string,
  version: number,
  providerIdentity: string,
): string {
  return `native-signal:${triggerId}:${version}:${createHash("sha256").update(providerIdentity).digest("hex")}`;
}
