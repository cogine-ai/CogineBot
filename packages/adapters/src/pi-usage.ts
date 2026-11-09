import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AgentRuntimeEvent,
  AgentUsage,
  ModelCallObserver,
  UsageOperationKind,
} from "@rakazo/adapter-kit";
import { UsagePricingSnapshotSchema } from "@rakazo/contracts";
import { Agent } from "undici";
import { withChatCompletionsCompatibility } from "./chat-completions-compat.js";
import type { ContextBudget } from "./context-selection.js";
import { withGoogleToolHistory } from "./google-tool-history.js";
import { modelConnectionStreamErrorMessage } from "./model-connection-errors.js";
import { estimateModelContextTokens } from "./model-context.js";
import {
  isOpenRouterGenerationId,
  lookupOpenRouterUsage,
  openRouterCosts,
  openRouterInferencePath,
} from "./openrouter-usage.js";
import { requestedPiCacheWriteRetention, resolvePiCacheRetention } from "./pi-cache-retention.js";
import { effectivePiOutputTokens, finalPiOutputPayload } from "./pi-output-budget.js";
import { MODEL_BUDGET_UNCHANGED_ERROR } from "./pi-runtime-limits.js";
import {
  providerErrorQuotaResetAt,
  providerResetAt,
  providerRetryAfterAt,
} from "./provider-quota-reset.js";
import { fetchPairedWithDispatcher } from "./undici-fetch.js";

/** Pi initializes absent usage to zero. Only raw numeric fields can prove reported zero. */
export type ReportedUsageFields = Set<keyof AgentUsage>;
const reportedCosts = new WeakMap<ReportedUsageFields, number>();
const reportedValues = new WeakMap<ReportedUsageFields, Map<keyof AgentUsage, number>>();

type UsageEvidence = {
  attempts: number;
  rejected: boolean;
  uncertain: boolean;
  errorBodyPending: boolean;
  requestId?: string;
  headerId?: string;
  generationId?: string;
  authorization?: string | null;
  apiKey?: string | null;
  configuredKey?: string;
  openRouter?: string;
  openRouterCost?: ReturnType<typeof openRouterCosts>;
};
type ProviderUsageEvent = {
  id?: unknown;
  generation_id?: unknown;
  usage?: unknown;
  response?: { id?: unknown; usage?: unknown };
  message?: { id?: unknown; usage?: unknown };
  error?: { metadata?: { generation_id?: unknown } };
};
const usageEvidence = new WeakMap<ReportedUsageFields, UsageEvidence>();

function evidenceFor(reported: ReportedUsageFields): UsageEvidence {
  const existing = usageEvidence.get(reported);
  if (existing) return existing;
  const evidence = { attempts: 0, rejected: false, uncertain: false, errorBodyPending: false };
  usageEvidence.set(reported, evidence);
  return evidence;
}

function safeRequestId(value: unknown, evidence: UsageEvidence): string | undefined {
  const secret = evidence.authorization?.replace(/^Bearer\s+/i, "");
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) &&
    (!secret || !value.includes(secret)) &&
    (!evidence.apiKey || !value.includes(evidence.apiKey)) &&
    (!evidence.configuredKey || !value.includes(evidence.configuredKey))
    ? value
    : undefined;
}

