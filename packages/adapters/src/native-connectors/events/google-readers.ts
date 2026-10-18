import { createHash } from "node:crypto";
import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { NativeRoutineEventSpecSchema, nativeEventResource } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { NativeActionError } from "../action.js";
import type { NativeEventReadApi } from "./readers.js";
import { nativeObservationMatches } from "./store.js";
import type { NativeSourceReadContext, NativeSourceReadResult } from "./worker.js";

type Obj = Record<string, unknown>;
type GmailSpec = Extract<
  NativeRoutineEventSpec,
  { kind: "gmail.message_received" | "gmail.thread_or_label_changed" }
>;
type DriveSpec = Extract<
  NativeRoutineEventSpec,
  { kind: "drive.file_changed" | "drive.file_trashed" }
>;
const MAX_PAGES = 1000;
const POLL_MS = 60_000; // Compensation only; this reader is not proof of push/watch delivery.
const enc = encodeURIComponent;
function object(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError("incomplete_response", "The Google event response was incomplete.");
  return value as Obj;
}
const optional = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048)
    throw new NativeActionError("incomplete_response", "The Google event identity was missing.");
  return value;
}
function decimal(value: unknown): string {
  const result = id(value);
  if (!/^\d+$/.test(result))
    throw new NativeActionError(
      "incomplete_response",
      "The Google sequence identifier was invalid.",
    );
  return result;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    throw new NativeActionError("incomplete_response", "Google omitted authoritative labels.");
  return value as string[];
}
function hash(value: unknown): string {
  return createHash("sha256").update(stableJsonValue(value)).digest("hex");
}
function fingerprint(context: NativeSourceReadContext): string {
  const row = context.row;
  return hash({
    spec: row.spec,
    version: row.version,
    armedAt: row.armedAt.toISOString(),
    connectionId: row.connectionId,
    authorizationRevision: row.authorizationRevision,
    grantId: row.grantId,
    authGeneration: row.authGeneration,
    configId: row.configId,
    configRevision: row.configRevision,
  });
}
function observe(
  context: NativeSourceReadContext,
  fields: Partial<NativeEventObservation> &
    Pick<NativeEventObservation, "eventIdentity" | "observedVersion" | "occurredAt">,
): NativeEventObservation {
  const row = context.row,
    spec = NativeRoutineEventSpecSchema.parse(row.spec);
  return {
    triggerId: row.id,
    triggerVersion: row.version,
    connectionId: row.connectionId,
    authorizationRevision: row.authorizationRevision,
    kind: spec.kind,
    resource: nativeEventResource(spec),
    evidence: "visible_state_change",
    ...fields,
  };
}
function result(state: Obj, now: Date): NativeSourceReadResult {
  return { state, nextPollAt: new Date(now.getTime() + POLL_MS) };
}
function status(error: unknown): unknown {
  return error instanceof NativeActionError ? error.options.recovery?.status : undefined;
}
function matchedLabels(spec: GmailSpec, current: string[], delta: string[] = []): string[] {
  if (!spec.labelIds) return [];
  return spec.labelIds.filter((label) => current.includes(label) || delta.includes(label));
}
async function gmailBaseline(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now: Date,
): Promise<NativeSourceReadResult> {
  context.signal.throwIfAborted();
  const profile = object(await api.get("/users/me/profile", { fields: "historyId" }));
  await context.heartbeat();
  return result(
    {
      ...optional(context.row.state),
      ready: true,
      gmailChanged: {
        queryFingerprint: fingerprint(context),
        historyId: decimal(profile.historyId),
      },
    },
    now,
  );
}
interface GmailCandidate {
  messageId: string;
  threadId: string;
  added: boolean;
  deleted: boolean;
  labels: string[];
}
function candidates(record: Obj): GmailCandidate[] {
  const found = new Map<string, GmailCandidate>();
  for (const key of ["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"]) {
    if (record[key] === undefined) continue;
    if (!Array.isArray(record[key]))
      throw new NativeActionError("incomplete_response", "Gmail history entries were incomplete.");
    for (const raw of record[key] as unknown[]) {
      const item = object(raw),
        message = object(item.message),
        messageId = id(message.id),
        threadId = id(message.threadId);
      let current = found.get(messageId);
      if (!current) {
        current = { messageId, threadId, added: false, deleted: false, labels: [] };
        found.set(messageId, current);
      }
      if (current.threadId !== threadId)
        throw new NativeActionError(
          "incomplete_response",
          "Gmail history changed message identity.",
        );
      current.added ||= key === "messagesAdded";
      current.deleted ||= key === "messagesDeleted";
      if (key === "labelsAdded" || key === "labelsRemoved")
        current.labels.push(...strings(item.labelIds));
    }
  }
  return [...found.values()];
}
/** Original startHistoryId remains pinned for every page. A history gap rebaselines without backfilling old mail. */
export async function readGmailChanges(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now = new Date(),
  forceBaseline = false,
): Promise<NativeSourceReadResult> {
  const spec = context.row.spec as GmailSpec;
  if (!["gmail.message_received", "gmail.thread_or_label_changed"].includes(spec.kind))
    throw new NativeActionError("invalid_input", "This source is not a Gmail trigger.");
  const previous = optional(context.row.state),
    saved = optional(previous.gmailChanged),
    queryFingerprint = fingerprint(context);
  if (
    forceBaseline ||
    previous.ready !== true ||
    saved.queryFingerprint !== queryFingerprint ||
    typeof saved.historyId !== "string"
  )
    return gmailBaseline(context, api, now);
  const original = decimal(saved.historyId);
  let pageToken: string | undefined;
  const pages = new Set<string>(),
    emitted = new Set<string>();
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    context.signal.throwIfAborted();
    let value: unknown;
    try {
      value = await api.get("/users/me/history", {
        startHistoryId: original,
        pageToken,
        maxResults: 500,
      });
    } catch (error) {
      if (status(error) === 404) return gmailBaseline(context, api, now);
      throw error;
    }
    const page = object(value);
    if (page.history !== undefined && !Array.isArray(page.history))
      throw new NativeActionError(
        "incomplete_response",
        "Gmail history pagination was incomplete.",
      );
    for (const raw of (page.history ?? []) as unknown[]) {
      const entry = object(raw),
        historyId = decimal(entry.id);
      if (BigInt(historyId) <= BigInt(original)) continue;
      for (const candidate of candidates(entry)) {
        if (spec.threadId && candidate.threadId !== spec.threadId) continue;
        if (spec.kind === "gmail.message_received" && (!candidate.added || candidate.deleted))
          continue;
        let message: Obj;
        if (candidate.deleted) {
          // A deleted message is unreadable. Only an explicitly selected, still-readable thread can prove its change.
          if (!spec.threadId || spec.kind === "gmail.message_received") continue;
          try {
            const thread = object(
              await api.get(`/users/me/threads/${enc(candidate.threadId)}`, {
                format: "minimal",
                fields: "id,historyId,messages(id,threadId,labelIds)",
              }),
            );
            if (thread.id !== candidate.threadId || !Array.isArray(thread.messages))
              throw new NativeActionError(
                "incomplete_response",
                "Gmail omitted the selected thread identity.",
              );
            decimal(thread.historyId);
            message = {
              id: candidate.messageId,
              threadId: thread.id,
              historyId: thread.historyId,
              labelIds: [
                ...new Set(
                  (thread.messages as unknown[]).flatMap((item) => strings(object(item).labelIds)),
                ),
              ],
            };
          } catch (error) {
            if (status(error) === 404) continue;
            throw error;
          }
        } else {
          try {
            message = object(
              await api.get(`/users/me/messages/${enc(candidate.messageId)}`, {
                format: "metadata",
                fields: "id,threadId,labelIds,historyId,internalDate",
              }),
            );
          } catch (error) {
            if (status(error) === 404) continue;
            throw error;
          }
          if (message.id !== candidate.messageId || message.threadId !== candidate.threadId)
            throw new NativeActionError(
              "incomplete_response",
              "Gmail did not confirm the expected message identity.",
            );
          decimal(message.historyId);
        }
        const labels = strings(message.labelIds),
          selectedLabels = matchedLabels(
            spec,
            labels,
            spec.kind === "gmail.thread_or_label_changed" ? candidate.labels : [],
          );
        if (spec.labelIds && !selectedLabels.length) continue;
        let occurredAt = now.toISOString();
        if (spec.kind === "gmail.message_received") {
          if (labels.includes("SENT") || labels.includes("DRAFT")) continue;
          const millis = Number(decimal(message.internalDate));
          if (
            !Number.isSafeInteger(millis) ||
            millis < context.row.armedAt.getTime() ||
            millis > now.getTime()
          )
            continue;
          occurredAt = new Date(millis).toISOString();
        }
        const eventIdentity =
          spec.kind === "gmail.message_received"
            ? `gmail:received:${candidate.messageId}`
            : `gmail:history:${historyId}:${candidate.messageId}`;
        if (emitted.has(eventIdentity)) continue;
        const event = observe(context, {
          evidence: "gmail_history",
          eventIdentity,
          observedVersion: historyId,
          occurredAt,
          messageId: candidate.messageId,
          threadId: candidate.threadId,
          historyId,
          ...(selectedLabels.length ? { labelIds: selectedLabels } : {}),
        });
        if (nativeObservationMatches(context.row, event, now)) {
          await context.emit(event);
          emitted.add(eventIdentity);
        }
      }
    }
    await context.heartbeat();
    if (page.nextPageToken === undefined) {
      const next = decimal(page.historyId);
      if (BigInt(next) < BigInt(original))
        throw new NativeActionError(
          "incomplete_response",
          "Gmail returned a regressing history cursor.",
        );
      return result(
        { ...previous, ready: true, gmailChanged: { queryFingerprint, historyId: next } },
        now,
      );
    }
    const next = id(page.nextPageToken);
    if (pages.has(next))
      throw new NativeActionError("incomplete_response", "Gmail repeated a pagination cursor.");
    pages.add(next);
    pageToken = next;
  }
  throw new NativeActionError(
    "incomplete_response",
    "Gmail exceeded the bounded history pagination budget; the cursor was not advanced.",
  );
}
const FILE_FIELDS = "id,version,trashed,isAppAuthorized,mimeType,modifiedTime";
async function driveFile(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  spec: DriveSpec,
  fileOnly: boolean,
): Promise<Obj> {
  const file = object(
    await api.get(`/files/${enc(spec.fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: true }),
  );
  if (file.id !== spec.fileId || typeof file.trashed !== "boolean")
    throw new NativeActionError(
      "incomplete_response",
      "Drive did not confirm the selected file state.",
    );
  decimal(file.version);
  if (fileOnly && file.isAppAuthorized !== true)
    throw new NativeActionError(
      "resource_unavailable",
      "The selected file is not authorized for this Google app.",
    );
  context.signal.throwIfAborted();
  return file;
}
/** The scope flag is supplied by the exact grant transport, never by a model or Routine input. */
export async function readDriveChanges(
  context: NativeSourceReadContext,
  api: NativeEventReadApi,
  now = new Date(),
  options: { driveFileOnly?: boolean } = {},
): Promise<NativeSourceReadResult> {
  const spec = context.row.spec as DriveSpec;
  if (!["drive.file_changed", "drive.file_trashed"].includes(spec.kind))
    throw new NativeActionError("invalid_input", "This source is not a Drive trigger.");
  const previous = optional(context.row.state),
    saved = optional(previous.driveChanged),
    queryFingerprint = fingerprint(context);
  const baseline =
    previous.ready !== true ||
    saved.queryFingerprint !== queryFingerprint ||
    typeof saved.pageToken !== "string";
  let pageToken: string, lastVersion: string, lastTrashed: boolean;
  if (baseline) {
    const start = object(await api.get("/changes/startPageToken", { supportsAllDrives: true }));
    pageToken = id(start.startPageToken);
    const file = await driveFile(context, api, spec, options.driveFileOnly !== false);
    lastVersion = decimal(file.version);
    lastTrashed = file.trashed as boolean;
  } else {
    pageToken = id(saved.pageToken);
    lastVersion = decimal(saved.lastVersion);
    if (typeof saved.lastTrashed !== "boolean")
      throw new NativeActionError("incomplete_response", "Drive baseline omitted its trash state.");
    lastTrashed = saved.lastTrashed;
  }
  const seen = new Set<string>([pageToken]);
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    context.signal.throwIfAborted();
    const page = object(
      await api.get("/changes", {
        pageToken,
        pageSize: 1000,
        spaces: "drive",
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        fields: "nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType)",
      }),
    );
    if (!Array.isArray(page.changes))
      throw new NativeActionError(
        "incomplete_response",
        "Drive changes pagination was incomplete.",
      );
    for (const raw of page.changes) {
      const change = object(raw);
      if (change.fileId !== spec.fileId) continue;
      // removed means deletion OR loss of access. Only a successful authority read can establish current trash state.
      const file = await driveFile(context, api, spec, options.driveFileOnly !== false);
      const version = decimal(file.version),
        trashed = file.trashed as boolean;
      if (BigInt(version) < BigInt(lastVersion))
        throw new NativeActionError(
          "incomplete_response",
          "Drive returned a regressing file version.",
        );
      const changed = version !== lastVersion || trashed !== lastTrashed;
      const newlyTrashed = !lastTrashed && trashed;
      const occurred = typeof change.time === "string" ? Date.parse(change.time) : Number.NaN;
      if (!Number.isFinite(occurred))
        throw new NativeActionError(
          "incomplete_response",
          "Drive omitted the authoritative change time.",
        );
      if (!baseline && changed && (spec.kind === "drive.file_changed" || newlyTrashed)) {
        const event = observe(context, {
          evidence: "drive_changes",
          eventIdentity: `drive:${spec.fileId}:${version}:${trashed}`,
          observedVersion: version,
          occurredAt: new Date(occurred).toISOString(),
          fileId: spec.fileId,
          trashed,
        });
        if (nativeObservationMatches(context.row, event, now)) await context.emit(event);
      }
      lastVersion = version;
      lastTrashed = trashed;
    }
    await context.heartbeat();
    if (page.nextPageToken === undefined) {
      const next = id(page.newStartPageToken);
      return result(
        {
          ...previous,
          ready: true,
          driveChanged: { queryFingerprint, pageToken: next, lastVersion, lastTrashed },
        },
        now,
      );
    }
    const next = id(page.nextPageToken);
    if (seen.has(next))
      throw new NativeActionError("incomplete_response", "Drive repeated a pagination cursor.");
    seen.add(next);
    pageToken = next;
  }
  throw new NativeActionError(
    "incomplete_response",
    "Drive exceeded the bounded changes pagination budget; the cursor was not advanced.",
  );
}
