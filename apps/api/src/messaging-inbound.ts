import { createHash } from "node:crypto";
import type {
  ArtifactStore,
  JobPublisher,
  MessagingInboundAttachment,
  MessagingInboundMessage,
} from "@rakazo/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@rakazo/adapter-kit";
import { messagingInboundNonce } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  messageBlockForArtifact,
  parseMessagingCommand,
  promptTextForAttachments,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type {
  MessagingIdentityRequest,
  Prisma,
  PrismaClient,
  ProvisionedMessagingIdentity,
  SignupPolicyEnv,
  ThreadEvents,
} from "@rakazo/db";
import {
  createThreadMessage,
  MessagingRouteAlreadyChosen,
  normalizeMessagingLinkCode,
  redeemMessagingLinkCode,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createOwnedArtifact } from "./artifacts.js";
import {
  MESSAGE_ROUTING_REARMED_REASON,
  MESSAGE_ROUTING_REASON,
  MESSAGE_ROUTING_RESERVATION_MS,
} from "./team-chat-startup.js";
import {
  deliverWebhookEvent,
  formatUntrustedDeliveryPayload,
  inboundDeliveryClientNonce,
  inboundEventName,
  messagingWakeIdempotencyKey,
} from "./webhook-inbound.js";

export interface MessagingInboundDeps {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  provision: (
    request: MessagingIdentityRequest,
    env: SignupPolicyEnv,
  ) => Promise<ProvisionedMessagingIdentity>;
  /**
   * Poke-style open line: unknown senders auto-provision their own account.
   * Off by default — strangers' runs would bill the deployment model key.
   */
  openSignup: boolean;
  signupPolicy: SignupPolicyEnv;
  /**
   * Best-effort "…" bubbles shown to a 1:1 sender while their run executes.
   * Cosmetic only — callers must catch failures; groups never get it.
   */
  typing?: (threadId: string) => Promise<void>;
  acknowledge?: (event: MessagingInboundMessage, runId: string) => void;
  artifacts?: ArtifactStore;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  userId: string;
  spaceId: string;
  botId: string;
};

/**
 * Inbound routing. 1:1 messages are messages to the sender's own bot (with
 * provisioning on first contact and the YES/NO/LEAVE owner commands).
 * Group messages drive channel discovery — upsert channel + members, DM
 * invites to linked owners, one intro when strangers are present — and
 * fan out to every approved member bot's own thread.
 */
export function createMessagingInboundHandler(deps: MessagingInboundDeps) {
  return async (event: MessagingInboundMessage): Promise<void> => {
    if (event.senderIsBot || !event.handle || !event.from) return;
    if (!event.isDirect) {
      await handleChannelEvent(deps, event);
      return;
    }
    await handleDirectEvent(deps, event);
  };
}

function inboundReceiptKey(event: MessagingInboundMessage, memberId?: string): string {
  const key = JSON.stringify([
    event.provider,
    event.workspaceId,
    event.threadId,
    event.from,
    event.handle,
    memberId,
  ]);
  return `inbound:${createHash("sha256").update(key).digest("hex")}`;
}

/** Keep a redelivery pinned to the original local thread across relinking. */
async function bindInboundTarget(
  prisma: PrismaClient,
  key: string,
  target: { identityId: string; threadId: string; provider: string },
): Promise<boolean> {
  const { count } = await prisma.messagingOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "inbound", status: "inbound", body: "", ...target }],
    skipDuplicates: true,
  });
  if (count === 1) return true;
  const prior = await prisma.messagingOutbound.findUnique({
    where: { idempotencyKey: key },
    select: { status: true, threadId: true, identityId: true },
  });
  return (
    prior !== null &&
    ["inbound", "inbound_routine", "inbound_message"].includes(prior.status) &&
    prior.threadId === target.threadId &&
    prior.identityId === target.identityId
  );
}

function routineDeliveryKey(event: MessagingInboundMessage) {
  return messagingWakeIdempotencyKey(
    event.provider,
    event.provider === "slack" ? messagingInboundNonce(event) : event.handle,
  );
}

