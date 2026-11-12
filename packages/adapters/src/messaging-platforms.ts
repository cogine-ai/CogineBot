import { createSlackAdapter } from "@chat-adapter/slack";
import {
  createTelegramAdapter,
  escapeMarkdownV2,
  TelegramFormatConverter,
} from "@chat-adapter/telegram";
import {
  createWhatsAppAdapter,
  splitMessage,
  WhatsAppAdapter,
  WhatsAppApiError,
} from "@chat-adapter/whatsapp";
import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type { MessagingInboundMessage, MessagingOutboundStatus } from "@rakazo/adapter-kit";
import type { Adapter } from "chat";
import { ConsoleLogger, convertEmojiPlaceholders, markdownToPlainText } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";
import type { ClientOptions as SendblueClientOptions } from "sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { LazyLarkAdapter } from "./lark/lazy-adapter.js";
import { Domain } from "./lark/thread-id.js";
import { isVitestRuntime } from "./test-runtime.js";

/**
 * Parsed platform credentials, filled from process.env at the composition
 * roots. A platform mounts when its full credential set is present.
 */
export interface MessagingEnvironmentValues {
  apiUrl?: string | undefined;
  sendblueApiKeyId?: string | undefined;
  sendblueApiSecret?: string | undefined;
  sendblueSigningSecret?: string | undefined;
  sendbluePhoneNumber?: string | undefined;
  slackBotToken?: string | undefined;
  slackSigningSecret?: string | undefined;
  whatsappAccessToken?: string | undefined;
  whatsappPhoneNumberId?: string | undefined;
  whatsappAppSecret?: string | undefined;
  whatsappVerifyToken?: string | undefined;
  telegramBotToken?: string | undefined;
  telegramWebhookSecret?: string | undefined;
  larkAppId?: string | undefined;
  larkAppSecret?: string | undefined;
  larkVerificationToken?: string | undefined;
  larkEncryptKey?: string | undefined;
  larkDomain?: string | undefined;
}

