import type { AgentBackupSource } from "@rakazo/contracts";
import { assertHeaderSafeApiKey } from "@rakazo/contracts";
import { readBackupAuth, readBackupConfig } from "./config.js";
import { backupProviderId, projectBackupModel } from "./model.js";

const providers = {
  anthropic: {
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
    endpoints: ["https://api.anthropic.com"],
  },
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
  // Match dotenv assignments without loading its Node filesystem entry point on clients.
  const assignment =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;
  for (const [, name, raw = ""] of (content ?? "").replace(/\r\n?/g, "\n").matchAll(assignment)) {
    const value = raw.trim();
    const quote = value[0];
    const unquoted = value.replace(/^(['"`])([\s\S]*)\1$/, "$2");
    values.set(
      name!,
      quote === '"' ? unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : unquoted,
    );
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
  const names =
    source === "hermes" && provider === "google"
      ? ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
      : providers[provider].env;
  const endpointNames = names.map((name) => name.replace(/_(API_KEY|TOKEN)$/, "_BASE_URL"));
  const config = files.config === undefined ? {} : readBackupConfig(source, files.config);
  if (!config) return undefined;
  const model = record(config.model);
  const projected = source === "hermes" ? projectBackupModel(source, config, null) : undefined;
  const hermesProvider =
    projected && projected !== "unavailable"
      ? projected.provider
      : backupProviderId(source, text(model.provider || config.provider));
  const configured =
    source === "openclaw" ? record(record(config.models).providers) : config.providers;
  const matching = [
    ...Object.entries(record(configured)),
    ...(source === "hermes" && Array.isArray(config.custom_providers)
      ? config.custom_providers.map((entry) => [text(record(entry).name), entry] as const)
      : []),
    ...(source === "hermes" ? [[hermesProvider, model] as const] : []),
  ].flatMap(([id, entry]) => (backupProviderId(source, id) === provider ? [record(entry)] : []));
  if (matching.some((entry) => hasAlternateEndpoint(entry, endpoints))) return undefined;
  if (
    source === "openclaw" &&
    matching.some(
      (entry) =>
        (entry.auth !== undefined && entry.auth !== "api-key") ||
        // A configured model can be selected through a provider-specific alias.
        (Array.isArray(entry.models) &&
          entry.models.some((row) => hasAlternateEndpoint(record(row), endpoints))),
    )
  )
    return undefined;
  if (
    source === "hermes" &&
    (!hermesProvider || hermesProvider === provider) &&
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
        endpointNames.includes(name) &&
        value.trim() &&
        !endpoints.includes(value.trim().replace(/\/+$/, ""))
      )
        return undefined;
      if (!env.has(name)) env.set(name, value);
    }
  }
  for (const name of endpointNames) {
    const value = env.get(name);
    if (value?.trim() && !endpoints.includes(value.trim().replace(/\/+$/, ""))) return undefined;
  }
  const auth =
    source === "hermes" && files.auth !== undefined ? readBackupAuth(files.auth) : undefined;
  if (auth === null) return undefined;
  const entries = Object.entries(record(auth?.credential_pool)).flatMap(([id, rows]) =>
    backupProviderId(source, id) === provider && Array.isArray(rows) ? rows.map(record) : [],
  );
  // The pool can route the same provider id through a different host or auth flow.
  if (entries.some((entry) => hasAlternateEndpoint(entry, endpoints))) return undefined;
  const keyEnv =
    source === "hermes" && hermesProvider === provider
      ? text(model.key_env || model.api_key_env)
      : "";
  const readKey = (value: unknown) => {
    const key = resolveKey(value, env);
    return provider === "anthropic" && key?.startsWith("sk-ant-oat") ? undefined : key;
  };
  if (keyEnv) return readKey(env.get(keyEnv));
  const configuredKeys = new Set(
    matching.flatMap((entry) =>
      [entry.apiKey, entry.api_key].flatMap((value) => {
        const key = readKey(value);
        return key ? [key] : [];
      }),
    ),
  );
  const envKey = names.map((name) => readKey(env.get(name))).find((key) => key !== undefined);
  // A saved pool can be selected independently of the generic provider fallback.
  for (const entry of entries) {
    if (entry.auth_type !== "api_key" || entry.source !== "manual") continue;
    const key = readKey(entry.access_token);
    if (key) configuredKeys.add(key);
  }
  if (envKey) configuredKeys.add(envKey);
  return configuredKeys.size === 1 ? configuredKeys.values().next().value : undefined;
}
