import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  clampMaxTokensToContext,
  clampReasoning,
  clampThinkingBudgetToAnswerRoom,
} from "@earendil-works/pi-ai/api/simple-options";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

/** The audited SDK families share the same reservation and final serialized cap. */
export function effectivePiOutputTokens(
  model: Model<Api>,
  context: Context,
  requestedMaxTokens: number,
): number | undefined {
  return model.api === "openai-completions" ||
    model.api === "openai-responses" ||
    model.api === "anthropic-messages"
    ? clampMaxTokensToContext(model, normalizeContext(context), requestedMaxTokens)
    : undefined;
}

/** Apply after caller replacement: SDK floors and thinking additions cannot expand a reservation. */
export function finalPiOutputPayload(
  model: Model<Api>,
  original: unknown,
  payload: unknown,
  cap: number,
  options?: SimpleStreamOptions,
): unknown {
  if (
    model.api !== "openai-completions" &&
    model.api !== "openai-responses" &&
    model.api !== "anthropic-messages"
  )
    return payload;
  if (!isRecord(payload) || !isRecord(original))
    throw new Error("Model request payload must be an object");
  const field =
    model.api === "openai-responses"
      ? "max_output_tokens"
      : model.api === "anthropic-messages"
        ? "max_tokens"
        : "max_completion_tokens" in original
          ? "max_completion_tokens"
          : "max_tokens";
  const next = { ...payload };
  delete next.max_tokens;
  delete next.max_completion_tokens;
  delete next.max_output_tokens;
  next[field] = cap;
  if (
    model.api === "anthropic-messages" &&
    isRecord(next.thinking) &&
    next.thinking.type === "enabled"
  ) {
    const budgetLevel = clampReasoning(options?.reasoning);
    const configuredBudget = budgetLevel ? options?.thinkingBudgets?.[budgetLevel] : undefined;
    const thinkingBudget = next.thinking.budget_tokens;
    const sdkThinking = original.thinking;
    const callerChangedThinking =
      !isRecord(sdkThinking) ||
      sdkThinking.type !== next.thinking.type ||
      sdkThinking.budget_tokens !== thinkingBudget;
    if (callerChangedThinking || (configuredBudget !== undefined && configuredBudget !== 0)) {
      // Explicit budgets are promises, unlike the SDK's automatically chosen level budget.
      if (
        typeof thinkingBudget !== "number" ||
        !Number.isSafeInteger(thinkingBudget) ||
        thinkingBudget < 1024 ||
        thinkingBudget >= cap
      )
        throw new Error("Model thinking budget exceeds the reserved output limit");
    } else {
      if (
        typeof thinkingBudget !== "number" ||
        !Number.isSafeInteger(thinkingBudget) ||
        thinkingBudget < 0
      )
        throw new Error("Model thinking budget exceeds the reserved output limit");
      const fitted =
        configuredBudget === 0 ? 0 : clampThinkingBudgetToAnswerRoom(thinkingBudget, cap);
      if (fitted < 1024) {
        if (!getSupportedThinkingLevels(model).includes("off"))
          throw new Error("Model thinking budget exceeds the reserved output limit");
        next.thinking = { type: "disabled" };
      } else next.thinking = { ...next.thinking, budget_tokens: fitted };
    }
  }
  return next;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
