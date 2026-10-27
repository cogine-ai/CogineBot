import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  CHATGPT_PLAN_CATALOG_MODEL_ID,
  CHATGPT_PLAN_PROVIDER_ID,
} from "./chatgpt-plan-provider.js";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { listPiCatalog } from "./pi-models.js";
import { resolveModelAuth } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { modelsForRequest, resolveRuntimeModel } from "./pi-runtime.js";

function requestModel(id: string, baseUrl: string): Pick<AgentRunRequest, "model"> {
  return { model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id, baseUrl } };
}

describe("request model catalogs", () => {
  function chatGPTRequest(
    id: string,
    access: string,
    modelIds: string[],
  ): Pick<AgentRunRequest, "model"> {
    const credential = {
      type: "oauth" as const,
      access,
      refresh: "fake-refresh-token",
      expires: Date.now() + 60 * 60_000,
      clientId: `oaiapp_${access}`,
      issuer: "https://auth.openai.com",
      subject: "fixture-subject",
      hostId: "urn:uuid:8d497bea-75d5-4b56-9bed-401ec51007a3",
      idToken: "fake-id-token",
      scopes: ["chatgpt.tokens.use.direct"],
      chatgptPlanModels: modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        contextWindow: 64000,
      })),
    };
    return { model: { provider: CHATGPT_PLAN_PROVIDER_ID, id, oauth: { credential } } };
  }

  it("isolates each ChatGPT registration's discovered catalog and never uses a static fallback", () => {
    const first = modelsForRequest(
      chatGPTRequest("account-a-model", "fake-a", ["account-a-model"]),
      CHATGPT_PLAN_PROVIDER_ID,
    );
    const second = modelsForRequest(
      chatGPTRequest("account-b-model", "fake-b", ["account-b-model"]),
      CHATGPT_PLAN_PROVIDER_ID,
    );
    expect(first).not.toBe(second);
    expect(first.getModels(CHATGPT_PLAN_PROVIDER_ID).map((entry) => entry.id)).toEqual([
      "account-a-model",
    ]);
    expect(second.getModel(CHATGPT_PLAN_PROVIDER_ID, "account-a-model")).toBeUndefined();
    expect(first.getModel(CHATGPT_PLAN_PROVIDER_ID, "account-b-model")).toBeUndefined();
    expect(first.getModel(CHATGPT_PLAN_PROVIDER_ID, CHATGPT_PLAN_CATALOG_MODEL_ID)).toBeUndefined();
    expect(
      resolveRuntimeModel(chatGPTRequest("account-b-model", "fake-a", ["account-a-model"]).model)
        .model,
    ).toBeUndefined();
    expect(
      resolveRuntimeModel({ provider: CHATGPT_PLAN_PROVIDER_ID, id: CHATGPT_PLAN_CATALOG_MODEL_ID })
        .model,
    ).toBeUndefined();
    // This is a real OpenRouter ID: requesting it here still cannot spend that provider's key.
    expect(
      resolveRuntimeModel(
        chatGPTRequest("openai/gpt-5.6-luna", "fake-a", ["account-a-model"]).model,
      ).model,
    ).toBeUndefined();
  });

  it("passes the selected ChatGPT credential through shared model resolution into Pi", async () => {
    const request = chatGPTRequest("account-model", "fake-selected-token", ["account-model"]);
    const selected = resolveRuntimeModel(request.model);
    expect(selected.apiKey).toBeUndefined();
    expect(selected.model?.provider).toBe(CHATGPT_PLAN_PROVIDER_ID);
    const result = await selected.models.complete(
      selected.model!,
      { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
      {
        fetch: async (input, init) => {
          expect(String(input)).toBe("https://api.openai.com/v1/responses");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer fake-selected-token",
          );
          expect(JSON.parse(String(init?.body))).toMatchObject({
            model: "account-model",
            store: false,
            stream: true,
          });
          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    expect(result.stopReason, result.errorMessage).toBe("stop");
  });

  it.each([
    ["openrouter", "openai/gpt-5.6-luna"],
    ["openai-codex", "gpt-6-astra"],
    ["openai-codex", "gpt-6-luna"],
    ["openai-codex", "gpt-6-sol"],
    ["anthropic", "claude-fable-5-1"],
    ["anthropic", "claude-opus-5-5"],
  ])("offers and resolves %s/%s with vision", (provider, id) => {
    const entry = listPiCatalog().find((model) => model.provider === provider && model.id === id);
    expect(entry).toBeDefined();
    const model = modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id);
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(entry?.thinkingLevels).toEqual(getSupportedThinkingLevels(model!));
    if (provider === "openai-codex") {
      expect(entry?.signIn).toBe("device-code");
      expect(entry?.thinkingLevels).toContain("max");
    }
    if (provider === "anthropic") {
      expect(entry?.signIn).toBe("auth-url");
      expect(entry?.thinkingLevels).toContain("max");
    }
  });

  it("isolates concurrent OpenAI-compatible endpoint registrations", () => {
    const first = modelsForRequest(
      requestModel("first-model", "http://127.0.0.1:8001/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const second = modelsForRequest(
      requestModel("second-model", "http://127.0.0.1:8002/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(first).not.toBe(second);
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "first-model")?.baseUrl).toBe(
      "http://127.0.0.1:8001/v1",
    );
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")).toBeUndefined();
    expect(second.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")?.baseUrl).toBe(
      "http://127.0.0.1:8002/v1",
    );
  });

  it("applies a connected model's image capability to the runtime model", () => {
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "vision-model",
          baseUrl: "http://127.0.0.1:8000/v1",
          acceptsImages: true,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "vision-model")?.input).toContain(
      "image",
    );
  });
});

it.each([true, false, undefined])(
  "keeps saved capability %s consistent between metadata and runtime",
  async (reasoning) => {
    const plaintext = buildModelConnectPlaintext({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: "same-model",
      baseUrl: "http://localhost:8000/v1",
      reasoning,
    });
    const auth = await resolveModelAuth(plaintext, OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(auth.secret.kind).toBe("openai_compatible");
    if (auth.secret.kind !== "openai_compatible") throw new Error("Wrong credential type");
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "same-model",
          baseUrl: auth.secret.baseUrl,
          reasoning: auth.secret.reasoning,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
    const credential = modelCredentialDto(
      {
        id: "cred",
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        label: "Server",
        isDefault: true,
        defaultModel: "same-model",
      },
      plaintext,
    );
    expect(model.reasoning).toBe(reasoning ?? false);
    expect(credential.thinkingLevels).toEqual(getSupportedThinkingLevels(model));
  },
);

describe("resolveRuntimeModel", () => {
  it("does not treat a stringified null as a catalog model", () => {
    const resolved = resolveRuntimeModel({ provider: "anthropic", id: "null" });
    expect(resolved.modelId).toBe("");
    expect(resolved.model).toBeUndefined();
    expect(resolved.provider).toBe("anthropic");
  });
});
