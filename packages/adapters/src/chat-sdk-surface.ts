import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createMemoryState } from "@chat-adapter/state-memory";
import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingFailureReason,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { Adapter, Message, PostableMarkdown, Thread } from "chat";
import { Chat, isLinkNode, parseMarkdown, text, toPlainText, walkAst } from "chat";
import { getLarkTextParts } from "./lark/text-parts.js";
import { withinMessagingAttachmentDeadline } from "./messaging-attachment-download.js";

/** Per-webhook drain of Chat SDK waitUntil work + inbound sink failures. */
const webhookDrain = new AsyncLocalStorage<{
  pending: Promise<unknown>[];
  failedKeys: string[];
  payload?: unknown;
}>();

/** Inbound webhook bodies larger than this are rejected before parsing. */
export const MESSAGING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const MESSAGING_SEND_TIMEOUT_MS = 10_000;
const TELEGRAM_PHOTO_MAX_BYTES = 10_000_000;
const TELEGRAM_UPLOAD_MAX_BYTES = 50_000_000;
const TELEGRAM_PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * One messaging platform mounted on the surface. The Chat SDK adapter owns
 * webhook verification, payload translation, and platform API calls; the
 * extra hooks cover the few per-platform facts the SDK does not surface.
 */
export interface MessagingPlatform {
  provider: string;
  capabilities: MessagingCapabilities;
  adapter: Adapter;
  acceptsThread?: (threadId: string) => boolean;
  acceptsInbound?: (raw: unknown, envelope: unknown) => Promise<boolean>;
  /** Deterministic 1:1 thread id for platforms without openDM (sendblue). */
  directThreadId?: (address: string) => string;
  /** Delivery-status events the Chat SDK drops (sendblue is_outbound posts). */
  peekStatus?: (payload: unknown) => MessagingOutboundStatus | null;
  peekStatuses?: (payload: unknown) => MessagingOutboundStatus[];
  redeliveryKeys?: (payload: unknown) => string[];
  classifyRejection?: (error: unknown) => MessagingFailureReason | undefined;
  /** Group roster addresses from the raw inbound payload, excluding our line. */
  participants?: (raw: unknown) => string[];
  /** Group display name from the raw inbound payload. */
  channelName?: (raw: unknown) => string | null;
  /** User-facing transport carried by the raw message when it differs from the provider. */
  transport?: (raw: unknown) => string | null;
  /**
   * Optional team-room enrichment (workspace id, mention/ambient kind, bot
   * sender, reply thread) derived from the raw platform payload.
   */
  enrichTeamRoom?: (
    raw: unknown,
    base: MessagingInboundMessage,
  ) => Partial<MessagingInboundMessage>;
}

/**
 * MessagingSurface over the Chat SDK (github.com/vercel/chat): one bot
 * presence across every mounted platform. Orchestration stays upstream —
 * this class only translates between Chat SDK events/calls and the
 * provider-neutral contract.
 */
export class ChatSdkMessagingSurface implements MessagingSurface {
  private readonly chat: Chat<Record<string, Adapter>>;
  private readonly byProvider = new Map<string, MessagingPlatform>();
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private initialized: Promise<void> | undefined;

  constructor(platforms: MessagingPlatform[], options: { userName?: string } = {}) {
    if (platforms.length === 0) throw new Error("ChatSdkMessagingSurface needs >=1 platform");
    for (const platform of platforms) this.byProvider.set(platform.provider, platform);
    const state = createMemoryState();
    if (this.byProvider.has("slack")) {
      const setIfNotExists = state.setIfNotExists.bind(state);
      // Slack's event envelope and the persisted routing keys include their
      // proper scope. The SDK's message cache key only contains the timestamp.
      state.setIfNotExists = (key, value, ttl) =>
        key.startsWith("dedupe:slack:") ? Promise.resolve(true) : setIfNotExists(key, value, ttl);
    }
    this.chat = new Chat({
      userName: options.userName ?? "rakazo",
      adapters: Object.fromEntries(platforms.map((p) => [p.provider, p.adapter])),
      state,
      // The SDK default ("drop") takes a per-conversation lock and discards
      // any message that arrives while it is held — and the LockError is
      // swallowed into waitUntil, so the webhook still ACKs 200 and the
      // vendor never retries. Two texts in quick succession would lose the
      // second. Each inbound message already runs inside its own webhook's
      // waitUntil task, so process them independently and let the per-message
      // client nonce downstream handle replay.
      concurrency: "concurrent",
    });
    const deliver = async (thread: Thread, message: Message) => {
      const platform = this.byProvider.get(providerOfThreadId(thread.id));
      try {
        const event = this.toInbound(thread, message);
        if (
          !event ||
          (platform?.acceptsInbound &&
            !(await platform.acceptsInbound(message.raw, webhookDrain.getStore()?.payload)))
        )
          return;
        await this.sink?.(event);
      } catch (error) {
        // processMessage hands waitUntil a swallowed promise, so track sink
        // failures here and turn them into HTTP 5xx after the drain.
        if (platform)
          webhookDrain.getStore()?.failedKeys.push(chatDedupeKey(platform.adapter, message.id));
        throw error;
      }
    };
    // Priority routing makes these disjoint: DMs, then @-mentions in
    // unsubscribed threads, then the catch-all pattern for everything else.
    // Subscribed threads skip the catch-all and only fire onSubscribedMessage
    // (chat SDK docs / dispatchToHandlersWithSignal); register deliver there too.
    this.chat.onDirectMessage(deliver);
    this.chat.onNewMention(deliver);
    this.chat.onSubscribedMessage(deliver);
    this.chat.onNewMessage(/(?:)/, deliver);
  }