function matchesLegacySlackRoutine(
  blocks: Prisma.JsonValue,
  event: MessagingInboundMessage,
): boolean {
  const text = (blocks as MessageBlock[]).find((block) => block.kind === "text")?.text;
  if (!text) return false;
  const start = "<untrusted_delivery_payload>\n";
  const offset = text.lastIndexOf(start);
  const end = text.lastIndexOf("\n</untrusted_delivery_payload>");
  if (offset < 0 || end <= offset) return false;
  try {
    const data = JSON.parse(text.slice(offset + start.length, end)) as {
      from?: string;
      kind?: string;
      channelName?: string | null;
      content?: string;
      mediaUrl?: string | null;
    };
    const escapePayloadText = (value: string) =>
      value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const legacy = event.legacySlackContent ?? { text: event.content, mediaUrl: event.mediaUrl };
    return (
      data.from === escapePayloadText(event.from) &&
      data.kind === (event.isDirect ? "direct" : "channel") &&
      (event.isDirect ||
        (data.channelName ===
          (event.channelName === null ? null : escapePayloadText(event.channelName)) &&
          data.content === escapePayloadText(legacy.text) &&
          (data.mediaUrl ?? null) ===
            (legacy.mediaUrl === null ? null : escapePayloadText(legacy.mediaUrl))))
    );
  } catch {
    return false;
  }
}

async function activeIdentity(
  prisma: Pick<Prisma.TransactionClient, "bot" | "spaceMember">,
  identity: Pick<IdentityRow, "spaceId" | "userId" | "botId">,
): Promise<boolean> {
  const { spaceId, userId, botId } = identity;
  const [member, bot] = await Promise.all([
    prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      select: { id: true },
    }),
    prisma.bot.findUnique({
      where: { id: botId, spaceId, userId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  return Boolean(member && bot);
}

function attachmentReader() {
  const deadlineAt = Date.now() + 10_000;
  const reads = new Map<MessagingInboundAttachment, Promise<Uint8Array>>();
  return (attachment: MessagingInboundAttachment) => {
    const cached = reads.get(attachment);
    if (cached) return cached;
    if (Date.now() >= deadlineAt) throw new Error("Attachment download deadline exceeded");
    const pending = attachment.fetch(deadlineAt);
    reads.set(attachment, pending);
    return pending;
  };
}

async function inboundContent(
  deps: Pick<MessagingInboundDeps, "prisma" | "artifacts">,
  target: Pick<IdentityRow, "spaceId" | "userId" | "botId">,
  event: MessagingInboundMessage,
  readAttachment = attachmentReader(),
) {
  const text = [event.content, event.mediaUrl].filter(Boolean).join("\n");
  const attachments = event.attachments ?? [];
  const artifacts: Awaited<ReturnType<typeof createOwnedArtifact>>[] = [];
  if (deps.artifacts && attachments.length) {
    for (const [index, attachment] of attachments.slice(0, ATTACHMENT_MAX_COUNT).entries()) {
      const name = attachment.name.trim().slice(0, 255) || "Attachment";
      const mimeType = inferAttachmentMimeType(name, attachment.mimeType);
      if (!mimeType || (attachment.size !== undefined && attachment.size > ATTACHMENT_MAX_BYTES))
        continue;
      let bytes: Uint8Array;
      try {
        bytes = await readAttachment(attachment);
      } catch {
        continue;
      }
      if (!bytes.byteLength || bytes.byteLength > ATTACHMENT_MAX_BYTES) continue;
      try {
        artifacts.push(
          await createOwnedArtifact({ prisma: deps.prisma, artifacts: deps.artifacts }, target, {
            botId: target.botId,
            name,
            mimeType,
            contentBase64: Buffer.from(bytes).toString("base64"),
            clientNonce: `${messagingInboundNonce(event)}:${target.botId}:attachment:${index}`,
          }),
        );
      } catch {
        getLogger().warn("messaging inbound attachment could not be stored");
      }
    }
  }
  const unavailable = attachments.length > artifacts.length;
  const caption = [text, unavailable ? "An attachment could not be received." : ""]
    .filter(Boolean)
    .join("\n");
  const blocks: MessageBlock[] = [
    ...(caption ? [{ kind: "text" as const, text: caption }] : []),
    ...artifacts.map(messageBlockForArtifact),
  ];
  return { blocks, caption, prompt: promptTextForAttachments(caption, artifacts) };
}

function externalMessagePrompt(event: MessagingInboundMessage, text: string, channelName?: string) {
  return formatUntrustedDeliveryPayload(
    channelName
      ? "Reply to this external group message as appropriate."
      : "Reply to this linked messaging conversation as appropriate.",
    { provider: event.provider, ...(channelName && { channel: channelName }), text },
  );
}

async function markInboundCommand(tx: Prisma.TransactionClient, key: string, provider: string) {
  const { count } = await tx.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey: key,
        kind: "inbound_command",
        status: "inbound_command",
        provider,
        body: "",
      },
    ],
    skipDuplicates: true,
  });
  return count === 1;
}

