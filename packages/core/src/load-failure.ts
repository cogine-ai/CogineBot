import { isNetworkFailure } from "./user-error.js";

export type LoadFailureKind = "offline" | "auth" | "space" | "server" | "unknown";

/** Classify a read failure without turning an HTTP response into a transport failure. */
export function loadFailureKind(error: unknown, online?: boolean): LoadFailureKind {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const record = current as { status?: unknown; code?: unknown; cause?: unknown };
    if (record.status === 401 || record.code === "UNAUTHORIZED") return "auth";
    if (record.status === 403 || record.code === "FORBIDDEN") return "space";
    if (
      (typeof record.status === "number" && record.status >= 500 && record.status <= 599) ||
      ["INTERNAL_SERVER_ERROR", "BAD_GATEWAY", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT"].includes(
        String(record.code),
      )
    )
      return "server";
    current = record.cause;
  }
  if (online === false || isNetworkFailure(error)) return "offline";
  return "unknown";
}
