import { credentialModelSettings } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { connectionModelSettings, withModelSettings } from "./model-settings.js";
import { keptModelSettings, parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

const LISTED_ONLY = "glm-5.3-flashx";
const KEY = "sk-synthetic-key";
const oauth = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 1 };
describe("stored model settings", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "preserves settings for the model named %s",
    (modelId) => {
      const configured = withModelSettings(
        parseModelSecret(
          JSON.stringify({ kind: "openai_compatible", baseUrl: "http://127.0.0.1:8181/v1" }),
        ),
        modelId,
        { images: true, reasoning: true, maxTokens: 2000 },
      );
      const saved = parseModelSecret(serializeModelSecret(configured));
      expect(Object.hasOwn(saved.models!, modelId)).toBe(true);
      expect(saved.models?.[modelId]).toEqual({
        images: true,
        reasoning: true,
        maxTokens: 2000,
      });
      expect(connectionModelSettings(saved, "openai-compatible", modelId)).toEqual(
        saved.models?.[modelId],
      );
      expect(
        credentialModelSettings(
          { provider: "openai-compatible", modelSettings: saved.models },
          modelId,
        ),
      ).toEqual(saved.models?.[modelId]);
    },
  );

  it.each(["__proto__", "constructor", "toString"])(
    "does not mistake an inherited %s property for saved settings",
    (modelId) => {
      const secret = {
        kind: "api_key" as const,
        key: KEY,
        maxTokens: 1024,
        models: { other: { maxTokens: 2048 } },
      };
      expect(connectionModelSettings(secret, "unknown-provider", modelId)).toEqual({
        maxTokens: 1024,
      });
      expect(
        credentialModelSettings(
          { provider: "unknown-provider", maxTokens: 1024, modelSettings: secret.models },
          modelId,
        ),
      ).toEqual({ maxTokens: 1024 });
    },
  );

  it("keep each model's settings through a round trip, dropping invalid ones", () => {
    const stored = parseModelSecret(
      JSON.stringify({
        kind: "api_key",
        key: KEY,
        models: {
          [LISTED_ONLY]: { images: true, maxTokens: 8_000 },
          broken: { maxTokens: 10, contextWindow: 5 },
          empty: {},
        },
      }),
    );
    expect(stored.models).toEqual({
      [LISTED_ONLY]: { images: true, maxTokens: 8_000 },
      empty: {},
    });
    expect(parseModelSecret(serializeModelSecret(stored))).toEqual(stored);
  });

  it("keep a plain key plain until a model has settings", () => {
    const secret = parseModelSecret(KEY);
    expect(serializeModelSecret(secret)).toBe(KEY);
    const withSettings = withModelSettings(secret, LISTED_ONLY, { images: true });
    expect(JSON.parse(serializeModelSecret(withSettings))).toMatchObject({
      kind: "api_key",
      key: KEY,
      models: { [LISTED_ONLY]: { images: true } },
    });
    expect(serializeModelSecret(withModelSettings(withSettings, LISTED_ONLY, {}))).toBe(KEY);
  });

  it("survive a sign-in refresh or replacement", () => {
    const signedIn = withModelSettings(parseModelSecret(JSON.stringify(oauth)), LISTED_ONLY, {
      reasoning: true,
    });
    const kept = keptModelSettings(signedIn);
    expect(kept).toEqual({ models: { [LISTED_ONLY]: { reasoning: true } } });
    for (const next of [
      { kind: "oauth" as const, credential: { ...oauth, access: "rotated" }, ...kept },
    ])
      expect(parseModelSecret(serializeModelSecret(next)).models).toEqual(kept.models);
  });

  it("keeps selected models' settings across a URL change without forwarding credentials", () => {
    const previous = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8181/old",
      apiKey: "fake-old-api-key",
      headers: { "x-private": "fake-private-value" },
      reasoning: true,
      enabledModelIds: ["kept", "removed"],
      models: {
        kept: { images: true, reasoning: false, contextWindow: 32000, maxTokens: 2000 },
        removed: { images: false },
      },
    });
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8181/new",
          modelId: "kept",
        },
        previous,
      ),
    );
    expect(saved.models).toEqual({
      kept: { images: true, reasoning: false, contextWindow: 32000, maxTokens: 2000 },
    });
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("headers");
    expect(saved).not.toHaveProperty("reasoning");
  });

  it("survive a key replacement and an endpoint save on the same server", () => {
    const keyed = serializeModelSecret(
      withModelSettings(parseModelSecret(KEY), LISTED_ONLY, { images: true }),
    );
    const replaced = buildModelConnectPlaintext(
      { provider: "zai", apiKey: "sk-another-key" },
      keyed,
    );
    expect(parseModelSecret(replaced).models).toEqual({ [LISTED_ONLY]: { images: true } });

    const endpoint = serializeModelSecret(
      withModelSettings(
        parseModelSecret(
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "http://127.0.0.1:8181/v1",
            apiKey: KEY,
            reasoning: true,
          }),
        ),
        "served",
        { images: true },
      ),
    );
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8181/v1",
          modelId: "served",
        },
        endpoint,
      ),
    );
    expect(saved).toMatchObject({ reasoning: true, models: { served: { images: true } } });
  });
});

