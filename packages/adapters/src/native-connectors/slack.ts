import { createHash } from "node:crypto";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import type { NativeAction, NativeActionContext, NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import type { CollaborationDefinition, CollaborationRun, Data } from "./collaboration-action.js";
import {
  array,
  collaborationActions,
  identity,
  incomplete,
  invalid,
  object,
  scopes,
  select,
  text,
} from "./collaboration-action.js";
import contract from "./slack.contract.json" with { type: "json" };

const HISTORY = ["channels:history", "groups:history", "im:history", "mpim:history"];
const TYPES: Record<string, string> = {
  public_channel: "channels:read",
  private_channel: "groups:read",
  im: "im:read",
  mpim: "mpim:read",
};
const USER_FIELDS = [
  "id",
  "team_id",
  "name",
  "real_name",
  "deleted",
  "is_bot",
  "is_app_user",
  "tz",
  "profile",
];
const CHANNEL_FIELDS = [
  "id",
  "name",
  "is_channel",
  "is_group",
  "is_im",
  "is_mpim",
  "is_private",
  "is_member",
  "is_archived",
  "is_ext_shared",
  "is_org_shared",
  "user",
  "topic",
  "purpose",
  "num_members",
];
const MESSAGE_FIELDS = [
  "type",
  "subtype",
  "ts",
  "thread_ts",
  "user",
  "bot_id",
  "app_id",
  "text",
  "blocks",
  "attachments",
  "files",
  "reply_count",
  "reply_users",
  "edited",
  "reactions",
  "permalink",
  "channel",
];
function authorize(definition: CollaborationDefinition, context: NativeActionContext): void {
  const p = context.principal,
    c = p.context;
  if (
    !["bot", "user"].includes(String(c.tokenType)) ||
    typeof c.teamId !== "string" ||
    c.teamId !== p.tenant ||
    (c.tokenType === "bot" ? c.botUserId : c.userId) !== p.subject
  )
    throw new NativeActionError(
      "authorization_required",
      "Select a verified Slack bot or personal account in this workspace.",
    );
  scopes(context, definition.authorization.acceptedAnyOfScopes);
  const id = definition.id,
    userData =
      id.includes(".search.") ||
      id.includes(".files.") ||
      id === "slack.conversations.history" ||
      id === "slack.conversations.replies" ||
      id === "slack.messages.update" ||
      id === "slack.messages.delete";
  if (c.tokenType === "user" && userData && c.slackUserDataAllowed !== true)
    throw new NativeActionError(
      "not_configured",
      "Personal Slack data access requires an approved collection policy for this app.",
    );
  if (id.includes(".search.") && (c.tokenType !== "user" || c.slackLegacySearchAllowed !== true))
    throw new NativeActionError(
      "not_configured",
      "This connection has no verified legacy Slack search capability. Real-time Search is not enabled.",
    );
}
function page(data: Data, key: string, project: (value: unknown) => unknown): Data {
  const items = array(data[key]).map(project),
    metadata = data.response_metadata === undefined ? {} : object(data.response_metadata);
  const cursor = metadata.next_cursor;
  if (cursor !== undefined && typeof cursor !== "string")
    return incomplete("Slack returned an invalid next cursor.");
  if (data.has_more !== undefined && typeof data.has_more !== "boolean")
    return incomplete("Slack returned invalid pagination metadata.");
  const hasMore = Boolean(cursor) || data.has_more === true;
  return {
    items,
    nextCursor: cursor || null,
    hasMore,
    allPagesRead: false,
    ...(hasMore && !cursor ? { continuationRequiresTimeBoundary: true } : {}),
  };
}
async function call(
  run: CollaborationRun,
  method: NativeRequest["method"],
  methodName: string,
  args: Data,
  write = false,
): Promise<Data> {
  const response = await run.request(
    {
      method,
      path: `/${methodName}`,
      ...(method === "GET"
        ? { query: args as Record<string, string | number | boolean> }
        : { body: args }),
    },
    write,
    methodName,
  );
  const data = object(response.body);
  if (data.ok !== true) {
    const error = typeof data.error === "string" ? data.error : "unconfirmed_response";
    if (
      write &&
      [
        "fatal_error",
        "internal_error",
        "request_timeout",
        "service_unavailable",
        "unconfirmed_response",
      ].includes(error)
    )
      return run.unknown(
        "Slack may have partially completed this write. Its receipt must be reconciled before retrying.",
      );
    if (data.ok !== false || typeof data.error !== "string")
      return incomplete("Slack omitted an explicit method outcome.");
    const kind = [
      "invalid_auth",
      "not_authed",
      "token_expired",
      "token_revoked",
      "account_inactive",
    ].includes(error)
      ? "authorization_expired"
      : [
            "missing_scope",
            "no_permission",
            "not_allowed_token_type",
            "cant_update_message",
            "cant_delete_message",
            "restricted_action",
          ].includes(error)
        ? "insufficient_scope"
        : [
              "channel_not_found",
              "message_not_found",
              "file_not_found",
              "thread_not_found",
              "user_not_found",
              "not_in_channel",
            ].includes(error)
          ? "resource_unavailable"
          : error === "ratelimited"
            ? "rate_limited"
            : "invalid_input";
    throw new NativeActionError(
      kind,
      `Slack rejected this method (${error.replace(/[^a-z0-9_]/g, "").slice(0, 80)}).`,
      { recovery: { ...run.receipt, upstream_code: error } },
    );
  }
  return data;
}
async function ownMessage(args: Data, run: CollaborationRun): Promise<void> {
  scopes(run.context, HISTORY);
  const response = await call(run, "GET", "conversations.history", {
    channel: args.channel,
    oldest: args.ts,
    latest: args.ts,
    inclusive: true,
    limit: 1,
  });
  const messages = array(response.messages).map(object),
    message = messages.find((row) => row.ts === args.ts);
  if (!message)
    throw new NativeActionError(
      "resource_unavailable",
      "The exact selected message is not available.",
    );
  if (message.user !== run.context.principal.subject)
    throw new NativeActionError(
      "insufficient_scope",
      "Only a message owned by the selected Slack account can be changed.",
    );
}
function resourceUrl(value: unknown, upload: boolean): string {
  const url = new URL(text(value));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(upload ? /^\/upload\/v1\/[A-Za-z0-9_\-/]+$/ : /^\/files-(pri|tmb)\//).test(url.pathname)
  )
    return invalid("Slack returned a file URL outside the supported provider authority.");
  return url.toString();
}
function user(value: unknown, context: NativeActionContext): Data {
  const item = select(identity(value), USER_FIELDS);
  if (item.profile) {
    const fields = ["real_name", "display_name", "status_text", "status_emoji", "image_72"];
    if (context.principal.scopes.includes("users:read.email")) fields.push("email");
    item.profile = select(object(item.profile), fields);
  }
  return item;
}
function channel(value: unknown): Data {
  return select(identity(value), CHANNEL_FIELDS);
}
function message(value: unknown): Data {
  const item = select(object(value), MESSAGE_FIELDS);
  text(item.ts);
  // Private file URLs never leave the authorized download path.
  if (Array.isArray(item.files))
    item.files = item.files.map((f) =>
      select(identity(f), ["id", "name", "title", "mimetype", "size", "permalink"]),
    );
  return item;
}
export function createSlackActions(): NativeAction[] {
  return collaborationActions(
    contract.actions,
    async (args, run) => {
      const id = run.definition.id,
        context = run.context;
      if (id === "slack.users.resolve") {
        if (args.userId || args.email) {
          if (args.email) scopes(context, ["users:read.email"]);
          const data = await call(
            run,
            "GET",
            args.email ? "users.lookupByEmail" : "users.info",
            args.email ? { email: args.email } : { user: args.userId },
          );
          const result = user(data.user, context);
          if (args.userId && result.id !== args.userId)
            return incomplete("Slack returned another user.");
          return run.finish({ users: [result], ambiguous: false, hasMore: false });
        }
        const data = await call(run, "GET", "users.list", {
          limit: args.limit ?? 100,
          ...select(args, ["cursor"]),
        });
        const all = page(data, "members", (value) => user(value, context)),
          query = String(args.query).toLocaleLowerCase();
        const matches = (all.items as Data[]).filter((item) =>
          [item.name, item.real_name, object(item.profile ?? {}).display_name].some(
            (name) => typeof name === "string" && name.toLocaleLowerCase().includes(query),
          ),
        );
        return run.finish({
          users: matches,
          ambiguous: matches.length !== 1 || all.hasMore === true,
          hasMore: all.hasMore,
          nextCursor: all.nextCursor,
          searchedSinglePage: true,
        });
      }
      if (id === "slack.conversations.list") {
        const types = (args.types ?? ["public_channel"]) as string[];
        for (const type of types) scopes(context, [TYPES[type]!]);
        const data = await call(run, "GET", "conversations.list", {
          limit: args.limit ?? 100,
          types: types.join(","),
          exclude_archived: args.exclude_archived ?? true,
          ...select(args, ["cursor"]),
        });
        return run.finish(page(data, "channels", channel));
      }
      if (id === "slack.conversations.get") {
        const data = await call(run, "GET", "conversations.info", { channel: args.channel }),
          selected = channel(data.channel);
        if (selected.id !== args.channel) return incomplete("Slack returned another conversation.");
        const members =
          args.includeMembers === true
            ? page(
                await call(run, "GET", "conversations.members", {
                  channel: args.channel,
                  limit: args.limit ?? 100,
                  ...select(args, ["cursor"]),
                }),
                "members",
                text,
              )
            : undefined;
        return run.finish({ channel: selected, ...(members ? { members } : {}) });
      }
      if (id === "slack.conversations.history" || id === "slack.conversations.replies") {
        const data = await call(
          run,
          "GET",
          id.endsWith("history") ? "conversations.history" : "conversations.replies",
          { ...args, limit: args.limit ?? 15 },
        );
        return run.finish(page(data, "messages", message));
      }
      if (id.includes(".search.")) {
        const key = id.endsWith("messages") ? "messages" : "files",
          data = object(
            (
              await call(run, "GET", `search.${key}`, {
                page: args.page ?? 1,
                count: args.count ?? 20,
                ...args,
              })
            )[key],
          );
        const paging = object(data.paging),
          totalPages = Number(paging.pages),
          current = Number(paging.page);
        if (
          !Number.isSafeInteger(totalPages) ||
          !Number.isSafeInteger(current) ||
          current < 1 ||
          totalPages < 0
        )
          return incomplete("Slack omitted search pagination.");
        const items = array(data.matches).map(
          key === "messages"
            ? message
            : (value) =>
                select(identity(value), ["id", "title", "name", "mimetype", "size", "permalink"]),
        );
        return run.finish({
          items,
          total: paging.total,
          hasMore: current < totalPages,
          nextPage: current < totalPages ? current + 1 : null,
          allPagesRead: current === 1 && current >= totalPages,
        });
      }
      if (
        [
          "slack.messages.send",
          "slack.messages.reply",
          "slack.messages.update",
          "slack.messages.delete",
        ].includes(id)
      ) {
        const method = id.endsWith("update")
          ? "chat.update"
          : id.endsWith("delete")
            ? "chat.delete"
            : "chat.postMessage";
        if (method !== "chat.postMessage") await ownMessage(args, run);
        const body =
          method === "chat.postMessage"
            ? {
                ...args,
                ...(id.endsWith("reply") ? { reply_broadcast: args.reply_broadcast ?? false } : {}),
                unfurl_links: args.unfurl_links ?? false,
                unfurl_media: args.unfurl_media ?? false,
              }
            : args;
        const data = await call(run, "POST", method, body, true),
          ts = text(data.ts),
          selectedChannel = text(data.channel);
        if (selectedChannel !== args.channel || (method !== "chat.postMessage" && ts !== args.ts))
          return run.unknown("Slack did not confirm the exact selected message.");
        return run.finish(
          {
            channel: selectedChannel,
            ts,
            ...(data.message ? { message: message(data.message) } : {}),
            ...(data.text !== undefined ? { text: data.text } : {}),
          },
          { channel: selectedChannel, ts },
        );
      }
      if (id === "slack.messages.schedule") {
        const now = Math.floor(Date.now() / 1000),
          when = Number(args.post_at);
        if (when <= now || when > now + 120 * 86400)
          return invalid("Choose a future scheduled time within 120 days.");
        const data = await call(run, "POST", "chat.scheduleMessage", args, true),
          scheduledId = text(data.scheduled_message_id);
        if (data.channel !== args.channel || Number(data.post_at) !== when)
          return run.unknown("Slack did not confirm the selected schedule destination and time.");
        return run.finish(
          { channel: args.channel, scheduled_message_id: scheduledId, post_at: when },
          { channel: args.channel, scheduled_message_id: scheduledId },
        );
      }
      if (id === "slack.scheduled.list")
        return run.finish({
          ...page(
            await call(run, "POST", "chat.scheduledMessages.list", {
              limit: args.limit ?? 100,
              ...args,
            }),
            "scheduled_messages",
            (value) =>
              select(identity(value), ["id", "channel_id", "post_at", "date_created", "text"]),
          ),
          origin: "selected_token_api_schedules_only",
        });
      if (id === "slack.scheduled.cancel") {
        await call(run, "POST", "chat.deleteScheduledMessage", args, true);
        return run.finish(
          { channel: args.channel, scheduled_message_id: args.scheduled_message_id },
          { channel: args.channel, scheduled_message_id: args.scheduled_message_id },
        );
      }
      if (id === "slack.conversations.open") {
        const users = args.users as string[];
        scopes(context, [users.length > 1 ? "mpim:write" : "im:write"]);
        const data = await call(
            run,
            "POST",
            "conversations.open",
            { users: users.join(","), return_im: true },
            true,
          ),
          selected = channel(data.channel);
        return run.finish({ channel: selected }, { resource_id: selected.id });
      }
      if (id === "slack.reactions.add") {
        await call(run, "POST", "reactions.add", args, true);
        return run.finish(
          { channel: args.channel, timestamp: args.timestamp, name: args.name },
          { channel: args.channel, ts: args.timestamp },
        );
      }
      if (id === "slack.files.upload") {
        if (!context.uploadResource)
          throw new NativeActionError(
            "not_configured",
            "The bounded Slack file upload transport is unavailable.",
          );
        const artifact = await context.readArtifact(String(args.artifactId));
        if (!artifact.bytes.length || artifact.bytes.length > ATTACHMENT_MAX_BYTES)
          return invalid("Choose a nonempty artifact no larger than 10 MiB.");
        const digest = createHash("sha256").update(artifact.bytes).digest("hex");
        await run.checkpoint({
          artifact_sha256: digest,
          artifact_bytes: artifact.bytes.length,
          channel: args.channel_id,
          ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}),
        });
        const allocation = await call(
            run,
            "POST",
            "files.getUploadURLExternal",
            { filename: args.filename, length: artifact.bytes.length },
            true,
          ),
          fileId = text(allocation.file_id),
          url = resourceUrl(allocation.upload_url, true);
        await context.validateResourceUrl(url);
        await run.checkpoint({
          stage: "upload_bytes",
          dispatch_state: "in_flight",
          file_id: fileId,
        });
        let uploaded: { status: number };
        try {
          uploaded = await context.uploadResource({
            url,
            bytes: artifact.bytes,
            contentType: "application/octet-stream",
          });
        } catch {
          return run.unknown(
            "The file byte upload response was lost; it will not be repeated or completed automatically.",
          );
        }
        if (uploaded.status < 200 || uploaded.status >= 300)
          return run.unknown("Slack did not confirm all uploaded bytes.");
        const data = await call(
          run,
          "POST",
          "files.completeUploadExternal",
          {
            files: [{ id: fileId, title: args.title ?? args.filename }],
            channel_id: args.channel_id,
            ...select(args, ["initial_comment", "thread_ts"]),
          },
          true,
        );
        const files = array(data.files).map(identity);
        if (files.length !== 1 || files[0]!.id !== fileId)
          return run.unknown("Slack did not confirm completion of this exact file.");
        return run.finish(
          {
            file_id: fileId,
            channel: args.channel_id,
            file: select(files[0]!, ["id", "title", "name", "size", "mimetype", "permalink"]),
          },
          { file_id: fileId, channel: args.channel_id },
        );
      }
      if (!context.downloadResource || !context.writeArtifact)
        throw new NativeActionError(
          "not_configured",
          "The bounded Slack file download transport is unavailable.",
        );
      const data = await call(run, "GET", "files.info", { file: args.file }),
        file = identity(data.file);
      if (file.id !== args.file) return incomplete("Slack returned another file.");
      const maxBytes = Number(args.maxBytes ?? ATTACHMENT_MAX_BYTES);
      if (!Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > maxBytes)
        return invalid("This file exceeds the selected download budget or has no verified size.");
      const url = resourceUrl(file.url_private_download ?? file.url_private, false);
      await context.validateResourceUrl(url);
      const download = await context.downloadResource({ url, maxBytes });
      if (download.bytes.length !== file.size || download.bytes.length > maxBytes)
        return incomplete("The authorized file download was incomplete.");
      const name = text(file.name);
      if (/[/\\\r\n]/.test(name)) return incomplete("Slack returned an invalid artifact name.");
      const artifact = await context.writeArtifact({
        bytes: download.bytes,
        name,
        mimeType: typeof file.mimetype === "string" ? file.mimetype : download.mimeType,
      });
      return run.finish({
        file_id: file.id,
        artifact,
        file: select(file, ["id", "name", "title", "mimetype", "size", "permalink"]),
      });
    },
    authorize,
  );
}
export const slackActions = createSlackActions();
