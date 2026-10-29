import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  attachmentLabels,
  messageAttachmentLabels,
  messageBlocksForQuestionCards,
} from "./message-presentation.js";

const choice: MessageBlock = {
  kind: "choice",
  question: "Pick one.",
  options: [{ id: "a", label: "A", letter: "A" }],
};

describe("visible choice question projection", () => {
  it("removes just the duplicate standalone question without changing saved blocks", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Before." },
      { kind: "text", text: "Pick one." },
      choice,
      { kind: "text", text: "Pick one. Then explain why." },
    ];
    expect(messageBlocksForQuestionCards(blocks, true)).toEqual([blocks[0], choice, blocks[3]]);
    expect(blocks).toHaveLength(4);
  });
  it("keeps text fallback when a card cannot render or has been dismissed", () => {
    const blocks: MessageBlock[] = [{ kind: "text", text: "Pick one." }, choice];
    expect(messageBlocksForQuestionCards(blocks, false)).toBe(blocks);
    expect(
      messageBlocksForQuestionCards([blocks[0]!, { ...choice, answerId: "_dismissed" }], true),
    ).toEqual([blocks[0], { ...choice, answerId: "_dismissed" }]);
  });
  it("preserves an approval card and removes only its duplicate narration", () => {
    const approval: MessageBlock = {
      kind: "ask",
      text: "Approve?",
      actions: [{ id: "yes", label: "Yes" }],
    };
    const text: MessageBlock = { kind: "text", text: "Approve?" };
    expect(messageBlocksForQuestionCards([text, approval], false)).toEqual([approval]);
    expect(
      messageBlocksForQuestionCards([approval, { ...choice, question: "Approve?" }], true),
    ).toEqual([approval, { ...choice, question: "Approve?" }]);
  });
  it("does not strip user prose that merely mentions an option or a similar question", () => {
    const text: MessageBlock = { kind: "text", text: "Please pick one." };
    expect(messageBlocksForQuestionCards([text, choice], true)).toEqual([text, choice]);
  });
});

describe("duplicate attachment display", () => {
  it("distinguishes equal-name/equal-size files using original immutable IDs", () => {
    const files = [
      { id: "a", name: "报告.txt", size: 12 },
      { id: "b", name: "报告.txt", size: 12 },
      { id: "c", name: "other.txt", size: 12 },
    ];
    expect([...attachmentLabels(files)]).toEqual([
      ["a", "1 · 12 B"],
      ["b", "2 · 12 B"],
    ]);
    expect(files[0]!.name).toBe("报告.txt");
    expect(attachmentLabels([files[1]!, files[2]!]).size).toBe(0);
  });
});

it("distinguishes duplicate-name versions across loaded messages without counting the same artifact twice", () => {
  const file = (artifactId: string): MessageBlock => ({
    kind: "file",
    artifactId,
    name: "report.txt",
    mimeType: "text/plain",
    size: 7,
  });
  const labels = messageAttachmentLabels([
    { blocks: [file("a")] },
    { blocks: [file("b"), file("a")] },
  ]);
  expect([...labels]).toEqual([
    ["a", "1 · 7 B"],
    ["b", "2 · 7 B"],
  ]);
});
