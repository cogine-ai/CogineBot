import { describe, expect, it } from "vitest";
import { readPluginCleanupRefs } from "./plugin-installs.js";

describe("bounded credential cleanup recovery state", () => {
  it("preserves old pending entries and opaque prepared recovery provenance", () => {
    expect(
      readPluginCleanupRefs([
        { id: "old", pending: true },
        { id: "new", pending: true, recoveryRef: "opaque-provider-reference" },
        { id: "resolved", ref: "opaque-ref" },
      ]),
    ).toEqual([
      { id: "old", pending: true },
      { id: "new", pending: true, recoveryRef: "opaque-provider-reference" },
      { id: "resolved", ref: "opaque-ref" },
    ]);
  });

  const invalid = [
    [{ id: "row", pending: true, recoveryRef: "" }],
    [{ id: "row", pending: true, recoveryRef: "x".repeat(8193) }],
    [{ id: "row", pending: true, ref: "invented", recoveryRef: "opaque" }],
    [{ id: "row", pending: true, recoveryRef: { provider: "invented" } }],
    [{ id: "row", pending: true, recoveryRef: "opaque", plaintext: "private" }],
    [
      { id: "row", pending: true },
      { id: "row", pending: true, recoveryRef: "opaque" },
    ],
  ];
  it.each(invalid.map((value) => ({ value })))(
    "rejects invalid or ambiguous reservations %#",
    ({ value }) => {
      expect(() => readPluginCleanupRefs(value)).toThrow("Invalid plugin cleanup state");
    },
  );
});
