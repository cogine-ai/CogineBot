import type { ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { ConnectionFormDraft } from "./model-connection-form.js";
import {
  compatibleConnectionReady,
  connectionFormFields,
  connectionFormModelId,
  modelCatalogProbeInput,
  modelConnectRequest,
  modelInferenceProbeInput,
  prioritizeProviderListedModels,
  selectedModelDirectoryStatus,
  withConnectionCatalogModels,
} from "./model-connection-form.js";

const catalog = [
  {
    provider: "anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  },
  { provider: "anthropic", id: "sonnet" },
  { provider: "openrouter", id: "jev" },
];
const COMPATIBLE = "openai-compatible";

function credential(overrides: Partial<ModelCredential> = {}): ModelCredential {
  return {
    id: "credential-fixture",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
    connectionRevision: 7,
    ...overrides,
  };
}

it("ranks listed choices for the displayed revision while leaving the base order and draft key alone", () => {
  const models = [1, 2, 3, 4].map((number) => ({
    id: `fixture-${number}`,
    provider: "anthropic",
    label: `Fixture ${number}`,
    billing: "API",
  }));
  const saved = credential({ providerListedModelIds: [models[3]!.id, models[1]!.id] });
  expect(prioritizeProviderListedModels(models, saved, 7, "")).toEqual([
    models[1],
    models[3],
    models[0],
    models[2],
  ]);
  expect(prioritizeProviderListedModels(models, saved, 6, "")).toBe(models);
  expect(prioritizeProviderListedModels(models, saved, 7, "new-key-draft")).toBe(models);
  expect(models.map(({ label }) => label)).toEqual([
    "Fixture 1",
    "Fixture 2",
    "Fixture 3",
    "Fixture 4",
  ]);
});

it("keeps the unconfirmed saved model scoped to the current connection and revision", () => {
  const catalog = [
    { id: "gpt-base", provider: "openai", label: "Base", billing: "API", subscription: false },
  ];
  const status = { confirmationRequired: true as const, notListed: true as const };
  const saved = {
    provider: "openai",
    modelId: "gpt-saved",
    connectionRevision: 7,
    savedModelDirectory: status,
  };
  expect(withConnectionCatalogModels(catalog, saved).map(({ id }) => id)).toEqual([
    "gpt-base",
    "gpt-saved",
  ]);
  expect(selectedModelDirectoryStatus(saved, 7, "gpt-saved", "")).toBe(status);
  expect(selectedModelDirectoryStatus(saved, 6, "gpt-saved", "")).toBeUndefined();
  expect(selectedModelDirectoryStatus(saved, 7, "gpt-base", "")).toBeUndefined();
  expect(selectedModelDirectoryStatus(saved, 7, "gpt-saved", "draft")).toBeUndefined();
});

it("adds new options only for the selected connection and keeps its saved model during a draft", () => {
  const base = {
    id: "gpt-base",
    provider: "openai",
    label: "Base",
    billing: "API",
    subscription: false,
  };
  const models = [base];
  const credential = {
    provider: "openai",
    connectionRevision: 7,
    modelId: "gpt-saved",
    savedProviderCatalogModelIds: ["gpt-saved", "gpt-other-saved"],
    providerListedModelIds: ["gpt-base", "gpt-new", "gpt-saved"],
  };
  const choices = withConnectionCatalogModels(models, credential, 7);
  expect(choices.map(({ id }) => id)).toEqual([
    "gpt-base",
    "gpt-new",
    "gpt-saved",
    "gpt-other-saved",
  ]);
  expect(choices[0]).toBe(base);
  expect(choices[1]).toMatchObject({
    images: false,
    reasoning: false,
    thinkingLevels: ["off"],
    contextWindow: 32_768,
    maxTokens: 16_384,
  });
  expect(choices[1]?.live).toBeUndefined();
  expect(withConnectionCatalogModels(models, credential, 6)).toBe(models);
  expect(withConnectionCatalogModels(models, credential, 7, "draft").map(({ id }) => id)).toEqual([
    "gpt-base",
    "gpt-saved",
  ]);
});

it("tests a discovered model only when its connection and server advertise support", () => {
  const base = {
    id: "gpt-base",
    provider: "openai",
    label: "Base",
    billing: "API",
    catalogProbe: true,
    savedCatalogProbe: true as const,
    inferenceProbe: true as const,
  };
  const modelId = "gpt-discovered";
  const saved = credential({
    provider: base.provider,
    authKind: "api_key",
    modelId,
    savedProviderCatalogModelIds: [modelId],
  });
  const legacy = withConnectionCatalogModels([base], saved)[1];
  expect(legacy?.inferenceProbe).toBeUndefined();
  const signed = { ...saved, providerCatalogInferenceProbe: "saved" as const };
  expect(withConnectionCatalogModels([base], signed)[1]?.inferenceProbe).toBe(true);
  expect(
    withConnectionCatalogModels([base], signed, 7, "fixture-draft")[1]?.inferenceProbe,
  ).toBeUndefined();
  const enabled = { ...saved, providerCatalogInferenceProbe: "replacement" as const };
  const discovered = withConnectionCatalogModels([base], enabled)[1];
  expect(discovered).toMatchObject({ id: modelId, inferenceProbe: true });
  expect(modelInferenceProbeInput(discovered, "", saved, 7)).toEqual({
    provider: base.provider,
    modelId,
    credentialId: saved.id,
    expectedRevision: 7,
  });
  expect(modelInferenceProbeInput(discovered, "fixture-draft", saved, 7)).toEqual({
    provider: base.provider,
    modelId,
    apiKey: "fixture-draft",
    credentialId: saved.id,
    expectedRevision: 7,
  });
  expect(modelInferenceProbeInput(discovered, "fixture-draft", saved, 6)).toBeUndefined();
  expect(modelInferenceProbeInput(base, "fixture-draft", saved, 7)).toEqual({
    provider: base.provider,
    modelId: base.id,
    apiKey: "fixture-draft",
  });

  const retained = {
    ...enabled,
    savedProviderCatalogModelIds: undefined,
    savedModelDirectory: { confirmationRequired: true as const },
  };
  expect(withConnectionCatalogModels([base], retained)[1]?.inferenceProbe).toBeUndefined();
  expect(withConnectionCatalogModels([base], retained, 7, "fixture-draft")[1]?.inferenceProbe).toBe(
    true,
  );
});

it("tests a model without a directory probe using the draft or current API key", () => {
  const model = {
    id: "fixture-claude",
    provider: "anthropic",
    label: "Claude",
    billing: "API",
    inferenceProbe: true as const,
  };
  const saved = credential({ provider: model.provider, authKind: "api_key" });
  expect(modelCatalogProbeInput(model, "fixture-draft", saved, 7)).toBeUndefined();
  expect(modelInferenceProbeInput(model, " fixture-draft ", saved, 7)).toEqual({
    provider: model.provider,
    modelId: model.id,
    apiKey: "fixture-draft",
  });
  expect(modelInferenceProbeInput(model, "", saved, 7)).toEqual({
    provider: model.provider,
    modelId: model.id,
    credentialId: saved.id,
    expectedRevision: 7,
  });
  expect(modelInferenceProbeInput(model, "short", saved, 7)).toBeUndefined();
  expect(modelInferenceProbeInput(model, "", saved, 6)).toBeUndefined();
  expect(modelInferenceProbeInput(model, "", { ...saved, provider: "openai" }, 7)).toBeUndefined();
  expect(modelInferenceProbeInput(model, "", { ...saved, authKind: "oauth" }, 7)).toBeUndefined();
});

function draft(overrides: Partial<ConnectionFormDraft> = {}): ConnectionFormDraft {
  return {
    apiKey: "",
    modelId: "",
    enabledModelIds: [],
    baseUrl: "",
    apiProtocol: "chat-completions",
    headerRows: null,
    reasoning: false,
    thinkingLevel: null,
    maxTokens: "",
    contextWindow: "262144",
    supportsImages: false,
    maxImagesPerPrompt: "",
    accountId: "",
    gatewayId: "",
    ...overrides,
  };
}

describe("connectionFormModelId", () => {
  it("keeps the model on screen while the catalog lists it", () => {
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        current: "opus",
      }),
    ).toBe("opus");
  });

  it("falls back to the connection's model, then the default, then the existing catalog order", () => {
    const defaults = { defaultProvider: "anthropic", defaultModel: "opus" };
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        credential: credential({ modelId: "sonnet" }),
        defaults,
        current: "gone",
      }),
    ).toBe("sonnet");
    expect(connectionFormModelId({ catalog, provider: "anthropic", defaults })).toBe("opus");
    expect(
      connectionFormModelId({
        catalog,
        provider: "anthropic",
        defaults: { defaultProvider: "openrouter", defaultModel: "jev" },
      }),
    ).toBe("opus");
  });

  it("opens a new OpenAI-compatible connection empty instead of on another server's model", () => {
    const defaults = { defaultProvider: COMPATIBLE, defaultModel: "local-model" };
    expect(connectionFormModelId({ catalog, provider: COMPATIBLE, defaults })).toBe("");
    expect(
      connectionFormModelId({
        catalog,
        provider: COMPATIBLE,
        credential: credential({ provider: COMPATIBLE, modelId: "saved-model" }),
        defaults,
        current: "typed-model",
      }),
    ).toBe("saved-model");
  });
});

