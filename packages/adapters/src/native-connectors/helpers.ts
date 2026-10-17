import type { NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";

export type Obj = Record<string, unknown>;
export type Schema = Record<string, unknown>;

export function object(value: unknown, label = "object"): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeActionError("invalid_input", `Expected ${label}.`);
  }
  return value as Obj;
}

export function only(args: Obj, keys: readonly string[]): void {
  if (Object.keys(args).some((key) => !keys.includes(key))) {
    throw new NativeActionError("invalid_input", "Unsupported action parameter.");
  }
}

export function text(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max) {
    throw new NativeActionError("invalid_input", `Invalid ${label}.`);
  }
  return value;
}

export function uuid(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw new NativeActionError("invalid_input", `Invalid ${label}.`);
  }
  return result;
}

export function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new NativeActionError("invalid_input", `Invalid ${label}.`);
  }
  return [...new Set(value)] as string[];
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new NativeActionError("invalid_input", `Invalid ${label}.`);
  }
  return value;
}

export function pick(args: Obj, keys: readonly string[]): Obj {
  return Object.fromEntries(
    keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  );
}

export function query(
  args: Obj,
  keys: readonly string[],
): Record<string, string | number | boolean | undefined> {
  const output: Record<string, string | number | boolean | undefined> = {};
  for (const key of keys) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new NativeActionError("invalid_input", `Invalid ${key}.`);
    }
    if (typeof value === "number" && !Number.isFinite(value))
      throw new NativeActionError("invalid_input", `Invalid ${key}.`);
    output[key] = value;
  }
  return output;
}

export function shape(properties: Obj, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

export function requireCapabilities(
  context: NativeActionContext,
  capabilities: readonly string[],
): void {
  if (capabilities.some((capability) => !context.principal.capabilities.includes(capability))) {
    throw new NativeActionError(
      "insufficient_scope",
      "This connection does not permit the action.",
    );
  }
}

/** No retry here. A request that may have reached the provider remains uncertain. */
export async function request(
  context: NativeActionContext,
  input: NativeRequest,
  writes: boolean,
  recovery: Obj = {},
): Promise<unknown> {
  let response: NativeResponse;
  try {
    response = await context.request(input);
  } catch (error) {
    if (error instanceof NativeActionError) throw error;
    throw new NativeActionError(
      writes ? "result_unknown" : "temporarily_unavailable",
      "Provider response unavailable.",
      {
        uncertain: writes,
        recovery: { ...recovery, operationId: context.operationId },
      },
    );
  }
  const { status } = response;
  if (status >= 200 && status < 300) return response.body;
  const retry = response.headers.get("retry-after");
  const retryAfterSeconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
  if (status === 401)
    throw new NativeActionError("authorization_expired", "Reconnect this account.");
  if (status === 403)
    throw new NativeActionError(
      "insufficient_scope",
      "The connection cannot access this resource.",
    );
  if (status === 404) throw new NativeActionError("resource_unavailable", "Resource unavailable.");
  if (status === 409 || status === 412)
    throw new NativeActionError("version_conflict", "The resource changed.");
  if (status === 429)
    throw new NativeActionError("rate_limited", "Provider rate limit reached.", {
      retryAfterSeconds,
    });
  if (status >= 500 || status === 408) {
    throw new NativeActionError(
      writes ? "result_unknown" : "temporarily_unavailable",
      "Provider response unavailable.",
      {
        uncertain: writes,
        recovery: { ...recovery, operationId: context.operationId },
      },
    );
  }
  throw new NativeActionError("invalid_input", "Provider rejected the request.");
}

export function responseObject(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeActionError("incomplete_response", "Provider returned an incomplete response.");
  }
  return value as Obj;
}
