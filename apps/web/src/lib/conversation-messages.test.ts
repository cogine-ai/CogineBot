import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { conversationMessages } from "./conversation-messages";

const picker: MessageBlock = {
  kind: "choice",
  question: "What do you want me on first?",
  options: ["day", "inbox", "research", "everything"].map((id) => ({ id, label: id, letter: id })),
};
function message(blocks: MessageBlock[]): ThreadMessage {
  return {
    id: "message",
    threadId: "thread",
    seq: 1,
    role: "bot",
    blocks,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("conversation messages", () => {
  it("removes the exact legacy startup picker and keeps the real message beside it", () => {
    expect(conversationMessages([message([picker])])).toEqual([]);
    const text: MessageBlock = { kind: "text", text: "Hello again." };
    expect(conversationMessages([message([picker, text])])[0]?.blocks).toEqual([text]);
  });

  it("keeps user requests, real choices and asks including approvals", () => {
    const ordinary = message([{ ...picker, question: "Which evening works?" }]);
    const sameQuestion = message([
      { ...picker, options: [{ id: "custom", label: "Custom", letter: "A" }] },
    ]);
    expect(conversationMessages([ordinary, sameQuestion])).toEqual([ordinary, sameQuestion]);
    expect(conversationMessages([ordinary])[0]).toBe(ordinary);
  });
});
