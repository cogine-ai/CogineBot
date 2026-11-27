import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DISCOVERED_MODEL_LIMITS } from "@rakazo/contracts";

/** Models endpoints often mix chat models with tools and media endpoints. */
export function isChatModelId(id: string): boolean {
  return (
    /^[\x21-\x7e]{1,1024}$/.test(id) &&
    !/(embed|(?:^|[-/_])tts(?:[-/_]|$)|whisper|transcrib|audio|realtime|dall-e|gpt-image|imagen|moderation|rerank|stable-diffusion|\bflux\b|image|text-to-speech|speech-to-text|\bsora\b|\bveo\b|video|\bocr\b|davinci|babbage|turbo-instruct|computer-use)/i.test(
      id,
    )
  );
}

const providerCatalogBaseUrl = "https://api.openai.com/v1";

export function isOfficialResponsesModel(model: Pick<Model<Api>, "provider" | "api" | "baseUrl">) {
  return (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl === providerCatalogBaseUrl
  );
}

export function isOfficialXaiResponsesProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "xai" &&
    model.api === "openai-responses" &&
    model.baseUrl === "https://api.x.ai/v1" &&
    isChatModelId(model.id)
  );
}

export function isOfficialChatCompletionProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  if (model.api !== "openai-completions" || !isChatModelId(model.id)) return false;
  if (model.provider === "openrouter") return model.baseUrl === "https://openrouter.ai/api/v1";
  if (model.provider === "deepseek") return model.baseUrl === "https://api.deepseek.com";
  return (
    model.provider === "groq" &&
    model.baseUrl === "https://api.groq.com/openai/v1" &&
    model.id !== "openai/gpt-oss-safeguard-20b"
  );
}

export function isOfficialAnthropicProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl">,
) {
  return (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    model.baseUrl === "https://api.anthropic.com"
  );
}

export function isOfficialGeminiProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "google" &&
    model.api === "google-generative-ai" &&
    model.baseUrl === "https://generativelanguage.googleapis.com/v1beta" &&
    model.id.startsWith("gemini-") &&
    isChatModelId(model.id) &&
    !/-(?:live|customtools)(?:-|$)/.test(model.id)
  );
}

const catalogModels = builtinModels();

/** The supported catalog and runtime must share the official Responses route. */
export function providerCatalogModel(
  provider: string,
  id: string,
  models: Models = catalogModels,
): Model<"openai-responses"> | undefined {
  if (
    provider !== "openai" ||
    !/^gpt-[a-z0-9][a-z0-9._-]{0,507}$/i.test(id) ||
    /^gpt-live(?:-|$)/i.test(id) ||
    !isChatModelId(id)
  )
    return undefined;
  const siblings = models.getProvider(provider)?.getModels();
  if (!siblings?.length || siblings.some((model) => !isOfficialResponsesModel(model)))
    return undefined;
  // The list endpoint only establishes availability for this key. It provides
  // no evidence about context, modalities, reasoning, or pricing.
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: providerCatalogBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...DISCOVERED_MODEL_LIMITS,
  };
}

/**
 * The account catalog's image answer replaces whatever modalities were guessed.
 * An absent answer leaves them alone, including the text-only cross-family fallback.
 */
export function withLiveImageInput(
  model: Model<Api>,
  supportsImages: boolean | undefined,
): Model<Api> {
  if (supportsImages === undefined) return model;
  const input: Model<Api>["input"] = supportsImages ? ["text", "image"] : ["text"];
  if (
    model.input.length === input.length &&
    input.every((modality, index) => model.input[index] === modality)
  ) {
    return model;
  }
  return { ...model, input };
}

/** Unknown catalog models use the capabilities saved for their own connection. */
export function withModelCapabilities(
  model: Model<Api>,
  settings: { acceptsImages?: boolean; reasoning?: boolean },
): Model<Api> {
  const withImages = withLiveImageInput(model, settings.acceptsImages);
  if (settings.reasoning === undefined || settings.reasoning === withImages.reasoning)
    return withImages;
  return { ...withImages, reasoning: settings.reasoning };
}

/** A deterministic fallback shared by listing and execution; never changes provider or host. */
export function liveModelSibling(
  models: Models,
  provider: string,
  id: string,
): Model<Api> | undefined {
  if (!isChatModelId(id)) return undefined;
  const siblings =
    models
      .getProvider?.(provider)
      ?.getModels()
      .filter((model) =>
        ["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api),
      ) ?? [];
  const urls = new Set(siblings.map((model) => model.baseUrl));
  if (urls.size !== 1 || siblings.length === 0) return undefined;
  const url = new URL(siblings[0]!.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || /[{}]/.test(url.href))
    return undefined;
  const prefixLength = (other: string) => {
    let n = 0;
    while (n < id.length && id[n] === other[n]) n++;
    return n;
  };
  const sibling = [...siblings].sort((a, b) => prefixLength(b.id) - prefixLength(a.id))[0]!;
  // Only a date/alias variant proves the same family and its capabilities.
  const family = (value: string) => value.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{4,8}|latest)$/, "");
  const sameFamily = family(id) === family(sibling.id);
  return {
    ...sibling,
    id,
    name: id,
    reasoning: sameFamily && sibling.reasoning,
    input: sameFamily ? [...sibling.input] : ["text"],
    // An unrelated sibling's window says nothing about this model's.
    contextWindow: sameFamily ? sibling.contextWindow : DEFAULT_MODEL_CONTEXT_WINDOW,
  };
}