async function alreadyReceived(
  prisma: PrismaClient,
  event: MessagingInboundMessage,
  identity: Pick<IdentityRow, "id" | "botId">,
  threadId: string,
  channelId?: string,
): Promise<boolean> {
  const legacyRoutineKey = messagingWakeIdempotencyKey(event.provider, event.handle);
  const routineKey = routineDeliveryKey(event);
  const clientNonce = `messaging:${event.provider}:${event.handle}`;
  const sameConversation = (message: { blocks: Prisma.JsonValue }) => {
    const channel = (message.blocks as MessageBlock[]).find(
      (block) => block.kind === "channel_message",
    );
    return channel?.channelId === channelId;
  };
  const current = await prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce } },
    select: { blocks: true },
  });
  if (current && sameConversation(current)) return true;

  const prior = await prisma.messagingOutbound.findMany({
    where: { identityId: identity.id, status: "inbound_binding", provider: event.provider },
    select: { threadId: true, idempotencyKey: true },
  });
  const threadIds = prior.flatMap((binding) => (binding.threadId ? [binding.threadId] : []));
  if (threadIds.length) {
    const deliveries = await prisma.message.findMany({
      where: { clientNonce, threadId: { in: threadIds } },
      select: { blocks: true },
    });
    if (deliveries.some(sameConversation)) return true;
  }
  const targets = [
    { threadId, botId: identity.botId },
    ...prior.flatMap((binding) => {
      const botId = binding.idempotencyKey.split(":").at(-1);
      return binding.threadId && botId ? [{ threadId: binding.threadId, botId }] : [];
    }),
  ];
  for (const target of targets) {
    for (const key of new Set([routineKey, legacyRoutineKey])) {
      const recorded = await prisma.message.findUnique({
        where: {
          threadId_clientNonce: {
            threadId: target.threadId,
            clientNonce: inboundDeliveryClientNonce("messaging", target.botId, key),
          },
        },
        select: { blocks: true },
      });
      if (recorded && (key === routineKey || matchesLegacySlackRoutine(recorded.blocks, event)))
        return true;
    }
  }
  return false;
}

async function handleDirectEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const hasContent = Boolean(event.content || event.mediaUrl || event.attachments?.length);
  const deliveryKey = inboundReceiptKey(event);
  const prior = await deps.prisma.messagingOutbound.findUnique({
    where: { idempotencyKey: deliveryKey },
    select: { identityId: true, status: true, threadId: true },
  });
  if (prior?.status === "inbound_command") return;
  const command = prior ? null : parseMessagingCommand(event.content);
  const code = prior ? null : normalizeMessagingLinkCode(event.content);
  const where = { provider_address: { provider: event.provider, address: event.from } } as const;
  const existing = await deps.prisma.messagingIdentity.findUnique({ where });
  if (prior && prior.identityId !== existing?.id) return;
  let ids: ProvisionedMessagingIdentity;
  if (existing) {
    const thread = await deps.prisma.thread.findFirst({
      where: { botId: existing.botId, spaceId: existing.spaceId, userId: existing.userId },
    });
    if (prior && prior.threadId !== thread?.id) return;
    if (thread && (await alreadyReceived(deps.prisma, event, existing, thread.id))) return;
    const active = thread && (await activeIdentity(deps.prisma, existing));
    // A fresh reply ends the consecutive-outbound streak, including when
    // there is no text to wake a Run.
    if (active && !prior) {
      await deps.prisma.messagingIdentity.update({
        where: { id: existing.id },
        data: { outboundSinceInbound: 0, lastInboundAt: new Date(), dmThreadId: event.threadId },
      });
    }
    if (
      code &&
      (await tryRedeemLinkCode(
        deps,
        event,
        code,
        deliveryKey,
        thread
          ? { identityId: existing.id, botId: existing.botId, threadId: thread.id }
          : undefined,
      ))
    )
      return;
    if (!active || !thread || !hasContent) return;
    if (command && (await applyOwnerCommand(deps, existing, command, deliveryKey))) return;
    ids = {
      provider: existing.provider,
      address: existing.address,
      userId: existing.userId,
      spaceId: existing.spaceId,
      botId: existing.botId,
      threadId: thread.id,
      created: false,
    };
  } else {
    if (code && (await tryRedeemLinkCode(deps, event, code, deliveryKey))) return;
    if (!deps.openSignup || !hasContent) return;
    ids = await deps.provision(
      {
        provider: event.provider,
        address: event.from,
        dmThreadId: event.threadId,
        displayName: event.fromLabel ? sanitizeMessagingLabel(event.fromLabel) : null,
      },
      deps.signupPolicy,
    );
  }

  const owner = existing ?? (await deps.prisma.messagingIdentity.findUnique({ where }));
  if (
    owner &&
    !(await bindInboundTarget(deps.prisma, deliveryKey, {
      identityId: owner.id,
      threadId: ids.threadId,
      provider: event.provider,
    }))
  )
    return;
  if (
    await deps.prisma.message.findUnique({
      where: {
        threadId_clientNonce: { threadId: ids.threadId, clientNonce: messagingInboundNonce(event) },
      },
      select: { id: true },
    })
  )
    return;

  // Message-trigger routines own the delivery when configured. Do not also
  // start a normal messaging continue for the same inbound handle.
  const content = await inboundContent(deps, ids, event);
  const receiptKey = owner ? deliveryKey : undefined;
  if (await wakeMessageRoutines(deps, ids, event, { content, receiptKey })) return;
  const { blocks, prompt } = content;
  const sent = await sendInboundMessage(deps.events, {
    spaceId: ids.spaceId,
    threadId: ids.threadId,
    botId: ids.botId,
    userId: ids.userId,
    blocks,
    prompt: externalMessagePrompt(event, prompt),
    trigger: "messaging",
    clientNonce: messagingInboundNonce(event),
    ...(receiptKey && { messagingReceiptKey: receiptKey }),
  });
  if (sent?.runId) {
    // Typing bubbles only make sense once a reply is actually coming. Fire
    // before the enqueue so they land ahead of a fast reply, and never await:
    // a stalled vendor typing call must not hold the webhook open. The bubbles
    // clear on their own after a short display window or when the reply
    // arrives, so long runs simply outlive them.
    if (deps.acknowledge) deps.acknowledge(event, sent.runId);
    else
      void deps.typing?.(event.threadId).catch((error) => {
        getLogger().error("messaging typing indicator error", error);
      });
    await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
      getLogger().error("messaging inbound run enqueue error", error);
    });
  }
}

