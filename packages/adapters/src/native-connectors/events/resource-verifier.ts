import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type {
  NativeEventAuthorizationProof,
  NativeEventScope,
  NativeRoutineTriggerInput,
  PreparedNativeRoutineTrigger,
} from "@rakazo/contracts";
import {
  NativeRoutineTriggerInputSchema,
  nativeEventApp,
  nativeEventResource,
} from "@rakazo/contracts";
import { connectionAuthorizationRevision } from "../../connector-account-binding.js";
import type { RemoteTransportDependencies } from "../../remote-mcp.js";
import { NativeActionError } from "../action.js";
import { NativeConfigSettingsSchema } from "../config.js";
import { NativeHttpClient } from "../http.js";
import type { NativeOAuthStore } from "../oauth.js";
import { nativeServiceBase } from "../service-bases.js";
import { nativeEventReadPermitted, onlyDriveFileScope } from "./authorization.js";
import { verifyRemainingEventResource } from "./remaining-resources.js";
import { isRemainingEventSpec, withRemainingNativeRead } from "./remaining-transport.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeActionError("incomplete_response", "The resource identity was not returned.");
  return value as RecordValue;
};
const optionalObject = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
const sameId = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();
const enc = encodeURIComponent;
/** Fixed API authorities and NativeOAuthStore are reused; this performs reads only and returns no credentials. */
export class NativeEventResourceVerifier {
  constructor(
    private readonly oauth: Pick<NativeOAuthStore, "authorization"> &
      Partial<Pick<NativeOAuthStore, "rejectCredential">>,
    private readonly options: { network?: RemoteTransportDependencies } = {},
  ) {}
  async prepare(
    scope: NativeEventScope,
    raw: NativeRoutineTriggerInput,
    signal: AbortSignal,
  ): Promise<PreparedNativeRoutineTrigger> {
    const input = NativeRoutineTriggerInputSchema.parse(raw),
      appId = nativeEventApp(input.spec);
    const context: AdapterContext = {
      ...scope,
      operationId: `native-event-verify:${randomUUID()}`,
      traceId: "native-event-verify",
      signal,
    };
    const initial = await this.oauth.authorization(input.connectionId, context);
    const revision = connectionAuthorizationRevision(initial.connection);
    if (
      !revision ||
      typeof optionalObject(initial.connection.metadata)?.authRevision !== "string" ||
      initial.connection.connectorId !== "native" ||
      initial.connection.provider !== appId ||
      initial.config.appId !== appId ||
      initial.connection.userId !== scope.userId ||
      initial.connection.spaceId !== scope.spaceId
    )
      throw new NativeActionError(
        "authorization_required",
        "Choose the exact native account for this trigger.",
      );
    const settings = NativeConfigSettingsSchema.parse(initial.config.config);
    const permitted = (live: typeof initial) => {
      const scopes = live.grant.scopes.filter((scope) => settings.scopes.includes(scope));
      return nativeEventReadPermitted(input.spec, scopes, settings.capabilities, {
        ...(optionalObject(optionalObject(live.auth.identity)?.context) ??
          optionalObject(live.grant.principal) ??
          {}),
        configuredScopes: settings.scopes,
      });
    };
    if (!permitted(initial))
      throw new NativeActionError(
        "insufficient_scope",
        "This event requires read access not granted to the selected connection.",
      );
    const revalidate = async (force = false) => {
      const live = await this.oauth.authorization(input.connectionId, context, force);
      if (
        live.connection.userId !== scope.userId ||
        live.connection.spaceId !== scope.spaceId ||
        live.connection.connectorId !== "native" ||
        live.connection.provider !== appId ||
        connectionAuthorizationRevision(live.connection) !== revision ||
        live.grant.id !== initial.grant.id ||
        live.grant.authGeneration !== initial.grant.authGeneration ||
        live.config.id !== initial.config.id ||
        live.config.revision !== initial.config.revision ||
        !permitted(live)
      )
        throw new NativeActionError(
          "authorization_required",
          "This account authorization changed while the resource was being verified.",
        );
      return live;
    };
    if (isRemainingEventSpec(input.spec)) {
      const spec = input.spec;
      await withRemainingNativeRead(
        initial,
        revalidate,
        signal,
        async (api, principal) => {
          if (settings.boundSpaceId && settings.boundSpaceId !== scope.spaceId)
            throw new NativeActionError(
              "authorization_required",
              "This application belongs to a different space.",
            );
          await verifyRemainingEventResource(spec, api, principal);
        },
        this.options.network,
        (version) =>
          this.oauth.rejectCredential?.(input.connectionId, context, version) ?? Promise.resolve(),
      );
      const live = await revalidate();
      return {
        input,
        proof: {
          ...scope,
          connectionId: input.connectionId,
          authorizationRevision: revision,
          grantId: live.grant.id,
          authGeneration: live.grant.authGeneration,
          configId: live.config.id,
          configRevision: live.config.revision,
          appId,
          resource: nativeEventResource(input.spec),
          spec: input.spec,
        },
      };
    }
    const http = new NativeHttpClient(
      nativeServiceBase(appId),
      async () => ({ kind: "bearer", value: (await revalidate()).auth.tokens.accessToken }),
      {
        network: this.options.network,
        signal,
        readOnly: true,
        headers: appId === "notion" ? { "Notion-Version": "2026-03-11" } : undefined,
      },
    );
    const get = async (
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
    ) => object((await http.request({ method: "GET", path, query })).body);
    try {
      if (
        input.spec.kind === "gmail.message_received" ||
        input.spec.kind === "gmail.thread_or_label_changed"
      ) {
        const profile = await get("/users/me/profile");
        if (typeof profile.historyId !== "string" || typeof profile.emailAddress !== "string")
          throw new NativeActionError(
            "incomplete_response",
            "The mailbox identity was not verified.",
          );
        for (const labelId of input.spec.labelIds ?? []) {
          const label = await get(`/users/me/labels/${enc(labelId)}`);
          if (label.id !== labelId)
            throw new NativeActionError(
              "resource_unavailable",
              "The exact mailbox label is unavailable.",
            );
        }
        if (input.spec.threadId) {
          const thread = await get(`/users/me/threads/${enc(input.spec.threadId)}`, {
            format: "metadata",
          });
          if (thread.id !== input.spec.threadId)
            throw new NativeActionError("resource_unavailable", "The exact thread is unavailable.");
        }
      } else if (
        input.spec.kind === "drive.file_changed" ||
        input.spec.kind === "drive.file_trashed"
      ) {
        const file = await get(`/files/${enc(input.spec.fileId)}`, {
          fields: "id,version,trashed,isAppAuthorized",
          supportsAllDrives: true,
        });
        const effective = initial.grant.scopes.filter((scope) => settings.scopes.includes(scope));
        if (
          file.id !== input.spec.fileId ||
          (onlyDriveFileScope(effective) && file.isAppAuthorized !== true)
        )
          throw new NativeActionError(
            "resource_unavailable",
            "This file has not been authorized to the application.",
          );
      } else if (
        input.spec.kind === "slack.app_mention" ||
        input.spec.kind === "slack.app_dm" ||
        input.spec.kind === "slack.channel_message"
      ) {
        const result = await get("/conversations.info", { channel: input.spec.channelId });
        const channel = optionalObject(result.channel);
        if (
          result.ok !== true ||
          channel?.id !== input.spec.channelId ||
          channel.is_archived === true ||
          (input.spec.kind === "slack.app_dm" ? channel.is_im !== true : channel.is_member !== true)
        )
          throw new NativeActionError(
            "resource_unavailable",
            "The selected bot cannot access this exact conversation.",
          );
        const effective = initial.grant.scopes.filter((scope) => settings.scopes.includes(scope));
        const historyScope =
          channel.is_im === true
            ? "im:history"
            : channel.is_private === true
              ? "groups:history"
              : "channels:history";
        if (input.spec.kind !== "slack.app_mention" && !effective.includes(historyScope))
          throw new NativeActionError(
            "insufficient_scope",
            "The exact conversation requires its own bot history scope.",
          );
        if (input.spec.kind === "slack.channel_message" && input.spec.threadTs) {
          const replies = await get("/conversations.replies", {
            channel: input.spec.channelId,
            ts: input.spec.threadTs,
            limit: 1,
          });
          if (
            replies.ok !== true ||
            !Array.isArray(replies.messages) ||
            optionalObject(replies.messages[0])?.ts !== input.spec.threadTs
          )
            throw new NativeActionError("resource_unavailable", "The exact thread is unavailable.");
        }
      } else if (input.spec.kind.startsWith("calendar.")) {
        const spec = input.spec as Extract<
          typeof input.spec,
          { kind: "calendar.event_changed" | "calendar.event_starting" }
        >;
        const page = await get(`/calendars/${enc(spec.calendarId)}/events`, {
          maxResults: 1,
          singleEvents: false,
        });
        if (page.kind !== "calendar#events")
          throw new NativeActionError(
            "incomplete_response",
            "The selected calendar collection could not be verified.",
          );
        if (spec.target.kind !== "calendar") {
          const current = await get(
            `/calendars/${enc(spec.calendarId)}/events/${enc(spec.target.eventId)}`,
          );
          const actualKind =
            current.recurringEventId && current.originalStartTime
              ? "instance"
              : Array.isArray(current.recurrence) && current.recurrence.length
                ? "series"
                : "single";
          if (
            current.id !== spec.target.eventId ||
            current.status === "cancelled" ||
            actualKind !== spec.target.kind
          )
            throw new NativeActionError(
              "resource_unavailable",
              "The exact Calendar recurrence target is no longer available.",
            );
        }
      } else {
        const resource = nativeEventResource(input.spec);
        const page = async (id: string) => {
          const result = await get(`/v1/pages/${enc(id)}`);
          if (result.object !== "page" || !sameId(result.id, id))
            throw new NativeActionError(
              "incomplete_response",
              "The selected page identity was not verified.",
            );
          return result;
        };
        const block = async (id: string) => {
          const result = await get(`/v1/blocks/${enc(id)}`);
          if (result.object !== "block" || !sameId(result.id, id))
            throw new NativeActionError(
              "incomplete_response",
              "The selected block identity was not verified.",
            );
          return result;
        };
        let authoritative: RecordValue;
        if (resource.type === "data_source") {
          authoritative = await get(`/v1/data_sources/${enc(resource.id)}`);
          if (authoritative.object !== "data_source" || !sameId(authoritative.id, resource.id))
            throw new NativeActionError(
              "resource_unavailable",
              "The selected data source is not available.",
            );
        } else if (resource.type === "page") authoritative = await page(resource.id);
        else {
          if (input.spec.kind !== "notion.comment_changed" || input.spec.target.type === "page")
            throw new NativeActionError("invalid_input", "Unsupported native trigger resource.");
          const target = input.spec.target;
          const anchor = target.type === "block" ? target.blockId : target.anchorBlockId;
          await page(target.pageId);
          let current = anchor;
          const visited = new Set<string>();
          let matches = sameId(anchor, target.pageId);
          while (!matches && visited.size < 100) {
            if (visited.has(current)) break;
            visited.add(current);
            const parent = optionalObject((await block(current)).parent);
            if (parent?.type === "page_id") {
              matches = sameId(parent.page_id, target.pageId);
              break;
            }
            if (parent?.type !== "block_id" || typeof parent.block_id !== "string") break;
            current = parent.block_id;
          }
          if (!matches)
            throw new NativeActionError(
              "resource_unavailable",
              "The comment anchor is not verified under the selected page.",
            );
          authoritative = await page(target.pageId);
          if (target.type === "discussion") {
            let cursor: string | undefined;
            const seen = new Set<string>();
            let found = false;
            for (let request = 0; request < 100; request++) {
              const comments = await get("/v1/comments", {
                block_id: anchor,
                page_size: 100,
                start_cursor: cursor,
              });
              if (
                !Array.isArray(comments.results) ||
                typeof comments.has_more !== "boolean" ||
                (comments.has_more &&
                  (typeof comments.next_cursor !== "string" || !comments.next_cursor))
              )
                throw new NativeActionError(
                  "incomplete_response",
                  "The comment scope was incomplete.",
                );
              if (
                comments.results.some((comment) =>
                  sameId(optionalObject(comment)?.discussion_id, target.discussionId),
                )
              ) {
                found = true;
                break;
              }
              if (!comments.has_more) break;
              cursor = String(comments.next_cursor);
              if (seen.has(cursor))
                throw new NativeActionError("incomplete_response", "The comment cursor repeated.");
              seen.add(cursor);
            }
            if (!found)
              throw new NativeActionError(
                "resource_unavailable",
                "The exact discussion could not be verified under this anchor.",
              );
          }
        }
        if (
          input.spec.kind === "notion.page_properties_or_data_source_changed" &&
          input.spec.propertyIds
        ) {
          const properties = optionalObject(authoritative.properties);
          const available = Object.values(properties ?? {}).flatMap((property) =>
            typeof optionalObject(property)?.id === "string"
              ? [String(optionalObject(property)?.id)]
              : [],
          );
          const decode = (value: string) => {
            try {
              return decodeURIComponent(value);
            } catch {
              throw new NativeActionError("invalid_input", "Malformed property ID.");
            }
          };
          if (
            input.spec.propertyIds.some(
              (id) => !available.some((actual) => decode(actual) === decode(id)),
            )
          )
            throw new NativeActionError(
              "resource_unavailable",
              "A selected property is not visible in the current schema.",
            );
        }
        if (input.spec.kind === "notion.comment_changed") {
          const target = input.spec.target;
          const anchor =
            target.type === "page"
              ? target.pageId
              : target.type === "block"
                ? target.blockId
                : target.anchorBlockId;
          const comments = await get("/v1/comments", { block_id: anchor, page_size: 1 });
          if (!Array.isArray(comments.results) || typeof comments.has_more !== "boolean")
            throw new NativeActionError(
              "incomplete_response",
              "Read access to comments could not be verified.",
            );
        }
      }
      const live = await revalidate();
      const proof: NativeEventAuthorizationProof = {
        ...scope,
        connectionId: input.connectionId,
        authorizationRevision: revision,
        grantId: live.grant.id,
        authGeneration: live.grant.authGeneration,
        configId: live.config.id,
        configRevision: live.config.revision,
        appId,
        resource: nativeEventResource(input.spec),
        spec: input.spec,
      };
      return { input, proof };
    } finally {
      await http.close();
    }
  }
}
