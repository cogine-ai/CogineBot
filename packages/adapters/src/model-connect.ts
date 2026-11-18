import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ModelConnectInput,
  ModelCredential,
  ModelSettings,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  assertHeaderSafeApiKey,
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT,
  cloudflareGatewayRouting,
  isCloudflareAiGatewayProvider,
  MAX_ENABLED_MODEL_IDS,
  modelOutputLeavesInputRoom,
  normalizeOpenAiCompatibleBaseUrl,
  sameOpenAiCompatibleBaseUrl,
} from "@rakazo/contracts";
import { clampCatalogThinkingLevel } from "@rakazo/core";
import { enabledOpenAiCompatibleModelIds } from "./model-selection.js";
import { connectionModelSettings } from "./model-settings.js";
import { modelIdSupportsImages, updateModelImageCapabilities } from "./model-vision.js";
import { modelCredentialAuthKind } from "./pi-catalog-availability.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import {
  CHATGPT_OAUTH_PROVIDER,
  ModelConnectionConfigurationError,
  parseModelSecret,
  parseStoredModelSettings,
  serializeModelSecret,
} from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleModel,
  openAiCompatibleVisionModelIds,
  prepareOpenAiCompatibleConnect,
} from "./pi-openai-compatible-provider.js";

export type BuildModelConnectOptions = {
  /** Skip writing visionModelIds when prior plaintext was unavailable during key replacement. */
  omitVisionModelIds?: boolean;
};

