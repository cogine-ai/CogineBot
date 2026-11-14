import type { AutomatedSenderPolicyMode } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "./team-chat-bridge.js";

/** Exercise the real policy evaluator with synthetic rows and an offline judge.
 * Never start the bridge, run an agent, or send to a provider. */
function fixture(
  mode: AutomatedSenderPolicyMode | null,
  listening: boolean | null = null,
  rules: string | null = null,
) {
  const now = new Date("2026-01-02T12:00:00Z");
  const bot = {
    id: "bot-synthetic",
    name: "Synthetic",
    teamChatAmbientEnabled: true,
    teamChatRules: "Bot default",
  };
  const conversation = {
    conversationId: "channel-a",
    displayName: "Synthetic room",
    teamChatAmbientEnabled: listening,
    teamChatRules: rules,
    automatedSenderPolicies: mode
      ? {
          sender: {
            name: "Synthetic sender",
            mode,
            ...(mode === "rollup" ? { rollupHours: 6 } : {}),
          },
        }
      : {},
  };
  const messages = [
    {
      id: "message-a",
      providerEventId: "event-a",
      senderId: "sender",
      senderName: "Synthetic sender",
      senderIsBot: true,
      content: "Synthetic update",
      createdAt: new Date(0),
      externalConversationId: "conversation-a",
      externalConversation: conversation,
    },
  ];
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findFirst = vi.fn(async () => ({ judgedAt: new Date(now.getTime() - 7 * 3600000) }));
  const decide = vi.fn(async () => ({ act: false }));
  const send = vi.fn();
  const sendUserMessage = vi.fn();
  const enqueue = vi.fn();
  const bridge = new TeamChatBridge({
    prisma: {
      bot: { findFirst: vi.fn(async () => bot) },
      externalMessage: { findMany: vi.fn(async () => messages), findFirst, updateMany },
    } as unknown as PrismaClient,
    events: { sendUserMessage },
    jobs: { enqueue },
    send,
    providerId: "slack",
    botId: bot.id,
    judge: { decide },
    ambientDebounceMs: 0,
  });
  const evaluator = bridge as unknown as {
    target: typeof bot;
    evaluateAmbient(now: Date): Promise<void>;
  };
  evaluator.target = bot;
  return {
    evaluate: () => evaluator.evaluateAmbient(now),
    messages,
    conversation,
    decide,
    updateMany,
    findFirst,
    send,
    sendUserMessage,
    enqueue,
    now,
  };
}

describe("synthetic external conversation policies", () => {
  it.each([null, "ignore", "rollup", "action", "user"] as const)(
    "applies %s only to its conversation and sender",
    async (mode) => {
      const f = fixture(mode);
      f.messages.push({
        ...f.messages[0]!,
        id: "message-b",
        providerEventId: "event-b",
        externalConversationId: "conversation-b",
        externalConversation: { ...f.conversation, automatedSenderPolicies: {} },
      });
      f.messages.push({
        ...f.messages[0]!,
        id: "message-c",
        providerEventId: "event-c",
        senderId: "other-sender",
      });
      await f.evaluate();
      if (mode === "action") {
        expect(f.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "message-a", status: "observed" },
            data: expect.objectContaining({ status: "received" }),
          }),
        );
        expect(f.decide).not.toHaveBeenCalled();
      } else if (mode === "rollup" || mode === "user") {
        expect(f.decide).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            rules: "Bot default",
            messages: [expect.objectContaining({ eventId: "event-a", senderId: "sender" })],
          }),
        );
      } else expect(f.decide).not.toHaveBeenCalled();
      expect(f.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["message-b"] }, status: "observed" },
          data: expect.objectContaining({ status: "ignored" }),
        }),
      );
      expect(f.send).not.toHaveBeenCalled();
      expect(f.sendUserMessage).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
  it("respects the existing rollup interval", async () => {
    const f = fixture("rollup");
    f.findFirst.mockResolvedValue({ judgedAt: new Date(f.now.getTime() - 5 * 3600000) });
    await f.evaluate();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalConversationId: "conversation-a",
          senderId: "sender",
        }),
      }),
    );
  });
  it("keeps explicit empty guidance distinct from inherited guidance", async () => {
    const f = fixture("user", true, "");
    await f.evaluate();
    expect(f.decide).toHaveBeenCalledWith(expect.objectContaining({ rules: "" }));
  });
  it("does not engage ambient messages when mentions-only overrides listening", async () => {
    const f = fixture("action", false);
    await f.evaluate();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ignored" }) }),
    );
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  });
});
