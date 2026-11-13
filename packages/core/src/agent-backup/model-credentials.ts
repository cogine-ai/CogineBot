import type { AgentBackupSource } from "@rakazo/contracts";
import { assertHeaderSafeApiKey } from "@rakazo/contracts";
import { readBackupConfig } from "./config.js";

const providers = {
  anthropic: { env: ["ANTHROPIC_API_KEY"], endpoints: ["https://api.anthropic.com"] },
  deepseek: {
    env: ["DEEPSEEK_API_KEY"],
    endpoints: ["https://api.deepseek.com", "https://api.deepseek.com/v1"],
  },
  google: {
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    endpoints: ["https://generativelanguage.googleapis.com/v1beta"],
  },
  groq: { env: ["GROQ_API_KEY"], endpoints: ["https://api.groq.com/openai/v1"] },
  openai: { env: ["OPENAI_API_KEY"], endpoints: ["https://api.openai.com/v1"] },
  openrouter: { env: ["OPENROUTER_API_KEY"], endpoints: ["https://openrouter.ai/api/v1"] },
} as const;

type Provider = keyof typeof providers;
export const isBackupModelKeyProvider = (provider: string): provider is Provider =>
  Object.hasOwn(providers, provider);
type Config = Record<string, unknown>;
const record = (value: unknown): Config =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Config) : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function providerId(source: AgentBackupSource, value: unknown) {
  const id = text(value).toLowerCase();
  if (id === "gemini" || id === "google-ai-studio") return "google";
  if (id === "claude") return "anthropic";
  if (source === "hermes" && id === "openai-api") return "openai";
  return id;
}

function hasAlternateEndpoint(entry: Config, endpoints: readonly string[]) {
  return ["baseUrl", "base_url", "runtime_base_url", "endpoint", "api_base", "apiBase", "url"].some(
    (field) => {
      const value = entry[field];
      if (value === undefined || value === null || value === "") return false;
      return !endpoints.includes(text(value).replace(/\/+$/, ""));
    },
  );
}

function parseEnv(content: string | undefined) {
  const values = new Map<string, string>();
  for (const line of (content ?? "").split(/\r?\n/)) {
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!assignment) continue;
    const name = assignment[1]!;
    const raw = assignment[2]!;
    const quoted = /^(['"])(.*?)\1(?:\s*#.*)?$/.exec(raw);
    if (!quoted && /^['"]/.test(raw)) continue;
    values.set(name, quoted?.[2] ?? raw.replace(/\s+#.*$/, ""));
  }
  return values;
}

function resolveKey(value: unknown, env: ReadonlyMap<string, string>): string | undefined {
  const ref = record(value);
  const literal = typeof value === "string" ? value : undefined;
  const envRef = literal?.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
  const key = text(
    envRef
      ? env.get(envRef)
      : ref.source === "env" && typeof ref.id === "string"
        ? env.get(ref.id)
        : literal,
  );
  if (key.length < 8 || key.length > 4096 || /[\x24{}'"<>]/.test(key)) return undefined;
  try {
    assertHeaderSafeApiKey(key);
    return key;
  } catch {
    return undefined;
  }
}

/** Call only after the user opts in. Return the key for one already reviewed provider. */
export function readBackupModelApiKey(
  source: AgentBackupSource,
  provider: string,
  files: { config?: string; env?: string; auth?: string },
): string | undefined {
  if (!isBackupModelKeyProvider(provider)) return undefined;
  const endpoints: readonly string[] = providers[provider].endpoints;
  const names = providers[provider].env;
  const config = files.config === undefined ? {} : readBackupConfig(source, files.config);
  if (!config) return undefined;
  const model = record(config.model);
  const configured =
    source === "openclaw" ? record(record(config.models).providers) : config.providers;
  const matching = [
    ...Object.entries(record(configured)),
    ...(source === "hermes" && Array.isArray(config.custom_providers)
      ? config.custom_providers.map((entry) => [text(record(entry).name), entry] as const)
      : []),
    ...(source === "hermes" ? [[text(model.provider || config.provider), model] as const] : []),
  ].flatMap(([id, entry]) => (providerId(source, id) === provider ? [record(entry)] : []));
  if (matching.some((entry) => hasAlternateEndpoint(entry, endpoints))) return undefined;
  if (
    source === "hermes" &&
    (!text(model.provider || config.provider) ||
      providerId(source, model.provider || config.provider) === provider) &&
    (hasAlternateEndpoint(config, endpoints) || hasAlternateEndpoint(model, endpoints))
  )
    return undefined;

  const env = parseEnv(files.env);
  if (source === "openclaw") {
    for (const [name, value] of Object.entries({
      ...record(config.env),
      ...record(record(config.env).vars),
    })) {
      if (typeof value !== "string") continue;
      if (
        names.some((key) => key.replace(/_API_KEY$/, "_BASE_URL") === name) &&
        value.trim() &&
        !endpoints.includes(value.trim().replace(/\/+$/, ""))
      )
        return undefined;
      if (!env.has(name)) env.set(name, value);
    }
  }
  for (const name of names) {
    const value = env.get(name.replace(/_API_KEY$/, "_BASE_URL"));
    if (value?.trim() && !endpoints.includes(value.trim().replace(/\/+$/, ""))) return undefined;
  }
  const auth = source === "hermes" && files.auth ? readBackupConfig("openclaw", files.auth) : null;
  const entries = Object.entries(record(auth?.credential_pool)).flatMap(([id, rows]) =>
    providerId(source, id) === provider && Array.isArray(rows) ? rows.map(record) : [],
  );
  const keys = [
    ...matching.map((entry) => entry.apiKey ?? entry.api_key),
    ...entries.flatMap((entry) =>
      entry.auth_type === "api_key" &&
      entry.source === "manual" &&
      !hasAlternateEndpoint(entry, endpoints)
        ? [entry.access_token]
        : [],
    ),
    ...names.map((name) => env.get(name)),
  ];
  return keys.map((key) => resolveKey(key, env)).find((key) => key !== undefined);
}