export function buildModelConnectPlaintext(
  input: ModelConnectInput,
  previousPlaintext?: string,
  options?: BuildModelConnectOptions,
): string {
  const endpointChanged = changedCompatibleEndpoint(input, previousPlaintext);
  const previous = tryParseModelSecret(endpointChanged ? undefined : previousPlaintext);
  const previousModels = endpointChanged
    ? parseStoredModelSettings(JSON.parse(previousPlaintext!).models).models
    : previous?.models;
  const inherited = previous?.kind === "api_key" ? previous : undefined;
  const cacheCapabilities = input.cacheCapabilities ?? inherited?.cacheCapabilities;
  const contextWindow = input.contextWindow ?? inherited?.contextWindow;
  const limits = {
    ...(cacheCapabilities !== undefined ? { cacheCapabilities } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    assertHeaderSafeApiKey(prepared.apiKey);
    const sameEndpoint =
      previous?.kind === "openai_compatible" &&
      sameOpenAiCompatibleBaseUrl(previous.baseUrl, prepared.baseUrl);
    const compatiblePrevious = sameEndpoint ? previous : undefined;
    if (input.apiKey === undefined && sameEndpoint) {
      // Revalidate the inherited key too: public endpoints must still use HTTPS.
      prepared.apiKey = prepareOpenAiCompatibleConnect({
        ...input,
        apiKey: previous.apiKey,
      }).apiKey;
    }
    const headers = input.headers ?? compatiblePrevious?.headers;
    const apiProtocol = input.apiProtocol ?? compatiblePrevious?.apiProtocol;
    prepareOpenAiCompatibleConnect({
      ...input,
      apiKey: prepared.apiKey,
      headers,
      apiProtocol,
    });
    const previousVisionModelIds = sameEndpoint ? previous.visionModelIds : undefined;
    const maxImagesPerPrompt =
      input.maxImagesPerPrompt === null
        ? undefined
        : (input.maxImagesPerPrompt ?? (sameEndpoint ? previous.maxImagesPerPrompt : undefined));
    const reasoning = input.reasoning ?? compatiblePrevious?.reasoning;
    const modelReasoning =
      previousModels && Object.hasOwn(previousModels, prepared.modelId)
        ? previousModels[prepared.modelId]?.reasoning
        : reasoning;
    let thinkingLevel =
      input.thinkingLevel !== undefined
        ? input.thinkingLevel
        : sameEndpoint
          ? previous.thinkingLevel
          : undefined;
    const maxTokens = connectMaxTokens(
      input.maxTokens,
      sameEndpoint ? previous.maxTokens : undefined,
    );
    const contextWindow =
      input.contextWindow !== undefined
        ? input.contextWindow
        : sameEndpoint
          ? previous.contextWindow
          : undefined;
    if (
      apiProtocol === "anthropic-messages" &&
      (input.thinkingLevel !== undefined || modelReasoning) &&
      thinkingLevel !== undefined &&
      thinkingLevel !== null &&
      thinkingLevel !== "off"
    ) {
      thinkingLevel = clampCatalogThinkingLevel(
        thinkingLevel,
        getSupportedThinkingLevels(
          openAiCompatibleModel(
            prepared.modelId,
            prepared.baseUrl,
            modelReasoning,
            false,
            undefined,
            undefined,
            apiProtocol,
          ),
        ),
      ) as ThinkingLevel | null;
    }
    if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
      throw new Error("Maximum output tokens must leave room for input");
    }
    const visionModelIds = updateModelImageCapabilities(
      previousVisionModelIds,
      prepared.modelId,
      input.supportsImages,
    );
    const includeVisionModelIds =
      !options?.omitVisionModelIds &&
      (input.supportsImages !== undefined || previousVisionModelIds !== undefined);
    const enabledModelIds = enabledOpenAiCompatibleModelIds(
      {
        kind: "openai_compatible",
        baseUrl: prepared.baseUrl,
        enabledModelIds: input.enabledModelIds ?? compatiblePrevious?.enabledModelIds,
      },
      prepared.modelId,
    );
    if (enabledModelIds.length > MAX_ENABLED_MODEL_IDS) {
      throw new Error(`Enable at most ${MAX_ENABLED_MODEL_IDS} models`);
    }
    const compatibleCacheCapabilities =
      input.cacheCapabilities ?? compatiblePrevious?.cacheCapabilities;
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
      ...(apiProtocol !== undefined ? { apiProtocol } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(compatibleCacheCapabilities !== undefined
        ? { cacheCapabilities: compatibleCacheCapabilities }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
      ...(includeVisionModelIds ? { visionModelIds } : {}),
      enabledModelIds,
      ...(maxImagesPerPrompt !== undefined ? { maxImagesPerPrompt } : {}),
      ...keptCompatibleModels(previousModels, enabledModelIds),
    };
    return serializeModelSecret(secret);
  }
  const apiKey = input.apiKey?.trim();
  // The Codex transport authenticates with the OAuth JWT from ChatGPT sign-in,
  // which carries the chatgpt account id it requires. A plain API key can never
  // work there, so reject it instead of persisting a credential that only fails
  // at request time.
  if (input.provider === CHATGPT_OAUTH_PROVIDER && apiKey) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  const maxTokens = connectMaxTokens(input.maxTokens, previous?.maxTokens);
  if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
    throw new Error("Maximum output tokens must leave room for input");
  }
  const routing = cloudflareRoutingForConnect(input, previous);
  if (apiKey) {
    if (apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
    assertHeaderSafeApiKey(apiKey);
    return serializeModelSecret({
      kind: "api_key",
      key: apiKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
      ...(previousModels ? { models: previousModels } : {}),
    });
  }
  if (previous?.kind === "api_key" && previous.key.trim().length >= 8) {
    if (input.provider === CHATGPT_OAUTH_PROVIDER) {
      throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
    }
    return serializeModelSecret({
      kind: "api_key",
      key: previous.key,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
      ...(previousModels ? { models: previousModels } : {}),
    });
  }
  if (previous?.kind === "oauth") {
    return serializeModelSecret({
      kind: "oauth",
      credential: previous.credential,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(previousModels ? { models: previousModels } : {}),
    });
  }
  if (input.provider === CHATGPT_OAUTH_PROVIDER) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  throw new Error("API key must contain at least 8 characters");
}

function keptCompatibleModels(
  models: Record<string, ModelSettings> | undefined,
  enabledModelIds: readonly string[],
): { models?: Record<string, ModelSettings> } {
  if (!models) return {};
  const kept = Object.fromEntries(
    Object.entries(models).filter(([modelId]) => enabledModelIds.includes(modelId)),
  );
  return Object.keys(kept).length > 0 ? { models: kept } : {};
}

const CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE =
  "ChatGPT subscription sign-in is required for this provider.";

/** A new endpoint with an explicit key cannot inherit the previous endpoint's configuration. */
function changedCompatibleEndpoint(input: ModelConnectInput, plaintext?: string): boolean {
  if (input.provider !== OPENAI_COMPATIBLE_PROVIDER_ID || input.apiKey === undefined || !plaintext)
    return false;
  try {
    const previous: unknown = JSON.parse(plaintext);
    if (
      !previous ||
      typeof previous !== "object" ||
      !("kind" in previous) ||
      previous.kind !== "openai_compatible" ||
      !("baseUrl" in previous) ||
      typeof previous.baseUrl !== "string"
    )
      return false;
    // Compare only endpoint identity before parsing fields a newer client may own.
    return (
      normalizeOpenAiCompatibleBaseUrl(previous.baseUrl) !==
      normalizeOpenAiCompatibleBaseUrl(input.baseUrl ?? "")
    );
  } catch {
    return false;
  }
}

/** Unreadable legacy keys remain replaceable; recognized future configurations do not. */
function tryParseModelSecret(plaintext?: string): StoredModelSecret | undefined {
  if (!plaintext) return undefined;
  try {
    return parseModelSecret(plaintext);
  } catch (error) {
    if (error instanceof ModelConnectionConfigurationError) throw error;
    return undefined;
  }
}

/**
 * Cloudflare AI Gateway routing is part of the saved key. Omitted fields keep
 * the previous connection's ids; a blank or unsafe value is rejected.
 */
function cloudflareRoutingForConnect(
  input: ModelConnectInput,
  previous: ReturnType<typeof tryParseModelSecret>,
): { accountId: string; gatewayId: string } | undefined {
  if (!isCloudflareAiGatewayProvider(input.provider)) return undefined;
  const accountId =
    input.accountId !== undefined
      ? input.accountId
      : previous?.kind === "api_key"
        ? previous.accountId
        : undefined;
  const gatewayId =
    input.gatewayId !== undefined
      ? input.gatewayId
      : previous?.kind === "api_key"
        ? previous.gatewayId
        : undefined;
  const routing = cloudflareGatewayRouting({ accountId, gatewayId });
  if (!routing) throw new Error(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  return routing;
}

/**
 * Whether the stored secret contains an API key. OAuth sign-in and a keyless
 * OpenAI-compatible server are connections without one. An unreadable secret
 * is not reported as a key — the client must not invent a stored-key state.
 */
function storedModelSecretHasApiKey(plaintext: string | undefined): boolean {
  if (!plaintext) return false;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind === "api_key") return parsed.key.trim().length > 0;
  if (parsed.kind === "openai_compatible") return Boolean(parsed.apiKey?.trim());
  return false;
}

/** `null` clears a saved limit. Omitting it keeps the previous connection's limit. */
function connectMaxTokens(
  input: number | null | undefined,
  previous: number | undefined,
): number | undefined {
  if (input === null) return undefined;
  if (input !== undefined) return input;
  return previous;
}

/** The efforts an OpenAI-compatible model offers: its endpoint's, once it is set to think. */
export function compatibleModelThinkingLevels(
  secret: Extract<StoredModelSecret, { kind: "openai_compatible" }>,
  modelId: string,
  row?: { supportsImages?: boolean; defaultModel?: string | null },
): ThinkingLevel[] {
  return getSupportedThinkingLevels(
    openAiCompatibleModel(
      modelId,
      secret.baseUrl,
      connectionModelSettings(secret, CONTRACT_OPENAI_COMPAT, modelId, row).reasoning,
      false,
      undefined,
      undefined,
      secret.apiProtocol,
    ),
  ) as ThinkingLevel[];
}

export function modelCredentialDto(
  row: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    defaultModel?: string | null;
    thinkingLevel?: string | null;
    supportsImages?: boolean;
    connectionRevision?: number;
  },
  plaintext?: string,
): ModelCredential {
  const credential: ModelCredential = {
    id: row.id,
    provider: row.provider,
    label: row.label,
    hasKey: storedModelSecretHasApiKey(plaintext),
    isDefault: row.isDefault,
    connectionRevision: row.connectionRevision ?? 1,
    ...(row.defaultModel ? { modelId: row.defaultModel } : {}),
    // Space-scoped effort stored beside the preference's modelId; the
    // openai-compatible secret may still contribute below when unset.
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel as ThinkingLevel } : {}),
  };
  if (row.provider !== CONTRACT_OPENAI_COMPAT) {
    if (!plaintext) return credential;
    const parsed = parseModelSecret(plaintext);
    return {
      ...credential,
      authKind: modelCredentialAuthKind(parsed),
      ...(parsed.models ? { modelSettings: parsed.models } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
      ...(parsed.kind !== "oauth"
        ? {
            cacheCapabilities: parsed.cacheCapabilities,
            contextWindow: parsed.contextWindow,
          }
        : {}),
      ...(parsed.kind === "api_key" && parsed.accountId ? { accountId: parsed.accountId } : {}),
      ...(parsed.kind === "api_key" && parsed.gatewayId ? { gatewayId: parsed.gatewayId } : {}),
    };
  }
  const compatibleCredential = {
    ...credential,
    supportsImages: row.supportsImages ?? false,
  };
  if (!plaintext) return compatibleCredential;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind !== "openai_compatible") {
    return { ...compatibleCredential, authKind: modelCredentialAuthKind(parsed) };
  }
  return {
    ...compatibleCredential,
    authKind: "openai_compatible",
    supportsImages:
      parsed.visionModelIds !== undefined
        ? modelIdSupportsImages(parsed.visionModelIds, row.defaultModel)
        : compatibleCredential.supportsImages,
    baseUrl: parsed.baseUrl,
    ...(parsed.apiProtocol !== undefined ? { apiProtocol: parsed.apiProtocol } : {}),
    ...(parsed.headers !== undefined ? { headerNames: Object.keys(parsed.headers) } : {}),
    reasoning: parsed.reasoning ?? false,
    ...(credential.thinkingLevel !== undefined || parsed.thinkingLevel !== undefined
      ? { thinkingLevel: credential.thinkingLevel ?? parsed.thinkingLevel }
      : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.contextWindow !== undefined ? { contextWindow: parsed.contextWindow } : {}),
    cacheCapabilities: parsed.cacheCapabilities,
    ...(parsed.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: parsed.maxImagesPerPrompt }
      : {}),
    enabledModelIds: enabledOpenAiCompatibleModelIds(parsed, row.defaultModel),
    visionModelIds: enabledOpenAiCompatibleModelIds(parsed, row.defaultModel).filter(
      (id) =>
        connectionModelSettings(parsed, row.provider, id, row).images ??
        openAiCompatibleVisionModelIds().has(id),
    ),
    ...(parsed.models ? { modelSettings: parsed.models } : {}),
    thinkingLevels: compatibleModelThinkingLevels(parsed, row.defaultModel ?? "custom", row),
    modelId: row.defaultModel ?? undefined,
  };
}
