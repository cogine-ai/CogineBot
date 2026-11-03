import type { Api, Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { effectivePiOutputTokens } from "./pi-output-budget.js";

it.each([
  "anthropic-messages",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
] as const)("leaves %s output semantics to its SDK adapter", (api) => {
  const model = {
    api,
    provider: "fixture",
    id: "fixture",
    name: "fixture",
    baseUrl: "https://models.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  } satisfies Model<Api>;
  expect(effectivePiOutputTokens(model, { messages: [] }, 1024)).toBeUndefined();
  expect(model.maxTokens).toBe(1024);
});