async function sendInboundMessage(
  events: MessagingInboundDeps["events"],
  input: Parameters<MessagingInboundDeps["events"]["sendUserMessage"]>[0],
) {
  return events.sendUserMessage(input).catch((error: unknown) => {
    if (error instanceof MessagingRouteAlreadyChosen) return null;
    throw error;
  });
}

/** Wake provider-neutral message routines through the same approval boundary as webhooks. */
export async function wakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma" | "events" | "jobs" | "artifacts">,
  target: Pick<ProvisionedMessagingIdentity, "spaceId" | "userId" | "botId" | "threadId">,
  event: MessagingInboundMessage,
  options?: {
    /**
     * Provider prefix for the wake clientNonce. TeamChat recovery looks up
     * nonces with TeamChatBridge.providerId (often "slack"); pass that here when
     * the inbound event.provider differs (e.g. teamchat-emulator).
     */
    deliveryProvider?: string;
    /**
     * TeamChat external message id. When set, atomically reassert routine
     * ownership before creating a run so a concurrent TeamChat agent claim
     * cannot also deliver for the same provider event.
     */
    externalMessageId?: string;
    content?: Awaited<ReturnType<typeof inboundContent>>;
    receiptKey?: string;
  },
): Promise<boolean> {
  const routines = await deps.prisma.routine.findMany({
    where: {
      botId: target.botId,
      spaceId: target.spaceId,
      userId: target.userId,
      active: true,
      messageProvider: event.provider,
    },
    select: {
      id: true,
      name: true,
      prompt: true,
      modelProvider: true,
      modelId: true,
      modelCredentialId: true,
      thinkingLevel: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (routines.length === 0) return false;

  if (options?.externalMessageId) {
    // CAS: only deliver when agent ownership has not claimed the row. Holding
    // message_routine_routing blocks TeamChat queue() from creating a parallel run.
    const reserved = await deps.prisma.externalMessage.updateMany({
      where: {
        id: options.externalMessageId,
        status: { in: ["deferred", "received", "observed"] },
        OR: [
          { engagementReason: null },
          {
            engagementReason: {
              in: [MESSAGE_ROUTING_REASON, MESSAGE_ROUTING_REARMED_REASON],
            },
          },
        ],
      },
      data: {
        engagementReason: MESSAGE_ROUTING_REASON,
        // Outlive a dead heartbeat so reconcile cannot promote to agent mid-wake.
        nextAttemptAt: new Date(Date.now() + MESSAGE_ROUTING_RESERVATION_MS),
      },
    });
    if (reserved.count !== 1) return false;
  }

  const content =
    options?.content ??
    (event.attachments?.length && (await activeIdentity(deps.prisma, target))
      ? await inboundContent(deps, target, event)
      : undefined);
  const attachments = content?.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const provider = inboundEventName(event.provider);
  const prompt = formatUntrustedDeliveryPayload(`[Messaging Event: ${provider}]`, {
    provider: event.provider,
    kind: event.isDirect ? "direct" : "channel",
    handle: event.handle,
    from: event.from,
    fromLabel: event.fromLabel,
    channelName: event.channelName,
    content: content?.caption || event.content,
    mediaUrl: event.mediaUrl,
    ...(attachments?.length && {
      attachments: attachments.map((file) => ({
        artifactId: file.artifactId,
        name: file.name,
        mimeType: file.mimeType,
        ...(file.kind === "file" && { size: file.size }),
      })),
    }),
  });
  const result = await deliverWebhookEvent(
    { events: deps.events, jobs: deps.jobs },
    {
      bot: { id: target.botId, spaceId: target.spaceId, userId: target.userId },
      threadId: target.threadId,
    },
    {
      prompt,
      routines,
      source: "messaging",
      messageProvider: event.provider,
      ...(attachments?.length && { attachments }),
      ...(options?.receiptKey && { messagingReceiptKey: options.receiptKey }),
      idempotencyKey:
        options?.deliveryProvider || options?.externalMessageId
          ? messagingWakeIdempotencyKey(options.deliveryProvider ?? event.provider, event.handle)
          : routineDeliveryKey(event),
      // TeamChat channel wakes may share a live thread with an active chat run.
      allowParallelRun: true,
    },
  ).catch((error: unknown) => {
    if (error instanceof MessagingRouteAlreadyChosen) return null;
    throw error;
  });
  return result !== null;
}

/**
 * TeamChat engagement can still receive the message, but unattended
 * message-routine wakes reuse the personal-line approval boundary:
 * linked identity for DMs; approved channel member when we have membership
 * state; otherwise a linked identity so public-channel strangers cannot start
 * active routines.
 */
export async function teamChatSenderCanWakeMessageRoutines(
  deps: Pick<MessagingInboundDeps, "prisma">,
  event: MessagingInboundMessage,
): Promise<boolean> {
  if (event.senderIsBot) return false;

  const linkedIdentity = await deps.prisma.messagingIdentity.findUnique({
    where: { provider_address: { provider: event.provider, address: event.from } },
    select: { id: true, userId: true, spaceId: true, botId: true },
  });
  if (!linkedIdentity || !(await activeIdentity(deps.prisma, linkedIdentity))) return false;

  if (event.isDirect) return true;

  const room =
    event.provider === "slack" && event.conversationKey ? `slack:${event.conversationKey}` : null;
  if (room) {
    // Older Slack ledgers can have one channel row per message thread.
    // Channel activity does not determine when a sender's approval changed.
    const roomWhere = {
      provider: "slack",
      OR: [{ threadId: room }, { threadId: { startsWith: `${room}:` } }],
    };
    const member = await deps.prisma.messagingChannelMember.findFirst({
      where: { address: event.from, channel: roomWhere },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { status: true, identityId: true },
    });
    if (member) return member.status === "approved" && member.identityId === linkedIdentity.id;
    const ledger = await deps.prisma.messagingChannel.findFirst({
      where: roomWhere,
      select: { id: true },
    });
    return !ledger;
  }
  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { threadId: event.threadId },
    select: { id: true },
  });
  if (channel) {
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address: event.from } },
      select: { status: true, identityId: true },
    });
    return member?.status === "approved" && member.identityId === linkedIdentity.id;
  }

  // Pure TeamChat workspace rooms have no personal membership ledger.
  // Still require a linked sender before waking message routines.
  return true;
}

