import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { reducedContextWindow } from "./groq-request-budget.js";

const REPORTED_WINDOW = [
  /maximum context length is (\d+) tokens/i,
  /model'?s (?:maximum )?context length (?:of )?\(?(\d+)/i,
  /"n_ctx"\s*:\s*(\d+)/,
  /loaded with context length of only (\d+) tokens/i,
];

/** The window an OpenAI-compatible server reports when an oversized request fails. */
export function reportedContextWindow(
  provider: string,
  errorMessage: string | undefined,
  currentWindow: number,
): number | undefined {
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID || !errorMessage || errorMessage.length > 16_384)
    return;
  for (const pattern of REPORTED_WINDOW) {
    const limit = Number(errorMessage.match(pattern)?.[1]);
    if (Number.isSafeInteger(limit) && limit >= 1)
      return reducedContextWindow(limit, currentWindow);
  }
  return;
}
