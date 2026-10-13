import type { ComposerMention } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { currentMentionAppearance, splitSentMentionText } from "./mention-display";

const bot = (id: string, name: string): ComposerMention => ({ kind: "bot", id, name });
const ada = bot("ada", "Ada");
const mei = bot("mei", "小梅");

function decorated(text: string, targets: readonly ComposerMention[]) {
  const parts = splitSentMentionText(text, targets);
  expect(parts.map((part) => part.text).join("")).toBe(text);
  return parts.flatMap((part) => (part.kind === "mention" ? part.mention.id : []));
}

describe("sent mention visual identities", () => {
  it("keeps literal @ names and all whitespace while recognizing a unique contiguous prefix", () => {
    const text = "@Ada \t@小梅  hello\nsecond line @Ada";
    const parts = splitSentMentionText(text, [ada, mei]);
    expect(decorated(text, [ada, mei])).toEqual(["ada", "mei"]);
    expect(parts.map((part) => part.text)).toEqual([
      "@Ada",
      " \t",
      "@小梅",
      "  hello\nsecond line @Ada",
    ]);
  });

  it("matches complete names containing spaces, Chinese, punctuation and emoji exactly", () => {
    const targets = [
      bot("chief", "Chief of Staff"),
      bot("cn", "小 梅"),
      bot("punctuation", "A.+ (review)"),
      bot("emoji", "旅行 🐈"),
    ];
    expect(decorated("@Chief of Staff @小 梅 @A.+ (review) @旅行 🐈 hello", targets)).toEqual([
      "chief",
      "cn",
      "punctuation",
      "emoji",
    ]);
  });

  it.each(["@Ada", "@Ada ", "@Ada\nhello"])(
    "recognizes an exact end or whitespace boundary: %s",
    (text) => {
      expect(decorated(text, [ada])).toEqual(["ada"]);
    },
  );

  it.each([
    "@Adaline hello",
    "@Ada@example.com hello",
    "@Ada.example.com hello",
    "@Ada/path hello",
    "@Ada: hello",
    "@ada hello",
    " @Ada hello",
    "hello @Ada",
    "email Ada@example.com",
    "https://example.com/@Ada",
    "/Skill\n@Ada hello",
  ])("leaves ordinary text, partial names, emails and urls literal: %s", (text) => {
    expect(decorated(text, [ada])).toEqual([]);
    expect(splitSentMentionText(text, [ada])).toEqual([{ kind: "text", text }]);
  });

  it("stops at an unknown prefix instead of decorating a later known name", () => {
    expect(decorated("@Unknown @Ada hello", [ada])).toEqual([]);
    const text = "@Ada @Unknown @小梅 hello";
    expect(decorated(text, [ada, mei])).toEqual(["ada"]);
    expect(splitSentMentionText(text, [ada, mei]).at(-1)).toEqual({
      kind: "text",
      text: " @Unknown @小梅 hello",
    });
  });

  it("never treats a new line's ordinary @ as another selected prefix", () => {
    expect(decorated("@Ada \n@小梅 hello", [ada, mei])).toEqual(["ada"]);
    expect(decorated("@Ada\r\n@小梅 hello", [ada, mei])).toEqual(["ada"]);
  });

  it("leaves duplicate names literal, including collisions with other target kinds", () => {
    expect(decorated("@Ada hello", [ada, bot("other", "Ada")])).toEqual([]);
    for (const kind of ["group", "routine", "connector", "everyone"] as const) {
      const collision: ComposerMention = { kind, id: "other", name: "Ada" };
      expect(decorated("@Ada hello", [ada, collision])).toEqual([]);
    }
  });

  it("does not guess between different length names that both match the complete prefix", () => {
    const ana = bot("ana", "Ana");
    const anaReed = bot("ana-reed", "Ana Reed");
    expect(decorated("@Ana Reed hello", [ana, anaReed])).toEqual([]);
    expect(decorated("@Ana Reed hello", [anaReed, ana])).toEqual([]);
    expect(decorated("@Ana hello", [ana, anaReed])).toEqual(["ana"]);
    expect(decorated("@Ana Reed hello", [anaReed])).toEqual(["ana-reed"]);
    expect(decorated("@Ana Reed hello", [ana, anaReed, bot("other", "Ana Reed")])).toEqual([]);
  });

  it("retains an earlier confirmed identity when the next prefix becomes ambiguous", () => {
    const targets = [ada, bot("ana", "Ana"), bot("ana-reed", "Ana Reed"), mei];
    const text = "@Ada @Ana Reed @小梅 hello";
    expect(decorated(text, targets)).toEqual(["ada"]);
    expect(splitSentMentionText(text, targets).at(-1)).toEqual({
      kind: "text",
      text: " @Ana Reed @小梅 hello",
    });
  });

  it("leaves non-Bot targets, missing former names and empty rosters literal", () => {
    const everyone: ComposerMention = { kind: "everyone", id: "everyone", name: "everyone" };
    expect(decorated("@everyone @Ada hello", [everyone, ada])).toEqual([]);
    expect(decorated("@Former Ada hello", [ada])).toEqual([]);
    expect(decorated("@Ada hello", [])).toEqual([]);
    expect(decorated("@ \n hello", [bot("empty", " "), bot("newline", "\n")])).toEqual([]);
    expect(splitSentMentionText("", [ada])).toEqual([]);
  });
});

describe("draft mention appearance", () => {
  it("uses a current Bot avatar without changing stored identity, name or other send metadata", () => {
    const saved: ComposerMention = Object.freeze({
      kind: "bot",
      id: "ada",
      name: "Former Ada",
      subtitle: "Saved context",
      color: "#F5A15D::shape_0",
    });
    const current: ComposerMention = {
      kind: "bot",
      id: "ada",
      name: "Current Ada",
      color: "#62A8EC::shape_10",
    };
    expect(currentMentionAppearance(saved, [current])).toEqual({
      ...saved,
      color: current.color,
    });
    expect(saved.color).toBe("#F5A15D::shape_0");
    expect(saved.name).toBe("Former Ada");
  });

  it("matches by Bot kind and identity, preserving missing targets and unrelated mentions", () => {
    const saved: ComposerMention = { ...ada, color: "#F5A15D::shape_0" };
    expect(
      currentMentionAppearance(saved, [
        { ...saved, id: "another", color: "#62A8EC::shape_10" },
        { ...saved, kind: "group", color: "#62A8EC::shape_10" },
      ]),
    ).toBe(saved);
    expect(currentMentionAppearance(saved, [ada])).toBe(saved);
    expect(currentMentionAppearance(saved, undefined)).toBe(saved);
    const group: ComposerMention = { ...saved, kind: "group" };
    expect(currentMentionAppearance(group, [{ ...saved, color: "#62A8EC" }])).toBe(group);
  });

  it("reflects an uploaded avatar and retains unchanged appearance references", () => {
    const saved: ComposerMention = { ...ada, color: "#F5A15D::shape_0" };
    const uploaded = { ...ada, color: "data:image/webp;base64,Zml4dHVyZQ==" };
    expect(currentMentionAppearance(saved, [uploaded]).color).toBe(uploaded.color);
    expect(currentMentionAppearance(saved, [saved])).toBe(saved);
  });
});