/**
 * Returns true when the message was exactly a link code that redeemed:
 * the address is now bound to the issuer's chosen bot and a confirmation
 * DM is on its way. An invalid or expired code falls through silently —
 * for linked senders it reads as a normal message, for strangers nothing
 * happens (no oracle, no reply spam).
 */
class InactiveMessagingIdentity extends Error {}
class InboundAlreadyClaimed extends Error {}

async function tryRedeemLinkCode(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
  code: string,
  commandKey: string,
  previous?: { identityId: string; botId: string; threadId: string },
): Promise<boolean> {
  const redeemed = await redeemMessagingLinkCode(
    deps.prisma,
    {
      code,
      provider: event.provider,
      address: event.from,
      dmThreadId: event.threadId,
    },
    async (tx, link) => {
      if (!(await activeIdentity(tx, link))) throw new InactiveMessagingIdentity();
      if (!(await markInboundCommand(tx, commandKey, event.provider)))
        throw new InboundAlreadyClaimed();
      if (previous && link.botId !== previous.botId) {
        await tx.messagingOutbound.createMany({
          data: [
            {
              idempotencyKey: `inbound-binding:${previous.identityId}:${previous.threadId}:${previous.botId}`,
              kind: "inbound_binding",
              status: "inbound_binding",
              body: "",
              provider: event.provider,
              identityId: previous.identityId,
              threadId: previous.threadId,
            },
          ],
          skipDuplicates: true,
        });
      }
      const bot = await tx.bot.findUnique({ where: { id: link.botId }, select: { name: true } });
      await writeConfirmation(
        tx,
        { id: link.identityId },
        link.confirmationKey,
        `Linked. Messages here now reach "${bot?.name ?? "your agent"}".`,
      );
    },
  ).catch((error: unknown) => {
    if (error instanceof InactiveMessagingIdentity || error instanceof InboundAlreadyClaimed)
      return null;
    throw error;
  });
  if (!redeemed) {
    return Boolean(
      await deps.prisma.messagingOutbound.findUnique({
        where: { idempotencyKey: commandKey },
        select: { id: true },
      }),
    );
  }
  await enqueueDeliverJob(deps);
  return true;
}

