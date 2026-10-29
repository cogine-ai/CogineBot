import { loadFailureKind } from "./load-failure.js";

export type AccessRecoveryState =
  | "session_expired"
  | "space_forbidden"
  | "subscription_required"
  | "billing_unavailable";

/** A client recovery hint; server authorization remains authoritative. */
export function accessRecoveryState(error: unknown): AccessRecoveryState | null {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const record = current as {
      status?: unknown;
      code?: unknown;
      data?: { reason?: unknown };
      cause?: unknown;
    };
    if (record.data?.reason === "billing_unavailable") return "billing_unavailable";
    if (
      record.status === 402 ||
      record.code === "PAYMENT_REQUIRED" ||
      record.data?.reason === "subscription_required"
    )
      return "subscription_required";
    current = record.cause;
  }
  const kind = loadFailureKind(error);
  return kind === "auth" ? "session_expired" : kind === "space" ? "space_forbidden" : null;
}
