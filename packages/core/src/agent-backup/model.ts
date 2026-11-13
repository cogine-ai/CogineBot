import type { AgentBackupModel, AgentBackupSource } from "@rakazo/contracts";
import { AgentBackupModelSchema, canonicalPiProviderId } from "@rakazo/contracts";
import { redactSecretText } from "@rakazo/logging/redaction";

const providerAliases = new Map([
  ["gemini", "google"],
  ["google-gemini", "google"],
  ["claude", "anthropic"],
  ["x-ai", "xai"],
  ["grok", "xai"],
  ["kimi", "kimi-coding"],
  ["moonshot", "moonshotai"],
  ["z-ai", "zai"],
  ["zhipu", "zai"],
]);
const hermesProviderAliases = new Map([
  ["openai-api", "openai"],
  ["chatgpt", "openai-codex"],
  ["chatgpt-codex", "openai-codex"],
  ["claude-code", "anthropic"],
  ["google-ai-studio", "google"],
  ["x.ai", "xai"],
  ["kimi-for-coding", "kimi-coding"],
  ["moonshot", "kimi-coding"],
  ["kimi-cn", "kimi-coding-cn"],
  ["moonshot-cn", "kimi-coding-cn"],
  ["glm", "zai"],
  ["z.ai", "zai"],
  ["minimax-china", "minimax-cn"],
  ["minimax_cn", "minimax-cn"],
  ["ai-gateway", "vercel-ai-gateway"],
  ["aigateway", "vercel-ai-gateway"],
  ["vercel", "vercel-ai-gateway"],
  ["opencode-zen", "opencode"],
  ["zen", "opencode"],
  ["go", "opencode-go"],
  ["opencode-go-sub", "opencode-go"],
  ["hf", "huggingface"],
  ["hugging-face", "huggingface"],
  ["huggingface-hub", "huggingface"],
  ["mimo", "xiaomi"],
  ["xiaomi-mimo", "xiaomi"],
  ["kilo", "kilocode"],
  ["kilo-code", "kilocode"],
  ["kilo-gateway", "kilocode"],
]);
// A saved address can disambiguate the account family. Only portable built-in routes are listed.
const hermesDefaultEndpoints = new Map<string, ReadonlyMap<string, string>>([
  ["anthropic", new Map([["https://api.anthropic.com", "anthropic"]])],
  [
    "deepseek",
    new Map([
      ["https://api.deepseek.com/v1", "deepseek"],
      ["https://api.deepseek.com", "deepseek"],
    ]),
  ],
  ["google", new Map([["https://generativelanguage.googleapis.com/v1beta", "google"]])],
  ["huggingface", new Map([["https://router.huggingface.co/v1", "huggingface"]])],
  [
    "kimi-coding",
    new Map([
      ["https://api.kimi.com/coding", "kimi-coding"],
      ["https://api.moonshot.ai/v1", "moonshotai"],
    ]),
  ],
  ["kimi-coding-cn", new Map([["https://api.moonshot.cn/v1", "moonshotai-cn"]])],
  ["minimax", new Map([["https://api.minimax.io/anthropic", "minimax"]])],
  ["minimax-cn", new Map([["https://api.minimaxi.com/anthropic", "minimax-cn"]])],
  ["nvidia", new Map([["https://integrate.api.nvidia.com/v1", "nvidia"]])],
  ["openai", new Map([["https://api.openai.com/v1", "openai"]])],
  ["openai-codex", new Map([["https://chatgpt.com/backend-api/codex", "openai-codex"]])],
  ["openrouter", new Map([["https://openrouter.ai/api/v1", "openrouter"]])],
  ["vercel-ai-gateway", new Map([["https://ai-gateway.vercel.sh/v1", "vercel-ai-gateway"]])],
  ["opencode", new Map([["https://opencode.ai/zen/v1", "opencode"]])],
  ["opencode-go", new Map([["https://opencode.ai/zen/go/v1", "opencode-go"]])],
  ["xai", new Map([["https://api.x.ai/v1", "xai"]])],
  ["xiaomi", new Map([["https://api.xiaomimimo.com/v1", "xiaomi"]])],
  [
    "zai",
    new Map([
      ["https://api.z.ai/api/coding/paas/v4", "zai"],
      ["https://open.bigmodel.cn/api/coding/paas/v4", "zai-coding-cn"],
    ]),
  ],
]);
const hermesEndpointRequired = new Set(["kimi-coding", "kimi-coding-cn", "zai"]);
const hermesAggregatorProviders = new Set(["openrouter", "nous", "vercel-ai-gateway", "kilocode"]);
const hermesAggregatorVendors = new Map([
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["deepseek", "deepseek"],
  ["glm", "z-ai"],
  ["kimi", "moonshotai"],
  ["minimax", "minimax"],
  ["grok", "x-ai"],
  ["qwen", "qwen"],
  ["mimo", "xiaomi"],
  ["trinity", "arcee-ai"],
  ["nemotron", "nvidia"],
  ["llama", "meta-llama"],
  ["step", "stepfun"],
]);
const hermesDirectProviders = new Set([
  "anthropic",
  "arcee",
  "deepseek",
  "google",
  "kimi-coding",
  "kimi-coding-cn",
  "minimax",
  "minimax-cn",
  "minimax-oauth",
  "openai-codex",
  "xai",
  "xiaomi",
  "zai",
]);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const own = (object: Record<string, unknown>, key: string) =>
  Object.hasOwn(object, key) ? object[key] : undefined;
