import { describe, expect, it } from "vitest";
import { ModelHeadersSchema, modelHeadersInput, parseModelHeaders } from "./model-headers.js";

describe("model header edits", () => {
  it("distinguishes untouched, clear and replacement", () => {
    expect(modelHeadersInput(null)).toBeUndefined();
    expect(modelHeadersInput([])).toEqual({});
    expect(modelHeadersInput([{ name: " x-session ", value: "secret" }])).toEqual({
      "x-session": "secret",
    });
  });
  it("does not collapse duplicate names or echo secrets", () => {
    expect(() =>
      modelHeadersInput([
        { name: "X-A", value: "secret" },
        { name: "x-a", value: "secret" },
      ]),
    ).toThrow(/^Invalid custom headers$/);
    expect(() => modelHeadersInput([{ name: "authorization", value: "secret" }])).toThrow(
      /^Invalid custom headers$/,
    );
  });
});

it("rejects empty header values", () => {
  expect(ModelHeadersSchema.safeParse({ "x-session": "" }).success).toBe(false);
  expect(() => modelHeadersInput([{ name: "x-session", value: "" }])).toThrow(
    /^Invalid custom headers$/,
  );
});

it("rejects exact duplicate rows before constructing a header map", () => {
  expect(() =>
    modelHeadersInput([
      { name: "x-a", value: "one" },
      { name: "x-a", value: "two" },
    ]),
  ).toThrow(/^Invalid custom headers$/);
});

it.each([
  { Authorization: "bad" },
  { Expect: "bad" },
  { "proxy-test": "bad" },
  { "sec-test": "bad" },
  { "bad name": "bad" },
  { "x-test": "bad\r\ninjected" },
  { "x-test": "bad\0value" },
  { "x-test": "x".repeat(1025) },
  { "X-Test": "a", "x-test": "b" },
  { "x-test": "one", " x-test ": "two" },
  { ["x".repeat(257)]: "value" },
  Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-${i}`, "value"])),
])("rejects unsafe header maps", (headers) => {
  expect(ModelHeadersSchema.safeParse(headers).success).toBe(false);
});

it.each(["1", "en", "xy9", " en ", 'quoted"value\\', "x".repeat(1024)])(
  "retains the exact printable header value without exposing it on validation failure",
  (value) => {
    expect(parseModelHeaders({ " X-Session ": value })).toEqual({ "X-Session": value });
    expect(() => parseModelHeaders({ "bad name": value })).toThrow(/^Invalid custom headers$/);
  },
);

it("accepts the header count and name limits without merging distinct names", () => {
  const headers = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x-${i}`, "value"]));
  expect(parseModelHeaders(headers)).toEqual(headers);
  expect(parseModelHeaders({ ["x".repeat(256)]: "value" })).toEqual({
    ["x".repeat(256)]: "value",
  });
});
