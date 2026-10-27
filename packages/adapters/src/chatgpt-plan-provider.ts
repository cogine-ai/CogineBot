import type {
  Model,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { dispatcherFetch } from "./undici-fetch.js";

export const CHATGPT_PLAN_PROVIDER_ID = "chatgpt-plan";
export const CHATGPT_PLAN_CATALOG_MODEL_ID = "connect";
export const CHATGPT_PLAN_BASE_URL = "https://api.openai.com/v1";
const TOOL_NAMESPACE = "coginebot";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 500;
const MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;

/** Account-specific catalog data, saved with the registration that discovered it. */
export interface ChatGPTPlanModelDescriptor {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

/** Runtime metadata stays bound to the credential that discovered it. */
export function readChatGPTPlanModels(credential: unknown): ChatGPTPlanModelDescriptor[] {
  if (!object(credential) || !Array.isArray(credential.chatgptPlanModels)) return [];
  if (credential.chatgptPlanModels.length > MAX_CATALOG_MODELS) {
    throw new Error("ChatGPT plan credential has too many models");
  }
  return credential.chatgptPlanModels.map((entry) => {
    if (!object(entry)) throw new Error("Invalid ChatGPT plan model metadata");
    const id = modelString(entry.id);
    const name = modelString(entry.name);
    if (!id || !name || id === CHATGPT_PLAN_CATALOG_MODEL_ID) {
      throw new Error("Invalid ChatGPT plan model metadata");
    }
    return {
      id,
      name,
      ...(positiveLimit(entry.contextWindow)
        ? { contextWindow: positiveLimit(entry.contextWindow) }
        : {}),
      ...(positiveLimit(entry.maxTokens) ? { maxTokens: positiveLimit(entry.maxTokens) } : {}),
      ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
      input:
        Array.isArray(entry.input) && entry.input.includes("image") ? ["text", "image"] : ["text"],
    };
  });
}

const disconnectedAuth: ProviderAuth = {
  apiKey: { name: "ChatGPT plan", resolve: async () => undefined },
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modelString(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value.trim()
    : undefined;
}

export function buildPiChatGPTPlanModel(
  descriptor: ChatGPTPlanModelDescriptor,
): Model<"openai-responses"> {
  const id = modelString(descriptor.id);
  const name = modelString(descriptor.name);
  if (!id || !name) throw new Error("Invalid ChatGPT plan model descriptor");
  return {
    id,
    name,
    api: "openai-responses",
    provider: CHATGPT_PLAN_PROVIDER_ID,
    baseUrl: CHATGPT_PLAN_BASE_URL,
    reasoning: descriptor.reasoning === true,
    input: descriptor.input?.includes("image") ? ["text", "image"] : ["text"],
    contextWindow: positiveLimit(descriptor.contextWindow) ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: positiveLimit(descriptor.maxTokens) ?? DEFAULT_MODEL_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: true,
      supportsMaxOutputTokens: false,
      supportsLongCacheRetention: false,
      supportsToolSearch: false,
      supportsAdditionalTools: false,
    },
  };
}

function chatGPTPlanProvider(
  descriptors: readonly ChatGPTPlanModelDescriptor[],
  auth: ProviderAuth = disconnectedAuth,
): Provider {
  const api = openAIResponsesApi();
  const assertExecutable = (model: Model<string>) => {
    if (model.id === CHATGPT_PLAN_CATALOG_MODEL_ID) {
      throw new Error("Connect a ChatGPT account and select one of its available models");
    }
  };
  const streams: ProviderStreams = {
    stream: (model, context, options) => {
      assertExecutable(model);
      return api.stream(model, context, {
        ...options,
        maxRetries: 0,
        onPayload: async (payload, selected) =>
          sanitizeChatGPTPlanPayload((await options?.onPayload?.(payload, selected)) ?? payload),
        fetch: createChatGPTPlanFetch(options?.fetch, options?.apiKey),
      });
    },
    streamSimple: (model, context, options) => {
      assertExecutable(model);
      return api.streamSimple(model, context, {
        ...options,
        maxRetries: 0,
        onPayload: async (payload, selected) =>
          sanitizeChatGPTPlanPayload((await options?.onPayload?.(payload, selected)) ?? payload),
        fetch: createChatGPTPlanFetch(options?.fetch, options?.apiKey),
      });
    },
  };
  return createProvider({
    id: CHATGPT_PLAN_PROVIDER_ID,
    name: "ChatGPT",
    baseUrl: CHATGPT_PLAN_BASE_URL,
    auth,
    models: descriptors.map(buildPiChatGPTPlanModel),
    api: streams,
  });
}

/** A disconnected catalog entry is discoverable without inventing an entitled model. */
export function registerChatGPTPlanCatalog(
  models: MutableModels,
  auth?: ProviderAuth,
): MutableModels {
  models.setProvider(
    chatGPTPlanProvider(
      [{ id: CHATGPT_PLAN_CATALOG_MODEL_ID, name: "Continue with ChatGPT" }],
      auth,
    ),
  );
  return models;
}

export function registerChatGPTPlanRuntime(
  models: MutableModels,
  options: { models: readonly ChatGPTPlanModelDescriptor[]; auth?: ProviderAuth },
): MutableModels {
  models.setProvider(chatGPTPlanProvider(options.models, options.auth));
  return models;
}

// The final HTTP boundary runs after Pi's samplingParams and onPayload hooks.
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

function namespaceTools(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("ChatGPT plan tools must be an array");
  const functions: Record<string, unknown>[] = [];
  const grouped: unknown[] = [];
  for (const tool of value) {
    if (!object(tool)) throw new Error("Invalid ChatGPT plan tool");
    if (tool.type === "function" || tool.type === "custom") {
      functions.push(tool);
    } else if (
      tool.type === "namespace" &&
      typeof tool.name === "string" &&
      Array.isArray(tool.tools) &&
      tool.tools.every(
        (entry) => object(entry) && (entry.type === "function" || entry.type === "custom"),
      )
    ) {
      grouped.push(tool);
    } else {
      throw new Error("This tool is not supported by the ChatGPT plan adapter");
    }
  }
  if (functions.length) {
    if (grouped.some((entry) => object(entry) && entry.name === TOOL_NAMESPACE)) {
      throw new Error("Duplicate ChatGPT plan tool namespace");
    }
    grouped.push({
      type: "namespace",
      name: TOOL_NAMESPACE,
      description: "Tools executed by CogineBot.",
      tools: functions,
    });
  }
  return grouped;
}

export function sanitizeChatGPTPlanPayload(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("Invalid ChatGPT plan request");
  const payload = { ...value };
  for (const field of UNSUPPORTED_FIELDS) delete payload[field];
  payload.store = false;
  payload.stream = true;
  const input =
    typeof payload.input === "string" ? [{ role: "user", content: payload.input }] : payload.input;
  if (!Array.isArray(input)) throw new Error("ChatGPT plan input must be an array");
  const tools = namespaceTools(payload.tools);
  const groupedNames = new Set<string>();
  for (const tool of tools ?? []) {
    if (object(tool) && tool.name === TOOL_NAMESPACE && Array.isArray(tool.tools)) {
      for (const entry of tool.tools)
        if (object(entry) && typeof entry.name === "string") groupedNames.add(entry.name);
    }
  }
  payload.input = input.map((entry) => {
    if (!object(entry)) throw new Error("Invalid ChatGPT plan input item");
    if (
      ["additional_tools", "tool_search_call", "tool_search_output"].includes(String(entry.type))
    ) {
      throw new Error("This tool input is not supported by the ChatGPT plan adapter");
    }
    const result = { ...entry };
    if (result.role === "system") result.role = "developer";
    if (
      (result.type === "function_call" || result.type === "custom_tool_call") &&
      result.namespace === undefined &&
      typeof result.name === "string" &&
      groupedNames.has(result.name)
    ) {
      result.namespace = TOOL_NAMESPACE;
    }
    return result;
  });
  if (tools !== undefined) payload.tools = tools;
  if (
    object(payload.tool_choice) &&
    payload.tool_choice.type === "function" &&
    typeof payload.tool_choice.name === "string" &&
    groupedNames.has(payload.tool_choice.name)
  ) {
    payload.tool_choice = { ...payload.tool_choice, namespace: TOOL_NAMESPACE };
  }
  return payload;
}

function errorCode(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const nested = object(value.error) ? value.error : value;
  const code = nested.code ?? (typeof value.error === "string" ? value.error : undefined);
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : undefined;
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("ChatGPT plan returned an empty response");
  const reader = response.body.getReader();
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("ChatGPT plan response is too large");
      text += decoder.decode(next.value, { stream: true });
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      throw new Error("ChatGPT plan returned invalid JSON");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function safeHttpFailure(response: Response): Promise<Response> {
  const body = await boundedJson(response, 64 * 1024).catch(() => undefined);
  return new Response(
    JSON.stringify({
      error: {
        code: errorCode(body) ?? "chatgpt_plan_request_failed",
        message: `ChatGPT plan request failed (HTTP ${response.status})`,
      },
    }),
    { status: response.status, headers: { "content-type": "application/json" } },
  );
}

/** Validate terminal SSE events before the older Pi parser can accept incomplete as success. */
function completedResponse(response: Response): Response {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.body || (contentType && contentType !== "text/event-stream")) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("ChatGPT plan did not return an event stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let completed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (completed) {
          await reader.cancel().catch(() => undefined);
          controller.close();
          return;
        }
        while (true) {
          const separator = /\r?\n\r?\n/.exec(pending);
          if (separator) {
            const frame = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (data) {
              if (data === "[DONE]")
                throw new Error("ChatGPT plan stream ended before response.completed");
              let event: unknown;
              try {
                event = JSON.parse(data) as unknown;
              } catch {
                throw new Error("ChatGPT plan returned an invalid stream event");
              }
              if (!object(event)) throw new Error("Invalid ChatGPT plan stream event");
              if (
                event.type === "response.failed" ||
                event.type === "response.incomplete" ||
                event.type === "error"
              ) {
                const code = errorCode(event.response ?? event);
                throw new Error(
                  code
                    ? `ChatGPT plan request failed: ${code}`
                    : "ChatGPT plan response did not complete",
                );
              }
              if (event.type === "response.completed") {
                if (!object(event.response) || event.response.status !== "completed") {
                  throw new Error("ChatGPT plan response did not complete");
                }
                completed = true;
              }
            }
            controller.enqueue(encoder.encode(`${frame}\n\n`));
            return;
          }
          const next = await reader.read();
          if (next.done) throw new Error("ChatGPT plan stream ended before response.completed");
          pending += decoder.decode(next.value, { stream: true });
          if (pending.length > MAX_SSE_FRAME_BYTES)
            throw new Error("ChatGPT plan stream event is too large");
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  headers.delete("content-length");
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** This transport has no configurable host and never forwards credentials through redirects. */
export function createChatGPTPlanFetch(
  baseFetch: typeof fetch = dispatcherFetch,
  accessToken?: string,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== "https://api.openai.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        (request.method === "POST" && url.pathname === "/v1/responses") ||
        (request.method === "GET" && url.pathname === "/v1/models")
      )
    ) {
      throw new Error("ChatGPT plan requests must use the pinned public OpenAI endpoint");
    }
    const token = accessToken?.trim();
    const authorization = token ? `Bearer ${token}` : request.headers.get("authorization");
    if (!authorization || !/^Bearer \S+$/.test(authorization))
      throw new Error("ChatGPT plan sign-in is required");
    const headers = new Headers(request.headers);
    headers.set("authorization", authorization);
    for (const name of [
      "openai-organization",
      "openai-project",
      "cookie",
      "host",
      "content-length",
    ])
      headers.delete(name);
    let body: string | undefined;
    if (request.method === "POST") {
      body = JSON.stringify(sanitizeChatGPTPlanPayload(await request.json()));
      headers.set("content-type", "application/json");
      headers.set("accept", "text/event-stream");
    }
    let response: Response;
    try {
      response = await baseFetch(url.href, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        redirect: "error",
      });
    } catch {
      request.signal.throwIfAborted();
      throw new Error("ChatGPT plan network request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("ChatGPT plan redirects are not allowed");
    }
    if (!response.ok) return safeHttpFailure(response);
    return request.method === "POST" ? completedResponse(response) : response;
  };
}

/** Discover entitlement from this account's catalog; never substitute a bundled model list. */
export async function discoverChatGPTPlanModels(
  accessToken: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ChatGPTPlanModelDescriptor[]> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const response = await createChatGPTPlanFetch(options.fetch, accessToken)(
    `${CHATGPT_PLAN_BASE_URL}/models`,
    {
      headers: { accept: "application/json" },
      signal,
    },
  );
  if (!response.ok)
    throw new Error(`ChatGPT plan model discovery failed (HTTP ${response.status})`);
  const body = await boundedJson(response, MAX_CATALOG_BYTES);
  if (!object(body) || !Array.isArray(body.models))
    throw new Error("ChatGPT plan model catalog is invalid");
  if (body.models.length > MAX_CATALOG_MODELS)
    throw new Error("ChatGPT plan returned too many models");
  const models: ChatGPTPlanModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of body.models) {
    if (!object(entry) || entry.visibility !== "list") continue;
    const id = modelString(entry.slug);
    const name = modelString(entry.display_name);
    if (!id || !name) throw new Error("ChatGPT plan returned an invalid model descriptor");
    if (seen.has(id)) continue;
    seen.add(id);
    const contextWindow = positiveLimit(entry.context_window);
    const maxTokens = positiveLimit(entry.max_output_tokens);
    const input =
      Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image")
        ? (["text", "image"] as Array<"text" | "image">)
        : (["text"] as Array<"text" | "image">);
    models.push({
      id,
      name,
      input,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    });
  }
  return models;
}
