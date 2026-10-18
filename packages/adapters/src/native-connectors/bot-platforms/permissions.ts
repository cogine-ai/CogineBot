import type { NativeAppConfig } from "@rakazo/db";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { array, incomplete, object, select, text } from "../collaboration-action.js";
import { NativeConfigSettingsSchema } from "../config.js";

export type BotRequest = (request: NativeRequest) => Promise<NativeResponse>;
export interface VerifiedTarget {
  id: string;
  guildId?: string;
  permissions?: string;
}
export const PERMISSIONS = {
  ADMINISTRATOR: 8n,
  ADD_REACTIONS: 64n,
  VIEW_CHANNEL: 1024n,
  SEND_MESSAGES: 2048n,
  MANAGE_MESSAGES: 8192n,
  ATTACH_FILES: 32768n,
  READ_MESSAGE_HISTORY: 65536n,
  SEND_MESSAGES_IN_THREADS: 274877906944n,
} as const;
export const denied = (message = "This bot cannot access the selected target."): never => {
  throw new NativeActionError("insufficient_scope", message);
};
export function id(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value !== 0) return String(value);
  if (typeof value === "string" && /^-?[1-9][0-9]{0,20}$/.test(value)) return value;
  return incomplete("The platform omitted a stable identity.");
}
export function settings(config: NativeAppConfig) {
  const s = NativeConfigSettingsSchema.parse(config.config);
  if (
    config.credentialKind !== "bot_token" ||
    s.actor !== "bot" ||
    !s.boundSpaceId ||
    !s.targetIds?.length ||
    s.targetIds.length > 100
  )
    throw new NativeActionError(
      "not_configured",
      "An administrator must bind this bot to this space and explicit targets.",
    );
  if (new Set(s.targetIds).size !== s.targetIds.length)
    throw new NativeActionError("not_configured", "Bot targets must be unique.");
  if (config.appId === "discord") {
    if (
      !s.tenantId ||
      !/^[1-9][0-9]{5,20}$/.test(s.tenantId) ||
      s.targetIds.some((t) => !/^[1-9][0-9]{5,20}$/.test(t))
    )
      throw new NativeActionError(
        "not_configured",
        "Configure an exact Discord guild and channel IDs.",
      );
  } else if (
    config.appId !== "telegram-bot" ||
    s.targetIds.some((t) => !/^-?[1-9][0-9]{0,18}$/.test(t))
  )
    throw new NativeActionError("not_configured", "Configure fixed Telegram numeric chat IDs.");
  return s as typeof s & { boundSpaceId: string; targetIds: string[] };
}
export function boundTarget(
  principal: NativeActionContext["principal"],
  target: unknown,
  platform: "telegram-bot" | "discord",
): VerifiedTarget {
  const c = principal.context;
  if (
    c.actorType !== "bot" ||
    c.credentialType !== "bot_token" ||
    c.scopeAuthority !== "provider_enforced" ||
    !c.boundSpaceId ||
    c.botId !== principal.subject
  )
    throw new NativeActionError(
      "authorization_required",
      "Select the verified bot connection for this space.",
    );
  const rows = array(c.verifiedTargets).map(object),
    matches = rows.filter((row) => row.id === String(target));
  if (matches.length !== 1) denied("This target is outside the selected bot connection.");
  const row = matches[0]!;
  if (
    platform === "discord" &&
    (!principal.tenant || row.guildId !== principal.tenant || c.bindingNamespace !== "guild")
  )
    denied("The target belongs to a different Discord guild.");
  return {
    id: text(row.id),
    ...(typeof row.guildId === "string" ? { guildId: row.guildId } : {}),
    ...(typeof row.permissions === "string" ? { permissions: row.permissions } : {}),
  };
}
export function telegramResult(response: NativeResponse): unknown {
  const body = object(response.body);
  if (body.ok === false) {
    const code = Number(body.error_code);
    throw new NativeActionError(
      code === 401
        ? "authorization_expired"
        : code === 403
          ? "insufficient_scope"
          : code === 429
            ? "rate_limited"
            : code >= 500
              ? "temporarily_unavailable"
              : "invalid_input",
      "Telegram rejected this request.",
      {
        ...(code === 429 && typeof object(body.parameters ?? {}).retry_after === "number"
          ? { retryAfterSeconds: Number(object(body.parameters).retry_after) }
          : {}),
      },
    );
  }
  if (body.ok !== true || body.result === undefined)
    return incomplete("Telegram omitted a confirmed result.");
  return body.result;
}
export async function telegramBot(request: BotRequest): Promise<Data> {
  const user = object(telegramResult(await request({ method: "GET", path: "/getMe" })));
  if (user.is_bot !== true) return denied("This credential does not identify a Telegram bot.");
  id(user.id);
  return user;
}
export async function telegramTarget(
  request: BotRequest,
  botId: string,
  chatId: string,
): Promise<{ chat: Data; member: Data | null }> {
  const chat = object(
    telegramResult(await request({ method: "GET", path: "/getChat", query: { chat_id: chatId } })),
  );
  if (
    id(chat.id) !== chatId ||
    !["private", "group", "supergroup", "channel"].includes(String(chat.type))
  )
    return denied();
  if (chat.type === "private") return { chat, member: null };
  const member = object(
    telegramResult(
      await request({
        method: "GET",
        path: "/getChatMember",
        query: { chat_id: chatId, user_id: botId },
      }),
    ),
  );
  if (
    id(object(member.user).id) !== botId ||
    object(member.user).is_bot !== true ||
    !["creator", "administrator", "member", "restricted"].includes(String(member.status)) ||
    (member.status === "restricted" && member.is_member !== true)
  )
    return denied();
  return { chat, member };
}
export function telegramPermission(
  proof: { chat: Data; member: Data | null },
  operation: "read" | "send" | "edit" | "delete" | "reactions" | "files",
): void {
  if (operation === "read" || !proof.member) return;
  const { chat, member } = proof;
  if (
    chat.type === "channel" &&
    ["send", "files"].includes(operation) &&
    member.status !== "creator" &&
    member.can_post_messages !== true
  )
    denied("This bot cannot post in the selected channel.");
  const permissions =
    member.status === "restricted" ? member : chat.permissions ? object(chat.permissions) : {};
  if (!["creator", "administrator"].includes(String(member.status))) {
    if (["send", "files"].includes(operation) && permissions.can_send_messages === false)
      denied("This bot cannot send messages to the selected chat.");
    if (operation === "files" && permissions.can_send_documents === false)
      denied("This bot cannot send documents to the selected chat.");
    if (operation === "reactions" && permissions.can_react_to_messages === false)
      denied("This bot cannot react in the selected chat.");
  }
  // Editing/deleting individual messages is finally enforced by Telegram itself;
  // the API has no arbitrary historical-message lookup that could prove authorship.
}
function bits(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,50}$/.test(value))
    return incomplete("Discord omitted permission bits.");
  return BigInt(value);
}
export function discordPermissions(
  guildId: string,
  botId: string,
  member: Data,
  roles: unknown[],
  overwrites: unknown[],
): bigint {
  if (id(object(member.user).id) !== botId)
    return denied("Discord returned a different guild member.");
  const roleRows = roles.map(object),
    memberRoles = array(member.roles).map(id),
    roleIds = new Set([guildId, ...memberRoles]);
  if (
    !roleRows.some((r) => r.id === guildId) ||
    memberRoles.some((role) => !roleRows.some((r) => r.id === role))
  )
    return incomplete("Discord omitted a required guild role.");
  let permissions = roleRows
    .filter((r) => roleIds.has(String(r.id)))
    .reduce((all, row) => all | bits(row.permissions), 0n);
  if (permissions & PERMISSIONS.ADMINISTRATOR) permissions = (1n << 128n) - 1n;
  else {
    const rows = overwrites.map(object),
      everyone = rows.find((r) => r.id === guildId && r.type === 0);
    if (everyone) permissions = (permissions & ~bits(everyone.deny)) | bits(everyone.allow);
    const selected = rows.filter(
      (r) => r.type === 0 && r.id !== guildId && roleIds.has(String(r.id)),
    );
    let deny = 0n,
      allow = 0n;
    for (const row of selected) {
      deny |= bits(row.deny);
      allow |= bits(row.allow);
    }
    permissions = (permissions & ~deny) | allow;
    const direct = rows.find((r) => r.type === 1 && r.id === botId);
    if (direct) permissions = (permissions & ~bits(direct.deny)) | bits(direct.allow);
  }
  if (
    member.communication_disabled_until !== null &&
    member.communication_disabled_until !== undefined
  ) {
    const until = Date.parse(text(member.communication_disabled_until));
    if (!Number.isFinite(until)) return incomplete("Discord returned an invalid timeout.");
    if (until > Date.now())
      permissions &= PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY;
  }
  return permissions;
}
export async function discordBot(request: BotRequest): Promise<Data> {
  const user = object((await request({ method: "GET", path: "/users/@me" })).body);
  if (user.bot !== true) return denied("This credential does not identify a Discord bot.");
  id(user.id);
  return user;
}
export async function discordTarget(
  request: BotRequest,
  botId: string,
  guildId: string,
  channelId: string,
): Promise<{ channel: Data; member: Data; permissions: bigint }> {
  const channel = object((await request({ method: "GET", path: `/channels/${channelId}` })).body);
  if (
    id(channel.id) !== channelId ||
    channel.guild_id !== guildId ||
    ![0, 5, 10, 11, 12].includes(Number(channel.type))
  )
    return denied("Choose an authorized guild text channel or thread.");
  const thread = [10, 11, 12].includes(Number(channel.type));
  let permissionChannel = channel;
  if (thread) {
    const parentId = id(channel.parent_id);
    permissionChannel = object(
      (await request({ method: "GET", path: `/channels/${parentId}` })).body,
    );
    if (permissionChannel.guild_id !== guildId || id(permissionChannel.id) !== parentId)
      return denied();
  }
  const member = object(
    (await request({ method: "GET", path: `/guilds/${guildId}/members/${botId}` })).body,
  );
  const roles = array((await request({ method: "GET", path: `/guilds/${guildId}/roles` })).body);
  const permissions = discordPermissions(
    guildId,
    botId,
    member,
    roles,
    array(permissionChannel.permission_overwrites),
  );
  if (!(permissions & PERMISSIONS.VIEW_CHANNEL))
    return denied("This bot cannot view the selected channel.");
  if (Number(channel.type) === 12) {
    const membership = object(
      (await request({ method: "GET", path: `/channels/${channelId}/thread-members/@me` })).body,
    );
    if (id(membership.user_id) !== botId)
      return denied("This bot is not a member of the private thread.");
  }
  return { channel, member, permissions };
}
export function requireDiscord(
  proof: { channel: Data; member: Data; permissions: bigint },
  permission: bigint,
  write = false,
): void {
  if (!(proof.permissions & permission))
    denied("The selected channel has not granted the required bot permission.");
  if (write && proof.member.pending === true)
    denied("This guild membership is awaiting verification.");
  if (write && [10, 11, 12].includes(Number(proof.channel.type))) {
    const metadata = object(proof.channel.thread_metadata);
    if (metadata.archived === true || metadata.locked === true)
      denied("Open this thread before changing its messages.");
  }
}
export const channelSnapshot = (row: Data): Data =>
  select(row, [
    "id",
    "guild_id",
    "type",
    "name",
    "topic",
    "parent_id",
    "nsfw",
    "last_message_id",
    "thread_metadata",
  ]);
