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
const ASSIGNMENT_SEPARATOR = /[:=][ \t]*/g;
const RAW_KEY_QUALIFIER = /^(?:access|(?:key|value|header|material|id|identifier|data)s?)$/i;
const TOKEN_COUNT_KEY =
  /^(?:(?:max(?:imum)?|min(?:imum)?|prompt|completion|input|output|total|reasoning|cached)tokens?(?:count|limit|used|usage)?|tokens|tokens?(?:count|limit|used|usage))$/;
const NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?=$|[\s,;})\]])/i;
const QUOTED_FIELD_KEY = /("(?:\\.|[^"\\])*"|'(?:\\(?:''|.)|''|[^'\\])*')(\s*[:=]\s*)/g;
const JSON_STRING = /"(?:\\.|[^"\\])*"/g;
const MAX_ENCODED_STRING_DEPTH = 8;
const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;
const BARE_SECRET =
  /(^|[^A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{35}|(?:gsk_|xai-|hf_|csk-|nvapi-|fw_)[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])|\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b)/g;

/** Read one complete value so quoted and nested credentials cannot leave a suffix behind. */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    const delimiter = text.startsWith(first.repeat(3), start) ? first.repeat(3) : first;
    let farthest = 0;
    for (const backslashEscapes of first === "'" ? [false, true] : [true]) {
      for (let index = start + delimiter.length; index < text.length; index += 1) {
        if (backslashEscapes && text[index] === "\\") {
          index += text[index + 1] === "\r" && text[index + 2] === "\n" ? 2 : 1;
        } else if (
          first === "'" &&
          delimiter.length === 1 &&
          backslashEscapes &&
          /[\r\n]/.test(text[index]!)
        ) {
          break;
        } else if (text.startsWith(delimiter, index)) {
          if (delimiter.length === 1 && first === "'" && text[index + 1] === "'") index += 1;
          else {
            farthest = Math.max(farthest, index + delimiter.length);
            break;
          }
        }
      }
    }
    return farthest || text.length;
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
  let index = start;
  while (index < text.length) {
    if (text[index] === "\\") {
      const continuation = /^\\(?:\r\n|\r|\n)[ \t]*/.exec(text.slice(index));
      index += continuation ? continuation[0].length : Math.min(2, text.length - index);
    } else if (/[\s"',;&}\]]/.test(text[index]!)) break;
    else index += 1;
  }
  return index;
}

function logicalValueEnd(text: string, start: number, keyStart: number, header: boolean): number {
  const lineStart =
    Math.max(text.lastIndexOf("\n", keyStart), text.lastIndexOf("\r", keyStart)) + 1;
  const parentIndent = header ? 0 : /^[ \t]*/.exec(text.slice(lineStart))![0].length;
  let end = start;
  while (end < text.length) {
    const newline = /\r\n|\r|\n/.exec(text.slice(end));
    if (!newline) return text.length;
    const lineEnd = end + newline.index;
    const nextLine = lineEnd + newline[0].length;
    let continuationStart = lineEnd;
    while (continuationStart > start && text[continuationStart - 1] === "\\")
      continuationStart -= 1;
    const continued = (lineEnd - continuationStart) % 2 === 1;
    let nextContent = nextLine;
    if (!header) {
      while (nextContent < text.length) {
        const blank = /^[ \t]*(?:\r\n|\r|\n)/.exec(text.slice(nextContent));
        if (!blank) break;
        nextContent += blank[0].length;
      }
    }
    const nextIndent = /^[ \t]*/.exec(text.slice(nextContent))![0].length;
    if (!continued && nextIndent <= parentIndent) return lineEnd;
    end = nextContent;
  }
  return end;
}

function blockScalarEnd(text: string, start: number, keyStart: number): number | undefined {
  const header = /^[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?(?:\r\n|\r|\n)/.exec(
    text.slice(start),
  );
  if (!header) return undefined;
  const lineStart =
    Math.max(text.lastIndexOf("\n", keyStart), text.lastIndexOf("\r", keyStart)) + 1;
  const parentIndent = /^[ \t]*/.exec(text.slice(lineStart))![0].length;
  let cursor = start + header[0].length;
  let end = cursor;
  while (cursor < text.length) {
    const newline = /\r\n|\r|\n/.exec(text.slice(cursor));
    const lineEnd = newline ? cursor + newline.index : text.length;
    const line = text.slice(cursor, lineEnd);
    if (line.trim() && /^[ \t]*/.exec(line)![0].length <= parentIndent) break;
    end = lineEnd;
    cursor = newline ? lineEnd + newline[0].length : text.length;
  }
  return end;
}

function rawKeyStart(text: string, end: number, boundary: number): number {
  let start = end;
  while (start > boundary && /[A-Za-z0-9_.-]/.test(text[start - 1]!)) start -= 1;
  const identifierStart = start;
  let word = text.slice(start, end);
  while (RAW_KEY_QUALIFIER.test(word)) {
    let previousEnd = start;
    while (previousEnd > boundary && /[ \t]/.test(text[previousEnd - 1]!)) previousEnd -= 1;
    if (previousEnd === start) break;
    let previousStart = previousEnd;
    while (previousStart > boundary && /[A-Za-z0-9_.-]/.test(text[previousStart - 1]!))
      previousStart -= 1;
    const previous = text.slice(previousStart, previousEnd);
    if (!previous) break;
    const normalized = normalizeKey(previous);
    if (
      SECRET_KEY.test(normalized) ||
      (/^keys?$/i.test(word) && /^(?:api|private)$/i.test(previous))
    )
      return previousStart;
    start = previousStart;
    word = previous;
  }
  return identifierStart;
}

function redactNamedValues(text: string, json: boolean): string {
  const encodedStrings: { start: number; end: number }[] = [];
  for (const token of text.matchAll(JSON_STRING)) {
    try {
      JSON.parse(token[0]);
      encodedStrings.push({ start: token.index, end: token.index + token[0].length });
    } catch {
      // Invalid quoted diagnostics remain inspectable as raw text.
    }
  }
  const jsonContainers: { start: number; end: number }[] = [];
  let stringIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    while (encodedStrings[stringIndex] && encodedStrings[stringIndex]!.end <= index)
      stringIndex += 1;
    const encoded = encodedStrings[stringIndex];
    if (encoded && encoded.start === index) {
      index = encoded.end - 1;
      continue;
    }
    if (text[index] !== "{" && text[index] !== "[") continue;
    const containerEnd = valueEnd(text, index);
    try {
      JSON.parse(text.slice(index, containerEnd));
      jsonContainers.push({ start: index, end: containerEnd });
    } catch {
      // Unproved structured syntax is treated as a conservative raw diagnostic.
    }
    index = containerEnd - 1;
  }
  let containerIndex = 0;
  let encodedIndex = 0;
  let output = "";
  let end = 0;
  for (const match of text.matchAll(json ? QUOTED_FIELD_KEY : ASSIGNMENT_SEPARATOR)) {
    let index = match.index;
    if (index < end) continue;
    while (encodedStrings[encodedIndex] && encodedStrings[encodedIndex]!.end <= index)
      encodedIndex += 1;
    const encoded = encodedStrings[encodedIndex];
    // Encoded diagnostic content is cleaned after decoding, with its own logical newlines.
    if (encoded && encoded.start < index && index < encoded.end) continue;
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
      index = rawKeyStart(text, keyEnd, end);
      key = text.slice(index, keyEnd);
      if (!key) continue;
    }
    const normalized = normalizeKey(key);
    if (!SECRET_KEY.test(normalized) && !(json && normalized === "email")) continue;
    const start = match.index + match[0].length;
    if (!json && TOKEN_COUNT_KEY.test(normalized) && NUMERIC_VALUE.test(text.slice(start)))
      continue;
    const blockEnd = blockScalarEnd(text, start, index);
    let next = blockEnd ?? valueEnd(text, start);
    while (jsonContainers[containerIndex] && jsonContainers[containerIndex]!.end <= index)
      containerIndex += 1;
    const container = jsonContainers[containerIndex];
    const strictJson =
      json &&
      match[1]!.startsWith('"') &&
      match[2]!.trim() === ":" &&
      container &&
      container.start < index &&
      index < container.end;
    if (!strictJson && blockEnd === undefined) {
      const header =
        (normalized.includes("cookie") || normalized.includes("authorization")) &&
        text[start] !== "'" &&
        text[start] !== '"';
      next = Math.max(next, logicalValueEnd(text, start, index, header));
      next = Math.max(next, logicalValueEnd(text, next, index, header));
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
    .replaceAll("''", "'")
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

function redactPrivateKeyBlocks(text: string): string {
  let output = "";
  let end = 0;
  for (const match of text.matchAll(PRIVATE_KEY_BEGIN)) {
    if (match.index < end) continue;
    const closing = `-----END ${match[1]}-----`;
    const closingStart = text.indexOf(closing, match.index + match[0].length);
    output += text.slice(end, match.index) + REDACTED;
    // An incomplete private block has no safe suffix boundary.
    end = closingStart < 0 ? text.length : closingStart + closing.length;
  }
  return output + text.slice(end);
}

function redactText(text: string, depth: number): string {
  const named = redactNamedValues(redactPrivateKeyBlocks(text).replace(EMAIL, REDACTED), true);
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
  const headers = redactNamedValues(decoded, false);
  return headers.replace(BEARER, `Bearer ${REDACTED}`).replace(BARE_SECRET, `$1${REDACTED}`);
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