/** Returns true when the command matched a pending item and was handled. */
async function applyOwnerCommand(
  deps: MessagingInboundDeps,
  identity: IdentityRow,
  command: "approve" | "decline" | "leave",
  commandKey: string,
): Promise<boolean> {
  if (command === "leave") {
    const membership = await deps.prisma.messagingChannelMember.findFirst({
      where: { identityId: identity.id, status: "approved" },
      orderBy: { updatedAt: "desc" },
    });
    if (!membership) return false;
    const processed = await deps.prisma.$transaction(async (tx) => {
      if (!(await markInboundCommand(tx, commandKey, identity.provider))) return true;
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: membership.id, status: "approved" },
        data: { status: "left" },
      });
      if (!count) {
        await tx.messagingOutbound.deleteMany({
          where: { idempotencyKey: commandKey, status: "inbound_command" },
        });
        return false;
      }
      await writeConfirmation(
        tx,
        identity,
        `command:leave:${membership.id}`,
        "You've left the channel. Your agent will no longer post there. The group chat itself is unchanged.",
      );
      return true;
    });
    if (!processed) return false;
    await enqueueDeliverJob(deps);
    return true;
  }

  const membership = await deps.prisma.messagingChannelMember.findFirst({
    where: { identityId: identity.id, status: "invited" },
    orderBy: { updatedAt: "desc" },
  });
  const connection = await deps.prisma.agentConnection.findFirst({
    where: { targetBotId: identity.botId, status: "pending" },
    orderBy: { updatedAt: "desc" },
  });
  // YES/NO answers whichever pending item is newest, channel invite or
  // agent connection.
  const target =
    membership && (!connection || membership.updatedAt >= connection.updatedAt)
      ? ({ kind: "channel", membership } as const)
      : connection
        ? ({ kind: "connection", connection } as const)
        : null;
  if (!target) return false;
  const approved = command === "approve";

  if (target.kind === "channel") {
    const key = `command:${command}:${target.membership.id}`;
    const claimed = await deps.prisma.$transaction(async (tx) => {
      if (!(await markInboundCommand(tx, commandKey, identity.provider))) return true;
      // The claim holds the membership row lock through commit, so the
      // participant sweep can never interleave with the confirmation write.
      const { count } = await tx.messagingChannelMember.updateMany({
        where: { id: target.membership.id, status: "invited" },
        data: { status: approved ? "approved" : "declined" },
      });
      // Swept out or answered elsewhere since the read: not ours to write.
      if (count === 0) {
        await tx.messagingOutbound.deleteMany({
          where: { idempotencyKey: commandKey, status: "inbound_command" },
        });
        return false;
      }
      await writeConfirmation(
        tx,
        identity,
        key,
        approved
          ? "You're in. Your agent will now see and reply to that group."
          : "No problem, your agent will stay out of that group.",
      );
      return true;
    });
    if (!claimed) return false;
    await enqueueDeliverJob(deps);
    return true;
  }

  const connectedKey = `command:connected:${target.connection.id}`;
  const requesterIdentity = approved
    ? await deps.prisma.messagingIdentity.findUnique({
        where: { botId: target.connection.requesterBotId },
      })
    : null;
  const key = `command:${command}:${target.connection.id}`;
  const claimed = await deps.prisma.$transaction(async (tx) => {
    if (!(await markInboundCommand(tx, commandKey, identity.provider))) return true;
    // The claim holds the connection row lock through commit, so a revoke
    // can never interleave with the confirmation writes.
    const { count } = await tx.agentConnection.updateMany({
      where: {
        id: target.connection.id,
        targetBotId: identity.botId,
        status: "pending",
        requestVersion: target.connection.requestVersion,
      },
      data: {
        status: approved ? "approved" : "declined",
        responseVersion: target.connection.requestVersion,
      },
    });
    // The observed request was answered, revoked, or reopened.
    if (count === 0) {
      await tx.messagingOutbound.deleteMany({
        where: { idempotencyKey: commandKey, status: "inbound_command" },
      });
      return false;
    }
    await writeConfirmation(
      tx,
      identity,
      key,
      approved
        ? "Connection approved. Your agents can now message each other."
        : "Connection declined.",
    );
    if (requesterIdentity) {
      await writeConfirmation(
        tx,
        requesterIdentity,
        connectedKey,
        "Your connection request was accepted. Your agents can now message each other.",
      );
    }
    return true;
  });
  if (!claimed) return false;
  await enqueueDeliverJob(deps);
  return true;
}

