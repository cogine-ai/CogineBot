import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NativeRoutineEventSpec } from "@rakazo/contracts";
import { z } from "zod";

export class InvalidNativeEventSignal extends Error {
  constructor() {
    super("Invalid native event signal.");
  }
}
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sameId = (a: string, b: string) =>
  a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();

export interface CalendarEventChannel {
  id: string;
  tokenHash: string;
  phase: "pending" | "active" | "retiring";
  resourceId: string | null;
  resourceUri: string | null;
  expiration: number | null;
}
export function calendarChannelTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** Headers are only a wake-up hint. Resource-URI is compared, NEVER fetched. */
export function verifyCalendarSignal(
  headers: Headers,
  channel: CalendarEventChannel,
  now = Date.now(),
): { phase: "early_sync" | "wake"; messageNumber: string; resourceId: string } {
  const id = headers.get("x-goog-channel-id"),
    token = headers.get("x-goog-channel-token"),
    resourceId = headers.get("x-goog-resource-id"),
    uri = headers.get("x-goog-resource-uri"),
    state = headers.get("x-goog-resource-state"),
    number = headers.get("x-goog-message-number");
  if (
    id !== channel.id ||
    !token ||
    token.length > 256 ||
    !equal(calendarChannelTokenHash(token), channel.tokenHash) ||
    !resourceId ||
    resourceId.length > 1024 ||
    !uri ||
    uri.length > 4096 ||
    !state ||
    !["sync", "exists", "not_exists"].includes(state) ||
    !number ||
    !/^[1-9][0-9]{0,127}$/.test(number) ||
    (state === "sync" && number !== "1") ||
    (channel.expiration !== null && now >= channel.expiration)
  )
    throw new InvalidNativeEventSignal();
  if (channel.phase === "pending") {
    if (state !== "sync") throw new InvalidNativeEventSignal();
    // Persist this hint only. Compare its resource ID/URI against the watch response before waking anything.
    return { phase: "early_sync", messageNumber: number, resourceId };
  }
  if (
    !channel.resourceId ||
    resourceId !== channel.resourceId ||
    !channel.resourceUri ||
    uri !== channel.resourceUri
  )
    throw new InvalidNativeEventSignal();
  return { phase: "wake", messageNumber: number, resourceId };
}

