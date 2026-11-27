import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ModelInferenceProbeStatus } from "@rakazo/contracts";
import { isModelInferenceRefusal, MODEL_INFERENCE_PROBE_TIMEOUT_MS } from "@rakazo/contracts";
import { cancelResponseBody, normalizeRunError, readBoundedJsonResponse } from "@rakazo/core";
import { createParser } from "eventsource-parser";
import { withChatCompletionsCompatibility } from "./chat-completions-compat.js";
import { isGeminiApiKeyError } from "./gemini-model-api.js";
import {
  anthropicModelAlias,
  isOfficialAnthropicProbeModel,
  isOfficialChatCompletionProbeModel,
  isOfficialGeminiProbeModel,
  isOfficialResponsesModel,
  isOfficialXaiResponsesProbeModel,
  isOpenRouterMessagesModel,
  supportsProviderCatalogModels,
} from "./pi-live-model.js";
import { reliableModelStream, resolveRuntimeModel } from "./pi-runtime.js";

const OUTPUT_LIMIT = 1024;
const ERROR_BODY_LIMIT = 16 * 1024;
const STREAM_PREFIX_LIMIT = 64 * 1024;
const PROBE_TOOL_NAME = "noop";
const PROBE_TOOL_DESCRIPTION = "Does nothing.";
const PROBE_SYSTEM_PROMPT = "Reply with OK.";
const PROBE_USER_PROMPT = "OK?";
const context: Context = {
  systemPrompt: PROBE_SYSTEM_PROMPT,
  messages: [{ role: "user", content: PROBE_USER_PROMPT, timestamp: 0 }],
  tools: [
    { name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION, parameters: Type.Object({}) },
  ],
};

type ProbeOptions = { fetch?: typeof fetch; signal?: AbortSignal };

