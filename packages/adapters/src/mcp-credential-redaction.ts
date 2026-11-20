function normalizedCredentialKey(key: string): string {
  return key
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

/** Headers whose values are credentials even when short (e.g. Cookie, X-Session). */
export function isAuthHeaderKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "x_session" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "x_auth_token"
  );
}

/** Explicit credential keys (access_token, api_key, …); numeric values stay redacted. */
function isExplicitCredentialKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  if (isAuthHeaderKey(key)) return true;
  return /(?:^|_)(secret|password|credential|access_token|refresh_token|id_token|auth_token|session_token|session_id|session_key|session_secret|api_key|api_token|private_key|signing_key|access_key)$/.test(
    normalized,
  );
}

/** Ambiguous *_token keys where numeric-only values are usually config, not secrets. */
function isAmbiguousCredentialKey(key: string): boolean {
  if (isExplicitCredentialKey(key)) return false;
  const normalized = normalizedCredentialKey(key);
  if (/(?:^|_)token$/.test(normalized)) {
    return !/(timeout|ttl|max|count|type|mode|name)$/.test(normalized);
  }
  return false;
}

/** Ambiguous settings such as a bare TOKEN can also contain configuration enums. */
function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (COMMON_CONFIG_VALUES.has(trimmed.toLowerCase())) return false;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const COMMON_CONFIG_VALUES = new Set([
  "production",
  "development",
  "staging",
  "test",
  "testing",
  "oauth",
  "openid",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "none",
  "null",
  "debug",
  "info",
  "warn",
  "error",
  "http",
  "https",
  "local",
  "localhost",
  "enabled",
  "disabled",
  "default",
  "auto",
  "manual",
  "read",
  "write",
  "sync",
  "async",
]);

export function isCommonMcpConfigValue(value: string): boolean {
  return COMMON_CONFIG_VALUES.has(value.toLowerCase());
}

/** An error may quote a token without its authorization scheme. */
export function mcpCredentialValueVariants(value: string): string[] {
  const text = value.trim();
  const bearer = text.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return [value, bearer];
  const basic = text.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator !== -1) {
      const username = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);
      return [value, basic, username, password].filter(Boolean);
    }
  }
  return [value];
}

/** Cookie fields can contain several credentials, while Set-Cookie also has attributes. */
export function mcpCookieCredentialValues(key: string, value: string): string[] {
  const normalized = normalizedCredentialKey(key);
  const responseHeader = /(?:^|_)set_cookie$/.test(normalized);
  if (
    !responseHeader &&
    !/(?:^|_)(?:cookies?|cookie_header|session_header|x_session)$/.test(normalized)
  )
    return [];
  const values: string[] = [];
  const pairs = value.trim().split(";");
  for (const pair of responseHeader ? pairs.slice(0, 1) : pairs) {
    const separator = pair.indexOf("=");
    if (separator < 1 || !pair.slice(0, separator).trim()) continue;
    const literal = pair.slice(separator + 1).trim();
    if (!literal) continue;
    values.push(literal);
    const unquoted = literal.match(/^"([\s\S]*)"$/)?.[1] ?? literal;
    if (unquoted !== literal) values.push(unquoted);
    try {
      const decoded = decodeURIComponent(unquoted);
      if (decoded !== unquoted) values.push(decoded);
    } catch {
      // The literal cookie value is still registered.
    }
  }
  return values;
}

export function isMcpCredentialFieldValue(
  key: string,
  value: string,
  allowConfigValues = false,
): boolean {
  if (isExplicitCredentialKey(key)) {
    const trimmed = value.trim();
    return Boolean(trimmed) && (allowConfigValues || !isCommonMcpConfigValue(trimmed));
  }
  return isAmbiguousCredentialKey(key) && looksLikeSecretValue(value);
}
