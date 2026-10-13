import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

export interface PeerMessage {
  id: string;
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  createdAt: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
}

type PeerBlock = Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }>;

export function isPeerBlock(block: MessageBlock): block is PeerBlock {
  return block.kind === "bot_message_sent" || block.kind === "bot_message_received";
}

export function peerMessagesFrom(
  messages: readonly ThreadMessage[],
  botId?: string,
): PeerMessage[] {
  const collected: PeerMessage[] = [];
  for (const message of messages) {
    // A group thread can contain receipts from several Bots to the same peer.
    if (botId && message.botId && message.botId !== botId) continue;
    for (const [index, block] of message.blocks.entries()) {
      if (!isPeerBlock(block)) continue;
      collected.push(
        block.kind === "bot_message_sent"
          ? {
              id: `${message.threadId}:${message.id}:${index}`,
              messageId: message.id,
              direction: "sent",
              peerBotId: block.toBotId,
              peerBotName: block.toBotName,
              text: block.text,
              createdAt: message.createdAt,
            }
          : {
              id: `${message.threadId}:${message.id}:${index}`,
              messageId: message.id,
              direction: "received",
              peerBotId: block.fromBotId,
              peerBotName: block.fromBotName,
              text: block.text,
              createdAt: message.createdAt,
            },
      );
    }
  }
  return collected;
}

/** One conversation per peer, most recently active first. */
export function peerConversations(
  messages: readonly ThreadMessage[],
  botId?: string,
): PeerConversation[] {
  const byPeer = new Map<string, PeerConversation>();
  for (const peerMessage of peerMessagesFrom(messages, botId)) {
    const existing = byPeer.get(peerMessage.peerBotId);
    if (existing) {
      existing.messages.push(peerMessage);
      // Names can change; the newest one wins.
      existing.peerBotName = peerMessage.peerBotName;
      existing.lastText = peerMessage.text;
      existing.lastAt = peerMessage.createdAt;
      continue;
    }
    byPeer.set(peerMessage.peerBotId, {
      peerBotId: peerMessage.peerBotId,
      peerBotName: peerMessage.peerBotName,
      messages: [peerMessage],
      lastText: peerMessage.text,
      lastAt: peerMessage.createdAt,
    });
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
