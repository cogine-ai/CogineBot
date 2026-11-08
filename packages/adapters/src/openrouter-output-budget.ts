/** Read the affordable output reservation from a verified OpenRouter credit error. */
export function affordableOpenRouterOutput(
  provider: string,
  errorMessage: string | undefined,
  currentLimit: number,
): number | undefined {
  if (
    provider !== "openrouter" ||
    !errorMessage ||
    errorMessage.length > 16_384 ||
    !/^402\b/.test(errorMessage) ||
    !Number.isSafeInteger(currentLimit) ||
    currentLimit < 1
  )
    return;
  try {
    const start = errorMessage.indexOf("{");
    if (start < 0) return;
    const parsed = JSON.parse(errorMessage.slice(start)) as CreditError & { error?: CreditError };
    const error = parsed.error ?? parsed;
    if ((error.metadata ?? parsed.metadata)?.limit_source !== "openrouter_credits") return;
    const match = error.message?.match(
      /^This request requires more credits, or fewer max_tokens\. You requested up to (\d+) tokens, but can only afford (\d+)\./,
    );
    if (!match) return;
    const requested = Number(match[1]);
    const affordable = Number(match[2]);
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(affordable)) return;
    if (affordable < 1 || affordable >= requested || affordable >= currentLimit) return;
    return affordable;
  } catch {
    return;
  }
}

type CreditError = { message?: string; metadata?: { limit_source?: string } };
