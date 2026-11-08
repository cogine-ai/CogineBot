import { expect, it } from "vitest";
import { reportedContextWindow } from "./reported-context-window.js";

const vllm = "400: This model's maximum context length is 2048 tokens. You requested 19563.";

it.each([
  ["llama.cpp", '400: {"type":"exceed_context_size_error","n_prompt_tokens":19563,"n_ctx":2048}'],
  ["vLLM", vllm],
  ["vLLM uppercase", vllm.toUpperCase()],
  ["SGLang", "400: Input (19563 tokens) exceeds the model's context length (2048 tokens)."],
  [
    "LiteLLM",
    "400: Requested token count exceeds the model's maximum context length of 2048 tokens.",
  ],
  ["compatible proxy", "400: Input length (19563) exceeds model's maximum context length (2048)."],
  ["LM Studio", "400: Model is loaded with context length of only 2048 tokens."],
])("shrinks the connection window from a %s overflow", (_server, response) => {
  expect(reportedContextWindow("openai-compatible", response, 262_144)).toBe(1740);
});

it("reads only bounded errors", () => {
  const response = vllm.padEnd(16_384);
  expect(reportedContextWindow("openai-compatible", response, 262_144)).toBe(1740);
  expect(reportedContextWindow("openai-compatible", `${response} `, 262_144)).toBeUndefined();
});

it.each([
  undefined,
  "400: Request exceeds the available context size.",
  '400: {"type":"exceed_context_size_error","n_ctx":0}',
  "400: This model's maximum context length is 1 tokens.",
  "400: This model's maximum context length is 9007199254740992 tokens.",
])("ignores a missing or unusable window (%s)", (response) => {
  expect(reportedContextWindow("openai-compatible", response, 262_144)).toBeUndefined();
});

it("does not change other providers or an equal, narrower or invalid window", () => {
  expect(reportedContextWindow("openrouter", vllm, 262_144)).toBeUndefined();
  for (const window of [1740, 1024, Number.POSITIVE_INFINITY, 2048.5]) {
    expect(reportedContextWindow("openai-compatible", vllm, window)).toBeUndefined();
  }
});