export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  // Same trim/empty-to-undefined normalization the API's env loader applies,
  // so a credential with stray whitespace behaves identically in both roles.
  const clean = (value: string | undefined) => value?.trim() || undefined;
  return {
    apiUrl: clean(env.API_URL),
    sendblueApiKeyId: clean(env.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: clean(env.SENDBLUE_API_SECRET),
    sendblueSigningSecret: clean(env.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: clean(env.SENDBLUE_PHONE_NUMBER),
    slackBotToken: clean(env.SLACK_BOT_TOKEN),
    slackSigningSecret: clean(env.SLACK_SIGNING_SECRET),
    whatsappAccessToken: clean(env.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: clean(env.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: clean(env.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET_TOKEN),
    larkAppId: clean(env.LARK_APP_ID),
    larkAppSecret: clean(env.LARK_APP_SECRET),
    larkVerificationToken: clean(env.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: clean(env.LARK_ENCRYPT_KEY),
    larkDomain: clean(env.LARK_DOMAIN),
  };
}

/** Bounds one vendor send so a hung request cannot stall the sequential outbox drain. */
const MESSAGING_SEND_TIMEOUT_MS = 10_000;

/** Slack errors a retry cannot fix: the bot cannot reach the channel or its token is dead. */
const SLACK_PERMANENT_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
]);

/** Meta 131047: outside the 24-hour window only a template can reach the user. */
const WHATSAPP_REENGAGEMENT_REQUIRED = 131047;

/**
 * Build the platform list for every fully configured provider. Group
 * conversations stay sendblue-only until channel semantics are mapped for
 * the other platforms, so their capabilities say so instead of half-working.
 *
 * `pollInboundMessages` must be true only in the one process that also
 * registers the inbound sink (messaging.onInbound — apps/api/src/app.ts).
 * Telegram's "auto" mode starts a long-poll the moment anything calls
 * chat.initialize() when no webhook is registered — and that includes a
 * process that only ever meant to *send*: outbound delivery
 * (sendToThread) lazily initializes too. A second process polling with no
 * inbound sink attached doesn't just do nothing — it actively steals
 * Telegram's single getUpdates slot away from the process that IS
 * listening, so both sides spend every cycle losing a 409 Conflict to the
 * other and messages stop arriving at all. Any caller that only sends
 * (e.g. apps/worker/src/index.ts, for messaging.deliver jobs) must leave
 * this false so Telegram mode resolves to "webhook" (passive — resolves
 * bot identity for outbound calls, never polls, and no webhook route is
 * mounted there for it to receive on anyway).
 */
export function messagingPlatformsFromEnv(
  env: MessagingEnvironmentValues,
  options: {
    pollInboundMessages?: boolean;
    sendblueTransport?: Pick<SendblueClientOptions, "baseURL" | "fetch">;
    larkTransport?: HttpInstance;
  } = {},
): MessagingPlatform[] {
  const platforms: MessagingPlatform[] = [];

  if (
    env.sendblueApiKeyId &&
    env.sendblueApiSecret &&
    env.sendblueSigningSecret &&
    env.sendbluePhoneNumber
  ) {
    const lineNumber = env.sendbluePhoneNumber;
    const adapter = createSendblueAdapter({
      apiKey: env.sendblueApiKeyId,
      apiSecret: env.sendblueApiSecret,
      defaultFromNumber: lineNumber,
      webhookSecret: env.sendblueSigningSecret,
      allowedServices: ["iMessage", "SMS", "RCS"],
      ...(env.apiUrl?.startsWith("https://")
        ? { statusCallbackUrl: new URL("/api/v1/messaging/webhook/sendblue", env.apiUrl).href }
        : {}),
    });
    // chat@4.39 derives thread.isDM solely from the optional Adapter.isDM
    // hook, and chat-adapter-sendblue@0.2.0 omits it — without this every
    // 1:1 message would route as a group. Derive it from the thread id.
    Object.assign(adapter, {
      isDM: (threadId: string) => !adapter.decodeThreadId(threadId).groupId,
    } satisfies Pick<Adapter, "isDM">);
    Object.assign(adapter, {
      sdk: adapter.getSdk().withOptions({
        maxRetries: 0,
        timeout: MESSAGING_SEND_TIMEOUT_MS,
        ...options.sendblueTransport,
      }),
    });
    platforms.push({
      provider: "sendblue",
      capabilities: { direct: true, groups: true, typing: true, receipt: "typing" },
      adapter,
      directThreadId: (address) =>
        adapter.encodeThreadId({ fromNumber: lineNumber, contactNumber: address }),
      acceptsThread: (threadId) => adapter.decodeThreadId(threadId).fromNumber === lineNumber,
      peekStatus: (payload) => parseSendblueStatus(payload, lineNumber),
      classifyRejection: (error) => {
        const status = asRecord(error)?.status;
        return typeof status === "number" && [400, 401, 403, 404, 422].includes(status)
          ? "rejected"
          : undefined;
      },
      participants: (raw) => sendblueParticipants(raw, lineNumber),
      channelName: (raw) => sendblueGroupName(raw),
      transport: (raw) => sendblueTransport(raw),
    });
  }

  if (env.slackBotToken && env.slackSigningSecret) {
    const adapter = createSlackAdapter({
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      webClientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: MESSAGING_SEND_TIMEOUT_MS,
      },
    });
    let ownWorkspace: Promise<string> | undefined;
    const addReaction = adapter.addReaction.bind(adapter);
    Object.assign(adapter, {
      addReaction: (threadId, messageId, emoji) =>
        addReaction(threadId, messageId, emoji).catch((error: unknown) => {
          if (slackPlatformError(error) !== "already_reacted") throw error;
        }),
    } satisfies Pick<Adapter, "addReaction">);
    platforms.push({
      provider: "slack",
      capabilities: { direct: true, groups: true, typing: false, receipt: "reaction" },
      adapter,
      enrichTeamRoom: enrichSlackTeamRoom,
      acceptsInbound: async (raw, payload) => {
        const envelope = asRecord(payload) ?? {};
        const authorizedTeams = arrayField(envelope, "authorizations").flatMap((authorization) => {
          const team = stringField(asRecord(authorization) ?? {}, "team_id");
          return team ? [team] : [];
        });
        const team =
          stringField(envelope, "team_id") ??
          stringField(asRecord(raw) ?? {}, "team_id") ??
          stringField(asRecord(raw) ?? {}, "team");
        if (!authorizedTeams.length && !team) return false;
        ownWorkspace ??= adapter.client.auth
          .test({ token: env.slackBotToken })
          .then((result) => {
            if (!result.team_id) throw new Error("Slack workspace could not be verified");
            return result.team_id;
          })
          .catch((error: unknown) => {
            ownWorkspace = undefined;
            throw error;
          });
        const ownTeam = await ownWorkspace;
        return authorizedTeams.length ? authorizedTeams.includes(ownTeam) : team === ownTeam;
      },
      redeliveryKeys: slackRedeliveryKeys,
      classifyRejection: (error) =>
        SLACK_PERMANENT_ERRORS.has(slackPlatformError(error) ?? "") ? "rejected" : undefined,
    });
  }

  if (
    env.whatsappAccessToken &&
    env.whatsappPhoneNumberId &&
    env.whatsappAppSecret &&
    env.whatsappVerifyToken
  ) {
    const adapter = createWhatsAppAdapter({
      accessToken: env.whatsappAccessToken,
      phoneNumberId: env.whatsappPhoneNumberId,
      appSecret: env.whatsappAppSecret,
      verifyToken: env.whatsappVerifyToken,
    });
    platforms.push({
      provider: "whatsapp",
      capabilities: { direct: true, groups: false, typing: false },
      adapter,
      acceptsThread: (threadId) =>
        adapter.decodeThreadId(threadId).phoneNumberId === env.whatsappPhoneNumberId,
      peekStatuses: (payload) => parseWhatsAppStatuses(payload, env.whatsappPhoneNumberId),
      classifyRejection: (error) => {
        if (!(error instanceof WhatsAppApiError)) return;
        if (error.errorCode === WHATSAPP_REENGAGEMENT_REQUIRED) return "reply_window_closed";
        if ([400, 401, 403, 404, 422].includes(error.status)) return "rejected";
      },
    });
  }

  // Both required: without the secret token the adapter accepts unsigned
  // webhook posts, so a forged update could reach inbound processing.
  if (env.telegramBotToken && env.telegramWebhookSecret) {
    platforms.push({
      provider: "telegram",
      capabilities: { direct: true, groups: false, typing: false, files: true },
      // Auto mode: uses the webhook route when Telegram has one registered
      // (checked via getWebhookInfo), and otherwise falls back to
      // long-polling getUpdates. Self-hosted/local deployments typically
      // have no public HTTPS endpoint for Telegram to push to, so the API
      // process calls initialize() at startup (apps/api/src/app.ts) to
      // start that polling loop immediately rather than waiting for the
      // first inbound webhook or outbound send. It must be the API
      // process specifically: that's where the inbound sink is registered,
      // and Telegram allows only one live getUpdates connection per bot —
      // a second poller elsewhere would just steal that slot and drop
      // every message into the void.
      adapter: createTelegramAdapter({
        botToken: env.telegramBotToken,
        secretToken: env.telegramWebhookSecret,
        mode: options.pollInboundMessages ? "auto" : "webhook",
      }),
      classifyRejection: (error) =>
        error instanceof Error && error.name === "PermissionError" ? "rejected" : undefined,
    });
  }

  // App ID, secret, and verification token are all required: without the
  // token the adapter accepts unsigned webhook posts. Encrypt key and
  // domain are optional (event encryption / open.feishu.cn vs open.larksuite.com).
  if (env.larkAppId && env.larkAppSecret && env.larkVerificationToken) {
    platforms.push({
      provider: "lark",
      capabilities: { direct: true, groups: false, typing: false },
      // Webhook-only: ws/long-connection incoming would consume events so
      // the HTTP webhook at /api/v1/messaging/webhook/lark never sees them.
      adapter: new LazyLarkAdapter({
        ...(options.larkTransport ? { httpInstance: options.larkTransport } : {}),
        appId: env.larkAppId,
        appSecret: env.larkAppSecret,
        verificationToken: env.larkVerificationToken,
        // Explicit defaults prevent the adapter from rereading untrimmed process.env values.
        encryptKey: env.larkEncryptKey ?? "",
        domain: env.larkDomain?.toLowerCase() === "lark" ? Domain.Lark : Domain.Feishu,
      }),
    });
  }

  return platforms;
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}

/**
 * Linked users run on their own credentials, so linking-only deployments
 * need no deployment model. Open signup provisions users with no credential
 * of their own, so that mode requires a configured deployment model — without
 * it their runs cannot execute.
 */
export function isMessagingSurfaceEnabled(
  platforms: MessagingPlatform[],
  options: { deploymentModelConfigured: boolean; openSignup: boolean },
): boolean {
  if (!isMessagingEnabled(platforms)) return false;
  return options.openSignup ? options.deploymentModelConfigured : true;
}

/** WhatsApp and Telegram both cap a text message at 4096 UTF-16 units. */
const MESSAGE_PART_LIMIT = 4096;

/** Split before enqueueing so retries only resend the parts that failed. */
export function splitOutboundBody(provider: string, body: string): string[] {
  if (provider === "whatsapp") return splitWhatsAppPart(body);
  if (provider !== "telegram") return [body];

  return splitTelegramPart(body);
}

/** Split like the SDK, which counts UTF-16 units, but never end a part on half an emoji. */
function splitKeepingPairs(body: string): string[] {
  const parts: string[] = [];
  let rest = body;
  while (rest.length > MESSAGE_PART_LIMIT) {
    // The SDK's first part only depends on the first MESSAGE_PART_LIMIT units.
    const [first = ""] = splitMessage(rest.slice(0, MESSAGE_PART_LIMIT + 1));
    const part = first.length > 1 && /[\uD800-\uDBFF]$/.test(first) ? first.slice(0, -1) : first;
    parts.push(part);
    rest = rest.slice(part.length).trimStart();
  }
  return rest || parts.length === 0 ? [...parts, rest] : parts;
}

const telegramFormat = new TelegramFormatConverter();

function splitTelegramPart(body: string, literal = false): string[] {
  const markdown = literal ? escapeMarkdownV2(body) : body;
  const plainText = literal ? body : markdownToPlainText(body);
  // The adapter truncates *after* rendering and emoji conversion, including
  // its plain-text fallback. Measure both payloads in UTF-16 units as it does.
  const payloads = [telegramFormat.fromMarkdown(markdown), plainText.trim() ? plainText : markdown];
  if (
    markdown.length <= MESSAGE_PART_LIMIT &&
    payloads.every((text) => convertEmojiPlaceholders(text, "gchat").length <= MESSAGE_PART_LIMIT)
  ) {
    return [markdown];
  }

  // Parse before splitting: cutting Markdown can turn code into prose and
  // consume literal backslashes. Oversized formatted replies use escaped text.
  if (!literal && plainText !== body) return splitTelegramPart(plainText, true);

  const parts = splitKeepingPairs(body);
  if (parts.length > 1) return parts.flatMap((part) => splitTelegramPart(part, literal));

  return halve(body).flatMap((half) => splitTelegramPart(half, literal));
}

/** Exposes the adapter's Markdown rendering, which the package does not export. */
class WhatsAppRenderer extends WhatsAppAdapter {
  render(markdown: string): string {
    return convertEmojiPlaceholders(this.formatConverter.renderPostable({ markdown }), "whatsapp");
  }
}

let whatsappRenderer: WhatsAppRenderer | undefined;

function splitWhatsAppPart(body: string): string[] {
  whatsappRenderer ??= new WhatsAppRenderer({
    accessToken: "",
    appSecret: "",
    logger: new ConsoleLogger("silent"),
    phoneNumberId: "",
    userName: "",
    verifyToken: "",
  });
  // The adapter re-splits anything that renders past the limit, outside the
  // queue's per-part retries and without keeping UTF-16 pairs together.
  if (whatsappRenderer.render(body).length <= MESSAGE_PART_LIMIT) return [body];

  const parts = splitKeepingPairs(body);
  return (parts.length > 1 ? parts : halve(body)).flatMap(splitWhatsAppPart);
}

/** Refines chunks that only grow beyond the limit during rendering. */
function halve(body: string): string[] {
  const midpoint = Math.floor(body.length / 2);
  const prefix = body.slice(0, midpoint);
  let boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
  if (boundary < midpoint / 2) boundary = midpoint;
  if (/[\uD800-\uDBFF]/.test(body[boundary - 1]!)) boundary--;
  return [body.slice(0, boundary), body.slice(boundary)];
}

/** Sendblue reports outbound delivery as webhooks the Chat SDK ignores. */
export function parseSendblueStatus(
  payload: unknown,
  lineNumber?: string,
): MessagingOutboundStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (body.is_outbound !== true) return null;
  if (lineNumber && (body.sendblue_number ?? body.from_number) !== lineNumber) return null;
  if (typeof body.message_handle !== "string" || !body.message_handle) return null;
  return {
    type: "status",
    provider: "sendblue",
    handle: body.message_handle,
    status: typeof body.status === "string" ? body.status : "",
  };
}

