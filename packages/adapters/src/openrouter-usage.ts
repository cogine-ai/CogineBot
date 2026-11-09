import type { AgentUsage } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const origin = "https://openrouter.ai";
const inferencePaths = new Set([
  "/api/v1/chat/completions",
  "/api/v1/responses",
  "/api/v1/messages",
]);
const amount = z.number().nonnegative().nullish();
const tokens = z.number().int().min(0).max(2_147_483_647).nullish();
const generation = z.object({
  data: z.object({
    id: z.string(),
    total_cost: amount,
    is_byok: z.boolean().nullish(),
    upstream_inference_cost: amount,
    native_tokens_prompt: tokens,
    native_tokens_completion: tokens,
    native_tokens_cached: tokens,
    native_tokens_reasoning: tokens,
  }),
});

export function openRouterInferencePath(url: string): string | undefined {
  const parsed = URL.parse(url);
  return parsed?.origin === origin &&
    !parsed.username &&
    !parsed.password &&
    inferencePaths.has(parsed.pathname)
    ? parsed.pathname
    : undefined;
}

export function isOpenRouterGenerationId(id: unknown): id is string {
  return typeof id === "string" && /^gen[-_][A-Za-z0-9_-]{1,251}$/.test(id);
}

/** BYOK fees are only one component of the combined provider cost. */
export function openRouterCosts(
  charge: unknown,
  isByok: unknown,
  upstream: unknown,
): Pick<AgentUsage, "costUsd" | "openRouterFeeUsd" | "upstreamInferenceCostUsd"> {
  const fee = amount.safeParse(charge).data ?? null;
  if (isByok === false) return { costUsd: fee };
  if (isByok !== true) return { costUsd: null };
  const inference = amount.safeParse(upstream).data ?? null;
  const total = fee === null || inference === null ? null : fee + inference;
  return {
    openRouterFeeUsd: fee,
    upstreamInferenceCostUsd: inference,
    costUsd: total !== null && Number.isFinite(total) ? total : null,
  };
}

/** Resolve only the generation named by the original request, with its original authorization. */
export async function lookupOpenRouterUsage(
  fetcher: typeof fetch,
  id: string,
  authorization: string,
  callerSignal?: AbortSignal,
): Promise<Partial<AgentUsage> | null> {
  if (!isOpenRouterGenerationId(id)) return null;
  const url = new URL("/api/v1/generation", origin);
  url.searchParams.set("id", id);
  const timeout = AbortSignal.timeout(5_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const response = await withAbort(
      fetcher(url.href, {
        headers: { Authorization: authorization },
        redirect: "error",
        signal,
      }),
      signal,
    );
    if (!response.ok || response.redirected || (response.url && response.url !== url.href)) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readBodyCapped(response, 64 * 1024, signal);
    const parsed = generation.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success || parsed.data.data.id !== id) return null;
    const data = parsed.data.data;
    const prompt = data.native_tokens_prompt;
    const output = data.native_tokens_completion;
    const cached = data.native_tokens_cached;
    return {
      ...openRouterCosts(data.total_cost, data.is_byok, data.upstream_inference_cost),
      ...(prompt != null && cached != null && cached <= prompt
        ? { inputTokens: prompt - cached }
        : {}),
      ...(output == null ? {} : { outputTokens: output }),
      ...(cached == null ? {} : { cacheReadTokens: cached }),
      ...(data.native_tokens_reasoning == null
        ? {}
        : { reasoningTokens: data.native_tokens_reasoning }),
      ...(prompt != null && output != null && prompt + output <= 2_147_483_647
        ? { totalTokens: prompt + output }
        : {}),
    };
  } catch {
    return null;
  }
}
