import type { AgentBackupModel, AgentBackupSource } from "@rakazo/contracts";
import { AgentBackupModelSchema, canonicalPiProviderId } from "@rakazo/contracts";
import { redactSecretText } from "@rakazo/logging/redaction";
import JSON5 from "json5";
import { parseDocument } from "yaml";

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
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const own = (object: Record<string, unknown>, key: string) =>
  Object.hasOwn(object, key) ? object[key] : undefined;
const providerId = (source: AgentBackupSource, value: string) => {
  const id = value.trim().toLowerCase();
  if (source === "hermes" && id === "openai-api") return "openai";
  if (source === "hermes" && id === "moonshot") return "kimi-coding";
  return canonicalPiProviderId(providerAliases.get(id) ?? id);
};

export const backupModelConfigPath = (source: AgentBackupSource) =>
  source === "openclaw" ? "openclaw.json" : "config.yaml";

export function backupModelLabel(model: AgentBackupModel | "unavailable" | undefined) {
  return model && model !== "unavailable" ? `${model.provider}/${model.modelId}` : null;
}

/** Config data stays on the device. A provider endpoint override requires a separate setup. */
export function projectBackupModel(
  source: AgentBackupSource,
  content: string | undefined,
  selectedAgent: string | null,
): AgentBackupModel | "unavailable" | undefined {
  if (content === undefined) return undefined;
  try {
    const parsed = parseConfig(source, content);
    if (!validConfig(parsed)) return "unavailable";
    const config = record(parsed);
    if (Object.hasOwn(config, "$include")) return "unavailable";
    let provider: string;
    let modelId: string;
    if (source === "hermes") {
      const model = record(config.model);
      if (!Object.hasOwn(config, "model")) return undefined;
      if (hasEndpoint(model) || hasEndpoint(config)) return "unavailable";
      provider = text(model.provider);
      modelId = text(model.default) || text(model.model);
      const overrides = [
        ...Object.entries(record(config.providers)),
        ...(Array.isArray(config.custom_providers)
          ? config.custom_providers.map((entry) => [text(record(entry).name), entry] as const)
          : []),
      ];
      if (
        overrides.some(
          ([name, entry]) =>
            providerId(source, name) === providerId(source, provider) &&
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
        Object.entries(providers).some(
          ([name, entry]) =>
            providerId(source, name) === providerId(source, provider) && hasEndpoint(record(entry)),
        )
      )
        return "unavailable";
    }
    if (
      [provider, modelId].some((value) => redactSecretText(value) !== value || /:\/\//.test(value))
    )
      return "unavailable";
    const result = AgentBackupModelSchema.safeParse({
      provider: providerId(source, provider),
      modelId,
    });
    return result.success ? result.data : "unavailable";
  } catch {
    return "unavailable";
  }
}

function parseConfig(source: AgentBackupSource, content: string): unknown {
  const input = content.replace(/^\uFEFF/, "");
  if (source === "openclaw") return JSON5.parse(input);
  const document = parseDocument(input, { schema: "core", logLevel: "silent" });
  if (document.errors.length || document.warnings.length)
    throw new Error("Invalid backup settings");
  return document.toJS({ maxAliasCount: 20 });
}

function validConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let remaining = 20_000;
  function visit(node: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 32) return false;
    if (!node || typeof node !== "object") return true;
    return Object.entries(node).every(
      ([key, child]) =>
        !["__proto__", "constructor", "prototype", "$include"].includes(key) &&
        visit(child, depth + 1),
    );
  }
  return visit(value, 0);
}

function hasEndpoint(value: Record<string, unknown>) {
  return ["baseUrl", "base_url", "endpoint", "api_base", "apiBase", "url"].some((key) =>
    hasOverride(own(value, key)),
  );
}

const hasOverride = (value: unknown) =>
  value !== undefined && value !== null && (typeof value !== "string" || Boolean(value.trim()));