export function normalizePiUsage(
  usage: Partial<Usage> | undefined,
  model: Pick<Model<Api>, "cost">,
  reported: ReportedUsageFields = new Set(),
  allowCatalogEstimate = true,
): AgentUsage {
  const evidence = usageEvidence.get(reported);
  const rejected = evidence?.rejected && !evidence.uncertain;
  const token = (value: number | undefined, key: keyof AgentUsage) =>
    !evidence?.uncertain &&
    !rejected &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (value > 0 || (reported.has(key) && (reportedValues.get(reported)?.get(key) ?? 0) === 0))
      ? value
      : null;
  const inputTokens = token(usage?.input, "inputTokens");
  const outputTokens = token(usage?.output, "outputTokens");
  const cacheReadTokens = token(usage?.cacheRead, "cacheReadTokens");
  const cacheWriteTokens = token(usage?.cacheWrite, "cacheWriteTokens");
  const rawTotal = reportedValues.get(reported)?.get("totalTokens");
  const buckets = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens];
  const derivedTotal = buckets.every((value) => value !== null)
    ? buckets.reduce<number>((sum, value) => sum + value!, 0)
    : null;
  // Pi synthesizes totals using zero placeholders for absent cache measurements.
  // Trust a reported total, or derive one only from a complete measured breakdown.
  const totalTokens = reported.has("totalTokens")
    ? token(rawTotal ?? usage?.totalTokens, "totalTokens")
    : derivedTotal !== null && Number.isSafeInteger(derivedTotal)
      ? derivedTotal
      : null;
  let rates = model.cost;
  let tierKnown = true;
  if (rates?.tiers?.length) {
    const tierInput =
      inputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null
        ? inputTokens + cacheReadTokens + cacheWriteTokens
        : null;
    tierKnown = tierInput !== null && Number.isSafeInteger(tierInput);
    if (tierKnown) {
      // Match Pi's strict threshold and highest-tier selection; Pi still computes the amount.
      let matchedThreshold = -1;
      for (const tier of model.cost.tiers ?? []) {
        if (tierInput! > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
          rates = tier;
          matchedThreshold = tier.inputTokensAbove;
        }
      }
    }
  }
  const costKnown =
    !!rates &&
    tierKnown &&
    [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some((rate) => rate > 0) &&
    inputTokens !== null &&
    outputTokens !== null &&
    (rates.cacheRead === 0 || cacheReadTokens !== null) &&
    (rates.cacheWrite === 0 || cacheWriteTokens !== null);
  const providerCost = reportedCosts.get(reported);
  const estimate =
    allowCatalogEstimate &&
    costKnown &&
    typeof usage?.cost?.total === "number" &&
    Number.isFinite(usage.cost.total) &&
    usage.cost.total >= 0
      ? usage.cost.total
      : null;
  const costUsd =
    evidence?.uncertain || evidence?.errorBodyPending
      ? null
      : rejected
        ? 0
        : evidence?.openRouter
          ? (evidence.openRouterCost?.costUsd ?? null)
          : (providerCost ?? estimate);
  const costSource =
    costUsd === null
      ? null
      : rejected
        ? "provider-rejection"
        : evidence?.openRouter || providerCost !== undefined
          ? "provider-reported"
          : "pi-catalog-estimate";
  return {
    providerRequestId: evidence?.uncertain
      ? null
      : evidence?.errorBodyPending
        ? (evidence.headerId ?? null)
        : (evidence?.generationId ?? evidence?.requestId ?? evidence?.headerId ?? null),
    pricingSnapshot: UsagePricingSnapshotSchema.safeParse(model.cost).data ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: token(usage?.cacheWrite1h, "cacheWrite1hTokens"),
    reasoningTokens: token(usage?.reasoning, "reasoningTokens"),
    totalTokens,
    ...(!evidence?.uncertain && !rejected ? evidence?.openRouterCost : undefined),
    costUsd,
    costSource,
    pricingVersion: costSource === "pi-catalog-estimate" ? "pi-ai-1.3.0" : null,
    usageSource: rejected
      ? "provider-rejected"
      : reported.size
        ? "provider-reported-via-pi"
        : "pi-normalized",
  };
}

function observeRequestId(raw: unknown, evidence: UsageEvidence) {
  const id = safeRequestId(raw, evidence);
  if (id === undefined) return;
  evidence.requestId ??= id;
  if (evidence.openRouter && isOpenRouterGenerationId(id)) {
    if (evidence.generationId && evidence.generationId !== id) evidence.uncertain = true;
    evidence.generationId ??= id;
  }
}

function observeEventIdentity(event: ProviderUsageEvent | null, evidence: UsageEvidence): boolean {
  const ids = [
    event?.generation_id,
    event?.error?.metadata?.generation_id,
    event?.response?.id,
    event?.message?.id,
  ].filter((id) => id != null);
  for (const id of ids) observeRequestId(id, evidence);
  observeRequestId(event?.id, evidence);
  return (
    ids.length > 0 ||
    (typeof event?.id === "string" && /^(gen[-_]|resp_|chatcmpl-|msg_)/.test(event.id)) ||
    event?.usage != null ||
    event?.response?.usage != null ||
    event?.message?.usage != null
  );
}

