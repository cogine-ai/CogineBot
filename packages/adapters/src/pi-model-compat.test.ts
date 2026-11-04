import type { Api, Model } from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { acceptedReasoningEfforts, applyPiModelCompatibility } from "./pi-model-compat.js";

// Observed: 400 "minijinja: rendering failed: raise_exception: Unexpected message role."
// Qwen-style chat templates only render system, user, assistant and tool.
it.each([
  ["groq", "openai/gpt-oss-20b"],
  ["groq", "openai/gpt-oss-120b"],
  ["groq", "qwen/qwen3.6-27b"],
  ["xiaomi", "mimo-v2.5"],
])("sends system instructions to the %s %s chat template", async (provider, id) => {
  const models = applyPiModelCompatibility(builtinModels());
  const model = models.getModel(provider, id);
  expect(model).toBeDefined();
  if (!model) return;
  let roles: string[] = [];
  const result = await models
    .streamSimple(
      model,
      {
        systemPrompt: "Fixture instructions.",
        messages: [{ role: "user", content: "Fixture request.", timestamp: 1 }],
      },
      {
        apiKey: "fixture-key",
        reasoning: "low",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
          roles = body.messages.map((message) => message.role);
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    )
    .result();
  expect(result.stopReason).toBe("stop");
  expect(roles).toEqual(["system", "user"]);
});

describe("provider compatibility boundaries", () => {
  it("keeps other providers unchanged", () => {
    const original = builtinModels();
    const openai = original.getProvider("openai");
    expect(openai).toBeDefined();
    expect(applyPiModelCompatibility(original).getProvider("openai")).toBe(openai);
  });
});

describe("reasoning efforts an endpoint refuses", () => {
  const model = (thinkingLevelMap: Model<Api>["thinkingLevelMap"]) =>
    ({ id: "example", reasoning: true, thinkingLevelMap }) as Model<Api>;

  it("keeps only the levels a generic endpoint lists and sends no effort for off", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none", xhigh: "xhigh", max: "max" }),
      '400: {"message":"reasoning_effort must be one of: low, medium, high, max","type":"invalid_request_error","param":"","code":null}',
    );
    const narrowed = model(levels);
    expect(getSupportedThinkingLevels(narrowed)).toEqual(["off", "low", "medium", "high", "max"]);
    expect(levels?.off).toBeUndefined();
    expect(clampThinkingLevel(narrowed, "minimal")).toBe("low");
    expect(clampThinkingLevel(narrowed, "xhigh")).toBe("max");
  });

  it("reads OpenAI's wording and keeps an accepted off value", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none" }),
      "400 Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', and 'high'.",
    );
    expect(levels).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it.each([
    '400: {"message":"Unexpected message role.","type":"invalid_request_error"}',
    '400: {"message":"reasoning_effort must be one of: turbo","type":"invalid_request_error"}',
  ])("ignores a rejection that names no usable effort: %s", (error) => {
    expect(acceptedReasoningEfforts(model({ off: "none" }), error)).toBeUndefined();
  });
});

it("patches only the exact regional Bedrock Haiku model without mutating sibling/provider declarations", () => {
  const exact = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
  const model = (provider: string, id: string): Model<Api> => ({
    provider,
    id,
    name: id,
    api: "bedrock-converse-stream",
    baseUrl: "https://models.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
    compat: { supportsStrictMode: true },
  });
  const target = model("amazon-bedrock", exact);
  const sibling = model("amazon-bedrock", "eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  const other = model("another-bedrock", exact);
  const models = createModels();
  models.setProvider(fixtureProvider("amazon-bedrock", [target, sibling]));
  models.setProvider(fixtureProvider("another-bedrock", [other]));
  applyPiModelCompatibility(models);
  expect(models.getModel("amazon-bedrock", exact)?.compat).toMatchObject({
    supportsStrictMode: false,
  });
  expect(models.getModel("amazon-bedrock", sibling.id)).toBe(sibling);
  expect(models.getModel("another-bedrock", exact)).toBe(other);
  expect(target.compat).toMatchObject({ supportsStrictMode: true });
});

it("keeps explicit developer declarations and native OpenAI/Azure/OpenRouter defaults", () => {
  const model = (provider: string, id: string, supportsDeveloperRole?: boolean): Model<Api> => ({
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
    ...(supportsDeveloperRole === undefined ? {} : { compat: { supportsDeveloperRole } }),
  });
  const models = createModels();
  const native = ["openai", "azure", "openrouter"].map((provider) => model(provider, "fixture"));
  for (const item of native) models.setProvider(fixtureProvider(item.provider, [item]));
  const explicitTrue = model("third-party", "explicit-true", true);
  const explicitFalse = model("third-party", "explicit-false", false);
  const unspecified = model("third-party", "unspecified");
  models.setProvider(fixtureProvider("third-party", [explicitTrue, explicitFalse, unspecified]));
  applyPiModelCompatibility(models);
  for (const item of [...native, explicitTrue, explicitFalse])
    expect(models.getModel(item.provider, item.id)).toBe(item);
  expect(models.getModel("third-party", "unspecified")?.compat).toMatchObject({
    supportsDeveloperRole: false,
  });
});

it("resolves the legacy Azure alias through the sole shared canonical provider identity", () => {
  const models = applyPiModelCompatibility(builtinModels());
  expect(models.getProvider("azure-openai-responses")).toBe(models.getProvider("azure"));
  const model = models.getProvider("azure")?.getModels()[0];
  expect(model).toBeDefined();
  if (!model) throw new Error("Expected built-in Azure catalog");
  expect(models.getModel("azure-openai-responses", model.id)).toBe(
    models.getModel("azure", model.id),
  );
});

function fixtureProvider(id: string, models: Model<Api>[]) {
  const catalog = builtinModels();
  const api = catalog.getProvider(
    models[0]?.api === "bedrock-converse-stream" ? "amazon-bedrock" : "openai",
  );
  if (!api) throw new Error("Missing fixture API");
  return createProvider({
    id,
    models,
    api,
    auth: {
      apiKey: {
        name: "Synthetic",
        resolve: async () => ({ auth: { apiKey: "synthetic-key" }, source: "fixture" }),
      },
    },
  });
}
