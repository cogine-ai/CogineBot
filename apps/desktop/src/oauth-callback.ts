import type { RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type OAuthCallbackFromOptions = {
  /** SSO callbacks must reach the API, including a loopback API on a separate port. */
  frameName?: string;
  /** App renderer origins — their `/callback` routes must not be treated as paste-flow codes. */
  excludeOrigins?: readonly string[];
  /** Preserve issued client IDs, granted scopes, and OAuth errors for the provider. */
  includeUrl?: boolean;
};

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Providers that sign in through a loopback redirect — Anthropic sends the
 * browser to `http://localhost:53692/callback` — return the authorization code
 * in the redirect URL. Rakazo runs no listener on that port and asks for the
 * code to be pasted instead, which the sign-in popup cannot show because an
 * Electron window has no address bar. The main process still sees the
 * navigation, so it reads the code from there.
 */
export function oauthCallbackFrom(
  url: string,
  options: OAuthCallbackFromOptions = {},
): RakazoDesktopOAuthCallback | undefined {
  if (options.frameName === "rakazo-sso-oauth") return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (!LOOPBACK_HOSTS.has(target.hostname)) return undefined;
  if (target.username || target.password || target.hash || url.length > 8192) return undefined;
  if (options.excludeOrigins?.includes(target.origin)) return undefined;
  const allowed = new Set([
    "code",
    "state",
    "client_id",
    "scope",
    "error",
    "error_description",
    "iss",
  ]);
  for (const key of target.searchParams.keys()) {
    // A callback cannot carry bearer credentials or ambiguous registration metadata.
    if (!allowed.has(key) || target.searchParams.getAll(key).length !== 1) return undefined;
  }
  const code = target.searchParams.get("code")?.trim();
  const error = target.searchParams.get("error")?.trim();
  if (
    (!code && !error) ||
    (target.searchParams.has("code") && target.searchParams.has("error")) ||
    (error && !options.includeUrl)
  )
    return undefined;
  const state = target.searchParams.get("state")?.trim();
  if (error && !state) return undefined;
  return {
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
    ...(options.includeUrl ? { callbackUrl: target.href } : {}),
  };
}
