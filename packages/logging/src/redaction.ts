const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "apikey",
]);
const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|credential|apikey|privatekey/;

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name || "Error",
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const BASIC_AUTHORIZATION = /\b((?:proxy-)?authorization)\s*[:=]\s*Basic\s+[^\s"',;&]+/gi;
const COOKIE_HEADER = /\b((?:set-)?cookie)\s*[:=]\s*[^\r\n]*/gi;
const ASSIGNMENT_SEPARATOR = /[:=][ \t]*/g;
const QUOTED_FIELD_KEY = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(\s*[:=]\s*)/g;
const JSON_STRING = /"(?:\\.|[^"\\])*"/g;
const MAX_ENCODED_STRING_DEPTH = 8;
const BARE_SECRET =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b)/g;

/** Read one complete value so quoted and nested credentials cannot leave a suffix behind. */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === first) return index + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const closing = [first === "{" ? "}" : "]"];
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"' || character === "'") index = valueEnd(text, index) - 1;
      else if (character === "{" || character === "[") closing.push(character === "{" ? "}" : "]");
      else if (character === "}" || character === "]") {
        if (closing.pop() !== character) return text.length;
        if (!closing.length) return index + 1;
      }
    }
    return text.length;
  }
  return start + (/^[^\s"',;&}\]]+/.exec(text.slice(start))?.[0].length ?? 0);
}

function redactNamedValues(text: string, json: boolean): string {
  let output = "";
  let end = 0;
  for (const match of text.matchAll(json ? QUOTED_FIELD_KEY : ASSIGNMENT_SEPARATOR)) {
    let index = match.index;
    if (index < end) continue;
    let key: string;
    if (json) {
      try {
        key = decodeQuotedKey(match[1]!);
      } catch {
        continue;
      }
    } else {
      let keyEnd = index;
      while (keyEnd > end && /[ \t]/.test(text[keyEnd - 1]!)) keyEnd -= 1;
      index = keyEnd;
      while (index > end && /[A-Za-z0-9_. \t-]/.test(text[index - 1]!)) index -= 1;
      key = text.slice(index, keyEnd);
      if (!key) continue;
    }
    const normalized = normalizeKey(key);
    if (!SECRET_KEY.test(normalized) && !(json && normalized === "email")) continue;
    const start = match.index + match[0].length;
    let next = valueEnd(text, start);
    if (!json && normalized.includes("cookie")) {
      const newline = text.slice(start).search(/[\r\n]/);
      next = newline < 0 ? text.length : start + newline;
    } else if (!json && normalized.includes("authorization")) {
      const scheme = /^(?:Basic|Bearer)[ \t]+[^\s"',;&]+/i.exec(text.slice(start));
      if (scheme) next = start + scheme[0].length;
    }
    if (next <= start) continue;
    const delimiter = match[2]?.includes("=") ? "=" : ":";
    const quote = text[start] === "'" ? "'" : '"';
    output +=
      text.slice(end, index) +
      (json ? `${match[1]}${delimiter}${quote}${REDACTED}${quote}` : `${key}=${REDACTED}`);
    end = next;
  }
  return output + text.slice(end);
}

function decodeQuotedKey(token: string): string {
  if (token.startsWith('"')) return JSON.parse(token);
  return token
    .slice(1, -1)
    .replace(
      /\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|(.))/gi,
      (
        _match,
        unicode: string | undefined,
        hex: string | undefined,
        escaped: string | undefined,
      ) => {
        if (unicode || hex) return String.fromCharCode(Number.parseInt(unicode ?? hex!, 16));
        return (
          ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped!] ??
          escaped!
        );
      },
    );
}

function redactText(text: string, depth: number): string {
  const named = redactNamedValues(text.replace(EMAIL, REDACTED), true);
  const decoded = named.replace(JSON_STRING, (token) => {
    let value: string;
    try {
      value = JSON.parse(token);
    } catch {
      return token;
    }
    // Uninspectable deeper encoded values must not pass through with credentials intact.
    const cleaned = depth >= MAX_ENCODED_STRING_DEPTH ? REDACTED : redactText(value, depth + 1);
    return cleaned === value ? token : JSON.stringify(cleaned);
  });
  const headers = decoded
    .replace(BASIC_AUTHORIZATION, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(COOKIE_HEADER, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`);
  return redactNamedValues(headers, false).replace(BARE_SECRET, REDACTED);
}

export function redactSensitiveText(text: string): string {
  return redactText(text, 0);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
