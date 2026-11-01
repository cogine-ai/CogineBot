export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Blank preserves unrestricted self-hosting; `none` reserves shared models for the owner. */
export type PlatformModelAllowlist = string[] | "owner_only";

export function parsePlatformModelAllowlist(raw: string | undefined): PlatformModelAllowlist {
  return raw?.trim().toLowerCase() === "none" ? "owner_only" : parseAllowlist(raw);
}

/** A mailbox grant requires current proof; deployment ownership is a separate authority. */
export function platformModelAllowed(input: {
  allowlist?: PlatformModelAllowlist;
  email: string;
  emailVerified: boolean;
  isOwner: boolean;
}): boolean {
  if (input.isOwner) return true;
  if (input.allowlist === "owner_only") return false;
  if (!input.allowlist?.length) return true;
  if (!input.emailVerified || isMessagingEmail(input.email)) return false;
  const normalized = input.email.trim().toLowerCase();
  // Domain grants match one complete mailbox domain, never suffixes or malformed addresses.
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) return false;
  return emailAllowed(normalized, input.allowlist);
}

export class PlatformModelForbiddenError extends Error {
  readonly code = "platform_model_forbidden";

  constructor() {
    super("platform_model_forbidden");
    this.name = "PlatformModelForbiddenError";
  }
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return true;
  return enabled !== "false" && enabled !== "0";
}

export function signupPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}): { enabled: boolean; allowlist: string[] } {
  return {
    enabled: signupsOpen(input.signupsEnabled),
    allowlist: parseAllowlist(input.signupAllowlist),
  };
}

/**
 * Non-empty SIGNUP_ALLOWLIST replaces the stored list on each API start.
 * A blank or unset value does not clear a stored list.
 * Uninitialized rows are copied separately so an upgrade still seeds both flags once.
 */
export function signupAllowlistBootUpdate(
  storedAllowlist: string,
  envAllowlist: string | undefined,
  policyInitialized: boolean,
): string | null {
  if (!policyInitialized) return null;
  const next = parseAllowlist(envAllowlist).join(",");
  if (!next) return null;
  if (next === parseAllowlist(storedAllowlist).join(",")) return null;
  return next;
}

/** How an allowlisted signup proceeds when delivery may be missing. */
export function allowlistedSignupAdmission(input: {
  allowlistSize: number;
  hasEmailDelivery: boolean;
  existingHumanCount: number;
}): "open" | "verify" | "needs-delivery" {
  if (input.allowlistSize === 0) return "open";
  if (input.hasEmailDelivery) return "verify";
  if (input.existingHumanCount === 0) return "open";
  return "needs-delivery";
}

/**
 * Decision after the deployment-settings row is locked. `claim` is the one
 * update that may set the owner; a concurrent signup loses that update.
 * Any other human account denies the exemption, verified or not, so an old
 * unverified signup cannot take the seat when delivery is later removed.
 */
export function firstAccountClaimDecision(input: {
  userId: string;
  ownerUserId: string | null;
  otherHuman: boolean;
}): "deny" | "claim" | "renew" {
  if (input.otherHuman) return "deny";
  if (input.ownerUserId && input.ownerUserId !== input.userId) return "deny";
  if (input.ownerUserId === input.userId) return "renew";
  return "claim";
}
