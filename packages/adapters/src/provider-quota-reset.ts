function futureDate(value: number, now: number): number | undefined {
  return Number.isSafeInteger(value) && value > now && Number.isFinite(new Date(value).getTime())
    ? value
    : undefined;
}

/** Retry-After is delta-seconds or an HTTP date, anchored to response receipt. */
export function providerRetryAfterAt(value: unknown, receivedAt: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return futureDate(receivedAt + Number(text) * 1_000, receivedAt);
  const date = new Date(text);
  return date.toUTCString() === text ? futureDate(date.getTime(), receivedAt) : undefined;
}

/** Gateways report an epoch in seconds or milliseconds, or a full UTC timestamp. */
export function providerResetAt(value: unknown, receivedAt: number): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^(?:\d{10}|\d{13})$/.test(text))
    return futureDate(Number(text) * (text.length === 10 ? 1_000 : 1), receivedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) return undefined;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === text.slice(0, 19)
    ? futureDate(date.getTime(), receivedAt)
    : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Accept structured reset metadata only from an observed provider error. */
export function providerErrorQuotaResetAt(
  diagnostic: string | undefined,
  status: number | undefined,
  receivedAt: number,
): number | undefined {
  if (!diagnostic || diagnostic.length > 32_000 || status !== 429) return undefined;
  const text = diagnostic.trim();
  const prefix = /^(?:(?:HTTP )?(\d{3})(?=[:\s])|[^\n():]{1,60} API error \((\d{3})\))[:\s]*/i.exec(
    text,
  );
  if (prefix && Number(prefix[1] ?? prefix[2]) !== status) return undefined;
  let body: Record<string, unknown>;
  try {
    body = object(JSON.parse(text.slice(prefix?.[0].length ?? 0)));
  } catch {
    return undefined;
  }
  const payload = object(body.error ?? body);
  const metadata = object(payload.metadata ?? body.metadata);
  const headers = new Map(
    Object.entries(object(metadata.headers)).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const resetAt = Math.max(
    providerResetAt(headers.get("x-ratelimit-reset"), receivedAt) ?? 0,
    providerRetryAfterAt(headers.get("retry-after"), receivedAt) ?? 0,
    providerResetAt(metadata.reset_at ?? metadata.resetAt ?? metadata.reset, receivedAt) ?? 0,
    providerResetAt(payload.reset_at ?? payload.resetAt, receivedAt) ?? 0,
  );
  return resetAt || undefined;
}
