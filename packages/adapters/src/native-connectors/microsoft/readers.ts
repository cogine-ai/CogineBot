import { createHash } from "node:crypto";
import { NativeActionError } from "../action.js";
import { stable } from "../collaboration-action.js";
import type { Data } from "./graph.js";
import {
  array,
  graphLink,
  incomplete,
  invalid,
  object,
  odataString,
  resource,
  segment,
  text,
} from "./graph.js";

export type MicrosoftEventSpec =
  | { kind: "sharepoint.list_item.changed"; siteId: string; listId: string }
  | {
      kind: "excel.range.changed";
      driveId: string;
      itemId: string;
      worksheetId: string;
      address: string;
    }
  | { kind: "planner.task.changed"; planId: string }
  | { kind: "teams.channel_message.created"; teamId: string; channelId: string };
export interface MicrosoftEventObservation {
  eventIdentity: string;
  observedVersion: string;
  occurredAt: string;
  metadata: Data;
}
/** The existing source worker supplies a fenced API, generation fingerprint and durable emit. No poller is created here. */
export interface MicrosoftReadContext {
  spec: MicrosoftEventSpec;
  state?: Data;
  fingerprint: string;
  signal: AbortSignal;
  heartbeat(): Promise<void>;
  emit(observation: MicrosoftEventObservation): Promise<boolean>;
  now?: Date;
}
export interface MicrosoftReadApi {
  get(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown>;
}
export interface MicrosoftReadResult {
  state: Data;
  nextPollAt: Date;
}
const MAX_PAGES = 1000;
const MAX_ITEMS = 50000;
const optional = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const scope = (ctx: MicrosoftReadContext) =>
  digest({ spec: ctx.spec, generation: ctx.fingerprint });
function prior(ctx: MicrosoftReadContext): Data {
  const saved = optional(ctx.state?.microsoft);
  return saved.version === 1 && saved.fingerprint === scope(ctx) && saved.ready === true
    ? saved
    : {};
}
function result(ctx: MicrosoftReadContext, value: Data): MicrosoftReadResult {
  return {
    state: {
      ...ctx.state,
      microsoft: { ...value, version: 1, fingerprint: scope(ctx), ready: true },
    },
    nextPollAt: new Date((ctx.now ?? new Date()).getTime() + 60000),
  };
}
async function beat(ctx: MicrosoftReadContext): Promise<void> {
  ctx.signal.throwIfAborted();
  await ctx.heartbeat();
}
async function emit(
  ctx: MicrosoftReadContext,
  id: string,
  version: string,
  metadata: Data,
  at?: unknown,
): Promise<void> {
  await beat(ctx);
  const date =
    typeof at === "string" && Number.isFinite(Date.parse(at))
      ? new Date(at).toISOString()
      : (ctx.now ?? new Date()).toISOString();
  if (
    !(await ctx.emit({
      eventIdentity: digest({ kind: ctx.spec.kind, id, version }),
      observedVersion: version,
      occurredAt: date,
      metadata,
    }))
  )
    throw new NativeActionError(
      "temporarily_unavailable",
      "The existing event receipt was not accepted; keep the previous cursor.",
    );
}
async function pages(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<Data[]> {
  const rows: Data[] = [],
    seen = new Set<string>();
  let next: string | undefined;
  for (let index = 0; index < MAX_PAGES; index++) {
    await beat(ctx);
    const request = next ? graphLink(next, path) : { path, query },
      body = object(
        await api.get(
          request.path,
          request.query as Record<string, string | number | boolean | undefined>,
        ),
      );
    rows.push(...array(body.value).map((value) => resource(value)));
    if (rows.length > MAX_ITEMS)
      return incomplete(
        "The selected Microsoft collection exceeds the bounded event scan; cursor unchanged.",
      );
    if (body["@odata.nextLink"] === undefined) return rows;
    next = text(body["@odata.nextLink"]);
    graphLink(next, path);
    if (seen.has(next)) return incomplete("Microsoft repeated an event page cursor.");
    seen.add(next);
  }
  return incomplete("Microsoft event pagination did not complete; cursor unchanged.");
}
async function sharePoint(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
  forceBaseline = false,
): Promise<MicrosoftReadResult> {
  if (ctx.spec.kind !== "sharepoint.list_item.changed")
    return invalid("Select a SharePoint list source.");
  const spec = ctx.spec,
    saved = forceBaseline ? {} : prior(ctx),
    incremental = typeof saved.deltaLink === "string",
    path = `/sites/${segment(spec.siteId)}/lists/${segment(spec.listId)}/items/delta`,
    rows = new Map<string, Data>(),
    seen = new Set<string>();
  let next = incremental ? String(saved.deltaLink) : undefined;
  try {
    for (let index = 0; index < MAX_PAGES; index++) {
      await beat(ctx);
      const request = next ? graphLink(next, path) : { path, query: { token: "latest" } },
        body = object(
          await api.get(
            request.path,
            request.query as Record<string, string | number | boolean | undefined>,
          ),
        );
      for (const value of array(body.value)) {
        const row = resource(value);
        rows.set(text(row.id), row);
      }
      if (rows.size > MAX_ITEMS)
        return incomplete("The SharePoint delta exceeds the bounded event scan.");
      const link = body["@odata.nextLink"],
        delta = body["@odata.deltaLink"];
      if (link !== undefined && delta !== undefined)
        return incomplete("Microsoft returned conflicting delta cursors.");
      if (link !== undefined) {
        next = text(link);
        graphLink(next, path);
        if (seen.has(next)) return incomplete("Microsoft repeated a delta cursor.");
        seen.add(next);
        continue;
      }
      graphLink(delta, path);
      if (incremental)
        for (const row of rows.values()) {
          const removed = row.deleted !== undefined || row["@removed"] !== undefined;
          const version =
            typeof row.eTag === "string"
              ? row.eTag
              : typeof row["@odata.etag"] === "string"
                ? String(row["@odata.etag"])
                : digest({ cursor: saved.deltaLink, row });
          await emit(
            ctx,
            text(row.id),
            removed ? `removed:${version}` : version,
            {
              siteId: spec.siteId,
              listId: spec.listId,
              itemId: row.id,
              deleted: removed,
              ...(typeof row.webUrl === "string" ? { url: row.webUrl } : {}),
            },
            row.lastModifiedDateTime,
          );
        }
      return result(ctx, { deltaLink: delta });
    }
    return incomplete("SharePoint delta pagination did not complete; cursor unchanged.");
  } catch (error) {
    if (incremental && error instanceof NativeActionError && error.options.recovery?.status === 410)
      return sharePoint(ctx, api, true);
    throw error;
  }
}
async function excel(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
): Promise<MicrosoftReadResult> {
  if (ctx.spec.kind !== "excel.range.changed") return invalid("Select an Excel range source.");
  const spec = ctx.spec;
  if (!/^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?$/.test(spec.address))
    return invalid("Select a bounded Excel A1 range.");
  await beat(ctx);
  const body = object(
    await api.get(
      `/drives/${segment(spec.driveId)}/items/${segment(spec.itemId)}/workbook/worksheets/${segment(spec.worksheetId)}/range(address=${odataString(spec.address)})`,
    ),
  );
  const rowCount = Number(body.rowCount),
    columnCount = Number(body.columnCount);
  if (
    !Number.isSafeInteger(rowCount) ||
    !Number.isSafeInteger(columnCount) ||
    rowCount < 1 ||
    columnCount < 1 ||
    rowCount * columnCount > 10000 ||
    typeof body.address !== "string"
  )
    return incomplete("Excel omitted a complete bounded range.");
  const content: Data = {};
  for (const field of ["values", "formulas", "numberFormat"]) {
    const matrix = array(body[field]).map(array);
    if (matrix.length !== rowCount || matrix.some((row) => row.length !== columnCount))
      return incomplete("Excel omitted range cells; cursor unchanged.");
    content[field] = matrix;
  }
  const hash = digest(content),
    saved = prior(ctx);
  const changed = typeof saved.contentHash === "string" && saved.contentHash !== hash;
  const sequence =
    (Number.isSafeInteger(saved.sequence) && Number(saved.sequence) >= 0
      ? Number(saved.sequence)
      : 0) + (changed ? 1 : 0);
  if (!Number.isSafeInteger(sequence))
    return incomplete("Excel event sequence exceeded its safe integer bound.");
  if (changed)
    await emit(ctx, spec.itemId, `${sequence}:${hash}`, {
      driveId: spec.driveId,
      fileId: spec.itemId,
      worksheetId: spec.worksheetId,
      address: spec.address,
      rowCount,
      columnCount,
    });
  return result(ctx, { contentHash: hash, sequence });
}
async function planner(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
): Promise<MicrosoftReadResult> {
  if (ctx.spec.kind !== "planner.task.changed")
    return invalid("Select a Planner basic plan source.");
  const spec = ctx.spec,
    rows = await pages(ctx, api, `/planner/plans/${segment(spec.planId)}/tasks`),
    saved = prior(ctx),
    previous = optional(saved.versions),
    current: Data = {};
  for (const row of rows) {
    const id = text(row.id);
    if (row.planId !== spec.planId)
      return incomplete("Microsoft returned a task from another plan.");
    current[id] = text(row["@odata.etag"]);
  }
  if (saved.ready === true) {
    for (const row of rows)
      if (previous[text(row.id)] !== current[text(row.id)])
        await emit(ctx, text(row.id), text(current[text(row.id)]), {
          planId: spec.planId,
          taskId: row.id,
          ...(typeof row.createdDateTime === "string"
            ? { createdDateTime: row.createdDateTime }
            : {}),
          change: previous[text(row.id)] === undefined ? "created" : "updated",
        });
    for (const [id, version] of Object.entries(previous))
      if (!Object.hasOwn(current, id))
        await emit(ctx, id, `removed:${digest(version)}`, {
          planId: spec.planId,
          taskId: id,
          change: "removed_from_visible_plan",
        });
  }
  return result(ctx, { versions: current });
}
async function teams(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
): Promise<MicrosoftReadResult> {
  if (ctx.spec.kind !== "teams.channel_message.created")
    return invalid("Select a Teams channel source.");
  const spec = ctx.spec,
    rows = await pages(
      ctx,
      api,
      `/teams/${segment(spec.teamId)}/channels/${segment(spec.channelId)}/messages`,
      { $top: 50 },
    ),
    saved = prior(ctx),
    previous = optional(saved.messageIds),
    current: Data = {};
  // Complete pagination precedes all emissions. Message order changes when older threads receive replies.
  for (const row of rows) {
    const id = text(row.id),
      channel = object(row.channelIdentity);
    if (
      channel.teamId !== spec.teamId ||
      channel.channelId !== spec.channelId ||
      (row.replyToId !== undefined && row.replyToId !== null)
    )
      return incomplete("Microsoft returned another channel or a reply in the root collection.");
    if (
      typeof row.createdDateTime !== "string" ||
      !Number.isFinite(Date.parse(row.createdDateTime))
    )
      return incomplete("Microsoft omitted channel message creation time.");
    current[id] = row.createdDateTime;
  }
  if (saved.ready === true)
    for (const row of rows)
      if (
        !Object.hasOwn(previous, text(row.id)) &&
        row.deletedDateTime == null &&
        row.messageType === "message"
      )
        await emit(
          ctx,
          text(row.id),
          text(row.createdDateTime),
          {
            teamId: spec.teamId,
            channelId: spec.channelId,
            messageId: row.id,
            ...(typeof row.webUrl === "string" ? { url: row.webUrl } : {}),
          },
          row.createdDateTime,
        );
  return result(ctx, { messageIds: current });
}
export async function readMicrosoftEvent(
  ctx: MicrosoftReadContext,
  api: MicrosoftReadApi,
): Promise<MicrosoftReadResult> {
  if (!ctx.fingerprint)
    return invalid("The existing source generation must be bound before reading Microsoft events.");
  switch (ctx.spec.kind) {
    case "sharepoint.list_item.changed":
      return sharePoint(ctx, api);
    case "excel.range.changed":
      return excel(ctx, api);
    case "planner.task.changed":
      return planner(ctx, api);
    case "teams.channel_message.created":
      return teams(ctx, api);
  }
}