/** Test one agent request on an eligible provider route and stop on acceptance. */
export async function probeModelInference(
  input: { provider: string; modelId: string; apiKey: string; providerCatalogModel?: true },
  options: ProbeOptions = {},
): Promise<ModelInferenceProbeStatus> {
  options.signal?.throwIfAborted();
  const { models, model, apiKey } = resolveRuntimeModel({
    provider: input.provider,
    id: input.modelId,
    apiKey: input.apiKey,
    providerCatalogModel: input.providerCatalogModel,
  });
  if (!model || !apiKey || input.provider !== model.provider) return "unavailable";
  const builtIn = Boolean(models.getModel(model.provider, model.id));
  const canProbeCatalogRoute =
    builtIn ||
    (input.providerCatalogModel === true && supportsProviderCatalogModels(model.provider));
  if (builtIn && isOpenRouterMessagesModel(model))
    return probeOpenRouterMessages(model, apiKey, options);
  if (canProbeCatalogRoute && isOfficialGeminiProbeModel(model))
    return probeGemini(model, apiKey, options);
  const chatCompletions = canProbeCatalogRoute && isOfficialChatCompletionProbeModel(model);
  const deepseek = chatCompletions && model.provider === "deepseek";
  const anthropic = canProbeCatalogRoute && isOfficialAnthropicProbeModel(model);
  const xai =
    (builtIn || input.providerCatalogModel === true) && isOfficialXaiResponsesProbeModel(model);
  const readFrames = chatCompletions || anthropic || xai;
  if (!readFrames && !isOfficialResponsesModel(model)) return "unavailable";
  // A probe confirms one selected model. Some registered Claude models request a
  // second, potentially billable model when the first one refuses a normal run.
  const probeModel =
    anthropic && model.compat && "allowedFallbackModels" in model.compat
      ? { ...model, compat: { ...model.compat, allowedFallbackModels: [] } }
      : model;
  const classifyFailure = (error: unknown, status?: number) =>
    anthropic
      ? anthropicFailureStatus(error, status)
      : xai
        ? xaiFailureStatus(error, apiKey, status)
        : providerProbeFailureStatus(model.provider, error, apiKey, status);

  const stop = new AbortController();
  const deadline = AbortSignal.timeout(MODEL_INFERENCE_PROBE_TIMEOUT_MS);
  const signal = AbortSignal.any([
    stop.signal,
    deadline,
    ...(options.signal ? [options.signal] : []),
  ]);
  const transport = options.fetch ?? globalThis.fetch;
  let accepted = false;
  let rejected: ModelInferenceProbeStatus | undefined;
  let errorDetail: string;
  try {
    const stream = reliableModelStream(
      models,
      probeModel,
      context,
      withChatCompletionsCompatibility(probeModel, {
        apiKey,
        signal,
        maxRetries: 0,
        maxTokens: OUTPUT_LIMIT,
        // Do not inherit organization and project defaults from the deployment.
        headers: { "OpenAI-Organization": null, "OpenAI-Project": null },
        onPayload: (payload) => {
          // The SDK can omit this field when it treats a key as a sign-in token.
          if (!payload || typeof payload !== "object")
            throw new Error("Invalid model test request");
          const field =
            anthropic || (chatCompletions && "max_tokens" in payload)
              ? "max_tokens"
              : chatCompletions
                ? "max_completion_tokens"
                : "max_output_tokens";
          const current =
            field in payload ? (payload as Record<string, unknown>)[field] : undefined;
          return {
            ...payload,
            [field]: typeof current === "number" ? Math.min(current, OUTPUT_LIMIT) : OUTPUT_LIMIT,
          };
        },
        fetch: async (request, init) => {
          if (anthropic) {
            const headers = new Headers(
              init?.headers ?? (request instanceof Request ? request.headers : undefined),
            );
            // The provider SDK also accepts pasted subscription tokens and can switch auth modes.
            if (headers.get("x-api-key") !== apiKey || headers.has("authorization"))
              throw new Error("Model test requires API key authentication");
          }
          let response: Response;
          try {
            response = await transport(request, { ...init, redirect: "error" });
          } catch {
            signal.throwIfAborted();
            throw new Error("Model test transport failed");
          }
          if (!response.ok) {
            const { body, error } = await readProbeError(response, signal);
            rejected = readFrames
              ? classifyFailure(error, response.status)
              : failureStatus(JSON.stringify(body) ?? "", apiKey, response.status);
            // The SDK's debug logger runs before the application can redact its errors.
            return new Response(null, { status: response.status });
          }
          if (!isEventStream(response)) {
            cancelResponseBody(response);
            throw new Error("Model server did not return an event stream");
          }
          if (readFrames) {
            // Interpret provider frames before the SDK turns stream errors into diagnostic text.
            const outcome = await readModelProbeFrames(response.body, signal, (frame, event) => {
              if (anthropic) return anthropicFrameOutcome(frame, model.id, classifyFailure, event);
              if (xai) return xaiFrameOutcome(frame, classifyFailure, event);
              return chatCompletionChunkOutcome(
                frame,
                classifyFailure,
                event === "error",
                deepseek,
              );
            }).catch(() => {
              signal.throwIfAborted();
              return "unavailable" as const;
            });
            accepted = outcome === "accepted";
            if (!accepted) rejected = outcome;
            stop.abort();
            return new Response(null, {
              status: response.status,
              headers: { "content-type": "text/event-stream" },
            });
          }
          return new Response(response.body, {
            status: response.status,
            headers: { "content-type": "text/event-stream" },
          });
        },
        onProviderStreamEvent: (event) => {
          if (!signal.aborted && !readFrames && createdResponse(event)) {
            accepted = true;
            stop.abort();
          }
        },
      }),
      undefined,
    );
    errorDetail = (await stream.result()).errorMessage ?? "";
  } catch (error) {
    errorDetail = error instanceof Error ? error.message : "";
  } finally {
    stop.abort();
  }
  options.signal?.throwIfAborted();
  if (accepted) return "accepted";
  if (rejected) return failureAtDeadline(rejected, deadline);
  if (deadline.aborted) return "timeout";
  return failureStatus(errorDetail, apiKey);
}

