import type { Context } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ModelInferenceProbeStatus } from "@rakazo/contracts";
import { MODEL_INFERENCE_PROBE_TIMEOUT_MS } from "@rakazo/contracts";
import { cancelResponseBody, normalizeRunError, readBoundedJsonResponse } from "@rakazo/core";
import { isOfficialResponsesModel } from "./pi-live-model.js";
import { reliableModelStream, resolveRuntimeModel } from "./pi-runtime.js";

const OUTPUT_LIMIT = 1024;
const ERROR_BODY_LIMIT = 16 * 1024;
const context: Context = {
  systemPrompt: "Reply with OK.",
  messages: [{ role: "user", content: "OK?", timestamp: 0 }],
  tools: [{ name: "noop", description: "Does nothing.", parameters: Type.Object({}) }],
};

/** Test one agent request on the pinned Responses route and stop on acceptance. */
export async function probeModelInference(
  input: { provider: string; modelId: string; apiKey: string },
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ModelInferenceProbeStatus> {
  options.signal?.throwIfAborted();
  const { models, model, apiKey } = resolveRuntimeModel({
    provider: input.provider,
    id: input.modelId,
    apiKey: input.apiKey,
  });
  if (!model || !apiKey || !isOfficialResponsesModel(model)) return "unavailable";

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
      model,
      context,
      {
        apiKey,
        signal,
        maxRetries: 0,
        maxTokens: OUTPUT_LIMIT,
        timeoutMs: MODEL_INFERENCE_PROBE_TIMEOUT_MS,
        // Do not inherit organization and project defaults from the deployment.
        headers: { "OpenAI-Organization": null, "OpenAI-Project": null },
        onPayload: (payload) => {
          // The SDK can omit this field when it treats a key as a sign-in token.
          if (!payload || typeof payload !== "object")
            throw new Error("Invalid model test request");
          const current = "max_output_tokens" in payload ? payload.max_output_tokens : undefined;
          return {
            ...payload,
            max_output_tokens:
              typeof current === "number" ? Math.min(current, OUTPUT_LIMIT) : OUTPUT_LIMIT,
          };
        },
        fetch: async (request, init) => {
          let response: Response;
          try {
            response = await transport(request, { ...init, redirect: "error" });
          } catch {
            signal.throwIfAborted();
            throw new Error("Model test transport failed");
          }
          if (!response.ok) {
            const body = await readBoundedJsonResponse<unknown>(
              response,
              ERROR_BODY_LIMIT,
              signal,
            ).catch(() => undefined);
            signal.throwIfAborted();
            rejected = failureStatus(JSON.stringify(body) ?? "", apiKey, response.status);
            // The SDK's debug logger runs before the application can redact its errors.
            return new Response(null, { status: response.status });
          }
          const contentType = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== "text/event-stream") {
            cancelResponseBody(response);
            throw new Error("Model server did not return an event stream");
          }
          return new Response(response.body, {
            status: response.status,
            headers: { "content-type": "text/event-stream" },
          });
        },
        onProviderStreamEvent: (event) => {
          if (
            !signal.aborted &&
            event &&
            typeof event === "object" &&
            "type" in event &&
            event.type === "response.created" &&
            "response" in event &&
            event.response &&
            typeof event.response === "object" &&
            "id" in event.response &&
            typeof event.response.id === "string" &&
            event.response.id.trim()
          ) {
            accepted = true;
            stop.abort();
          }
        },
      },
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
  if (deadline.aborted) return "timeout";
  return rejected ?? failureStatus(errorDetail, apiKey);
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