describe("connectionFormFields", () => {
  it("fills a new connection with defaults and the endpoint preset", () => {
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "",
        presetBaseUrl: "https://ollama.com/v1",
      }),
    ).toEqual({
      enabledModelIds: [],
      baseUrl: "https://ollama.com/v1",
      apiProtocol: "chat-completions",
      reasoning: false,
      thinkingLevel: null,
      maxTokens: "4096",
      contextWindow: "32768",
      supportsImages: false,
      maxImagesPerPrompt: "",
      accountId: "",
      gatewayId: "",
    });
  });

  it("shows a saved OpenAI-compatible connection, with effort only for its saved model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      enabledModelIds: ["local", "other"],
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: 2048,
      contextWindow: 32_000,
      supportsImages: true,
      maxImagesPerPrompt: 4,
    });
    const fields = connectionFormFields({
      catalog,
      provider: COMPATIBLE,
      modelId: "local",
      credential: saved,
      presetBaseUrl: "https://ignored.example/v1",
    });
    expect(fields).toMatchObject({
      enabledModelIds: ["local", "other"],
      baseUrl: "http://127.0.0.1:8000/v1",
      apiProtocol: "chat-completions",
      reasoning: true,
      thinkingLevel: "high",
      maxTokens: "2048",
      contextWindow: "32000",
      supportsImages: true,
      maxImagesPerPrompt: "4",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "other", credential: saved })
        .thinkingLevel,
    ).toBeNull();
  });

  it.each([true, false])(
    "uses the model's thinking support (%s) while preserving legacy connection defaults",
    (enabled) => {
      const saved = credential({
        provider: COMPATIBLE,
        modelId: "local",
        apiProtocol: "chat-completions",
        baseUrl: "https://models.example.test/v1",
        reasoning: !enabled,
        thinkingLevel: "high",
        modelSettings: { local: { reasoning: enabled }, other: { reasoning: !enabled } },
      });
      const fields = connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "local",
        credential: saved,
      });
      expect(fields.thinkingLevel).toBe("high");
      const request = modelConnectRequest({
        form: draft({ ...fields, modelId: "local", thinkingLevel: "high" }),
        selected: { provider: COMPATIBLE, providerName: "Model server", id: "local" },
        credential: saved,
        credentialId: saved.id,
        expectedRevision: 7,
      });
      expect(request.status).toBe("ready");
      if (request.status !== "ready") return;
      expect(request.input.thinkingLevel).toBe(enabled ? "high" : undefined);
      expect(Object.hasOwn(request.input, "thinkingLevel")).toBe(enabled);
      expect(request.input.reasoning).toBe(!enabled);
      expect(saved.modelSettings?.other?.reasoning).toBe(!enabled);
    },
  );

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "preserves retained form effort after thinking support is disabled on %s",
    (apiProtocol) => {
      const saved = credential({
        provider: COMPATIBLE,
        modelId: "local",
        apiProtocol,
        baseUrl: "https://models.example.test/v1",
        reasoning: true,
        thinkingLevel: "high",
        modelSettings: { local: { reasoning: false } },
      });
      const request = modelConnectRequest({
        form: draft({
          ...connectionFormFields({
            catalog,
            provider: COMPATIBLE,
            modelId: "local",
            credential: saved,
          }),
          modelId: "local",
          thinkingLevel: "high",
        }),
        selected: { provider: COMPATIBLE, id: "local" },
        credential: saved,
        credentialId: saved.id,
        expectedRevision: 7,
      });
      expect(request.status).toBe("ready");
      if (request.status !== "ready") return;
      expect(Object.hasOwn(request.input, "thinkingLevel")).toBe(false);
      expect(saved.thinkingLevel).toBe("high");
    },
  );

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "preserves an untouched dormant effort when saving a %s connection",
    (apiProtocol) => {
      for (const settings of [{}, { reasoning: false }]) {
        const saved = credential({
          provider: COMPATIBLE,
          modelId: "local",
          apiProtocol,
          baseUrl: "https://models.example.test/v1",
          reasoning: true,
          thinkingLevel: "low",
          modelSettings: { local: settings },
        });
        const fields = connectionFormFields({
          catalog,
          provider: COMPATIBLE,
          modelId: "local",
          credential: saved,
        });
        const request = modelConnectRequest({
          form: draft({ ...fields, modelId: "local" }),
          selected: { provider: COMPATIBLE, id: "local" },
          credential: saved,
          credentialId: saved.id,
          expectedRevision: 7,
        });
        expect(request.status).toBe("ready");
        if (request.status !== "ready") return;
        expect(Object.hasOwn(request.input, "thinkingLevel")).toBe(false);
        expect(saved.thinkingLevel).toBe("low");
      }
    },
  );

  it("does not carry dormant effort to a different compatible model", () => {
    const saved = credential({
      provider: COMPATIBLE,
      modelId: "local",
      baseUrl: "https://models.example.test/v1",
      thinkingLevel: "high",
      modelSettings: { local: { reasoning: false }, other: { reasoning: false } },
    });
    const request = modelConnectRequest({
      form: draft({
        ...connectionFormFields({
          catalog,
          provider: COMPATIBLE,
          modelId: "other",
          credential: saved,
        }),
        modelId: "other",
      }),
      selected: { provider: COMPATIBLE, id: "other" },
      credential: saved,
      credentialId: saved.id,
      expectedRevision: 7,
    });
    expect(request.status).toBe("ready");
    if (request.status !== "ready") return;
    expect(request.input.thinkingLevel).toBeNull();
    expect(Object.hasOwn(request.input, "thinkingLevel")).toBe(true);
  });

  it("keeps a saved protocol and clamps its effort levels to what the protocol runs", () => {
    const saved = credential({
      provider: COMPATIBLE,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local",
      reasoning: true,
      thinkingLevel: "max",
      apiProtocol: "anthropic-messages",
    });
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .apiProtocol,
    ).toBe("anthropic-messages");
    // Anthropic Messages has no budget above high, so a saved max clamps down.
    expect(
      connectionFormFields({ catalog, provider: COMPATIBLE, modelId: "local", credential: saved })
        .thinkingLevel,
    ).toBe("high");
    const request = modelConnectRequest({
      form: draft({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "local",
        apiProtocol: "anthropic-messages",
        reasoning: true,
        thinkingLevel: "xhigh",
        maxTokens: "4096",
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      apiProtocol: "anthropic-messages",
      thinkingLevel: "high",
    });
  });

  it("clamps a catalog connection's effort to its model and leaves the endpoint empty", () => {
    const fields = connectionFormFields({
      catalog,
      provider: "anthropic",
      modelId: "opus",
      credential: credential({ modelId: "opus", thinkingLevel: "medium", baseUrl: "x" }),
    });
    expect(fields.thinkingLevel).toBe("high");
    expect(fields.baseUrl).toBe("");
    expect(fields.maxTokens).toBe("");
  });
});