  describe(): AdapterDescriptor<{ providers: string[] }> {
    return {
      id: "chat-sdk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: [...this.byProvider.keys()] },
    };
  }

  platforms(): MessagingPlatformDescriptor[] {
    return [...this.byProvider.values()].map((platform) => ({
      provider: platform.provider,
      capabilities: platform.capabilities,
    }));
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void {
    this.sink = sink;
  }

  handleWebhook(provider: string, request: Request): Promise<Response> | null {
    const platform = this.byProvider.get(provider);
    if (!platform) return null;
    return this.dispatchWebhook(platform, request);
  }

  async sendToThread(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult> {
    const platform = this.byProvider.get(providerOfThreadId(request.threadId));
    if (!platform || platform.acceptsThread?.(request.threadId) === false)
      throw new MessagingSendError("permanent", "rejected");
    const telegram = platform.provider === "telegram";
    const markdown = telegram || platform.provider === "whatsapp" || platform.provider === "lark";
    const { attachment } = request;
    if (
      attachment &&
      (!platform.capabilities.files ||
        (telegram && attachment.data.byteLength > TELEGRAM_UPLOAD_MAX_BYTES))
    )
      throw new MessagingSendError("permanent", "attachment_unavailable");

    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(MESSAGING_SEND_TIMEOUT_MS),
    ]);
    try {
      signal.throwIfAborted();
      await raceWithSignal(this.ensureInitialized(), signal);
      signal.throwIfAborted();
    } catch (cause) {
      // Initializing does not submit a message. An outbox retry is safe here.
      throw new MessagingSendError("retryable", "rejected", undefined, cause);
    }
    const message = attachment
      ? attachmentMessage(telegram, request.body, attachment)
      : markdown
        ? { markdown: request.body }
        : request.body;
    const submitted = this.chat
      .thread(request.threadId)
      .post(message)
      .then((sent) => ({
        handle: "id" in sent && typeof sent.id === "string" ? sent.id : "",
      }))
      .catch((error: unknown) => {
        throw classifySendError(platform, error);
      });
    try {
      return await raceWithSignal(submitted, signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) {
        // The SDK can outlive the caller's deadline. Expose its completion
        // so the outbox can keep the conversation ordered and save a late handle.
        throw new MessagingSendError("unknown", "outcome_unknown", undefined, error, submitted);
      }
      throw error;
    }
  }