/** Delete-then-insert inside the caller's claim transaction: the prior
 * cycle's row must not suppress the new confirmation. */
async function writeConfirmation(
  tx: Pick<Prisma.TransactionClient, "messagingOutbound">,
  identity: { id: string },
  key: string,
  body: string,
): Promise<void> {
  await tx.messagingOutbound.deleteMany({ where: { idempotencyKey: key } });
  await tx.messagingOutbound.createMany({
    data: [{ idempotencyKey: key, kind: "dm", identityId: identity.id, body }],
    skipDuplicates: true,
  });
}

async function enqueueDeliverJob(deps: MessagingInboundDeps): Promise<void> {
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging confirmation enqueue error", error);
  });
}

async function handleChannelEvent(
  deps: MessagingInboundDeps,
  event: MessagingInboundMessage,
): Promise<void> {
  const channelName = event.channelName ? sanitizeMessagingLabel(event.channelName) : null;
  const channel = await deps.prisma.messagingChannel.upsert({
    where: { threadId: event.threadId },
    create: { provider: event.provider, threadId: event.threadId, name: channelName },
    update: channelName ? { name: channelName } : {},
  });

  const participants = [...event.participants];
  if (!participants.includes(event.from)) participants.push(event.from);

  let hasUnlinked = false;
  for (const address of participants) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { provider_address: { provider: event.provider, address } },
    });
    const member = await deps.prisma.messagingChannelMember.findUnique({
      where: { channelId_address: { channelId: channel.id, address } },
    });
    if (member) {
      // Compare against the current identity, not just null: unlinking
      // deletes the identity row but leaves this FK-free column pointing at
      // the dead id, so a re-link would otherwise never reattach and the
      // member would sit in the channel unreachable by every lookup.
      if (identity && member.identityId !== identity.id) {
        await deps.prisma.messagingChannelMember.update({
          where: { id: member.id },
          data: { identityId: identity.id },
        });
        if (member.status === "invited") await inviteMember(deps, channel, identity);
      }
      if (member.status === "left") {
        // Back in the group: restart the approval cycle.
        await deps.prisma.messagingChannelMember.update({
          where: { id: member.id },
          data: { status: "invited" },
        });
        if (identity) await inviteMember(deps, channel, identity);
      }
      if (!identity) hasUnlinked = true;
      continue;
    }
    // Upsert, not create: concurrent group webhooks race on the unique key.
    await deps.prisma.messagingChannelMember.upsert({
      where: { channelId_address: { channelId: channel.id, address } },
      create: {
        channelId: channel.id,
        address,
        identityId: identity?.id ?? null,
        status: "invited",
      },
      update: {},
    });
    if (identity) await inviteMember(deps, channel, identity);
    else hasUnlinked = true;
  }

  // Someone removed from the group must stop receiving its content.
  // A webhook without a participants roster says nothing about membership —
  // never sweep on partial data.
  if (event.participants.length > 0) {
    await deps.prisma.messagingChannelMember.updateMany({
      where: {
        channelId: channel.id,
        address: { notIn: participants },
        status: { in: ["invited", "approved"] },
      },
      data: { status: "left" },
    });
  }

  if (hasUnlinked && !channel.introPostedAt) {
    await deps.prisma.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `intro:${channel.id}`,
          kind: "intro",
          threadId: channel.threadId,
          body: "Hi. This line hosts CogineBot personal agents. Some people in this group haven't messaged it yet; send any message to this line first if you want your own agent here.",
        },
      ],
      skipDuplicates: true,
    });
    await deps.prisma.messagingChannel.update({
      where: { id: channel.id },
      data: { introPostedAt: new Date() },
    });
    await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
      getLogger().error("messaging intro enqueue error", error);
    });
  }

  // Only approved owners' bots participate.
  const senderMember = await deps.prisma.messagingChannelMember.findUnique({
    where: { channelId_address: { channelId: channel.id, address: event.from } },
  });
  if (senderMember?.status !== "approved") return;

  const senderIdentity = senderMember.identityId
    ? await deps.prisma.messagingIdentity.findUnique({ where: { id: senderMember.identityId } })
    : null;
  if (
    !senderIdentity ||
    senderIdentity.address !== event.from ||
    senderIdentity.provider !== event.provider ||
    !(await activeIdentity(deps.prisma, senderIdentity))
  )
    return;
  const fromLabel = await ownerFirstName(deps.prisma, senderIdentity.userId, event.from);

  const approved = await deps.prisma.messagingChannelMember.findMany({
    where: { channelId: channel.id, status: "approved", identityId: { not: null } },
  });
  const block: MessageBlock = {
    kind: "channel_message",
    provider: event.provider,
    ...(event.transport ? { transport: event.transport } : {}),
    channelId: channel.id,
    fromAddress: event.from,
    fromLabel,
    text: event.content,
    hop: 0,
  };
  const readAttachment = attachmentReader();
  for (const member of approved) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { id: member.identityId! },
    });
    if (
      !identity ||
      identity.provider !== event.provider ||
      identity.address !== member.address ||
      !(await activeIdentity(deps.prisma, identity))
    )
      continue;
    const thread = await deps.prisma.thread.findFirst({
      where: { botId: identity.botId, spaceId: identity.spaceId, userId: identity.userId },
    });
    if (!thread) continue;
    const target = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      threadId: thread.id,
    };
    if (await alreadyReceived(deps.prisma, event, identity, thread.id, channel.id)) continue;
    const receiptKey = inboundReceiptKey(event, member.id);
    if (
      !(await bindInboundTarget(deps.prisma, receiptKey, {
        identityId: identity.id,
        threadId: thread.id,
        provider: event.provider,
      }))
    )
      continue;
    if (
      await deps.prisma.message.findUnique({
        where: {
          threadId_clientNonce: { threadId: thread.id, clientNonce: messagingInboundNonce(event) },
        },
        select: { id: true },
      })
    )
      continue;
    const content = await inboundContent(deps, target, event, readAttachment);
    if (await wakeMessageRoutines(deps, target, event, { content, receiptKey })) continue;
    const { blocks, caption, prompt } = content;
    const sent = await sendInboundMessage(deps.events, {
      spaceId: identity.spaceId,
      threadId: thread.id,
      botId: identity.botId,
      userId: identity.userId,
      blocks: [{ ...block, text: caption }, ...blocks.filter((item) => item.kind !== "text")],
      prompt: externalMessagePrompt(event, prompt, channel.name ?? "group"),
      trigger: "messaging",
      clientNonce: messagingInboundNonce(event),
      messagingReceiptKey: receiptKey,
    });
    if (sent?.runId) {
      await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
        getLogger().error("messaging channel fan-out enqueue error", error);
      });
    }
  }
}

