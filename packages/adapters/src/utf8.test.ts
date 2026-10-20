import { describe, expect, it } from "vitest";
import { byteLength, truncateUtf8 } from "./utf8.js";

describe("UTF-8 byte length", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["aé中🙂", 10],
    ["\ud800", 3],
    ["\udc00", 3],
  ])("counts the encoded bytes of %j", (value, expected) => {
    expect(byteLength(value)).toBe(expected);
  });
});

describe("UTF-8 truncation", () => {
  it.each([
    [0, ""],
    [1, "a"],
    [2, "a"],
    [3, "aé"],
    [4, "aé"],
    [5, "aé"],
    [6, "aé中"],
    [7, "aé中"],
    [8, "aé中"],
    [9, "aé中"],
    [10, "aé中🙂"],
    [11, "aé中🙂"],
  ])("keeps a whole-code-point head within %i bytes", (maxBytes, expected) => {
    expect(truncateUtf8("aé中🙂", maxBytes)).toBe(expected);
    expect(truncateUtf8("aé中🙂", maxBytes, "start")).toBe(expected);
    expect(byteLength(expected)).toBeLessThanOrEqual(maxBytes);
  });

  it.each([
    [0, ""],
    [1, ""],
    [2, ""],
    [3, ""],
    [4, "🙂"],
    [5, "🙂"],
    [6, "🙂"],
    [7, "中🙂"],
    [8, "中🙂"],
    [9, "é中🙂"],
    [10, "aé中🙂"],
    [11, "aé中🙂"],
  ])("keeps a whole-code-point tail within %i bytes", (maxBytes, expected) => {
    expect(truncateUtf8("aé中🙂", maxBytes, "end")).toBe(expected);
    expect(byteLength(expected)).toBeLessThanOrEqual(maxBytes);
  });

  it.each(["start", "end"] as const)("handles empty and nonpositive %s budgets", (keep) => {
    expect(truncateUtf8("", 10, keep)).toBe("");
    expect(truncateUtf8("text", 0, keep)).toBe("");
    expect(truncateUtf8("text", -1, keep)).toBe("");
  });

  it.each(["\ud800", "\udc00"])(
    "preserves lone surrogate %j with its existing replacement-byte accounting",
    (surrogate) => {
      expect(truncateUtf8(surrogate, 2)).toBe("");
      expect(truncateUtf8(surrogate, 3)).toBe(surrogate);
      expect(truncateUtf8(`${surrogate}a`, 3)).toBe(surrogate);
      expect(truncateUtf8(`a${surrogate}`, 3, "end")).toBe(surrogate);
      expect(truncateUtf8(`a${surrogate}`, 2, "end")).toBe("");
    },
  );

  it("keeps paired surrogates whole next to lone surrogates", () => {
    expect(truncateUtf8("🙂", 3)).toBe("");
    expect(truncateUtf8("🙂", 3, "end")).toBe("");
    expect(truncateUtf8("\ud800🙂\udc00", 6)).toBe("\ud800");
    expect(truncateUtf8("\ud800🙂\udc00", 6, "end")).toBe("\udc00");
    expect(truncateUtf8("\ud800🙂\udc00", 7)).toBe("\ud800🙂");
    expect(truncateUtf8("\ud800🙂\udc00", 7, "end")).toBe("🙂\udc00");
  });

  it("bounds code points rather than grapheme clusters", () => {
    expect(truncateUtf8("e\u0301", 1)).toBe("e");
    expect(truncateUtf8("e\u0301", 2, "end")).toBe("\u0301");
  });
});
