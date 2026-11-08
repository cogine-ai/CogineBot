import { expect, it } from "vitest";
import { groqRequestContextWindow } from "./groq-request-budget.js";

function rejection(limit = 6000, requested = 7000) {
  return {
    code: "rate_limit_exceeded",
    type: "tokens",
    message: `Request too large on tokens per minute (TPM): Limit ${limit}, Requested ${requested}, reduce your message size.`,
  };
}

it.each(["flat", "nested"] as const)(
  "shrinks the window for a %s Groq 413 token limit",
  (shape) => {
    const error = rejection();
    const response =
      shape === "flat" ? `413: ${JSON.stringify(error)}` : `413 ${JSON.stringify({ error })}`;
    expect(groqRequestContextWindow("groq", response, 32_000)).toBe(5100);
  },
);

it("reads a complete bounded error body", () => {
  const response = `413: ${JSON.stringify(rejection())}`.padEnd(16_384);
  expect(groqRequestContextWindow("groq", response, 32_000)).toBe(5100);
  expect(groqRequestContextWindow("groq", `${response} `, 32_000)).toBeUndefined();
});

it.each([
  undefined,
  "413: invalid JSON",
  "413: Request Entity Too Large",
  `429: ${JSON.stringify(rejection())}`,
  `413: ${JSON.stringify({ ...rejection(), type: "requests" })}`,
  `413: ${JSON.stringify({ ...rejection(), code: "other" })}`,
  `413: ${JSON.stringify(rejection(6000, 6000))}`,
  `413: ${JSON.stringify(rejection(0))}`,
  `413: ${JSON.stringify(rejection(1))}`,
  `413: ${JSON.stringify(rejection(6000, Number.MAX_SAFE_INTEGER + 1))}`,
])("ignores an unrelated or unusable rejection (%s)", (response) => {
  expect(groqRequestContextWindow("groq", response, 32_000)).toBeUndefined();
});

it("does not change an equal, narrower or invalid current window", () => {
  const response = `413: ${JSON.stringify(rejection())}`;
  expect(groqRequestContextWindow("openai-compatible", response, 32_000)).toBeUndefined();
  for (const window of [5100, 4000, 0, Number.NaN, Number.POSITIVE_INFINITY, 32_000.5]) {
    expect(groqRequestContextWindow("groq", response, window)).toBeUndefined();
  }
});
