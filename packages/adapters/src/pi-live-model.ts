import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DISCOVERED_MODEL_LIMITS } from "@rakazo/contracts";
import { GEMINI_API_BASE_URL } from "./gemini-model-api.js";
import { OPENROUTER_API_BASE_URL } from "./openrouter-model-api.js";

/** Models endpoints often mix chat models with tools and media endpoints. */
export function isChatModelId(id: string): boolean {
  return (
    /^[\x21-\x7e]{1,1024}$/.test(id) &&
    !/(embed|(?:^|[-/_])tts(?:[-/_]|$)|whisper|transcrib|audio|realtime|dall-e|gpt-image|imagen|moderation|rerank|stable-diffusion|\bflux\b|image|text-to-speech|speech-to-text|\bsora\b|\bveo\b|video|\bocr\b|davinci|babbage|turbo-instruct|computer-use)/i.test(
      id,
    )
  );
}

const openAiResponsesBaseUrl = "https://api.openai.com/v1";
const codexBaseUrl = "https://chatgpt.com/backend-api";
const xaiResponsesBaseUrl = "https://api.x.ai/v1";
const deepseekCompletionsBaseUrl = "https://api.deepseek.com";
const groqCompletionsBaseUrl = "https://api.groq.com/openai/v1";
const nativeChatProbeBaseUrls = new Map([
  ["together", "https://api.together.ai/v1"],
  ["cerebras", "https://api.cerebras.ai/v1"],
  ["moonshotai", "https://api.moonshot.ai/v1"],
  ["moonshotai-cn", "https://api.moonshot.cn/v1"],
  ["kimi-coding", "https://api.kimi.com/coding/v1"],
]);
const anthropicMessagesBaseUrl = "https://api.anthropic.com";
const nonChatVariant =
  /(?:^|[/._:-])(?:guard|safeguard|compound|imagine|orpheus|voice|live)(?:[/._:-]|$)/i;

function acceptsGroqModelId(id: string): boolean {
  return (
    id.length <= 512 &&
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(id) &&
    !nonChatVariant.test(id)
  );
}

export function isCodexInferenceProbeModel(
  model: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">,
): boolean {
  return (
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    model.baseUrl === codexBaseUrl &&
    /^gpt-6(?:\.[12])?-(?:astra|sol|luna|terra)$/.test(model.id)
  );
}

/** A chat model listed by the selected subscription has one fixed transport. */
export function codexDirectoryModel(id: string): Model<"openai-codex-responses"> | undefined {
  if (id.length > 512 || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || !isChatModelId(id))
    return undefined;
  return {
    id,
    name: id,
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: codexBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...DISCOVERED_MODEL_LIMITS,
  };
}

export function isOfficialResponsesModel(model: Pick<Model<Api>, "provider" | "api" | "baseUrl">) {
  return (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    model.baseUrl === openAiResponsesBaseUrl
  );
}

export function isOfficialXaiResponsesProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "xai" &&
    model.api === "openai-responses" &&
    model.baseUrl === xaiResponsesBaseUrl &&
    isChatModelId(model.id)
  );
}

export function isOfficialDeepSeekChatCompletionModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "deepseek" &&
    model.api === "openai-completions" &&
    model.baseUrl === deepseekCompletionsBaseUrl &&
    isChatModelId(model.id)
  );
}

export function isOfficialChatCompletionProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  if (model.provider === "deepseek") return isOfficialDeepSeekChatCompletionModel(model);
  if (model.api !== "openai-completions" || !isChatModelId(model.id)) return false;
  if (model.provider === "openrouter") return model.baseUrl === OPENROUTER_API_BASE_URL;
  return (
    model.provider === "groq" &&
    model.baseUrl === groqCompletionsBaseUrl &&
    acceptsGroqModelId(model.id)
  );
}

export function isOfficialNativeChatProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.api === "openai-completions" &&
    isChatModelId(model.id) &&
    model.baseUrl === nativeChatProbeBaseUrls.get(model.provider)
  );
}

export function isOfficialAnthropicProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl">,
) {
  return (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    model.baseUrl === anthropicMessagesBaseUrl
  );
}

export function isOfficialMiniMaxProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "minimax" &&
    model.api === "anthropic-messages" &&
    model.baseUrl === "https://api.minimax.io/anthropic" &&
    model.id === "MiniMax-M3"
  );
}

export function isOfficialFireworksProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "fireworks" &&
    ((model.api === "anthropic-messages" &&
      model.baseUrl === "https://api.fireworks.ai/inference") ||
      (model.api === "openai-completions" &&
        model.baseUrl === "https://api.fireworks.ai/inference/v1")) &&
    /^accounts\/fireworks\/models\/[a-z0-9][a-z0-9-]*$/.test(model.id) &&
    isChatModelId(model.id)
  );
}

const vercelGatewayMessagesProbeIds = new Set([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
  "google/gemini-3-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.5-flash",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "google/gemini-4-argon",
  "openai/gpt-4-turbo",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5.1-thinking",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
  "openai/gpt-6-astra",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-6.2-astra",
  "openai/gpt-6.2-sol",
  "openai/o1",
  "openai/o3",
  "openai/o3-mini",
  "openai/o4-mini",
]);

export function isOfficialVercelGatewayMessagesProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return (
    model.provider === "vercel-ai-gateway" &&
    model.api === "anthropic-messages" &&
    model.baseUrl === "https://ai-gateway.vercel.sh" &&
    (/^anthropic\/claude-(?:haiku|sonnet|opus)-\d+(?:\.\d+)?$/.test(model.id) ||
      vercelGatewayMessagesProbeIds.has(model.id))
  );
}

