import type { AgentBackupModel } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { validateModelAuthAvailability } from "./model-selection.js";
import {
  catalogProviderProbeBaseUrl,
  listPiCatalog,
  probeCatalogProviderModels,
} from "./pi-models.js";

const keyChecks = new Map([
  ["anthropic", { url: "https://api.anthropic.com/v1/models", header: "x-api-key" }],
  ["deepseek", { url: "https://api.deepseek.com/models", header: "Authorization" }],
  [
    "google",
    {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      header: "x-goog-api-key",
    },
  ],
  ["openrouter", { url: "https://openrouter.ai/api/v1/key", header: "Authorization" }],
]);
const catalogChecks = new Set(["openai", "groq"]);

export function supportsBackupModelKey(model: AgentBackupModel) {
  return (
    (keyChecks.has(model.provider) ||
      (catalogChecks.has(model.provider) &&
        catalogProviderProbeBaseUrl(model.provider) !== null)) &&
    listPiCatalog().some(
      (entry) =>
        entry.provider === model.provider &&
        entry.id === model.modelId &&
        !entry.placeholder &&
        entry.auth !== "oauth",
    )
  );
}

/** Verify the selected model at its pinned provider before persisting a connection. */
export async function verifyBackupModelKey(
  model: AgentBackupModel,
  apiKey: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string> {
  if (!supportsBackupModelKey(model)) throw new Error("Unsupported backup model");
  if (model.provider === "anthropic" && apiKey.startsWith("sk-ant-oat"))
    throw new Error("The provider requires an API key");
  const plaintext = buildModelConnectPlaintext({ ...model, apiKey });
  if (validateModelAuthAvailability(model.provider, model.modelId, plaintext))
    throw new Error("Unavailable model");
  const check = keyChecks.get(model.provider);
  if (check) {
    const modelLookup = model.provider === "anthropic" || model.provider === "google";
    const probeSignal = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
    const response = await fetcher(
      modelLookup ? `${check.url}/${encodeURIComponent(model.modelId)}` : check.url,
      {
        headers: {
          [check.header]: check.header === "Authorization" ? `Bearer ${apiKey}` : apiKey,
          ...(model.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        redirect: "error",
        signal: probeSignal,
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Provider did not accept the key or the reviewed model");
    }
    if (model.provider === "deepseek") {
      const listing = await readBoundedJsonResponse<{ data?: { id?: string }[] }>(
        response,
        2_000_000,
        probeSignal,
      );
      if (!listing.data?.some(({ id }) => id === model.modelId))
        throw new Error("The key cannot use the reviewed model");
    } else {
      void response.body?.cancel().catch(() => undefined);
    }
  } else {
    const models = await probeCatalogProviderModels(
      { provider: model.provider, apiKey },
      fetcher,
      signal,
    );
    if (!models.includes(model.modelId)) throw new Error("The key cannot use the reviewed model");
  }
  return plaintext;
}
