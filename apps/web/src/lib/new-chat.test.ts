import type { Bot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { groupCreationIntent, newChatDraft } from "./new-chat";

describe("first-message group creation", () => {
  it("replays the original intent even when names change after a lost response", () => {
    const draft = newChatDraft();
    draft.botIds = ["a", "b"];
    const bots = [
      { id: "a", name: "Robin" },
      { id: "b", name: "Alex" },
    ] as Bot[];
    const initial = groupCreationIntent(draft, bots);
    bots[0]!.name = "Renamed";
    expect(groupCreationIntent(draft, bots)).toBe(initial);
    expect(initial).toEqual({ name: "Robin, Alex", botIds: ["a", "b"], clientNonce: draft.id });
    expect(newChatDraft().id).not.toBe(draft.id);
  });

  it("bounds a default name without losing member identity or order", () => {
    const draft = newChatDraft();
    draft.botIds = ["b", "a"];
    const intent = groupCreationIntent(draft, [
      { id: "a", name: "A".repeat(80) },
      { id: "b", name: "B".repeat(80) },
    ] as Bot[]);
    expect(intent.name).toHaveLength(80);
    expect(intent.botIds).toEqual(["b", "a"]);
    expect(intent.botIds).not.toBe(draft.botIds);
  });

  it("never truncates half of an emoji in a default group name", () => {
    const draft = newChatDraft();
    draft.botIds = ["a", "b"];
    const intent = groupCreationIntent(draft, [
      { id: "a", name: `${"A".repeat(79)}😀` },
      { id: "b", name: "B" },
    ] as Bot[]);
    expect(intent.name).toBe("A".repeat(79));
  });
});