describe("compatibleConnectionReady", () => {
  const ready = {
    baseUrl: " http://h/v1 ",
    modelId: "m",
    apiProtocol: "chat-completions" as const,
    headerRows: null,
  };

  it("needs a URL and a model", () => {
    expect(compatibleConnectionReady(ready)).toBe(true);
    expect(compatibleConnectionReady({ ...ready, modelId: "" })).toBe(false);
    expect(compatibleConnectionReady({ ...ready, baseUrl: " " })).toBe(false);
  });

  it("refuses invalid header rows", () => {
    expect(
      compatibleConnectionReady({ ...ready, headerRows: [{ name: "bad name", value: "v" }] }),
    ).toBe(false);
  });
});

describe("modelConnectRequest", () => {
  const anthropic = {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "opus",
    thinkingLevels: ["low", "high"] as ModelCredential["thinkingLevels"],
  };

  it("waits for a key, or a saved connection for a limits-only save", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "short" }),
        selected: anthropic,
        credentialId: null,
      }).status,
    ).toBe("incomplete");
    expect(
      modelConnectRequest({ form: draft(), selected: anthropic, credentialId: null }).status,
    ).toBe("incomplete");
  });

  it("names the out-of-range field", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: "sk-long-enough", maxTokens: "0" }),
        selected: anthropic,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxTokens" });
    const compatible = { provider: COMPATIBLE, id: "openai-compatible" };
    const form = draft({ baseUrl: "http://h/v1", modelId: "m", maxTokens: "4096" });
    expect(
      modelConnectRequest({
        form: { ...form, supportsImages: true, maxImagesPerPrompt: "2000" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "maxImagesPerPrompt" });
    expect(
      modelConnectRequest({
        form: { ...form, contextWindow: "" },
        selected: compatible,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
  });

  it("connects a catalog key with the clamped effort", () => {
    expect(
      modelConnectRequest({
        form: draft({ apiKey: " sk-long-enough ", thinkingLevel: "medium" }),
        selected: anthropic,
        credentialId: null,
      }),
    ).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "opus",
      input: {
        provider: "anthropic",
        apiKey: "sk-long-enough",
        modelId: "opus",
        thinkingLevel: "high",
        maxTokens: null,
        label: "Anthropic",
      },
    });
  });

  it("leaves the stored effort alone on a limits-only save unless model or effort changed", () => {
    const saved = credential({ modelId: "opus", thinkingLevel: "high" });
    const limits = modelConnectRequest({
      form: draft({ apiKey: "sk-ignored-here", maxTokens: "1024", thinkingLevel: "high" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      expectedRevision: 7,
      settingsOnly: true,
    });
    expect(limits).toMatchObject({ status: "ready", savingLimitOnly: true });
    expect(limits.status === "ready" && limits.input).toEqual({
      provider: "anthropic",
      modelId: "opus",
      maxTokens: 1024,
      label: "Anthropic",
      credentialId: saved.id,
      expectedRevision: 7,
    });
    const effort = modelConnectRequest({
      form: draft({ thinkingLevel: "low" }),
      selected: anthropic,
      credential: saved,
      credentialId: saved.id,
      expectedRevision: 7,
    });
    expect(effort.status === "ready" && effort.input.thinkingLevel).toBe("low");
    const model = modelConnectRequest({
      form: draft(),
      selected: anthropic,
      credential: credential({ modelId: "sonnet" }),
      credentialId: saved.id,
      expectedRevision: 7,
    });
    expect(model.status === "ready" && "thinkingLevel" in model.input).toBe(true);
  });

  it("sends Cloudflare routing ids trimmed", () => {
    const request = modelConnectRequest({
      form: draft({ apiKey: "cf-long-enough", accountId: " acct ", gatewayId: " gw " }),
      selected: { provider: "cloudflare-ai-gateway", id: "model" },
      credentialId: null,
    });
    expect(request.status === "ready" && request.input).toMatchObject({
      accountId: "acct",
      gatewayId: "gw",
    });
  });

  it("saves an OpenAI-compatible connection without repeating its default in the enabled list", () => {
    const request = modelConnectRequest({
      form: draft({
        apiKey: " key ",
        baseUrl: " http://h/v1 ",
        modelId: " m ",
        enabledModelIds: ["m", "n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: "4096",
        supportsImages: true,
        headerRows: [{ name: " X-Team ", value: "v" }],
      }),
      selected: {
        provider: COMPATIBLE,
        id: "openai-compatible",
        providerName: "OpenAI-compatible",
      },
      credentialId: "credential-fixture",
      expectedRevision: 7,
    });
    expect(request).toEqual({
      status: "ready",
      savingLimitOnly: false,
      activeModelId: "m",
      input: {
        provider: COMPATIBLE,
        baseUrl: "http://h/v1",
        apiProtocol: "chat-completions",
        headers: { "X-Team": "v" },
        modelId: "m",
        enabledModelIds: ["n"],
        reasoning: true,
        thinkingLevel: "high",
        maxTokens: 4096,
        contextWindow: 262_144,
        supportsImages: true,
        maxImagesPerPrompt: null,
        apiKey: "key",
        label: "OpenAI-compatible",
        credentialId: "credential-fixture",
        expectedRevision: 7,
      },
    });
  });
});

describe("local connection ownership and validation", () => {
  const selected = { provider: COMPATIBLE, id: "custom", providerName: "Model server" };
  const form = draft({
    baseUrl: "https://models.example.test/v1",
    modelId: "same-model",
    maxTokens: "4096",
  });

  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "saves %s with the captured identity and headers",
    (apiProtocol) => {
      const result = modelConnectRequest({
        form: { ...form, apiProtocol, headerRows: [{ name: "X-Team", value: "en" }] },
        selected,
        credentialId: "connection-a",
        expectedRevision: 9,
      });
      expect(result.status === "ready" && result.input).toMatchObject({
        apiProtocol,
        headers: { "X-Team": "en" },
        credentialId: "connection-a",
        expectedRevision: 9,
      });
    },
  );

  it("keeps untouched headers omitted and an empty replacement explicit", () => {
    const unchanged = modelConnectRequest({ form, selected, credentialId: null });
    const cleared = modelConnectRequest({
      form: { ...form, headerRows: [] },
      selected,
      credentialId: null,
    });
    expect(unchanged.status === "ready" && unchanged.input.headers).toBeUndefined();
    expect(cleared.status === "ready" && cleared.input.headers).toEqual({});
    expect(unchanged.status === "ready" && unchanged.input).not.toHaveProperty("credentialId");
    expect(unchanged.status === "ready" && unchanged.input).not.toHaveProperty("expectedRevision");
  });

  it("rejects unknown protocol, partial saved-header edits and missing captured revision without leaking values", () => {
    const secret = "synthetic-private-header";
    for (const [patch, field] of [
      [{ apiProtocol: "unknown" }, "apiProtocol"],
      [
        {
          headerRows: [
            { name: "X-Saved", value: "" },
            { name: "X-New", value: secret },
          ],
        },
        "headers",
      ],
    ] as const) {
      const result = modelConnectRequest({
        form: { ...form, ...patch } as unknown as ConnectionFormDraft,
        selected,
        credentialId: null,
      });
      expect(result).toEqual({ status: "invalid", field });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(modelConnectRequest({ form, selected, credentialId: "connection-a" })).toEqual({
      status: "invalid",
      field: "connection",
    });
    const unknown = credential({
      provider: COMPATIBLE,
      apiProtocol: "unknown" as ModelCredential["apiProtocol"],
    });
    expect(
      connectionFormFields({
        catalog,
        provider: COMPATIBLE,
        modelId: "same-model",
        credential: unknown,
      }).apiProtocol,
    ).toBe("");
  });

  it.each([1, 15, 16])("preserves the output limit %i through every protocol", (cap) => {
    for (const apiProtocol of ["chat-completions", "responses", "anthropic-messages"] as const) {
      const result = modelConnectRequest({
        form: { ...form, apiProtocol, maxTokens: String(cap) },
        selected,
        credentialId: null,
      });
      expect(result.status === "ready" && result.input.maxTokens).toBe(cap);
    }
  });

  it("retains the existing input-room constraint", () => {
    expect(
      modelConnectRequest({
        form: { ...form, maxTokens: "16", contextWindow: "16" },
        selected,
        credentialId: null,
      }),
    ).toEqual({ status: "invalid", field: "outputRoom" });
  });
});

describe("modelCatalogProbeInput", () => {
  const entry = { provider: "openai", catalogProbe: true, savedCatalogProbe: true as const };
  const saved = credential({ provider: "openai", authKind: "api_key" });
  it("binds an empty draft to the displayed saved connection revision", () => {
    expect(modelCatalogProbeInput(entry, "", saved, 7)).toEqual({
      provider: "openai",
      credentialId: saved.id,
      expectedRevision: 7,
    });
    expect(modelCatalogProbeInput(entry, "", saved, 6)).toBeUndefined();
    expect(
      modelCatalogProbeInput({ ...entry, savedCatalogProbe: undefined }, "", saved, 7),
    ).toBeUndefined();
    expect(modelCatalogProbeInput(entry, "", { ...saved, authKind: "oauth" }, 7)).toBeUndefined();
    expect(
      modelCatalogProbeInput(entry, "", { ...saved, provider: "openrouter" }, 7),
    ).toBeUndefined();
  });
  it("tests only the replacement draft when the user types one", () => {
    expect(modelCatalogProbeInput(entry, "  fixture-key  ", saved, 7)).toEqual({
      provider: "openai",
      apiKey: "fixture-key",
    });
    expect(modelCatalogProbeInput(entry, "short", saved, 7)).toBeUndefined();
    expect(
      modelCatalogProbeInput({ ...entry, catalogProbe: false }, "fixture-key", saved, 7),
    ).toBeUndefined();
  });
});
