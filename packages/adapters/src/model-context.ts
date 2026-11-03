import type { Context } from "@earendil-works/pi-ai";
import type { ContextBudget } from "./context-selection.js";
import { estimateContextTokens, providerContextPrefix } from "./context-selection.js";

/** Shared provider framing allowance for planning and reservation. */
export const MODEL_CONTEXT_FRAMING_TOKENS = 240;

const MIN_FALLBACK_CONTEXT_MARGIN = 256;
const FALLBACK_CONTEXT_MARGIN_DIVISOR = 10;

export function fallbackContextSafetyMargin(inputTokens: number): number {
  return Math.max(
    MIN_FALLBACK_CONTEXT_MARGIN,
    Math.ceil(inputTokens * (1 / FALLBACK_CONTEXT_MARGIN_DIVISOR)),
  );
}

/** Highest integer input estimate admitted by the strict fallback margin, including framing. */
export function maxFallbackInputTokens(contextWindow: number, outputTokens: number): number {
  const available = Math.floor(contextWindow - outputTokens - 1);
  // floor(10*n/11) = n-ceil(n/11), without a potentially unsafe multiplication.
  return Math.max(
    0,
    Math.min(
      available - MIN_FALLBACK_CONTEXT_MARGIN,
      available - Math.ceil(available / (FALLBACK_CONTEXT_MARGIN_DIVISOR + 1)),
    ),
  );
}

/**
 * Provider-neutral planning estimate, including tool schemas and message framing.
 * An adapter image estimate applies only to actual image blocks; unknown images
 * retain their serialized-byte fallback.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  return (
    estimateContextTokens(
      providerContextPrefix(context.systemPrompt ?? "", context.tools ?? [], context.messages),
      imageTokens,
    ) + MODEL_CONTEXT_FRAMING_TOKENS
  );
}