  async openDirectThread(
    provider: string,
    address: string,
    context: AdapterContext,
  ): Promise<string> {
    const platform = this.byProvider.get(provider);
    if (!platform) throw new Error(`Unknown messaging provider: ${provider}`);
    if (platform.directThreadId) return platform.directThreadId(address);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(MESSAGING_SEND_TIMEOUT_MS),
    ]);
    await raceWithSignal(this.ensureInitialized(), signal);
    if (!platform.adapter.openDM) throw new MessagingSendError("permanent", "rejected");
    signal.throwIfAborted();
    return raceWithSignal(platform.adapter.openDM(address), signal);
  }

  async sendTyping(threadId: string, context: AdapterContext): Promise<void> {
    const platform = this.byProvider.get(providerOfThreadId(threadId));
    if (!platform?.capabilities.typing) return;
    await raceWithSignal(this.ensureInitialized(), context.signal);
    context.signal.throwIfAborted();
    // The Chat SDK adapter API takes no abort signal, so the underlying
    // request cannot be cancelled — but the caller's wait is still bounded.
    await raceWithSignal(platform.adapter.startTyping(threadId), context.signal);
  }

  async acknowledge(threadId: string, handle: string, context: AdapterContext): Promise<void> {
    const platform = this.byProvider.get(providerOfThreadId(threadId));
    if (!platform?.capabilities.receipt) return;
    if (platform.capabilities.receipt === "typing") return this.sendTyping(threadId, context);
    await raceWithSignal(this.ensureInitialized(), context.signal);
    context.signal.throwIfAborted();
    await raceWithSignal(platform.adapter.addReaction(threadId, handle, "eyes"), context.signal);
  }

  /**
   * Proactively start the underlying Chat SDK instance. Webhook handling
   * and outbound sends already trigger this lazily (see ensureInitialized
   * below), but a polling-mode adapter (Telegram in "auto" mode with no
   * public webhook URL registered) needs its pull loop running before the
   * first inbound message can ever arrive, so long-running hosts call this
   * explicitly at startup instead of waiting on the first send.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Stop Telegram getUpdates before exit. Chat.shutdown() only calls
   * adapter.disconnect(), which Telegram does not implement.
   */
  async shutdown(): Promise<void> {
    const pending = this.initialized;
    this.initialized = undefined;
    if (pending) await pending.catch(() => undefined);
    await this.stopPollingAdapters();
    const chat = this.chat as { shutdown?: () => Promise<void> };
    await chat.shutdown?.().catch(() => undefined);
  }

  private ensureInitialized(): Promise<void> {
    // Webhook handling initializes lazily inside the Chat SDK; proactive
    // sends from job runners need the explicit call. Chat keeps a rejected
    // initPromise until shutdown(), so clear that before allowing a retry.
    if (!this.initialized) {
      this.initialized = this.chat.initialize().catch(async (error) => {
        try {
          // Telegram may already be polling if Promise.all failed on another
          // adapter after Telegram's initialize started getUpdates.
          await this.stopPollingAdapters();
          await (this.chat as { shutdown?: () => Promise<void> }).shutdown?.();
        } catch {
          // Best-effort reset of Chat's cached init failure.
        } finally {
          this.initialized = undefined;
        }
        throw error;
      });
    }
    return this.initialized;
  }

  private async stopPollingAdapters(): Promise<void> {
    for (const platform of this.byProvider.values()) {
      const adapter = platform.adapter as { stopPolling?: () => Promise<void> };
      await adapter.stopPolling?.().catch(() => undefined);
    }
  }

  private async dispatchWebhook(platform: MessagingPlatform, request: Request): Promise<Response> {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MESSAGING_WEBHOOK_MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await readBoundedText(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES) : "";
    if (body === null) {
      return new Response("Payload too large", { status: 413 });
    }
    const forwarded = hasBody
      ? new Request(request.url, { method: request.method, headers: request.headers, body })
      : request;
    // Real Chat SDK adapters fire processMessage without awaiting it; they
    // only register the work via waitUntil. Drain that work before ACKing so
    // a vendor 200 cannot race ahead of provision/enqueue, and surface sink
    // failures as 5xx so the vendor retries.
    const drain = {
      pending: [] as Promise<unknown>[],
      failedKeys: [] as string[],
      payload: parseJson(body),
    };
    const response = await webhookDrain.run(drain, async () => {
      const adapterResponse = await this.chat.webhooks[platform.provider]!(forwarded, {
        waitUntil: (task) => {
          drain.pending.push(task);
        },
      });
      await Promise.all(drain.pending);
      return adapterResponse;
    });
    if (drain.failedKeys.length > 0) {
      // The SDK marks deliveries seen before the sink resolves. A vendor
      // retry must reach the durable nonce checks after a sink failure.
      const keys = [...drain.failedKeys, ...(platform.redeliveryKeys?.(drain.payload) ?? [])];
      await Promise.all(keys.map((key) => this.chat.getState().delete(key)));
      return new Response("Inbound processing failed", { status: 500 });
    }
    if ((platform.peekStatuses || platform.peekStatus) && response.ok && body) {
      const status = platform.peekStatus?.(drain.payload);
      for (const event of platform.peekStatuses?.(drain.payload) ?? (status ? [status] : []))
        await this.sink?.(event);
    }
    return response;
  }

  private toInbound(thread: Thread, message: Message): MessagingInboundMessage | null {
    if (message.author.isMe || message.author.isSystem) return null;
    const provider = providerOfThreadId(thread.id);
    const platform = this.byProvider.get(provider);
    if (!platform || platform.acceptsThread?.(thread.id) === false) return null;
    const isDirect = thread.isDM;
    if (!isDirect && !platform.capabilities.groups) return null;
    const fromLabel = message.author.fullName || message.author.userName || null;
    const transport = platform.transport?.(message.raw) ?? null;
    // Use authenticated file APIs. Some adapters expose only a webhook URL
    // wrapped in fetchData, which is still a link for the conversation.
    const attachments = inboundAttachments(message, provider);
    const base: MessagingInboundMessage = {
      type: "message",
      provider,
      ...(transport ? { transport } : {}),
      handle: message.id,
      threadId: thread.id,
      isDirect,
      from: message.author.userId,
      ...(message.author.isBot === true && { senderIsBot: true }),
      fromLabel: fromLabel === message.author.userId ? null : fromLabel,
      channelName: isDirect ? null : (platform.channelName?.(message.raw) ?? null),
      participants: isDirect ? [] : (platform.participants?.(message.raw) ?? []),
      content: plainTextWithLinks(message, provider === "lark"),
      mediaUrl:
        message.attachments.find(
          (attachment) => attachment.url && !canFetchAttachment(attachment, provider),
        )?.url ?? null,
      ...(attachments.length ? { attachments } : {}),
      ...(provider === "slack" && !isDirect
        ? {
            legacySlackContent: {
              text: message.text ?? "",
              mediaUrl: message.attachments.find((attachment) => attachment.url)?.url ?? null,
            },
          }
        : {}),
    };
    const payload = webhookDrain.getStore()?.payload;
    const enrichment =
      platform.enrichTeamRoom?.(
        payload && typeof payload === "object" ? { ...payload, event: message.raw } : message.raw,
        base,
      ) ?? {};
    return { ...base, ...enrichment };
  }
}

