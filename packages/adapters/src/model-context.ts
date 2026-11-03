import type { Context } from "@earendil-works/pi-ai";
import type { ContextBudget } from "./context-selection.js";
import { estimateContextTokens, providerContextPrefix } from "./context-selection.js";

/** Shared provider framing allowance for planning and reservation. */
export const MODEL_CONTEXT_FRAMING_TOKENS = 240;

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
