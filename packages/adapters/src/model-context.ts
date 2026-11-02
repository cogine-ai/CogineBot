import type { Context } from "@earendil-works/pi-ai";
import type { ContextBudget } from "./context-selection.js";
import { estimateContextTokens } from "./context-selection.js";

/**
 * Provider-neutral planning estimate, including tool schemas and message framing.
 * An adapter image estimate applies only to actual image blocks; unknown images
 * retain their serialized-byte fallback.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  return estimateContextTokens(context, imageTokens) + 240;
}
