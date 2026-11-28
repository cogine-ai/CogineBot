import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

const terra = {
  id: "gpt-6.1-terra",
  name: "GPT-6.1 Terra",
  cost: {
    input: 1,
    output: 5,
    cacheRead: 0.05,
    cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
  },
};
const terraApiThinkingLevels = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

const gpt62Models = [
  {
    id: "gpt-6.2-astra",
    name: "GPT-6.2 Astra",
    codexBase: "gpt-6-astra",
    gatewayBase: "openai/gpt-6-astra",
    cost: {
      input: 8,
      output: 40,
      cacheRead: 0.4,
      cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
    },
  },
  {
    id: "gpt-6.2-sol",
    name: "GPT-6.2 Sol",
    codexBase: "gpt-6.1-sol",
    gatewayBase: "openai/gpt-6.1-sol",
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
  },
];

/** These subscription picks require the selected account's live model list. */
export const codexAccountCatalogModelIds: ReadonlySet<string> = new Set([
  terra.id,
  ...gpt62Models.map(({ id }) => id),
]);

/** Fill catalog gaps until the bundled provider library includes these releases. */
export function supplementPiModels(models: MutableModels): MutableModels {
  function add(
    providerId: string,
    baseId: string,
    overrides: Partial<Model<Api>> & { id: string },
    position: "first" | "last" = "first",
  ) {
    if (models.getModel(providerId, overrides.id)) return;
    const provider = models.getProvider(providerId);
    const base = models.getModel(providerId, baseId);
    if (!provider || !base) throw new Error(`Missing model baseline: ${providerId}/${baseId}`);
    const model = { ...base, ...overrides };
    models.setProvider({
      ...provider,
      getModels: () =>
        position === "last" ? [...provider.getModels(), model] : [model, ...provider.getModels()],
    });
  }
  add("anthropic", "claude-sonnet-5", {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    },
  });
  const sol = models.getModel("openai-codex", "gpt-6-sol");
  add("openai-codex", "gpt-6-sol", {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    // Subscription transport keeps its own window; the account catalog may narrow it.
    contextWindow: sol?.contextWindow ?? 272000,
  });
  add("openai", "gpt-6.1-sol", { ...terra, thinkingLevelMap: terraApiThinkingLevels }, "last");
  add(
    "openai-codex",
    "gpt-6.1-sol",
    // The subscription catalog supports low and higher reasoning for Terra.
    { ...terra, thinkingLevelMap: { ...terraApiThinkingLevels, off: null, minimal: "low" } },
    "last",
  );
  add(
    "vercel-ai-gateway",
    "openai/gpt-6.1-sol",
    {
      ...terra,
      id: `openai/${terra.id}`,
      compat: { allowEmptySignature: true, supportsTemperature: false },
    },
    "last",
  );
  for (const { id, name, codexBase, gatewayBase, cost } of gpt62Models) {
    add(
      "openai-codex",
      codexBase,
      {
        id,
        name,
        cost,
        contextWindow: 272000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
      },
      "last",
    );
    add(
      "vercel-ai-gateway",
      gatewayBase,
      {
        id: `openai/${id}`,
        name,
        cost,
        // The Messages route translates a thinking budget to the provider's effort.
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" },
        compat: { allowEmptySignature: true, supportsTemperature: false },
      },
      "last",
    );
  }
  return models;
}