const supportedNotionTypes = [
  "page.content_updated",
  "page.created",
  "page.deleted",
  "page.moved",
  "page.undeleted",
  "page.properties_updated",
  "data_source.content_updated",
  "data_source.schema_updated",
  "data_source.created",
  "data_source.deleted",
  "data_source.moved",
  "data_source.undeleted",
  "comment.created",
  "comment.updated",
  "comment.deleted",
] as const;
const NotionEnvelopeSchema = z.object({
  id: uuid,
  timestamp: z.iso.datetime({ offset: true }),
  workspace_id: uuid,
  subscription_id: uuid,
  integration_id: uuid,
  type: z.string().min(1).max(128),
  api_version: z.string().max(32).optional(),
  accessible_by: z
    .array(z.object({ id: uuid, type: z.enum(["person", "bot"]) }))
    .max(1000)
    .optional(),
  entity: z.object({
    id: uuid,
    type: z.enum(["page", "block", "database", "data_source", "comment"]),
  }),
  data: z.object({
    page_id: uuid.optional(),
    parent: z
      .object({
        id: uuid,
        type: z.enum(["page", "block", "database", "data_source", "workspace", "space"]),
      })
      .optional(),
    updated_properties: z
      .array(z.union([z.string().min(1).max(1024), z.object({ id: z.string().min(1).max(1024) })]))
      .max(1000)
      .optional(),
  }),
});
export interface NotionVerifiedHook {
  integrationId: string;
  subscriptionId: string;
  verified: boolean;
  verificationToken: string;
}
export interface NotionEventSignal {
  id: string;
  timestamp: string;
  workspaceId: string;
  integrationId: string;
  subscriptionId: string;
  type: (typeof supportedNotionTypes)[number];
  apiVersion?: string;
  accessibleBy?: Array<{ id: string; type: "person" | "bot" }>;
  entity: { id: string; type: "page" | "block" | "database" | "data_source" | "comment" };
  pageId?: string;
  parent?: { id: string; type: "page" | "block" | "database" | "data_source" | "workspace" };
  propertyIds?: string[];
}
/** Setup may preview only signed identity; this alone does not trust/enable a hook. */
export function verifyNotionSetupIdentity(
  raw: Uint8Array,
  signature: string | null,
  verificationToken: string,
): { integrationId: string; subscriptionId: string } {
  if (
    !verificationToken ||
    raw.byteLength === 0 ||
    raw.byteLength > 262_144 ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    throw new InvalidNativeEventSignal();
  const expected = `sha256=${createHmac("sha256", verificationToken).update(raw).digest("hex")}`;
  if (!equal(signature, expected)) throw new InvalidNativeEventSignal();
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new InvalidNativeEventSignal();
  }
  const parsed = NotionEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new InvalidNativeEventSignal();
  return { integrationId: parsed.data.integration_id, subscriptionId: parsed.data.subscription_id };
}
/** Raw bytes + trusted owner configuration. verification_token POSTs are not runtime events. */
export function verifyNotionSignal(
  raw: Uint8Array,
  signature: string | null,
  hook: NotionVerifiedHook,
): NotionEventSignal | undefined {
  if (
    !hook.verified ||
    !hook.verificationToken ||
    raw.byteLength === 0 ||
    raw.byteLength > 262_144 ||
    !signature ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    throw new InvalidNativeEventSignal();
  const expected = `sha256=${createHmac("sha256", hook.verificationToken).update(raw).digest("hex")}`;
  if (!equal(signature, expected)) throw new InvalidNativeEventSignal();
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new InvalidNativeEventSignal();
  }
  const parsed = NotionEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new InvalidNativeEventSignal();
  const event = parsed.data;
  if (
    !sameId(event.integration_id, hook.integrationId) ||
    !sameId(event.subscription_id, hook.subscriptionId)
  )
    throw new InvalidNativeEventSignal();
  if (!(supportedNotionTypes as readonly string[]).includes(event.type)) return undefined;
  if (
    (event.type.startsWith("page.") && event.entity.type !== "page") ||
    (event.type.startsWith("data_source.") && event.entity.type !== "data_source") ||
    (event.type.startsWith("comment.") &&
      (event.entity.type !== "comment" ||
        !event.data.page_id ||
        !event.data.parent ||
        !["page", "block"].includes(event.data.parent.type)))
  )
    throw new InvalidNativeEventSignal();
  // Strip names, authors, arbitrary body/data and attempt count before durable jobs or model context.
  return {
    id: event.id,
    timestamp: event.timestamp,
    workspaceId: event.workspace_id,
    integrationId: event.integration_id,
    subscriptionId: event.subscription_id,
    type: event.type as NotionEventSignal["type"],
    ...(event.api_version ? { apiVersion: event.api_version } : {}),
    ...(event.accessible_by ? { accessibleBy: event.accessible_by } : {}),
    entity: event.entity,
    ...(event.data.page_id ? { pageId: event.data.page_id } : {}),
    ...(event.data.parent
      ? {
          parent: {
            ...event.data.parent,
            type: event.data.parent.type === "space" ? "workspace" : event.data.parent.type,
          },
        }
      : {}),
    ...(event.data.updated_properties
      ? {
          propertyIds: event.data.updated_properties.map((property) =>
            typeof property === "string" ? property : property.id,
          ),
        }
      : {}),
  };
}
export interface NotionEventPrincipal {
  workspaceId: string;
  botId: string;
  ownerUserId: string;
  credentialKind: "oauth";
}
/** Authors are never actors. accessible_by routing still requires a current REST read of the selected resource. */
export function notionSignalAccessible(
  signal: NotionEventSignal,
  principal: NotionEventPrincipal,
): boolean {
  // The verified grant already binds the natural owner. Do not require the webhook to also list that person.
  return (
    sameId(signal.workspaceId, principal.workspaceId) &&
    Boolean(
      signal.accessibleBy?.some(
        (entry) => entry.type === "bot" && sameId(entry.id, principal.botId),
      ),
    )
  );
}
/** Candidate filter only; exact discussion membership needs current read or stored, same-binding comment witness. */
export function notionSignalCandidate(
  spec: NativeRoutineEventSpec,
  signal: NotionEventSignal,
): boolean {
  if (spec.kind === "notion.page_content_changed")
    return (
      signal.entity.type === "page" &&
      sameId(signal.entity.id, spec.target.pageId) &&
      [
        "page.content_updated",
        "page.created",
        "page.deleted",
        "page.moved",
        "page.undeleted",
      ].includes(signal.type)
    );
  if (spec.kind === "notion.page_properties_or_data_source_changed") {
    if (spec.target.type === "page")
      return (
        signal.entity.type === "page" &&
        sameId(signal.entity.id, spec.target.pageId) &&
        [
          "page.properties_updated",
          "page.created",
          "page.deleted",
          "page.moved",
          "page.undeleted",
        ].includes(signal.type)
      );
    return (
      signal.entity.type === "data_source" &&
      sameId(signal.entity.id, spec.target.dataSourceId) &&
      signal.type.startsWith("data_source.")
    );
  }
  if (
    spec.kind !== "notion.comment_changed" ||
    !signal.type.startsWith("comment.") ||
    !signal.pageId ||
    !sameId(signal.pageId, spec.target.pageId)
  )
    return false;
  if (spec.target.type === "page")
    return signal.parent?.type === "page" && sameId(signal.parent.id, spec.target.pageId);
  const anchor = spec.target.type === "block" ? spec.target.blockId : spec.target.anchorBlockId;
  return Boolean(
    signal.parent &&
      ["page", "block"].includes(signal.parent.type) &&
      sameId(signal.parent.id, anchor),
  );
}