export function isOpenRouterMessagesModel(model: Pick<Model<Api>, "provider" | "api" | "baseUrl">) {
  return (
    model.provider === "openrouter" &&
    model.api === "anthropic-messages" &&
    model.baseUrl === "https://openrouter.ai/api"
  );
}

/** Claude 4.5 aliases address the same model family as their dated snapshots. */
export function anthropicModelAlias(id: string): string | undefined {
  return /^(claude-(?:haiku|sonnet|opus)-4-5)-\d{8}$/.exec(id)?.[1];
}

/** Preserve selectable aliases when the official list returns only dated snapshots. */
export function withCatalogModelAliases(provider: string, ids: string[]): string[] {
  if (provider !== "anthropic") return ids;
  const choices = new Set(ids);
  for (const id of ids) {
    const alias = anthropicModelAlias(id);
    if (alias) choices.add(alias);
  }
  return [...choices];
}

export function isOfficialGeminiModel(model: Pick<Model<Api>, "provider" | "api" | "baseUrl">) {
  return (
    model.provider === "google" &&
    model.api === "google-generative-ai" &&
    model.baseUrl === GEMINI_API_BASE_URL
  );
}

function acceptsGeminiModelId(id: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9._-]{0,504}$/.test(id) && !/-(?:live|customtools)(?:-|$)/.test(id);
}

export function isOfficialGeminiProbeModel(
  model: Pick<Model<Api>, "provider" | "api" | "baseUrl" | "id">,
) {
  return isOfficialGeminiModel(model) && acceptsGeminiModelId(model.id) && isChatModelId(model.id);
}

const catalogModels = builtinModels();

type CatalogRoute = {
  api: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
  baseUrl: string;
  acceptsId: (id: string) => boolean;
  compat?: Model<"openai-completions">["compat"];
};

const catalogRoutes = new Map<string, CatalogRoute>([
  [
    "openai",
    {
      api: "openai-responses",
      baseUrl: openAiResponsesBaseUrl,
      acceptsId: (id) =>
        /^gpt-[a-z0-9][a-z0-9._-]{0,507}$/i.test(id) && !/^gpt-live(?:-|$)/i.test(id),
    },
  ],
  [
    "xai",
    {
      api: "openai-responses",
      baseUrl: xaiResponsesBaseUrl,
      acceptsId: (id) =>
        /^grok-[a-z0-9][a-z0-9._-]{0,506}$/i.test(id) &&
        !/[-._](?:imagine|voice|live)(?:[-._]|$)/i.test(id),
    },
  ],
  [
    "deepseek",
    {
      api: "openai-completions",
      baseUrl: deepseekCompletionsBaseUrl,
      acceptsId: (id) =>
        /^deepseek-[a-z0-9][a-z0-9._-]{0,502}$/i.test(id) &&
        !/[-._](?:voice|live)(?:[-._]|$)/i.test(id),
    },
  ],
  [
    "groq",
    {
      api: "openai-completions",
      baseUrl: groqCompletionsBaseUrl,
      acceptsId: acceptsGroqModelId,
      // The Chat Completions endpoint does not support the OpenAI store option.
      compat: { supportsStore: false },
    },
  ],
  [
    "openrouter",
    {
      api: "openai-completions",
      baseUrl: OPENROUTER_API_BASE_URL,
      acceptsId: (id) =>
        id.length <= 256 &&
        /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(id) &&
        !/^openrouter\/(?:auto(?:-[a-z0-9.-]+)?|free)(?::|$)/i.test(id) &&
        !nonChatVariant.test(id) &&
        !/:(?:batch|online)$/i.test(id),
      compat: { supportsStore: false },
    },
  ],
  [
    "anthropic",
    {
      api: "anthropic-messages",
      baseUrl: anthropicMessagesBaseUrl,
      acceptsId: (id) => /^claude-[a-z0-9][a-z0-9-]{0,504}$/i.test(id),
    },
  ],
  [
    "google",
    {
      api: "google-generative-ai",
      baseUrl: GEMINI_API_BASE_URL,
      acceptsId: acceptsGeminiModelId,
    },
  ],
]);

function providerCatalogRoute(provider: string, models: Models): CatalogRoute | undefined {
  const route = catalogRoutes.get(provider);
  if (!route) return undefined;
  const registered = models.getProvider(provider)?.getModels();
  // Built-in OpenRouter Claude models use its native Messages route. Keep their
  // registration and require the remaining siblings to use the official Chat route.
  const siblings =
    provider === "openrouter"
      ? registered?.filter((model) => !isOpenRouterMessagesModel(model))
      : registered;
  if (
    !siblings?.length ||
    siblings.some(
      (model) =>
        model.provider !== provider || model.api !== route.api || model.baseUrl !== route.baseUrl,
    )
  )
    return undefined;
  return route;
}

export function supportsProviderCatalogModels(provider: string): boolean {
  return providerCatalogRoute(provider, catalogModels) !== undefined;
}

/** The supported catalog and runtime must share the official provider route. */
export function providerCatalogModel(
  provider: string,
  id: string,
  models: Models = catalogModels,
): Model<CatalogRoute["api"]> | undefined {
  if (!isChatModelId(id)) return undefined;
  const route = providerCatalogRoute(provider, models);
  if (!route?.acceptsId(id)) return undefined;
  // The directory reader retains only IDs. Use conservative limits until
  // context, modalities, reasoning, and pricing have been verified separately.
  return {
    id,
    name: id,
    provider,
    api: route.api,
    baseUrl: route.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(route.compat ? { compat: route.compat } : {}),
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