function failureAtDeadline(status: ModelInferenceProbeStatus, deadline: AbortSignal) {
  return deadline.aborted && !isModelInferenceRefusal(status) ? "timeout" : status;
}

function isEventStream(response: Response): boolean {
  return (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "text/event-stream"
  );
}

async function readProbeError(response: Response, signal: AbortSignal) {
  const body = await readBoundedJsonResponse<unknown>(response, ERROR_BODY_LIMIT, signal).catch(
    () => undefined,
  );
  return { body, error: body && typeof body === "object" && "error" in body ? body.error : body };
}

/** The Google SDK does not expose the fetch boundary needed by connection tests. */
async function probeGemini(
  model: Pick<Model<Api>, "id" | "baseUrl" | "maxTokens">,
  apiKey: string,
  options: ProbeOptions,
): Promise<ModelInferenceProbeStatus> {
  return await probeNativeEventStream(
    `${model.baseUrl}/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,
    { "x-goog-api-key": apiKey },
    {
      systemInstruction: { parts: [{ text: PROBE_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: PROBE_USER_PROMPT }] }],
      tools: [
        { functionDeclarations: [{ name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION }] },
      ],
      generationConfig: { maxOutputTokens: Math.min(model.maxTokens, OUTPUT_LIMIT) },
    },
    options,
    (error, status) => geminiFailureStatus(error, apiKey, status),
    (frame, event) => geminiFrameOutcome(frame, apiKey, event),
  );
}

async function probeOpenRouterMessages(
  model: Pick<Model<Api>, "id" | "baseUrl" | "maxTokens">,
  apiKey: string,
  options: ProbeOptions,
): Promise<ModelInferenceProbeStatus> {
  const classifyFailure = (error: unknown, status?: number) =>
    openRouterMessagesFailureStatus(error, apiKey, status ?? errorHttpStatus(error));
  // The Anthropic SDK inherits deployment-level headers. This gateway only
  // receives the selected OpenRouter key and the headers for this request.
  return await probeNativeEventStream(
    `${model.baseUrl}/v1/messages`,
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    {
      model: model.id,
      system: PROBE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: PROBE_USER_PROMPT }],
      tools: [
        {
          name: PROBE_TOOL_NAME,
          description: PROBE_TOOL_DESCRIPTION,
          input_schema: { type: "object", properties: {} },
        },
      ],
      max_tokens: Math.min(model.maxTokens, OUTPUT_LIMIT),
      stream: true,
    },
    options,
    classifyFailure,
    (frame, event) => anthropicFrameOutcome(frame, model.id, classifyFailure, event),
  );
}

async function probeNativeEventStream(
  url: string,
  headers: Record<string, string>,
  body: object,
  options: ProbeOptions,
  classifyFailure: StreamFailureClassifier,
  frameOutcome: (frame: unknown, event?: string) => ModelInferenceProbeStatus | undefined,
): Promise<ModelInferenceProbeStatus> {
  const deadline = AbortSignal.timeout(MODEL_INFERENCE_PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const transport = options.fetch ?? globalThis.fetch;
  try {
    const response = await transport(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const { error } = await readProbeError(response, signal);
      options.signal?.throwIfAborted();
      return failureAtDeadline(classifyFailure(error, response.status), deadline);
    }
    if (!isEventStream(response)) {
      cancelResponseBody(response);
      signal.throwIfAborted();
      return "unavailable";
    }
    return await readModelProbeFrames(response.body, signal, frameOutcome);
  } catch {
    options.signal?.throwIfAborted();
    return failureAtDeadline("unavailable", deadline);
  }
}

function probeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function geminiFrameOutcome(
  frame: unknown,
  apiKey: string,
  event?: string,
): ModelInferenceProbeStatus | undefined {
  const record = probeRecord(frame);
  if (record?.error !== undefined || event === "error")
    return geminiFailureStatus(record?.error ?? frame, apiKey, errorHttpStatus(frame));
  const block = probeRecord(record?.promptFeedback)?.blockReason;
  if (typeof block === "string" && block && block !== "BLOCK_REASON_UNSPECIFIED")
    return "unavailable";
  const candidate = Array.isArray(record?.candidates)
    ? probeRecord(record.candidates[0])
    : undefined;
  const finish = candidate?.finishReason;
  if (
    finish &&
    finish !== "FINISH_REASON_UNSPECIFIED" &&
    finish !== "STOP" &&
    finish !== "MAX_TOKENS"
  )
    return "unavailable";
  const content = probeRecord(candidate?.content);
  const parts = content?.parts;
  const role = content?.role;
  if (Array.isArray(parts) && (role === undefined || role === "model")) {
    for (const value of parts) {
      const part = probeRecord(value);
      if (
        (typeof part?.text === "string" && part.text.trim()) ||
        probeRecord(part?.functionCall)?.name === PROBE_TOOL_NAME
      )
        return "accepted";
    }
  }
  if (finish === "STOP" || finish === "MAX_TOKENS") return "unavailable";
}

function geminiFailureStatus(
  error: unknown,
  apiKey: string,
  status?: number,
): ModelInferenceProbeStatus {
  status ??= errorHttpStatus(error);
  if (status === 408 || status === 504) return "timeout";
  if (status !== undefined && status >= 500) return "unavailable";
  if (status === 401) return "auth";
  if (status === 402) return "credit";
  const record = probeRecord(error);
  const message = typeof record?.message === "string" ? record.message.replaceAll(apiKey, "") : "";
  if (
    (status === 403 || status === undefined) &&
    /^Your API key was reported as (?:leaked|blocked)\b/i.test(message)
  )
    return "auth";
  if (
    (status === 400 || status === 403 || status === undefined) &&
    isGeminiApiKeyError(record?.details)
  )
    return "auth";
  if (
    (status === 400 || status === 403 || status === 429 || status === undefined) &&
    /\b(?:spend(?:ing)? (?:cap|limit) (?:was |has been )?(?:reached|exceeded)|(?:reached|exceeded) (?:(?:your|the|its) )?(?:monthly )?spend(?:ing)? (?:cap|limit))\b/i.test(
      message,
    )
  )
    return "spending";
  if (status === 429) return "rate";
  if (status === 403 || status === 404) return "model";
  return "unavailable";
}

function createdResponse(event: unknown): boolean {
  if (
    !event ||
    typeof event !== "object" ||
    !("type" in event) ||
    event.type !== "response.created"
  )
    return false;
  return (
    "response" in event &&
    !!event.response &&
    typeof event.response === "object" &&
    "id" in event.response &&
    typeof event.response.id === "string" &&
    Boolean(event.response.id.trim())
  );
}

type StreamFailureClassifier = (error: unknown, status?: number) => ModelInferenceProbeStatus;

async function readModelProbeFrames(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  frameOutcome: (frame: unknown, event?: string) => ModelInferenceProbeStatus | undefined,
): Promise<ModelInferenceProbeStatus> {
  if (!body) return "unavailable";
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let outcome: ModelInferenceProbeStatus | undefined;
  const parser = createParser({
    onEvent({ data, event }) {
      if (outcome) return;
      if (data === "[DONE]") {
        outcome = "unavailable";
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        outcome = "unavailable";
        return;
      }
      outcome = frameOutcome(frame, event);
    },
  });
  try {
    let remaining = STREAM_PREFIX_LIMIT;
    while (!outcome && remaining > 0) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value.subarray(0, remaining), { stream: true }));
      remaining -= value.byteLength;
    }
    signal.throwIfAborted();
    return outcome ?? "unavailable";
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

const chatSuccessFinishReasons = new Set(["stop", "length", "tool_calls", "function_call"]);

function chatCompletionChunkOutcome(
  event: unknown,
  classifyFailure: StreamFailureClassifier,
  isErrorEvent: boolean,
  requireOutput: boolean,
): ModelInferenceProbeStatus | undefined {
  if (!event || typeof event !== "object") return isErrorEvent ? "unavailable" : undefined;
  const choice = "choices" in event && Array.isArray(event.choices) ? event.choices[0] : undefined;
  const error = ("error" in event ? event.error : undefined) ?? choice?.error;
  if (error || isErrorEvent)
    return classifyFailure(error ?? event, requireOutput ? errorHttpStatus(event) : undefined);
  const finish = choice?.finish_reason;
  if (finish != null && !chatSuccessFinishReasons.has(finish)) return "unavailable";
  const delta = choice?.delta;
  if (
    "object" in event &&
    event.object === "chat.completion.chunk" &&
    "id" in event &&
    typeof event.id === "string" &&
    event.id.trim() &&
    delta &&
    typeof delta === "object" &&
    ((!requireOutput && delta.role === "assistant") ||
      [delta.content, delta.reasoning, delta.reasoning_content].some(
        (text) => typeof text === "string" && text.length > 0,
      ) ||
      (Array.isArray(delta.tool_calls) &&
        (requireOutput ? delta.tool_calls.some(isProbeToolCall) : delta.tool_calls.length > 0)))
  )
    return "accepted";
}

function isProbeToolCall(call: unknown): boolean {
  if (!call || typeof call !== "object" || !("type" in call) || call.type !== "function")
    return false;
  const tool = "function" in call ? call.function : undefined;
  return Boolean(
    tool && typeof tool === "object" && "name" in tool && tool.name === PROBE_TOOL_NAME,
  );
}

function anthropicFrameOutcome(
  frame: unknown,
  requestedModel: string,
  classifyFailure: StreamFailureClassifier,
  event?: string,
): ModelInferenceProbeStatus | undefined {
  if (!frame || typeof frame !== "object") return event === "error" ? "unavailable" : undefined;
  const type = "type" in frame ? frame.type : undefined;
  if (event === "error" || type === "error" || "error" in frame)
    return classifyFailure("error" in frame ? frame.error : undefined);
  if (type !== "message_start" || (event && event !== "message_start")) return;
  const message = "message" in frame ? frame.message : undefined;
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "message" ||
    !("role" in message) ||
    message.role !== "assistant" ||
    !("id" in message) ||
    typeof message.id !== "string" ||
    !message.id.trim() ||
    !("model" in message) ||
    typeof message.model !== "string"
  )
    return "unavailable";
  return message.model === requestedModel || anthropicModelAlias(message.model) === requestedModel
    ? "accepted"
    : "unavailable";
}

function anthropicFailureStatus(error: unknown, status?: number): ModelInferenceProbeStatus {
  const record = error && typeof error === "object" ? error : undefined;
  const type = record && "type" in record ? record.type : undefined;
  const details = record && "details" in record ? record.details : undefined;
  const code =
    details && typeof details === "object" && "error_code" in details
      ? details.error_code
      : undefined;
  if (
    status === 408 ||
    status === 504 ||
    ((status === 500 || status === undefined) && type === "timeout_error")
  )
    return "timeout";
  if (status !== undefined && status >= 500) return "unavailable";
  if (
    (status === 400 || status === 429 || status === undefined) &&
    (code === "enforced_spend_limit_reached" || code === "contract_spend_limit_reached")
  )
    return "spending";
  if (status === 429) return "rate";
  if (status === 401) return "auth";
  if (status === 402) return "credit";
  if (status === 403 || status === 404) return "model";
  if (status === undefined) {
    switch (type) {
      case "authentication_error":
        return "auth";
      case "billing_error":
        return "credit";
      case "permission_error":
      case "not_found_error":
        return "model";
      case "rate_limit_error":
        return "rate";
    }
  }
  if ((status === 400 || status === undefined) && type === "invalid_request_error") {
    if (code === "claude_code_key_creator_not_member") return "auth";
    if (code === "organization_on_hold") return "model";
    const message = record && "message" in record ? record.message : undefined;
    if (typeof message === "string") {
      // These billing refusals share the same envelope as ordinary validation errors.
      if (/^Your credit balance is too low\b/i.test(message)) return "credit";
      if (/^You have reached your specified (?:workspace )?API usage limits\b/i.test(message))
        return "spending";
    }
  }
  return "unavailable";
}

function xaiFrameOutcome(
  frame: unknown,
  classifyFailure: StreamFailureClassifier,
  event?: string,
): ModelInferenceProbeStatus | undefined {
  if (!frame || typeof frame !== "object") return event === "error" ? "unavailable" : undefined;
  const type = "type" in frame ? frame.type : event;
  if (event === "error" || type === "error" || "error" in frame)
    return classifyFailure("error" in frame ? frame.error : frame, errorHttpStatus(frame));
  const response = "response" in frame ? frame.response : undefined;
  if (response && typeof response === "object") {
    if ("error" in response && response.error)
      return classifyFailure(response.error, errorHttpStatus(frame) ?? errorHttpStatus(response));
    if (
      "status" in response &&
      (response.status === "failed" ||
        response.status === "cancelled" ||
        response.status === "incomplete")
    )
      return "unavailable";
  }
  if (type === "response.failed" || type === "response.incomplete" || type === "response.cancelled")
    return "unavailable";
  if (event && event !== type) return;
  // Grok can open an in-progress response before inference begins.
  if (
    type === "response.completed" &&
    response &&
    typeof response === "object" &&
    "status" in response &&
    response.status === "completed" &&
    "id" in response &&
    typeof response.id === "string" &&
    response.id.trim()
  )
    return "accepted";
  if (
    (type === "response.output_text.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.function_call_arguments.delta") &&
    "delta" in frame &&
    typeof frame.delta === "string" &&
    frame.delta.length > 0
  )
    return "accepted";
}

function errorHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (
    ("status" in error ? httpErrorStatusNumber(error.status) : undefined) ??
    ("code" in error ? httpErrorStatusNumber(error.code) : undefined)
  );
}

function httpErrorStatusNumber(value: unknown): number | undefined {
  if (typeof value === "string" && /^[45]\d{2}$/.test(value)) return Number(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value < 600
    ? value
    : undefined;
}

function xaiFailureStatus(
  error: unknown,
  apiKey: string,
  status?: number,
): ModelInferenceProbeStatus {
  status ??= errorHttpStatus(error);
  if (status === 429) return "rate";
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  if (typeof message === "string") {
    // The provider can return a text error in its JSON envelope, with no billing code.
    if (
      (status === 403 || status === undefined) &&
      /^Your newly created team doesn't have any credits or licenses yet\b/i.test(message)
    )
      return "credit";
    if (status === 400 && /^(?:incorrect|invalid) API key\b/i.test(message)) return "auth";
  }
  const result = failureStatus(JSON.stringify(error) ?? "", apiKey, status);
  // A forbidden request can mean the team or key is barred from the selected model.
  return status === 403 && result === "auth" ? "model" : result;
}

function providerProbeFailureStatus(
  provider: string,
  error: unknown,
  apiKey: string,
  status?: number,
): ModelInferenceProbeStatus {
  const record = probeRecord(error);
  const code = record?.code;
  const message = typeof error === "string" ? error : record?.message;
  if (provider === "deepseek") {
    status ??= errorHttpStatus(error);
    if (status === 402) return "credit";
    if (status === 429) return "rate";
    if (
      status === undefined &&
      (code === "insufficient_balance" ||
        (typeof message === "string" && /^insufficient balance\b/i.test(message)))
    )
      return "credit";
  }
  status ??= typeof code === "number" ? code : undefined;
  if (provider === "groq") {
    if (status === 429 || status === 498) return "rate";
    if ((status === undefined || status === 400) && code === "blocked_api_access")
      return "spending";
    if (status === undefined || status === 400 || status === 403 || status === 404) {
      switch (code) {
        case "model_not_found":
        case "model_decommissioned":
        case "model_terms_required":
        case "model_permission_blocked_org":
        case "model_permission_blocked_project":
          return "model";
      }
    }
    if (
      status === 400 &&
      typeof record?.message === "string" &&
      /^(?:unsupported|unknown|unrecognized)[ _-]model\b(?![ :]+(?:parameters?|fields?|options?|settings?)\b)/i.test(
        record.message.trim(),
      )
    )
      return "model";
  }
  if (provider === "openrouter") {
    const budget = openRouterBudgetFailureStatus(error, apiKey, status);
    if (budget) return budget;
    if (status === 402) return "unavailable";
  }
  return failureStatus(JSON.stringify(error) ?? "", apiKey, status);
}

function openRouterMessagesFailureStatus(
  error: unknown,
  apiKey: string,
  status?: number,
): ModelInferenceProbeStatus {
  const record = probeRecord(error);
  const budgetStatus =
    status ??
    (record?.type === "billing_error"
      ? 402
      : record?.type === "permission_error"
        ? 403
        : undefined);
  const budget = openRouterBudgetFailureStatus(error, apiKey, budgetStatus);
  if (budget) return budget;
  if (status === undefined || status === 402) {
    if (record?.error_type === "payment_required") return "credit";
    if (status === 402) return "unavailable";
  }
  if ((status === undefined || status >= 500) && record?.error_type === "timeout") return "timeout";
  if (status === undefined && record?.type !== "billing_error") {
    const outcome = anthropicFailureStatus(error);
    if (outcome !== "unavailable") return outcome;
  }
  return failureStatus(JSON.stringify(error) ?? "", apiKey, status);
}

function openRouterBudgetFailureStatus(
  error: unknown,
  apiKey: string,
  status: number | undefined,
): ModelInferenceProbeStatus | undefined {
  const record = probeRecord(error);
  const metadata = probeRecord(record?.metadata);
  const source = metadata?.limit_source;
  if (
    status === 402 &&
    (source === "openrouter_in_flight_budget" ||
      (source === undefined && metadata?.reason === "in_flight_budget_exhausted"))
  )
    return "rate";
  if (
    (status === 402 || status === 403) &&
    (source === "openrouter_key_limit" ||
      source === "openrouter_workspace_budget" ||
      source === "openrouter_guardrail_budget")
  )
    return "spending";
  // A 402 can mean exhausted credits or a temporary in-flight budget limit.
  if (status !== 402) return;
  if (source === "openrouter_credits") return "credit";
  const message = typeof error === "string" ? error : record?.message;
  if (typeof message !== "string") return;
  const detail = message.replaceAll(apiKey, "").trim();
  if (/^(?:insufficient credits|this request requires more credits)\b/i.test(detail))
    return "credit";
  if (
    /^(?:your )?(?:(?:(?:team|workspace|account|organi[sz]ation|(?:api )?key) )?(?:(?:daily|weekly|monthly) )?spending limit|(?:api )?key limit) (?:has been )?(?:reached|exceeded)\b/i.test(
      detail,
    ) ||
    /^workspace (?:daily|weekly|monthly) budget of \$[\d,.]+ exceeded\b/i.test(detail)
  )
    return "spending";
}

function failureStatus(error: string, apiKey: string, status?: number): ModelInferenceProbeStatus {
  if (status === 401) return "auth";
  // Classify the diagnostic without forwarding any provider text or key.
  const detail = error.replaceAll(apiKey, "");
  if (status === 429 && /\borganization_usage_limit_exceeded\b/.test(detail)) return "spending";
  const { kind } = normalizeRunError(status ? `${status}: ${detail}` : detail);
  switch (kind) {
    case "credit":
    case "model":
    case "rate":
    case "spending":
    case "timeout":
      return kind;
    case "key":
      return "spending";
    default:
      if (status === 402) return "credit";
      if (status === 403 || status === 404) return "model";
      return kind === "auth" ? kind : "unavailable";
  }
}