function attachmentMessage(
  telegram: boolean,
  body: string,
  file: MessagingOutboundAttachment,
): PostableMarkdown {
  const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
  if (
    telegram &&
    TELEGRAM_PHOTO_TYPES.has(file.mimeType) &&
    data.byteLength <= TELEGRAM_PHOTO_MAX_BYTES
  ) {
    return {
      markdown: body,
      attachments: [{ type: "image", data, name: file.name, mimeType: file.mimeType }],
    };
  }
  return { markdown: body, files: [{ data, filename: file.name, mimeType: file.mimeType }] };
}

function inboundAttachments(message: Message, provider: string): MessagingInboundAttachment[] {
  return message.attachments.flatMap((attachment) => {
    if (!canFetchAttachment(attachment, provider)) return [];
    const { data, fetchData } = attachment;
    const size = Buffer.isBuffer(data) ? data.byteLength : (data?.size ?? attachment.size);
    return [
      {
        name: attachment.name || attachment.type,
        mimeType: attachment.mimeType ?? "",
        ...(size !== undefined ? { size } : {}),
        fetch: async (deadlineAt) => {
          if (Buffer.isBuffer(data)) return new Uint8Array(data);
          if (data) return new Uint8Array(await data.arrayBuffer());
          return new Uint8Array(await withinMessagingAttachmentDeadline(deadlineAt, fetchData!));
        },
      },
    ];
  });
}

function canFetchAttachment(attachment: Message["attachments"][number], provider: string): boolean {
  if (attachment.data) return true;
  if (!attachment.fetchData) return false;
  if (provider === "slack") return slackFileUrl(attachment.url);
  return provider === "telegram" || provider === "whatsapp";
}

function slackFileUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const target = new URL(url);
    return (
      target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      (target.hostname === "files.slack.com" ||
        target.hostname === "slack-files.com" ||
        target.hostname.endsWith(".slack-files.com") ||
        target.origin === "https://files.slack-gov.com" ||
        target.origin === "https://slack-files-gov.com")
    );
  } catch {
    return false;
  }
}

/**
 * The SDK's message.text keeps only a link's label, so a Slack link labelled
 * `example.com/projects/…` reaches the model without its target.
 */
