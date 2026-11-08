import { expect, it } from "vitest";
import { affordableOpenRouterOutput } from "./openrouter-output-budget.js";

function rejection(affordable = 1024) {
  return {
    message: `This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford ${affordable}.`,
    metadata: { limit_source: "openrouter_credits" },
  };
}

it.each(["flat", "nested", "split metadata"] as const)(
  "accepts a lower OpenRouter reservation from a %s 402",
  (shape) => {
    const { message, metadata } = rejection();
    const body =
      shape === "flat"
        ? { message, metadata }
        : shape === "nested"
          ? { error: { message, metadata } }
          : { error: { message }, metadata };
    expect(affordableOpenRouterOutput("openrouter", `402 ${JSON.stringify(body)}`, 4096)).toBe(
      1024,
    );
  },
);

it("reads only bounded credit errors", () => {
  const response = `402: ${JSON.stringify(rejection())}`.padEnd(16_384);
  expect(affordableOpenRouterOutput("openrouter", response, 4096)).toBe(1024);
  expect(affordableOpenRouterOutput("openrouter", `${response} `, 4096)).toBeUndefined();
});

it.each([
  undefined,
  "402: invalid JSON",
  "402: Insufficient credits.",
  `401: ${JSON.stringify(rejection())}`,
  `402: ${JSON.stringify({ message: rejection().message })}`,
  `402: ${JSON.stringify({ ...rejection(), metadata: { limit_source: "openrouter_key_limit" } })}`,
  `402: ${JSON.stringify({ ...rejection(), metadata: { limit_source: "openrouter_in_flight_budget" } })}`,
  `402: ${JSON.stringify(rejection(0))}`,
  `402: ${JSON.stringify(rejection(4096))}`,
  `402: ${JSON.stringify(rejection(8192))}`,
  `402: ${JSON.stringify(rejection(Number.MAX_SAFE_INTEGER + 1))}`,
])("ignores an unrelated or unusable credit error (%s)", (response) => {
  expect(affordableOpenRouterOutput("openrouter", response, 4096)).toBeUndefined();
});

it("never raises a current output limit", () => {
  const response = `402: ${JSON.stringify(rejection())}`;
  expect(affordableOpenRouterOutput("openai-compatible", response, 4096)).toBeUndefined();
  for (const cap of [1024, 512, 0, Number.NaN, Number.POSITIVE_INFINITY, 4096.5]) {
    expect(affordableOpenRouterOutput("openrouter", response, cap)).toBeUndefined();
  }
});
