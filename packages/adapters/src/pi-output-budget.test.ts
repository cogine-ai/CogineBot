import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { effectivePiOutputTokens } from "./pi-output-budget.js";

it.each([
  ["openai-completions", 1024],
  ["anthropic-messages", 1024],
  ["openai-responses", 1024],
  ["openai-codex-responses", undefined],
  ["google-generative-ai", undefined],
] as const)("shares the audited output budget only for %s", (api, expected) => {
  const model = {
    api,
    provider: "fixture",
    id: "fixture",
    name: "fixture",
    baseUrl: "https://models.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  } satisfies Model<Api>;
  expect(effectivePiOutputTokens(model, { messages: [] }, 1024)).toBe(expected);
  expect(model.maxTokens).toBe(1024);
});

it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
  "retains the SDK4096 safety allowance for %s",
  (api) => {
    const model = {
      api,
      provider: "fixture",
      id: "fixture",
      name: "fixture",
      baseUrl: "https://models.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    } satisfies Model<Api>;
    expect(effectivePiOutputTokens(model, { messages: [] }, 1024)).toBe(1);
    expect(model.maxTokens).toBe(1024);
  },
);
