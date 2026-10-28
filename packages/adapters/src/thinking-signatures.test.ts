import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { isThinkingSignatureMismatch, withoutThinkingBlocks } from "./thinking-signatures.js";

describe("thinking signature recovery", () => {
  it.each([
    "400 Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
    "Invalid signature in thinking block",
    "proxy rejected a block bound to a different conversation",
  ])("recognizes the specific provider failure: %s", (error) => {
    expect(isThinkingSignatureMismatch(error)).toBe(true);
  });

  it.each([
    undefined,
    "invalid api key",
    "signature verification failed",
    "thinking.adaptive.block_binding: Extra inputs",
  ])("leaves unrelated failures alone: %s", (error) =>
    expect(isThinkingSignatureMismatch(error)).toBe(false),
  );

  it("removes only historical assistant thinking without mutating the transcript", () => {
    const context = {
      systemPrompt: "retain instructions",
      tools: [{ name: "write_effect" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep" },
            { type: "image", data: "fake" },
          ],
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "old", thinkingSignature: "fake-sig" },
            {
              type: "thinking",
              thinking: "redacted",
              thinkingSignature: "fake-redacted",
              redacted: true,
            },
            { type: "text", text: "keep answer" },
            { type: "toolCall", id: "effect", name: "write_effect", arguments: { value: "once" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "effect",
          content: [{ type: "text", text: "saved" }],
          timestamp: 1,
        },
        { role: "assistant", content: [{ type: "text", text: "plain" }] },
      ],
    } as unknown as TranscriptContext;
    const before = JSON.stringify(context);
    const stripped = withoutThinkingBlocks(context);
    expect(stripped).not.toBe(context);
    expect(Reflect.get(stripped, "tools")).toBe(Reflect.get(context, "tools"));
    expect(stripped.messages[0]).toBe(context.messages[0]);
    expect(stripped.messages[2]).toBe(context.messages[2]);
    expect(stripped.messages[3]).toBe(context.messages[3]);
    expect(stripped.messages[1]).toMatchObject({
      content: [
        { type: "text", text: "keep answer" },
        { type: "toolCall", id: "effect", name: "write_effect", arguments: { value: "once" } },
      ],
    });
    expect(JSON.stringify(context)).toBe(before);
    expect(withoutThinkingBlocks(stripped)).toBe(stripped);
  });

  it("reuses context identity when there are no assistant thinking blocks", () => {
    const context = {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    } as TranscriptContext;
    expect(withoutThinkingBlocks(context)).toBe(context);
  });
});