/** Pull Slack team-room fields the Chat SDK does not expose on Message. */
export function parseWhatsAppStatuses(
  payload: unknown,
  phoneNumberId?: string,
): MessagingOutboundStatus[] {
  const statuses: MessagingOutboundStatus[] = [];
  for (const entry of arrayField(asRecord(payload), "entry")) {
    for (const change of arrayField(asRecord(entry), "changes")) {
      const value = asRecord(asRecord(change)?.value);
      const reportedNumber = stringField(asRecord(value?.metadata) ?? {}, "phone_number_id");
      if (phoneNumberId && reportedNumber !== phoneNumberId) continue;
      for (const item of arrayField(value, "statuses")) {
        const record = asRecord(item) ?? {};
        const handle = stringField(record, "id");
        const status = stringField(record, "status");
        if (!handle || !status) continue;
        statuses.push({
          type: "status",
          provider: "whatsapp",
          handle,
          status: status.toUpperCase(),
          ...(arrayField(record, "errors").some(
            (error) => asRecord(error)?.code === WHATSAPP_REENGAGEMENT_REQUIRED,
          ) && { reason: "reply_window_closed" as const }),
        });
      }
    }
  }
  return statuses;
}

/** Slack's marker for a dispatched event; it turns Slack's retries into no-ops. */
function slackRedeliveryKeys(payload: unknown): string[] {
  const eventId = stringField(asRecord(payload) ?? {}, "event_id");
  return eventId ? [`slack:event-delivered:${eventId}`] : [];
}

