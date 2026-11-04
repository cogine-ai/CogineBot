import type { Api, Model, Models, Provider } from "@earendil-works/pi-ai";

/** Error diagnostics are connection-scoped; normal user and model text never passes here. */
export function modelConnectionErrorMessage(
  error: unknown,
  connection: { apiKey?: string; headers?: Readonly<Record<string, string>> },
): string {
  const message = error instanceof Error ? error.message : String(error);
  const values = [connection.apiKey, ...Object.values(connection.headers ?? {})];
  const variants = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    for (const value of [raw, raw.trim()]) {
      let encoded = value;
      for (let depth = 0; depth < 3; depth++) {
        variants.add(encoded);
        encoded = JSON.stringify(encoded).slice(1, -1);
      }
    }
  }
  if (![...variants].some((value) => message.includes(value))) return message;
  // Once a provider reflects a connection secret, discard its untrusted prose rather than
  // replacing short substrings inside HTTP status/category fields used by recovery.
  const declaredStatus =
    error && typeof error === "object" && "status" in error ? error.status : undefined;
  const parsedStatus = /^(?:[^\n():]{1,60} API error \((\d{3})\):\s*|(\d{3})(?:\s*:\s*|\s+))/.exec(
    message,
  );
  const status =
    typeof declaredStatus === "number" &&
    Number.isInteger(declaredStatus) &&
    declaredStatus >= 100 &&
    declaredStatus <= 599
      ? declaredStatus
      : Number(parsedStatus?.[1] ?? parsedStatus?.[2]) || undefined;
  const categories = [
    ["context_length_exceeded", 400],
    ["insufficient_quota", 402],
    ["authentication_error", 401],
    ["permission_error", 403],
    ["rate_limit_error", 429],
    ["overloaded_error", 529],
  ] as const;
  const category = categories.find(([name]) => message.includes(name));
  return `${status ?? category?.[1] ?? 500}: ${category?.[0] ?? "Model request failed."}`;
}

const connectionHeaders = new WeakMap<Provider, Readonly<Record<string, string>>>();
export function registerModelConnectionHeaders(
  provider: Provider,
  headers: Readonly<Record<string, string>>,
): void {
  connectionHeaders.set(provider, { ...headers });
}
export function modelConnectionStreamErrorMessage(
  models: Models,
  model: Model<Api>,
  error: unknown,
  apiKey?: string,
): string {
  if (model.provider !== "openai-compatible")
    return error instanceof Error ? error.message : String(error);
  const provider = models.getProvider?.(model.provider);
  return modelConnectionErrorMessage(error, {
    apiKey,
    headers: provider ? connectionHeaders.get(provider) : undefined,
  });
}