describe("connectionModelSettings", () => {
  it("returns a cleared model to its card, not to the connection's earlier values", () => {
    const legacy = parseModelSecret(
      JSON.stringify({ kind: "api_key", key: KEY, maxTokens: 2_048 }),
    );
    const cleared = withModelSettings(
      withModelSettings(legacy, "glm-5.3", { maxTokens: 4_000 }),
      "glm-5.3",
      {},
    );
    expect(connectionModelSettings(cleared, "zai", "glm-5.3")).toEqual({});
    expect(connectionModelSettings(cleared, "zai", "glm-5.3-flash")).toEqual({ maxTokens: 2_048 });
    expect(parseModelSecret(serializeModelSecret(cleared)).models).toEqual({ "glm-5.3": {} });
  });

  it("prefers a model's own settings over the connection's earlier values", () => {
    const secret = withModelSettings(
      parseModelSecret(JSON.stringify({ kind: "api_key", key: KEY, maxTokens: 2_048 })),
      LISTED_ONLY,
      { images: true },
    );
    expect(connectionModelSettings(secret, "zai", LISTED_ONLY)).toEqual({ images: true });
    expect(connectionModelSettings(secret, "zai", "glm-5.3")).toEqual({ maxTokens: 2_048 });
  });

  it("keeps the catalog's image and thinking answer for models it knows", () => {
    const secret = withModelSettings(parseModelSecret(KEY), "glm-5.3", {
      images: true,
      reasoning: false,
      maxTokens: 4_000,
    });
    expect(connectionModelSettings(secret, "zai", "glm-5.3")).toEqual({ maxTokens: 4_000 });
  });

  it("reads an OpenAI-compatible connection's earlier settings for each model", () => {
    const secret = parseModelSecret(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:8181/v1",
        reasoning: true,
        visionModelIds: ["vision"],
        maxImagesPerPrompt: 3,
        contextWindow: 64_000,
      }),
    );
    expect(connectionModelSettings(secret, "openai-compatible", "vision")).toEqual({
      contextWindow: 64_000,
      reasoning: true,
      images: true,
      maxImagesPerPrompt: 3,
    });
    expect(connectionModelSettings(secret, "openai-compatible", "text").images).toBeUndefined();
  });

  it("shows each model's settings and image support on the connection the apps read", () => {
    const plaintext = serializeModelSecret(
      withModelSettings(
        parseModelSecret(
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "http://127.0.0.1:8181/v1",
            enabledModelIds: ["vision", "text"],
          }),
        ),
        "vision",
        { images: true, reasoning: true },
      ),
    );
    const dto = modelCredentialDto(
      {
        id: "c",
        provider: "openai-compatible",
        label: "Server",
        defaultModel: "vision",
        isDefault: true,
      },
      plaintext,
    );
    expect(dto.modelSettings).toEqual({ vision: { images: true, reasoning: true } });
    expect(dto.visionModelIds).toEqual(["vision"]);
    expect(dto.thinkingLevels?.length).toBeGreaterThan(1);
  });
});