export function enrichSlackTeamRoom(
  raw: unknown,
  base: MessagingInboundMessage,
): Partial<MessagingInboundMessage> {
  const root = asRecord(raw);
  if (!root) return {};
  const event = asRecord(root.event) ?? root;
  const teamId =
    stringField(root, "team_id") ?? stringField(event, "team") ?? stringField(event, "team_id");
  const eventType = stringField(event, "type");
  const botProfile = asRecord(event.bot_profile) ?? {};
  const botId = stringField(event, "bot_id") ?? stringField(botProfile, "id");
  const threadTs = stringField(event, "thread_ts");
  const channel = stringField(event, "channel");
  const enrichment: Partial<MessagingInboundMessage> = {};
  if (teamId) enrichment.workspaceId = teamId;
  if (channel) enrichment.conversationKey = channel;
  if (botId) enrichment.senderIsBot = true;
  else if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    enrichment.senderIsBot = true;
  }
  if (threadTs) enrichment.replyThreadId = threadTs;
  else enrichment.replyThreadId = null;
  if (!base.isDirect) {
    const text = stringField(event, "text") ?? base.content;
    const botUserId = slackAuthorizedBotUserId(root);
    // app_mention is Slack's bot-directed event. A bare <@U…> mention of
    // someone else must stay ambient so listen policy still applies.
    enrichment.kind =
      eventType === "app_mention" || mentionsSlackBot(text, botUserId) ? "mention" : "ambient";
  }
  return enrichment;
}