const rejectedBeforeGeneration = new Set([400, 401, 402, 403, 404, 405, 406, 413, 415, 422, 429]);
/** A bounded error body can preserve the HTTP status after its transport was interrupted. */
export const incompleteModelErrorBodies = new WeakSet<Response>();

/** Inspect only what the SDK reads. An unread, incomplete, or billable response stays uncertain. */
function observeRejectionBody(response: Response, evidence: UsageEvidence): Response {
  const canReject = rejectedBeforeGeneration.has(response.status);
  const isJson = response.headers.get("content-type")?.toLowerCase().includes("json");
  if (!response.body) {
    evidence.rejected = canReject && !isJson && !evidence.generationId;
    return response;
  }
  evidence.errorBodyPending = true;
  const attempt = evidence.attempts;
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes <= 64 * 1024) text += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      flush() {
        if (
          attempt !== evidence.attempts ||
          incompleteModelErrorBodies.has(response) ||
          bytes > 64 * 1024 ||
          (isJson && bytes === 0)
        )
          return;
        text += decoder.decode();
        let event: ProviderUsageEvent | null;
        try {
          event = text.trim() ? JSON.parse(text) : null;
        } catch {
          if (isJson) return;
          event = null;
        }
        evidence.errorBodyPending = false;
        const hasGenerationEvidence = observeEventIdentity(event, evidence);
        evidence.rejected = canReject && !evidence.generationId && !hasGenerationEvidence;
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Read only bounded SSE frames, retaining field presence, never provider text or payloads. */
export function usageReportingFetch(
  fetcher: typeof fetch,
  reported: ReportedUsageFields,
): typeof fetch {
  return async (input, init) => {
    const evidence = evidenceFor(reported);
    // A second transport attempt can replace only a proven no-generation attempt.
    if (evidence.attempts++ > 0 && !evidence.rejected) evidence.uncertain = true;
    evidence.rejected = false;
    evidence.errorBodyPending = false;
    evidence.requestId = undefined;
    evidence.headerId = undefined;
    evidence.generationId = undefined;
    evidence.openRouterCost = undefined;
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    evidence.authorization = headers.get("authorization");
    evidence.apiKey = headers.get("x-api-key");
    evidence.openRouter =
      (init?.method ?? request?.method ?? "GET").toUpperCase() === "POST"
        ? openRouterInferencePath(request?.url ?? String(input))
        : undefined;
    reported.clear();
    reportedCosts.delete(reported);
    reportedValues.delete(reported);
    // Keep the package Agent paired after this wrapper hides the default fetch identity.
    const transport =
      init && "dispatcher" in init && init.dispatcher instanceof Agent
        ? fetchPairedWithDispatcher(fetcher)
        : fetcher;
    const response = await transport(input, init);
    if (
      response.redirected ||
      (evidence.openRouter &&
        response.url &&
        openRouterInferencePath(response.url) !== evidence.openRouter)
    ) {
      evidence.uncertain = true;
      evidence.openRouter = undefined;
    }
    const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
    if (evidence.openRouter) {
      const id = safeRequestId(response.headers.get("x-generation-id"), evidence);
      if (isOpenRouterGenerationId(id)) evidence.generationId = id;
    }
    evidence.headerId = safeRequestId(
      response.headers.get("x-request-id") ?? response.headers.get("request-id"),
      evidence,
    );
    if (!sse && !response.ok && !evidence.uncertain)
      return observeRejectionBody(response, evidence);
    if (!response.body || !sse) return response;
    const attempt = evidence.attempts;
    let buffer = "";
    let dropping = false;
    const decoder = new TextDecoder();
    const observe = (frame: string) => {
      if (attempt !== evidence.attempts) return;
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      try {
        const event = JSON.parse(data);
        observeEventIdentity(event, evidence);
        const usage = event.usage ?? event.response?.usage ?? event.message?.usage;
        if (!usage || typeof usage !== "object") return;
        const mark = (value: unknown, key: keyof AgentUsage) => {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            reported.add(key);
            const values = reportedValues.get(reported) ?? new Map();
            values.set(key, value);
            reportedValues.set(reported, values);
          }
        };
        const rawInput = usage.prompt_tokens ?? usage.input_tokens;
        const includesCache =
          usage.prompt_tokens !== undefined ||
          event.response !== undefined ||
          usage.input_tokens_details !== undefined;
        const rawRead =
          usage.prompt_tokens_details?.cached_tokens ??
          usage.input_tokens_details?.cached_tokens ??
          usage.prompt_cache_hit_tokens ??
          usage.cached_tokens;
        const rawWrite =
          usage.prompt_tokens_details?.cache_write_tokens ??
          usage.input_tokens_details?.cache_write_tokens;
        mark(
          typeof rawInput === "number" && includesCache
            ? Math.max(
                0,
                rawInput -
                  (typeof rawRead === "number" ? rawRead : 0) -
                  (typeof rawWrite === "number" ? rawWrite : 0),
              )
            : rawInput,
          "inputTokens",
        );
        mark(usage.completion_tokens ?? usage.output_tokens, "outputTokens");
        mark(usage.total_tokens, "totalTokens");
        if (
          evidence.openRouter &&
          (usage.cost !== undefined ||
            usage.is_byok !== undefined ||
            usage.cost_details !== undefined)
        ) {
          evidence.openRouterCost = openRouterCosts(
            usage.cost,
            usage.is_byok,
            usage.cost_details?.upstream_inference_cost,
          );
        } else if (
          typeof usage.cost === "number" &&
          Number.isFinite(usage.cost) &&
          usage.cost >= 0
        ) {
          reportedCosts.set(reported, usage.cost);
        }
        mark(rawRead ?? usage.cache_read_input_tokens, "cacheReadTokens");
        mark(rawWrite ?? usage.cache_creation_input_tokens, "cacheWriteTokens");
        mark(usage.cache_creation?.ephemeral_1h_input_tokens, "cacheWrite1hTokens");
        mark(
          usage.completion_tokens_details?.reasoning_tokens ??
            usage.output_tokens_details?.reasoning_tokens,
          "reasoningTokens",
        );
      } catch {
        /* Invalid/non-JSON SSE frames are handled by the provider parser. */
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            if (!dropping && frame.length <= 262144) observe(frame);
            dropping = false;
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
          if (buffer.length > 262144) {
            buffer = buffer.slice(-1);
            dropping = true;
          }
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function resolveUsage(
  usage: Partial<Usage> | undefined,
  model: Pick<Model<Api>, "cost">,
  reported: ReportedUsageFields,
  fetcher: typeof fetch,
  options: { signal?: AbortSignal; allowCatalogEstimate: boolean },
): Promise<AgentUsage> {
  const measured = normalizePiUsage(usage, model, reported, options.allowCatalogEstimate);
  const evidence = usageEvidence.get(reported);
  const authorization =
    evidence?.authorization ??
    (evidence?.openRouter === "/api/v1/messages" && evidence.apiKey
      ? `Bearer ${evidence.apiKey}`
      : undefined);
  if (
    measured.costUsd != null ||
    !evidence?.openRouter ||
    evidence.uncertain ||
    evidence.errorBodyPending ||
    !evidence.generationId ||
    !authorization ||
    !/^Bearer [A-Za-z0-9._~+/=-]+$/i.test(authorization) ||
    (evidence.apiKey && authorization.slice(7) !== evidence.apiKey)
  )
    return measured;

  const recovered = await lookupOpenRouterUsage(
    fetcher,
    evidence.generationId,
    authorization,
    options.signal,
  );
  if (
    !recovered ||
    (measured.openRouterFeeUsd !== undefined &&
      recovered.costUsd != null &&
      recovered.openRouterFeeUsd === undefined)
  )
    return measured;
  return {
    ...measured,
    inputTokens: measured.inputTokens ?? recovered.inputTokens ?? null,
    outputTokens: measured.outputTokens ?? recovered.outputTokens ?? null,
    cacheReadTokens: measured.cacheReadTokens ?? recovered.cacheReadTokens ?? null,
    reasoningTokens: measured.reasoningTokens ?? recovered.reasoningTokens ?? null,
    totalTokens: measured.totalTokens ?? recovered.totalTokens ?? null,
    openRouterFeeUsd: recovered.openRouterFeeUsd ?? measured.openRouterFeeUsd,
    upstreamInferenceCostUsd:
      recovered.upstreamInferenceCostUsd ?? measured.upstreamInferenceCostUsd,
    ...(recovered.costUsd != null
      ? {
          costUsd: recovered.costUsd,
          costSource: "provider-reported",
          usageSource: "provider-reconciled",
        }
      : {}),
  };
}

/** One exclusive bucket per whole model call, including any answer alongside retrieval.
 * Setup, compaction and subagent attribution takes precedence. Only immediately consumed
 * trailing tool results count; an old search in retained history does not reclassify new work.
 */
function usageOperationKind(
  base: UsageOperationKind,
  context: Context,
  message: AssistantMessage,
): UsageOperationKind {
  if (base !== "answer") return base;
  const historyTool = (name: string) => name === "search_history" || name === "read_history";
  if (message.content.some((part) => part.type === "toolCall" && historyTool(part.name)))
    return "retrieval";
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const previous = context.messages[index]!;
    if (previous.role !== "toolResult") break;
    if (historyTool(previous.toolName)) return "retrieval";
  }
  return base;
}

/** Guard and account every actual model invocation, including tools, failures and subagents. */
export type PiDispatchBudget = {
  inputTokens: number;
  maxOutputTokens: number;
  providerRetryAfterMs?: number;
  providerQuotaResetAt?: number;
};

export type PiBudgetCorrection = {
  previous: PiDispatchBudget;
  kind: "request-input" | "context-window" | "output";
};

export function observedPiStream(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  push: (event: AgentRuntimeEvent) => void,
  observer?: ModelCallObserver,
  attribution: {
    operationKind: UsageOperationKind;
    agentId?: string;
    modelCredentialId?: string | null;
  } = {
    operationKind: "answer",
  },
  hooks?: {
    prepareContext?: (context: Context, model: Model<Api>) => Context;
    imageTokens?: ContextBudget["imageTokens"];
    onUsage?: (usage: AgentUsage) => void;
    recordUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => void | Promise<void>;
    /** Provider failures only; excludes context, reservations and usage settlement. */
    onProviderError?: (message: AssistantMessage, budget: PiDispatchBudget) => void;
    onProviderDone?: (message: AssistantMessage, budget: PiDispatchBudget) => void;
    budgetCorrection?: PiBudgetCorrection;
    /** Corrective attempts share a deadline across context preparation and reservation. */
    requestDeadline?: number;
    onRequestDeadlineExceeded?: (message: AssistantMessage) => void;
  },
) {
  const stream = createAssistantMessageEventStream();
  const reported: ReportedUsageFields = new Set();
  evidenceFor(reported).configuredKey = options?.apiKey;
  const usageModel = { cost: structuredClone(model.cost) };
  const fetcher = options?.fetch ?? globalThis.fetch;
  const callId = randomUUID();
  const emitUsage = async (usage: AgentUsage, operationKind = attribution.operationKind) => {
    const event = {
      type: "usage" as const,
      ...usage,
      provider: model.provider,
      model: model.id,
      callId,
      ...attribution,
      ...(attribution.modelCredentialId === undefined
        ? {}
        : {
            costOwner:
              attribution.modelCredentialId === null ? ("deployment" as const) : ("user" as const),
          }),
      operationKind,
    };
    try {
      await hooks?.recordUsage?.(event);
    } catch (error) {
      push(event);
      throw error;
    }
    push({ ...event, ...(hooks?.recordUsage ? { accounted: true } : {}) });
  };
  void (async () => {
    let normalized: AgentUsage | null = null;
    let reservation: string | undefined;
    let started = false;
    let settled = false;
    let partialMessage: AssistantMessage | undefined;
    let providerError: unknown;
    let providerThrew = false;
    let dispatchBudget: (() => PiDispatchBudget) | undefined;
    let providerResponse:
      | {
          status: number;
          receivedAt: number;
          retryAfterMs?: number;
          quotaResetAt?: number;
        }
      | undefined;
    let observedFetchResponse = false;
    const failedBudget = (
      message: AssistantMessage,
      budget: PiDispatchBudget,
    ): PiDispatchBudget => {
      const receivedAt = providerResponse?.receivedAt ?? Date.now();
      const retryAfterMs = providerResponse?.retryAfterMs;
      const quotaResetAt = Math.max(
        providerResponse?.quotaResetAt ?? 0,
        providerErrorQuotaResetAt(message.errorMessage, providerResponse?.status, receivedAt) ?? 0,
      );
      return {
        ...budget,
        ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }),
        ...(quotaResetAt ? { providerQuotaResetAt: quotaResetAt } : {}),
      };
    };
    let requestDeadlineError: Error | undefined;
    let deadlineController: AbortController | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineActive = false;
    let notifyDeadline: (() => void) | undefined;
    const deadlineExpired =
      hooks?.requestDeadline === undefined
        ? undefined
        : new Promise<{ kind: "deadline" }>((resolve) => {
            notifyDeadline = () => resolve({ kind: "deadline" });
          });
    let payloadReady = false;
    let requestDispatched = false;
    const clearDeadline = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      deadlineActive = false;
    };
    const observeResponse = (
      status: number,
      retryAfter: string | null | undefined,
      rateLimitReset: string | null | undefined,
    ) => {
      if (status >= 200 && status < 300) clearDeadline();
      const receivedAt = Date.now();
      const value = retryAfter?.trim();
      const delay =
        (status === 429 || status === 503) && value
          ? /^\d+$/.test(value)
            ? Number(value) * 1_000
            : Date.parse(value) - receivedAt
          : 0;
      const quotaResetAt =
        status === 429
          ? Math.max(
              providerRetryAfterAt(retryAfter, receivedAt) ?? 0,
              providerResetAt(rateLimitReset, receivedAt) ?? 0,
            ) || undefined
          : undefined;
      providerResponse = {
        status,
        receivedAt,
        retryAfterMs: Number.isFinite(delay) && delay > 0 ? delay : undefined,
        quotaResetAt,
      };
    };
    const expireDeadline = () => {
      requestDeadlineError ??= new Error("Model request deadline expired before headers");
      notifyDeadline?.();
      deadlineController?.abort(requestDeadlineError);
      return requestDeadlineError;
    };
    const checkDeadline = () => {
      options?.signal?.throwIfAborted();
      if (hooks?.requestDeadline !== undefined && Date.now() >= hooks.requestDeadline)
        throw expireDeadline();
    };
    try {
      // A tool-budget or cancellation stop can reach Pi's next-turn hook after
      // aborting. It is not a model invocation and must not create unknown usage.
      options?.signal?.throwIfAborted();
      // Reject an unsupported declared control before reserving or making any request.
      const cacheRetention = resolvePiCacheRetention(model, options?.cacheRetention);
      const preparedContext = hooks?.prepareContext?.(context, model) ?? context;
      const effectiveMaxTokens = effectivePiOutputTokens(
        model,
        preparedContext,
        options?.maxTokens ?? model.maxTokens,
      );
      const maxOutputTokens = effectiveMaxTokens ?? options?.maxTokens ?? model.maxTokens;
      let inputTokens: number | undefined;
      const measuredBudget = () => {
        inputTokens ??= estimateModelContextTokens(preparedContext, hooks?.imageTokens);
        return { inputTokens, maxOutputTokens };
      };
      dispatchBudget = measuredBudget;
      if (hooks?.budgetCorrection) {
        const { previous, kind } = hooks.budgetCorrection;
        const measured = measuredBudget();
        const smallerOutputWithSameInput =
          measured.inputTokens === previous.inputTokens &&
          measured.maxOutputTokens < previous.maxOutputTokens;
        const reduced =
          (kind !== "output" && measured.inputTokens < previous.inputTokens) ||
          (kind !== "request-input" && smallerOutputWithSameInput);
        if (!reduced) throw new Error(MODEL_BUDGET_UNCHANGED_ERROR);
      }
      reservation = observer
        ? await observer.beforeCall({
            provider: model.provider,
            modelId: model.id,
            inputTokensEstimate: measuredBudget().inputTokens,
            maxOutputTokens,
            cacheWriteRetention: requestedPiCacheWriteRetention(model, cacheRetention),
          })
        : undefined;
      options?.signal?.throwIfAborted();
      const remainingMs =
        hooks?.requestDeadline === undefined ? undefined : hooks.requestDeadline - Date.now();
      checkDeadline();
      if (remainingMs !== undefined) {
        deadlineController = new AbortController();
        deadlineActive = true;
        deadlineTimer = setTimeout(expireDeadline, remainingMs);
        deadlineTimer.unref?.();
      }
      started = true;
      // Some Pi adapters reject custom fetch outright. Only audited SSE families opt in.
      const collectRawUsage =
        /^(openai-|anthropic-)/.test(model.api) && !model.provider.startsWith("google");
      // Each guarded reservation covers one HTTP attempt, not hidden SDK retries.
      const payloadOptions = withGoogleToolHistory(
        model,
        withChatCompletionsCompatibility(model, options ?? {}),
      );
      const streamOptions: SimpleStreamOptions = {
        ...options,
        ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
        ...(remainingMs === undefined
          ? {}
          : {
              timeoutMs: remainingMs,
              signal: options?.signal
                ? AbortSignal.any([options.signal, deadlineController!.signal])
                : deadlineController!.signal,
            }),
        ...(deadlineController || hooks?.onProviderError
          ? {
              onResponse: (response, requestModel) => {
                // The transport already captured the relative delay at header receipt.
                if (!observedFetchResponse)
                  observeResponse(
                    response.status,
                    response.headers["retry-after"],
                    response.headers["x-ratelimit-reset"],
                  );
                return options?.onResponse?.(response, requestModel);
              },
            }
          : {}),
        onPayload: async (payload, requestModel) => {
          const original =
            payload && typeof payload === "object"
              ? {
                  ...payload,
                  ...("thinking" in payload &&
                  payload.thinking &&
                  typeof payload.thinking === "object" &&
                  !Array.isArray(payload.thinking)
                    ? { thinking: { ...payload.thinking } }
                    : {}),
                }
              : payload;
          const replacement = await payloadOptions.onPayload?.(payload, requestModel);
          const finalPayload = finalPiOutputPayload(
            model,
            original,
            replacement ?? payload,
            maxOutputTokens,
            options,
          );
          checkDeadline();
          payloadReady = true;
          return finalPayload;
        },
        ...(cacheRetention ? { cacheRetention } : {}),
        ...(observer ? { maxRetries: 0 } : {}),
      };
      let upstream: ReturnType<Models["streamSimple"]>;
      try {
        const usageFetch = usageReportingFetch(fetcher, reported);
        upstream = models.streamSimple(
          model,
          preparedContext,
          collectRawUsage
            ? {
                ...streamOptions,
                onProviderStreamEvent: (data, eventModel) => {
                  const evidence = evidenceFor(reported);
                  if (data && typeof data === "object")
                    observeEventIdentity(data as ProviderUsageEvent, evidence);
                  return streamOptions.onProviderStreamEvent?.(data, eventModel);
                },
                fetch:
                  deadlineController || hooks?.onProviderError
                    ? async (input, init) => {
                        checkDeadline();
                        requestDispatched = true;
                        providerResponse = undefined;
                        observedFetchResponse = false;
                        const response = await usageFetch(input, init);
                        observeResponse(
                          response.status,
                          response.headers.get("retry-after"),
                          response.headers.get("x-ratelimit-reset"),
                        );
                        observedFetchResponse = true;
                        return response;
                      }
                    : usageFetch,
              }
            : streamOptions,
        );
      } catch (error) {
        providerThrew = true;
        providerError = error;
        throw error;
      }
      const events = hooks?.onProviderError
        ? (async function* () {
            try {
              yield* upstream;
            } catch (error) {
              providerThrew = true;
              providerError = error;
              throw error;
            }
          })()
        : upstream;
      const iterator = events[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = iterator.next().then((value) => ({ kind: "event" as const, value }));
          const outcome = await (deadlineActive && deadlineExpired
            ? Promise.race([next, deadlineExpired])
            : next);
          if (outcome.kind === "deadline") {
            // Before payload preparation, or before an audited fetch, no model request left.
            if (!payloadReady || (collectRawUsage && !requestDispatched)) started = false;
            options?.signal?.throwIfAborted();
            throw requestDeadlineError;
          }
          if (outcome.value.done) break;
          const event = outcome.value.value;
          if (event.type === "error" && event.error.errorMessage) {
            event.error.errorMessage = modelConnectionStreamErrorMessage(
              models,
              model,
              event.error.errorMessage,
              options?.apiKey,
            );
          }
          // These APIs expose no response hook; their start follows generateContentStream.
          if (
            event.type === "start" &&
            (model.api === "google-generative-ai" || model.api === "google-vertex")
          )
            clearDeadline();
          if (event.type === "done" || event.type === "error") {
            clearDeadline();
          }
          if (hooks?.onProviderError) {
            partialMessage =
              event.type === "done"
                ? event.message
                : event.type === "error"
                  ? event.error
                  : event.partial;
          }
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            observeRequestId(message.responseId, evidenceFor(reported));
            normalized = await resolveUsage(
              message.usage,
              usageModel,
              reported,
              fetcher,
              // An error can carry partial token counts that Pi priced as if the call had finished.
              { signal: options?.signal, allowCatalogEstimate: event.type === "done" },
            );
            await emitUsage(
              normalized,
              usageOperationKind(attribution.operationKind, preparedContext, message),
            );
            try {
              hooks?.onUsage?.(normalized);
            } catch {
              /* Cache telemetry cannot discard accounted spend. */
            }
            if (observer && reservation !== undefined) {
              settled = true;
              await observer.afterCall(reservation, normalized);
            }
          }
          if (event.type === "error")
            hooks?.onProviderError?.(event.error, failedBudget(event.error, measuredBudget()));
          if (event.type === "done" && hooks?.onProviderDone)
            hooks.onProviderDone(event.message, measuredBudget());
          stream.push(event);
        }
      } finally {
        void iterator.return?.().catch(() => undefined);
      }
      const result = await upstream.result();
      if (result.errorMessage)
        result.errorMessage = modelConnectionStreamErrorMessage(
          models,
          model,
          result.errorMessage,
          options?.apiKey,
        );
      stream.end(result);
    } catch (error) {
      clearDeadline();
      let terminalError = error;
      if (started && normalized === null) {
        try {
          const failedUsage = await resolveUsage(undefined, usageModel, reported, fetcher, {
            signal: options?.signal,
            allowCatalogEstimate: false,
          });
          if (failedUsage.costUsd != null || failedUsage.providerRequestId != null) {
            normalized = failedUsage;
          }
          await emitUsage(failedUsage);
        } catch (accountingError) {
          terminalError = accountingError;
        }
      }
      if (observer && reservation !== undefined && !settled) {
        // Keep the reservation alive until settlement finishes, before exposing termination.
        settled = true;
        try {
          await observer.afterCall(reservation, normalized);
        } catch {
          /* Already failing. */
        }
      }
      // Preserve a proper Pi terminal message so Agent and cancellation both settle.
      const message = {
        role: "assistant" as const,
        content: hooks?.onProviderError ? (partialMessage?.content ?? []) : [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error" as const,
        errorMessage: modelConnectionStreamErrorMessage(
          models,
          model,
          terminalError,
          options?.apiKey,
        ),
        timestamp: Date.now(),
      };
      if (
        providerThrew &&
        terminalError === providerError &&
        terminalError !== requestDeadlineError &&
        dispatchBudget
      )
        hooks?.onProviderError?.(message, failedBudget(message, dispatchBudget()));
      if (requestDeadlineError && terminalError === requestDeadlineError)
        hooks?.onRequestDeadlineExceeded?.(message);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    } finally {
      clearDeadline();
    }
  })();
  return stream;
}
