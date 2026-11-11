import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { canonicalPiProviderId } from "@rakazo/contracts";
import {
  CHATGPT_PLAN_CATALOG_MODEL_ID,
  CHATGPT_PLAN_PROVIDER_ID,
  readChatGPTPlanModels,
} from "./chatgpt-plan-provider.js";
import { DEFAULT_OPENROUTER_MODEL_ID } from "./deployment-model.js";
import { supplementPiModels } from "./pi-current-models.js";
import { withLiveImageInput } from "./pi-live-model.js";
import { registerLocalProvider } from "./pi-local-provider.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

/** Computer tools whose results include screenshots for the model. */
export const IMAGE_RETURNING_COMPUTER_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "open_path",
  "launch_app",
]);

export const MODEL_CANNOT_SEE_MESSAGE = "This bot's model cannot see; pick a vision-capable model.";

/** Return whether a model id is explicitly enabled for image input on a connection. */
export function modelIdSupportsImages(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
): boolean {
  const normalizedModelId = modelId?.trim();
  return Boolean(
    normalizedModelId && modelIds?.some((candidate) => candidate.trim() === normalizedModelId),
  );
}

/** Resolve capability metadata bound to this connection rather than another account. */
export function connectionModelImageInput(
  provider: string,
  modelId: string,
  credential: { supportsImages?: boolean; defaultModel?: string | null },
  secret: StoredModelSecret,
): boolean | undefined {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID && secret.kind === "openai_compatible") {
    if (secret.visionModelIds !== undefined)
      return modelIdSupportsImages(secret.visionModelIds, modelId);
    return credential.supportsImages === true && credential.defaultModel?.trim() === modelId.trim()
      ? true
      : undefined;
  }
  if (provider === CHATGPT_PLAN_PROVIDER_ID && secret.kind === "oauth") {
    return readChatGPTPlanModels(secret.credential)
      .find((model) => model.id === modelId)
      ?.input?.includes("image");
  }
  return undefined;
}

/** Update the explicit per-model image capability without disturbing other model ids. */
export function updateModelImageCapabilities(
  modelIds: readonly string[] | undefined,
  modelId: string | null | undefined,
  supportsImages: boolean | undefined,
): string[] {
  const next = new Set(
    (modelIds ?? [])
      .map((candidate) => candidate.trim())
      .filter((candidate) => candidate.length > 0),
  );
  const normalizedModelId = modelId?.trim();
  if (normalizedModelId && supportsImages !== undefined) {
    if (supportsImages) next.add(normalizedModelId);
    else next.delete(normalizedModelId);
  }
  return [...next];
}

let catalogModelsCache: Models | undefined;

function catalogModels(): Models {
  // Same catalog the runtime calls, including models added ahead of the bundled library.
  catalogModelsCache ??= registerOpenAiCompatibleCatalog(
    registerLocalProvider(supplementPiModels(builtinModels())),
  );
  return catalogModelsCache;
}

/**
 * Mirror Pi's scripted placeholder resolution so vision checks use the same
 * model the runtime will actually call.
 */
export function resolveModelRefForVisionCheck(
  provider: string,
  modelId: string,
): { provider: string; id: string } {
  const normalizedProvider = canonicalPiProviderId(provider.trim());
  const normalizedId = modelId.trim();
  if (normalizedProvider === "scripted" || normalizedId === "scripted") {
    return {
      provider: "openrouter",
      id: process.env.PI_DEFAULT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL_ID,
    };
  }
  return { provider: normalizedProvider, id: normalizedId };
}

/**
 * Whether the selected model accepts image input, per the Pi model catalog's
 * declared `input` modalities. Unknown models are treated as text-only.
 * The `scripted` placeholder is resolved the same way Pi does (env default /
 * GPT-5.6 Luna fallback) before the catalog check. An explicit connection capability
 * override is honored for OpenAI-compatible models and authenticated ChatGPT catalogs.
 */
export function modelAcceptsImageInput(
  provider: string,
  modelId: string,
  acceptsImages?: boolean,
): boolean {
  if (provider.trim() === CHATGPT_PLAN_PROVIDER_ID) {
    return Boolean(
      acceptsImages && modelId.trim() && modelId.trim() !== CHATGPT_PLAN_CATALOG_MODEL_ID,
    );
  }
  const resolved = resolveModelRefForVisionCheck(provider, modelId);
  if (!resolved.provider || !resolved.id) return false;
  if (resolved.provider === OPENAI_COMPATIBLE_PROVIDER_ID && acceptsImages !== undefined)
    return acceptsImages;

  let model = catalogModelWithOpenRouterFallback(catalogModels(), resolved.provider, resolved.id);
  if (model && resolved.provider === CHATGPT_OAUTH_PROVIDER)
    model = withLiveImageInput(model, acceptsImages);
  return Boolean(model?.input.includes("image"));
}

export function filterImageReturningComputerTools<T extends { name: string }>(
  tools: T[],
  acceptsImages: boolean,
): T[] {
  if (acceptsImages) return tools;
  return tools.filter((tool) => !IMAGE_RETURNING_COMPUTER_TOOLS.has(tool.name));
}

export function catalogModelWithOpenRouterFallback(models: Models, provider: string, id: string) {
  let model = models.getModel(provider, id);
  if (
    !model &&
    provider !== "openrouter" &&
    provider !== OPENAI_COMPATIBLE_PROVIDER_ID &&
    provider !== CHATGPT_PLAN_PROVIDER_ID
  ) {
    model = models.getModel("openrouter", id);
  }
  return model;
}

/** Attachment admission distinguishes missing capability evidence from a text-only model. */
export function knownModelImageInput(provider: string, modelId: string): boolean | undefined {
  const resolved = resolveModelRefForVisionCheck(provider, modelId);
  if ([OPENAI_COMPATIBLE_PROVIDER_ID, CHATGPT_PLAN_PROVIDER_ID].includes(resolved.provider))
    return undefined;
  const model = catalogModelWithOpenRouterFallback(catalogModels(), resolved.provider, resolved.id);
  return model ? model.input.includes("image") : undefined;
}
