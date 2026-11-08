/** Groq's token-rate rejection identifies a ceiling for this request. */
export function groqRequestContextWindow(
  provider: string,
  errorMessage: string | undefined,
  currentWindow: number,
): number | undefined {
  if (
    provider !== "groq" ||
    !errorMessage ||
    errorMessage.length > 16_384 ||
    !/^413\b/.test(errorMessage)
  )
    return;
  try {
    const start = errorMessage.indexOf("{");
    if (start < 0) return;
    const parsed = JSON.parse(errorMessage.slice(start)) as GroqTokenError & {
      error?: GroqTokenError;
    };
    const error = parsed.error ?? parsed;
    if (error.code !== "rate_limit_exceeded" || error.type !== "tokens") return;
    const match = error.message?.match(
      /on tokens per minute \(TPM\): Limit (\d+), Requested (\d+),/,
    );
    if (!match) return;
    const limit = Number(match[1]);
    const requested = Number(match[2]);
    if (!Number.isSafeInteger(requested) || requested <= limit) return;
    return reducedContextWindow(limit, currentWindow);
  } catch {
    return;
  }
}

type GroqTokenError = { code?: string; type?: string; message?: string };

/** Allow for provider tokenizer differences and only lower a valid request window. */
export function reducedContextWindow(limit: number, currentWindow: number): number | undefined {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(currentWindow)) return;
  const window = Math.floor(limit * 0.85);
  return window > 0 && window < currentWindow ? window : undefined;
}