function plainTextWithLinks(message: Message, lark: boolean): string {
  const parts = lark ? getLarkTextParts(message.formatted) : undefined;
  if (parts) {
    const rendered = parts.map((part, index) => {
      if (part.literal) return { value: part.text, addedTarget: false };
      const value = part.text;
      if (!value.trim()) return { value, addedTarget: false };
      const result = renderLinks(parseMarkdown(value));
      const first = result.ast.children.at(0);
      const last = result.ast.children.at(-1);
      const start = first?.position?.start.offset ?? 0;
      const end = last?.position?.end.offset ?? value.length;
      const prefix = value.slice(0, start);
      const previous = parts[index - 1];
      const sameLine = previous?.literal && !previous.text.endsWith("\n") && !prefix.includes("\n");
      const leading = sameLine ? prefix : prefix.replace(/[^\r\n]/g, "");
      let trailing = value.slice(end);
      // Markdown drops spaces at a fragment boundary; preserve them when the
      // next structured item is on the same row.
      if (last?.type === "paragraph" && !trailing && parts[index + 1]?.literal)
        trailing = value.match(/[ \t]+$/)?.[0] ?? "";
      // A heading followed by a code row has the same paragraph separation as
      // a heading followed by ordinary text in the SDK's plain-text renderer.
      const headingBreak =
        parts[index + 1]?.literal &&
        result.ast.children.at(-1)?.type === "heading" &&
        trailing === "\n"
          ? "\n"
          : "";
      return {
        value: leading + toPlainText(result.ast) + headingBreak + trailing,
        addedTarget: result.addedTarget,
      };
    });
    return rendered.some((part) => part.addedTarget)
      ? rendered.map((part) => part.value).join("")
      : (message.text ?? "");
  }
  const result = renderLinks(message.formatted);
  return result.addedTarget ? toPlainText(result.ast) : (message.text ?? "");
}

function renderLinks(formatted: Message["formatted"]): {
  ast: Message["formatted"];
  addedTarget: boolean;
} {
  let addedTarget = false;
  const ast = walkAst(structuredClone(formatted), (node) => {
    if (!isLinkNode(node)) return node;
    const label = toPlainText({ type: "root", children: node.children }).trim();
    const bare = node.url.replace(/^(?:https?:\/\/|mailto:)/, "");
    if (!label) {
      addedTarget = true;
      return text(node.url);
    }
    if (label === node.url || label === bare || label === bare.replace(/\/$/, ""))
      return text(label);
    addedTarget = true;
    return text(`${label} (${node.url})`);
  });
  return { ast, addedTarget };
}

export function messagingInboundNonce(event: MessagingInboundMessage): string {
  // The Telegram SDK already includes the chat in its handle. Slack
  // timestamps need the conversation added here.
  if (event.provider !== "slack") return `messaging:${event.provider}:${event.handle}`;
  const scoped = JSON.stringify([event.workspaceId, event.threadId, event.handle]);
  return `messaging:${event.provider}:${createHash("sha256").update(scoped).digest("hex")}`;
}

export function providerOfThreadId(threadId: string): string {
  return threadId.split(":", 1)[0] ?? "";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // The abandoned branch must not surface as an unhandled rejection.
      promise.catch(() => undefined);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Read the body incrementally so an unauthenticated chunked request (no
 * trustworthy Content-Length) is cut off at the cap instead of being
 * buffered whole. Returns null once the cap is exceeded.
 */
export async function readBoundedText(
  request: Pick<Request, "body">,
  maxBytes: number,
): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function chatDedupeKey(adapter: Adapter, messageId: string): string {
  // Chat SDK 4.40 marks the adapter/message pair before dispatch.
  return `dedupe:${adapter.name}:${messageId}`;
}

export class MessagingSendError extends Error {
  override readonly name = "MessagingSendError";
  constructor(
    readonly disposition: "retryable" | "permanent" | "unknown",
    readonly reason: MessagingFailureReason,
    readonly retryAfterMs?: number,
    cause?: unknown,
    readonly inFlight?: Promise<MessagingSendResult>,
  ) {
    super(reason, { cause });
  }
}

function classifySendError(platform: MessagingPlatform, error: unknown): MessagingSendError {
  const failure = error as {
    retryAfter?: unknown;
    status?: unknown;
    code?: unknown;
    headers?: Headers;
    response?: { status?: number; headers?: Headers };
  } | null;
  if (
    failure?.status === 429 ||
    failure?.response?.status === 429 ||
    failure?.code === "RATE_LIMITED" ||
    failure?.code === "slack_webapi_rate_limited_error"
  ) {
    const headers = failure?.headers ?? failure?.response?.headers;
    const rawRetry =
      failure?.retryAfter ??
      headers?.get?.("retry-after") ??
      (platform.provider === "lark" ? headers?.get?.("x-ogw-ratelimit-reset") : undefined);
    const seconds = Number(rawRetry);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : typeof rawRetry === "string"
        ? Date.parse(rawRetry) - Date.now()
        : NaN;
    const retryAfterMs =
      Number.isFinite(delay) && delay > 0 && delay < 8_640_000_000_000_000 - Date.now()
        ? delay
        : undefined;
    return new MessagingSendError("retryable", "rate_limited", retryAfterMs, error);
  }
  const rejection = platform.classifyRejection?.(error);
  if (rejection) return new MessagingSendError("permanent", rejection, undefined, error);
  return new MessagingSendError("unknown", "outcome_unknown", undefined, error);
}