async function inviteMember(
  deps: MessagingInboundDeps,
  channel: { id: string; name: string | null },
  identity: IdentityRow,
): Promise<void> {
  const name = channel.name ?? "a group chat";
  // A returning member restarts the approval cycle; clear the prior invite
  // row or skipDuplicates would leave them with no prompt to answer.
  await deps.prisma.messagingOutbound.deleteMany({
    where: { idempotencyKey: `invite:${channel.id}:${identity.id}` },
  });
  await deps.prisma.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey: `invite:${channel.id}:${identity.id}`,
        kind: "dm",
        identityId: identity.id,
        body: `"${name}" was linked to your CogineBot agent. Reply YES to let your agent join the conversation there, or NO to stay out.`,
      },
    ],
    skipDuplicates: true,
  });
  const thread = await deps.prisma.thread.findFirst({ where: { botId: identity.botId } });
  if (thread) {
    const note = await createThreadMessage(deps.prisma, {
      threadId: thread.id,
      role: "system",
      blocks: [
        {
          kind: "meta",
          text: `You were added to the group chat "${name}". Reply YES in this conversation to join it with your agent.`,
        },
      ],
    });
    await deps.events.notify(thread.id, note.seq).catch(() => undefined);
  }
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("messaging invite enqueue error", error);
  });
}

async function ownerFirstName(
  prisma: PrismaClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const first = user?.name.trim().split(/\s+/)[0];
  return first ? sanitizeMessagingLabel(first) : fallback;
}