export const backupProviderId = (source: AgentBackupSource, value: string) => {
  const id = value.trim().toLowerCase();
  const hermesId = source === "hermes" ? hermesProviderAliases.get(id) : undefined;
  return canonicalPiProviderId(hermesId ?? providerAliases.get(id) ?? id);
};

export const backupModelConfigPath = (source: AgentBackupSource) =>
  source === "openclaw" ? "openclaw.json" : "config.yaml";

export function backupModelLabel(model: AgentBackupModel | "unavailable" | undefined) {
  return model && model !== "unavailable" ? `${model.provider}/${model.modelId}` : null;
}

/** Config data stays on the device. A provider endpoint override requires a separate setup. */
export function projectBackupModel(
  source: AgentBackupSource,
  config: Record<string, unknown> | null | undefined,
  selectedAgent: string | null,
): AgentBackupModel | "unavailable" | undefined {
  if (config === undefined) return undefined;
  if (!config) return "unavailable";
  try {
    let provider: string;
    let modelId: string;
    let routedProvider: string | undefined;
    if (source === "hermes") {
      const model = record(config.model);
      if (!Object.hasOwn(config, "model")) return undefined;
      let providerValue = own(model, "provider");
      if (providerValue && typeof providerValue !== "string") return "unavailable";
      let selected: unknown = typeof config.model === "string" ? config.model : undefined;
      for (const field of ["default", "model", "name"] as const) {
        const value = own(model, field);
        const nested = record(value);
        if (hasEndpoint(nested)) return "unavailable";
        const nestedProvider = own(nested, "provider");
        const currentProvider = text(providerValue);
        if (!currentProvider || currentProvider === "auto") {
          if (nestedProvider && typeof nestedProvider !== "string") return "unavailable";
          providerValue = text(nestedProvider) || providerValue;
        }
        if (selected) continue;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const nestedId = nested.model || nested.default;
          if (nestedId && typeof nestedId !== "string") return "unavailable";
          selected = text(nestedId);
        } else selected = value;
      }
      modelId = text(selected);
      provider = text(providerValue || config.provider);
      const canonicalProvider = backupProviderId(source, provider);
      const endpoints = [...endpointOverrides(model), ...endpointOverrides(config)];
      if (!endpoints.length && hermesEndpointRequired.has(canonicalProvider)) return "unavailable";
      const routes = endpoints.map((endpoint) =>
        hermesDefaultEndpoints.get(canonicalProvider)?.get(text(endpoint).replace(/\/+$/, "")),
      );
      routedProvider = routes[0];
      if (routes.some((route) => !route || route !== routedProvider)) return "unavailable";
      const overrides = [
        ...Object.entries(record(config.providers)),
        ...(Array.isArray(config.custom_providers)
          ? config.custom_providers.map((entry) => [text(record(entry).name), entry] as const)
          : []),
      ];
      if (
        overrides.some(
          ([name, entry]) =>
            [canonicalProvider, routedProvider].includes(backupProviderId(source, name)) &&
            (hasEndpoint(record(entry)) || hasOverride(own(record(entry), "api"))),
        )
      )
        return "unavailable";
      if (
        Object.hasOwn(record(config.model_aliases), modelId) ||
        Object.hasOwn(record(model.aliases), modelId)
      )
        return "unavailable";
    } else {
      const agents = record(config.agents);
      const defaults = record(agents.defaults);
      if (Object.hasOwn(agents, "$include") || Object.hasOwn(defaults, "$include"))
        return "unavailable";
      const entries = record(agents.entries);
      const list = Array.isArray(agents.list) ? agents.list.map(record) : [];
      if (
        (Object.hasOwn(agents, "list") && !Array.isArray(agents.list)) ||
        (Object.hasOwn(agents, "entries") && Object.hasOwn(agents, "list"))
      )
        return "unavailable";
      const candidates = [...Object.values(entries).map(record), ...list];
      if (
        !Object.hasOwn(defaults, "model") &&
        !candidates.some((entry) => Object.hasOwn(entry, "model"))
      )
        return undefined;
      // A relative folder name cannot prove which named agent supplied the settings.
      if (!selectedAgent) return "unavailable";
      const entry = record(
        own(entries, selectedAgent) ?? list.find((row) => text(row.id) === selectedAgent),
      );
      if (hasOverride(own(entry, "agentDir"))) return "unavailable";
      const value = own(entry, "model") ?? own(defaults, "model");
      const name = typeof value === "string" ? value.trim() : text(record(value).primary);
      const slash = name.indexOf("/");
      if (slash < 1 || hasEndpoint(entry) || hasEndpoint(defaults) || hasEndpoint(record(value)))
        return "unavailable";
      provider = name.slice(0, slash);
      modelId = name.slice(slash + 1);
      const providers = record(record(config.models).providers);
      if (
        Object.entries(providers).some(([name, value]) => {
          if (backupProviderId(source, name) !== backupProviderId(source, provider)) return false;
          const entry = record(value);
          return (
            hasEndpoint(entry) ||
            (Array.isArray(entry.models) &&
              entry.models.map(record).some((row) => text(row.id) === modelId && hasEndpoint(row)))
          );
        })
      )
        return "unavailable";
    }
    if (
      [provider, modelId].some((value) => redactSecretText(value) !== value || /:\/\//.test(value))
    )
      return "unavailable";
    const canonicalProvider = routedProvider ?? backupProviderId(source, provider);
    if (source === "hermes") {
      const normalized = normalizeHermesModelId(backupProviderId(source, provider), modelId);
      if (normalized !== modelId && redactSecretText(normalized) !== normalized)
        return "unavailable";
      modelId = normalized;
    }
    const result = AgentBackupModelSchema.safeParse({ provider: canonicalProvider, modelId });
    return result.success ? result.data : "unavailable";
  } catch {
    return "unavailable";
  }
}

