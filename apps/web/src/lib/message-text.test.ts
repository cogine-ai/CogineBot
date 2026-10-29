import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText } from "./message-text.js";

function message(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role: "bot", blocks, createdAt: "2026-08-29" };
}

describe("copyableMessageText", () => {
  it("joins text, progress, and ask blocks without chrome", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "first" },
          { kind: "progress", text: "working" },
          { kind: "ask", text: "question?" },
        ]),
      ),
    ).toBe("first\nworking\nquestion?");
  });

  it("includes channel messages with their chat attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "RCS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("RCS · Alice: dinner at 7?");
  });

  it("falls back to the provider label for unknown transport values", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "email",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "hello",
          },
        ]),
      ),
    ).toBe("iMessage · Alice: hello");
  });
});

it("copies Unicode and original boundary newlines without ASCII or whitespace normalization", () => {
  const text = "\n  中文 日本語 한국어 العربية e\u0301 👩‍👩‍👧‍👦\r\nnext\n";
  expect(copyableMessageText(message([{ kind: "text", text }]))).toBe(text);
});
