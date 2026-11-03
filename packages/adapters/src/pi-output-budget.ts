import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

/** Match the audited Chat Completions SDK guard without changing other API budgets. */
export function effectivePiOutputTokens(
  model: Model<Api>,
  context: Context,
  requestedMaxTokens: number,
): number | undefined {
  return model.api === "openai-completions"
    ? clampMaxTokensToContext(model, normalizeContext(context), requestedMaxTokens)
    : undefined;
}