function normalizeHermesModelId(provider: string, modelId: string): string {
  if (hermesAggregatorProviders.has(provider)) {
    if (modelId.includes("/")) return modelId;
    const lower = modelId.toLowerCase();
    const vendor =
      hermesAggregatorVendors.get(lower.split("-", 1)[0]!) ??
      [...hermesAggregatorVendors].find(([prefix]) => lower.startsWith(prefix))?.[1];
    return vendor ? `${vendor}/${modelId}` : modelId;
  }
  if (provider === "opencode" || provider === "opencode-go") {
    const slash = modelId.indexOf("/");
    const bare = slash >= 0 ? modelId.slice(slash + 1).trim() || modelId : modelId;
    return provider === "opencode" && bare.toLowerCase().startsWith("claude-")
      ? bare.replaceAll(".", "-")
      : bare;
  }
  if (!hermesDirectProviders.has(provider)) return modelId;
  const separator = modelId.search(/[/:]/);
  if (separator >= 0) {
    const prefix = modelId.slice(0, separator);
    const remainder = modelId.slice(separator + 1).trim();
    if (
      remainder &&
      (backupProviderId("hermes", prefix) === provider ||
        (provider === "openai-codex" && prefix === "openai"))
    )
      modelId = remainder;
  }
  if (provider === "anthropic" && !modelId.includes("/")) return modelId.replaceAll(".", "-");
  if (provider === "xiaomi") return modelId.toLowerCase();
  if (provider === "deepseek" && !modelId.includes("/")) {
    const bare = modelId.toLowerCase();
    return ["deepseek-chat", "deepseek-reasoner"].includes(bare) ? "deepseek-flash" : bare;
  }
  return modelId;
}

function endpointOverrides(value: Record<string, unknown>) {
  return ["baseUrl", "base_url", "endpoint", "api_base", "apiBase", "url"]
    .map((key) => own(value, key))
    .filter(hasOverride);
}

function hasEndpoint(value: Record<string, unknown>) {
  return endpointOverrides(value).length > 0;
}

const hasOverride = (value: unknown) =>
  value !== undefined && value !== null && (typeof value !== "string" || Boolean(value.trim()));
