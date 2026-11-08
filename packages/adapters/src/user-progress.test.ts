import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  midTaskMessagePrompt,
  midTurnProgressBudgetAllows,
  midTurnProgressBudgetUsed,
  narrationStatusLine,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

describe("clampUserProgressMessage", () => {
  it("trims and rejects empty text", () => {
    expect(clampUserProgressMessage("  hello  ")).toBe("hello");
    expect(clampUserProgressMessage("   ")).toBe("");
  });

  it("clamps long progress beats", () => {
    const clamped = clampUserProgressMessage("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 40));
    expect(clamped).toHaveLength(USER_PROGRESS_MESSAGE_MAX_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("isProgressMessageTruncated", () => {
  it("is false for text that fits", () => {
    expect(isProgressMessageTruncated("short update")).toBe(false);
    expect(isProgressMessageTruncated("x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH))).toBe(false);
  });

  it("is true for text that would be cut off by clampUserProgressMessage", () => {
    const long = "x".repeat(USER_PROGRESS_MESSAGE_MAX_LENGTH + 1);
    expect(isProgressMessageTruncated(long)).toBe(true);
    expect(clampUserProgressMessage(long).endsWith("…")).toBe(true);
  });
});

describe("mid-turn progress budget", () => {
  it("opens at 60 seconds and permits at most three messages", () => {
    const startedAt = Date.parse("2026-11-08T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt });
    try {
      vi.setSystemTime(startedAt + 59_999);
      expect(midTurnProgressBudgetAllows(0, Date.now() - startedAt)).toBe(false);

      vi.setSystemTime(startedAt + 60_000);
      expect(midTurnProgressBudgetAllows(0, Date.now() - startedAt)).toBe(true);
      expect(midTurnProgressBudgetAllows(2, Date.now() - startedAt)).toBe(true);
      expect(midTurnProgressBudgetAllows(3, Date.now() - startedAt)).toBe(false);
      expect(midTurnProgressBudgetUsed(2)).toBe(false);
      expect(midTurnProgressBudgetUsed(3)).toBe(true);
      expect(midTurnProgressBudgetUsed(4)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("narrationStatusLine", () => {
  it("collapses whitespace and keeps the ellipsis inside the 60-character cap", () => {
    expect(narrationStatusLine("  Checking\nthe   totals.  ")).toBe("Checking the totals.");
    expect(narrationStatusLine("   ")).toBe("");
    const boundary = "x".repeat(60);
    expect(narrationStatusLine(boundary)).toBe(boundary);
    expect(narrationStatusLine(`${boundary}x`)).toBe(`${"x".repeat(59)}…`);
    expect(narrationStatusLine(`${"x".repeat(58)}😀x`)).toBe(`${"x".repeat(58)}…`);
  });
});

describe("midTaskMessagePrompt", () => {
  it("preserves source labels and suggests a brief answer only when the tool is offered", () => {
    const text = "From the user: Is it done?";
    const prefix = `A message arrived while you were working:\n\n${text}\n\n`;
    expect(midTaskMessagePrompt(text)).toBe(`${prefix}Take it into account and continue the task.`);
    expect(midTaskMessagePrompt(text, true)).toBe(
      `${prefix}If it asks something or changes the plan, answer briefly with message_user, then continue the task.`,
    );
  });
});

describe("extractNarrationText", () => {
  it("pulls text blocks and current text while keeping tool activity", () => {
    const { text, remaining } = extractNarrationText(
      [
        { kind: "text", text: "Checking calendars. " },
        { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
        { kind: "text", text: "Found three options." },
      ],
      " Still looking.",
    );
    expect(text).toBe("Checking calendars. Found three options. Still looking.");
    expect(remaining).toEqual([{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }]);
  });
});

describe("finalBlocksAfterMidTurnProgress", () => {
  it("drops a hollow final message that is only hidden tool activity", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
    expect(finalBlocksAfterMidTurnProgress([steps], true)).toEqual([]);
    expect(finalBlocksAfterMidTurnProgress([steps], false)).toEqual([steps]);
  });

  it("keeps a final answer alongside tool activity", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "text", text: "You are free Tuesday afternoon." },
    ];
    expect(finalBlocksAfterMidTurnProgress(blocks, true)).toEqual(blocks);
    expect(isToolActivityBlock(blocks[0]!)).toBe(true);
  });
});

describe("botMessageOutcomeFromMidTurn", () => {
  it("prefers the final reply as a result", () => {
    expect(botMessageOutcomeFromMidTurn("All set.", ["Checking calendars…"])).toEqual({
      text: "All set.",
      intent: "result",
    });
  });

  it("returns mid-turn progress as status when there is no final reply", () => {
    expect(
      botMessageOutcomeFromMidTurn("", ["Checking calendars…", "Found three free slots."]),
    ).toEqual({
      text: "Checking calendars…\n\nFound three free slots.",
      intent: "status",
    });
  });

  it("returns null when nothing was posted", () => {
    expect(botMessageOutcomeFromMidTurn("  ", [])).toBeNull();
  });
});

describe("userProgressClientNonce", () => {
  it("tags mid-turn progress messages for reconciler detection", () => {
    const nonce = userProgressClientNonce("run-1", 0);
    expect(nonce.startsWith("user-progress:run-1:0:")).toBe(true);
    expect(isUserProgressClientNonce(nonce)).toBe(true);
    expect(userProgressClientNonce("run-1", 0)).not.toBe(nonce);
    expect(isUserProgressClientNonce(null)).toBe(false);
    expect(isUserProgressClientNonce("other")).toBe(false);
  });
});
