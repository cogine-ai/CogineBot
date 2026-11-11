import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { Model, MutableModels, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelApiProtocol } from "@rakazo/contracts";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  parseModelHeaders,
} from "@rakazo/contracts";
import { Agent } from "undici";
import {
  modelConnectionErrorMessage,
  registerModelConnectionHeaders,
} from "./model-connection-errors.js";
import { declaredVisionModelIds, inputModalities } from "./model-modalities.js";
import type { ResolveHostname } from "./network-address.js";
import {
  createAddressCheckedLookup,
  isCloudMetadataAddress,
  isLinkLocalAddress,
  isPrivateAddress,
} from "./network-address.js";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./openai-compatible-url.js";
import { MODEL_CONNECT_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { guardToolCallNames } from "./pi-tool-call-guard.js";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

export { OPENAI_COMPATIBLE_PROVIDER_ID };

/** Placeholder catalog model id; users enter the real id when connecting. */
export const OPENAI_COMPATIBLE_CATALOG_MODEL_ID = "custom";

/** Model ids this endpoint serves with vision, declared by the operator. */
export const OPENAI_COMPATIBLE_VISION_MODELS_ENV = "RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS";

export function openAiCompatibleVisionModelIds(): ReadonlySet<string> {
  return declaredVisionModelIds(OPENAI_COMPATIBLE_VISION_MODELS_ENV);
}

const MAX_MODELS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_IDS = 4_000;
/** Pinned catalogs (OpenRouter is ~1 MiB). Custom server URLs stay on the tight caps. */
const CATALOG_MAX_MODELS_RESPONSE_BYTES = 8 * 1024 * 1024;
const CATALOG_MAX_MODEL_IDS = 8_000;
const MAX_MODEL_ID_LENGTH = 256;

function modelsProbeLimits(catalogProbe?: boolean): { maxBytes: number; maxModelIds: number } {
  return catalogProbe
    ? { maxBytes: CATALOG_MAX_MODELS_RESPONSE_BYTES, maxModelIds: CATALOG_MAX_MODEL_IDS }
    : { maxBytes: MAX_MODELS_RESPONSE_BYTES, maxModelIds: MAX_MODEL_IDS };
}

const OPENAI_COMPAT_BASE = "http://127.0.0.1:1/v1";
const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";
const resolveHostname: ResolveHostname = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export function openAiCompatibleModel(
  id: string,
  baseUrl: string,
  reasoning = false,
  acceptsImages = false,
  maxTokens = DEFAULT_MODEL_MAX_TOKENS,
  contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW,
  apiProtocol: ModelApiProtocol = "chat-completions",
): Model<"openai-completions" | "openai-responses" | "anthropic-messages"> {
  return {
    id,
    name: id,
    api:
      apiProtocol === "responses"
        ? "openai-responses"
        : apiProtocol === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: apiProtocol === "anthropic-messages" ? anthropicMessagesBaseUrl(baseUrl) : baseUrl,
    reasoning,
    ...(apiProtocol === "anthropic-messages"
      ? // The built-in Anthropic provider passes no level map either: pi-ai derives
        // budget-based thinking from `reasoning` alone.
        {}
      : {
          compat: {
            // `store: false` is already the default, and Google's endpoint rejects the field.
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: reasoning,
            thinkingFormat: "openai",
          },
          thinkingLevelMap: reasoning
            ? { off: "none", xhigh: "xhigh", max: "max" }
            : { off: "none" },
        }),
    input: inputModalities(acceptsImages),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

/**
 * The Anthropic SDK appends `/v1/messages` itself, so the endpoint it gets must
 * not carry the `/v1` the normalized OpenAI-style base URL ends with.
 */
function anthropicMessagesBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/*$/, "");
  return url.toString().replace(/\/$/, "");
}

function openAiCompatibleProvider(
  models: Model<"openai-completions" | "openai-responses" | "anthropic-messages">[],
  policy: { headers?: Record<string, string> } = {},
): Provider {
  // The SDK requires a key even for header-authenticated or keyless endpoints.
  // Keep its placeholder private to this provider so a real key named "local" is preserved.
  const placeholderApiKey = randomUUID();
  const fetchPolicy = { ...policy, placeholderApiKey };
  const api = (protocol: string) =>
    protocol === "openai-responses"
      ? openAIResponsesApi()
      : protocol === "anthropic-messages"
        ? anthropicMessagesApi()
        : openAICompletionsApi();
  // Guard the fetch the caller supplied (the runtime's seam for tests) or the
  // dispatcher-matched default; never the bare global.
  const safeApi: ProviderStreams = {
    stream: (model, context, options) =>
      api(model.api).stream(model, context, {
        ...options,
        fetch: createOpenAiCompatibleFetch(options?.fetch, undefined, fetchPolicy),
      }),
    streamSimple: (model, context, options) =>
      api(model.api).streamSimple(model, context, {
        ...options,
        fetch: createOpenAiCompatibleFetch(options?.fetch, undefined, fetchPolicy),
      }),
  };
  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: models[0]?.baseUrl ?? OPENAI_COMPAT_BASE,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        resolve: async () => ({
          auth: { apiKey: placeholderApiKey },
          source: "OpenAI-compatible endpoint",
        }),
      },
    },
    models,
    api: safeApi,
  });
}

export function createOpenAiCompatibleLookup(
  url: URL,
  resolve: ResolveHostname = resolveHostname,
): LookupFunction {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const privateHostname = isPrivateOpenAiCompatibleHostname(hostname);
  return createAddressCheckedLookup(resolve, (addresses) => {
    if (addresses.length === 0) throw new Error("Model server did not resolve to an address");
    if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
      throw new Error("Model server hostname resolved to a blocked metadata address");
    }
    if (privateHostname) {
      if (
        addresses.some(
          (entry) =>
            isIP(entry.address) === 0 ||
            !isPrivateAddress(entry.address) ||
            isLinkLocalAddress(entry.address),
        )
      ) {
        throw new Error("Local model server hostname resolved outside the private network");
      }
      return;
    }
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error("Public model server hostname resolved to a private address");
    }
  });
}

function isAuthHeader(name: string, value: string | null | undefined): boolean {
  const lower = name.toLowerCase();
  return (lower === "authorization" || lower === "x-api-key") && Boolean(value);
}

function headersCarryAuthorization(headers: HeadersInit): boolean {
  const entries =
    headers instanceof Headers || Array.isArray(headers) ? [...headers] : Object.entries(headers);
  return entries.some(([name, value]) => isAuthHeader(name, value));
}

export function createOpenAiCompatibleFetch(
  baseFetch: typeof globalThis.fetch = dispatcherFetch,
  resolve: ResolveHostname = resolveHostname,
  opts?: { allowPublic?: boolean; headers?: Record<string, string>; placeholderApiKey?: string },
): typeof globalThis.fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = assertAllowedOpenAiCompatibleRequestUrl(rawUrl, {
      allowPublic: opts?.allowPublic,
    });
    const customHeaders = opts?.headers === undefined ? undefined : parseModelHeaders(opts.headers);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const dispatcher = new Agent({
      connect: {
        timeout: MODEL_CONNECT_TIMEOUT_MS,
        ...(isIP(hostname) === 0 ? { lookup: createOpenAiCompatibleLookup(url, resolve) } : {}),
      },
    });
    // Pair the package dispatcher with its fetch; explicit transports stay in charge.
    const transport = fetchPairedWithDispatcher(baseFetch);
    try {
      const requestInit = await requestInitFor(input, init);
      const headers = new Headers(requestInit.headers);
      if (opts?.placeholderApiKey) {
        if (headers.get("authorization") === `Bearer ${opts.placeholderApiKey}`)
          headers.delete("authorization");
        if (headers.get("x-api-key") === opts.placeholderApiKey) headers.delete("x-api-key");
      }
      for (const [name, value] of Object.entries(customHeaders ?? {})) headers.set(name, value);
      if (headersCarryAuthorization(headers) || Object.keys(customHeaders ?? {}).length > 0) {
        assertHttpsForKeyedOpenAiCompatibleUrl(url, "present");
      }
      const response = await transport(url, {
        ...requestInit,
        headers,
        redirect: "error",
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      return await closeDispatcherWithResponse(response, dispatcher);
    } catch (error) {
      await dispatcher.destroy().catch(() => undefined);
      throw error;
    }
  };
}

/** The base fetch comes from the undici package, which recognizes only its own
 * Request class and reads a global Request as the string "[object Request]".
 * Flatten Request inputs to a URL plus init, with init overriding the
 * Request's fields the way fetch itself merges them. */
async function requestInitFor(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  if (!(input instanceof Request)) return init ?? {};
  const request = new Request(input, init);
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  };
}

async function closeDispatcherWithResponse(
  response: Response,
  dispatcher: Agent,
): Promise<Response> {
  if (!response.body) {
    await dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Always-visible catalog provider with a placeholder model entry. */
export function openAiCompatibleCatalogProvider(): Provider {
  // The vision gate resolves against this catalog rather than the per-run
  // registry, so a model only declared at runtime would still read as
  // text-only. Register the operator's declared vision models here too.
  //
  // If the reserved placeholder id ("custom") is itself declared vision-
  // capable, upgrade the placeholder entry rather than appending a second
  // model with the same id — Models.getModel returns the first match, so a
  // duplicate would leave the gate reading the text-only placeholder.
  const visionIds = openAiCompatibleVisionModelIds();
  const placeholderAcceptsImages = visionIds.has(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  const visionModels = [...visionIds]
    .filter((id) => id !== OPENAI_COMPATIBLE_CATALOG_MODEL_ID)
    .map((id) => openAiCompatibleModel(id, OPENAI_COMPAT_BASE, false, true));
  return openAiCompatibleProvider([
    {
      ...openAiCompatibleModel(
        OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
        OPENAI_COMPAT_BASE,
        false,
        placeholderAcceptsImages,
      ),
      name: "Custom model id",
    },
    ...visionModels,
  ]);
}

export function registerOpenAiCompatibleCatalog(models: MutableModels): MutableModels {
  models.setProvider(openAiCompatibleCatalogProvider());
  return guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
}

/** Register a concrete model + base URL for an agent run. */
export function registerOpenAiCompatibleRuntime(
  models: MutableModels,
  opts: {
    modelId: string;
    baseUrl: string;
    reasoning?: boolean;
    acceptsImages?: boolean;
    maxTokens?: number;
    contextWindow?: number;
    apiProtocol?: ModelApiProtocol;
    headers?: Record<string, string>;
  },
): MutableModels {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  const modelId = opts.modelId.trim();
  const acceptsImages = opts.acceptsImages ?? openAiCompatibleVisionModelIds().has(modelId);
  models.setProvider(
    openAiCompatibleProvider(
      [
        openAiCompatibleModel(
          modelId,
          baseUrl,
          opts.reasoning,
          acceptsImages,
          opts.maxTokens,
          opts.contextWindow,
          opts.apiProtocol,
        ),
      ],
      { headers: opts.headers === undefined ? undefined : parseModelHeaders(opts.headers) },
    ),
  );
  guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
  const provider = models.getProvider(OPENAI_COMPATIBLE_PROVIDER_ID);
  if (provider) registerModelConnectionHeaders(provider, { ...opts.headers });
  return models;
}

export type OpenAiCompatibleConnectInput = {
  provider: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
  apiProtocol?: ModelApiProtocol;
  headers?: Record<string, string>;
};

export function prepareOpenAiCompatibleConnect(input: OpenAiCompatibleConnectInput): {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
} {
  const baseUrl = input.baseUrl?.trim();
  const modelId = input.modelId?.trim();
  if (!baseUrl) throw new Error("Base URL is required for OpenAI-compatible models");
  if (!modelId) throw new Error("Model id is required for OpenAI-compatible models");
  const allowed = assertAllowedOpenAiCompatibleUrl(baseUrl);
  const apiKey = input.apiKey?.trim();
  const headers = input.headers === undefined ? undefined : parseModelHeaders(input.headers);
  assertHttpsForKeyedOpenAiCompatibleUrl(
    allowed,
    apiKey || (Object.keys(headers ?? {}).length ? "present" : undefined),
  );
  const normalized = allowed.href;
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

export type OpenAiCompatibleModelsResponse = {
  object?: string;
  data?: Array<{ id?: string }>;
  models?: Array<{ id?: string }>;
};

/** Shared suffix: /models probe is optional when the user already knows a model id. */
const OPENAI_COMPAT_PROBE_HAND_FILL_HINT = "You can still Connect with an explicit model id.";

function probeModelIds(
  body: OpenAiCompatibleModelsResponse,
  opts?: { catalogProbe?: boolean },
): string[] {
  const { maxModelIds } = modelsProbeLimits(opts?.catalogProbe);
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!entries) {
    throw new Error(
      `Model server response did not include a models list. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LENGTH || ids.length >= maxModelIds) {
      throw new Error("Model server returned too many or overly long model ids");
    }
    ids.push(id);
  }
  return ids;
}

async function readBoundedJson(
  response: Response,
  opts?: { catalogProbe?: boolean },
): Promise<OpenAiCompatibleModelsResponse> {
  const { maxBytes } = modelsProbeLimits(opts?.catalogProbe);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
  if (!response.body) {
    throw new Error(
      `Model server returned an empty response. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Model server response is too large. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as OpenAiCompatibleModelsResponse;
  } catch {
    throw new Error(`Model server returned invalid JSON. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
  }
}

export async function probeOpenAiCompatibleModels(
  input: {
    baseUrl: string;
    apiKey?: string;
    apiProtocol?: ModelApiProtocol;
    headers?: Record<string, string>;
  },
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
  opts?: { allowPublic?: boolean; catalogProbe?: boolean },
): Promise<string[]> {
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl, {
    allowPublic: opts?.allowPublic,
  });
  const customHeaders = input.headers === undefined ? undefined : parseModelHeaders(input.headers);
  assertHttpsForKeyedOpenAiCompatibleUrl(
    baseUrl,
    input.apiKey || (Object.keys(customHeaders ?? {}).length ? "present" : undefined),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiProtocol === "anthropic-messages") {
      headers["anthropic-version"] = ANTHROPIC_MESSAGES_VERSION;
      if (input.apiKey?.trim()) headers["x-api-key"] = input.apiKey.trim();
    } else if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, {
      ...opts,
      headers: customHeaders,
    });
    const response = await safeFetch(new URL("models", `${baseUrl.href}/`).href, {
      headers,
      redirect: "error",
      signal: merged,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server redirects are not allowed. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model server returned ${response.status}. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`,
      );
    }
    const body = await readBoundedJson(response, opts);
    return probeModelIds(body, opts);
  } catch (error) {
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError");
    if (aborted) {
      // Caller-cancelled probes keep the original AbortError; the 5s probe budget gets a hint.
      if (signal?.aborted) throw error;
      throw new Error(`Model server probe timed out. ${OPENAI_COMPAT_PROBE_HAND_FILL_HINT}`);
    }
    const message = modelConnectionErrorMessage(error, input);
    if (message !== (error instanceof Error ? error.message : String(error)))
      throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