/** Bot user id from Slack's event authorizations (the app that received the event). */
function slackAuthorizedBotUserId(root: Record<string, unknown>): string | undefined {
  const authorizations = root.authorizations;
  if (!Array.isArray(authorizations)) return undefined;
  for (const entry of authorizations) {
    const record = asRecord(entry);
    if (record?.is_bot !== true) continue;
    const userId = stringField(record, "user_id");
    if (userId) return userId;
  }
  return undefined;
}

function mentionsSlackBot(text: string, botUserId: string | undefined): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function slackPlatformError(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record?.code !== "slack_webapi_platform_error") return undefined;
  return stringField(asRecord(record.data) ?? {}, "error");
}

function arrayField(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function sendblueParticipants(raw: unknown, lineNumber: string): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const participants = (raw as { participants?: unknown }).participants;
  if (!Array.isArray(participants)) return [];
  return participants.filter(
    (entry): entry is string => typeof entry === "string" && entry !== lineNumber,
  );
}

function sendblueGroupName(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const name = (raw as { group_display_name?: unknown }).group_display_name;
  return typeof name === "string" && name ? name : null;
}

function sendblueTransport(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const service = (raw as { service?: unknown }).service;
  return service === "iMessage" || service === "SMS" || service === "RCS" ? service : null;
}
