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
const SECRET_KEY =
  /password|passwd|secret|token|authorization|cookie|credential|apikey|privatekey|^(?:aws)?accesskeyid$/;

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

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iy;
const WORD_CHARACTER = /[A-Za-z0-9_]/;
const EMAIL_LOCAL_CHARACTER = /[A-Za-z0-9._%+-]/;
const URL_SCHEME_CHARACTER = /[A-Za-z0-9+.-]/;
const BASE64URL_CHARACTER = /[A-Za-z0-9_-]/;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const ASSIGNMENT_SEPARATOR = /[:=][ \t]*|->[ \t]*|[ \t]is(?:[ \t]*[:=][ \t]*|[ \t]+)/gi;
const RAW_KEY_QUALIFIER = /^(?:access|(?:key|value|header|material|id|identifier|data)s?)$/i;
const NATURAL_CREDENTIAL_KEY =
  /(?:password|passwd|secret|token|authorization|cookie|credential|apikey|privatekey|accesskeyid)s?(?:(?:access|key|value|header|material|id|identifier|data)s?)*$/;
const TOKEN_COUNT_KEY =
  /^(?:(?:max(?:imum)?|min(?:imum)?|prompt|completion|input|output|total|reasoning|cached)tokens?(?:count|limit|used|usage)?|tokens|tokens?(?:count|limit|used|usage))$/;
const NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?=$|[\s,;})\]])/i;
const QUOTED_FIELD_SEPARATOR = /\s*[:=]\s*|[ \t]*->[ \t]*|[ \t]+is(?:[ \t]*[:=][ \t]*|[ \t]+)/iy;
const MAX_ENCODED_STRING_DEPTH = 8;
const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;
const BARE_SECRET =
  /(^|[^A-Za-z0-9_-])(?:AIza[A-Za-z0-9_-]{35}|(?:gsk_|xai-|hf_|csk-|nvapi-|fw_)[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])|\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|(?:ak_|ck_)[A-Za-z0-9]+)\b)/g;

function lineStartAt(text: string, at: number): number {
  for (let index = at; index >= 0; index--) {
    if (text[index] === "\r" || text[index] === "\n") return index + 1;
  }
  return 0;
}

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
  const lineStart = lineStartAt(text, keyStart);
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
  const lineStart = lineStartAt(text, keyStart);
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
  let candidateWords = 1;
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
    candidateWords += 1;
    if (
      SECRET_KEY.test(normalized) ||
      (candidateWords <= 3 && normalizeKey(text.slice(previousStart, end)) === "accesskeyid") ||
      (/^keys?$/i.test(word) && /^(?:api|private)$/i.test(previous))
    )
      return previousStart;
    start = previousStart;
    word = previous;
  }
  return identifierStart;
}

function* jsonStrings(text: string): Generator<{ index: number; token: string }> {
  const firstQuote = text.indexOf('"');
  if (firstQuote < 0) return;
  // Cache each possible body's end so an unclosed outer quote cannot rescan inner quotes.
  const closingAfter = new Uint32Array(text.length + 2);
  for (let index = text.length - 1; index > firstQuote; index--) {
    const character = text[index];
    if (character === '"') closingAfter[index] = index + 1;
    else if (character !== "\\") closingAfter[index] = closingAfter[index + 1]!;
    else if (index + 1 < text.length && !/[\r\n\u2028\u2029]/.test(text[index + 1]!))
      closingAfter[index] = closingAfter[index + 2]!;
  }
  for (let index = firstQuote; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const end = closingAfter[index + 1]!;
    if (!end) continue;
    yield { index, token: text.slice(index, end) };
    index = end - 1;
  }
}

/** Check whether decoding a valid JSON document silently discarded any object members. */
export function hasDuplicateJsonFields(text: string, decoded: unknown): boolean {
  const separator = /\s*:/y;
  let fieldCount = 0;
  for (const { index, token } of jsonStrings(text)) {
    separator.lastIndex = index + token.length;
    if (separator.test(text)) fieldCount++;
  }
  const pending = [decoded];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (!Array.isArray(value)) fieldCount -= Object.keys(value).length;
    for (const entry of Object.values(value)) pending.push(entry);
  }
  return fieldCount > 0;
}

function jsonStringSpans(text: string): { start: number; end: number }[] {
  const encodedStrings: { start: number; end: number }[] = [];
  for (const { index, token } of jsonStrings(text)) {
    try {
      JSON.parse(token);
      encodedStrings.push({ start: index, end: index + token.length });
    } catch {
      // Invalid quoted diagnostics remain inspectable as raw text.
    }
  }
  return encodedStrings;
}

type TextRedactionPolicy = "diagnostic" | "portable";

type QuotedFieldMatch = { index: number; 0: string; 1: string; 2: string };
type QuotedFieldSpan = { index: number; closing: number; end: number };

/** Cache viable suffixes, including the shorter escape when a doubled quote cannot finish. */
function* fieldsWithQuote(
  text: string,
  quote: string,
  separatorEnds: Uint32Array,
  allowSingleMultiline: boolean,
): Generator<QuotedFieldSpan> {
  const firstQuote = text.indexOf(quote);
  if (firstQuote < 0) return;
  const closingAfter = new Uint32Array(text.length + 3);
  for (let index = text.length - 1; index > firstQuote; index--) {
    const character = text[index];
    if (character === quote) {
      const closing = separatorEnds[index] ? index + 1 : 0;
      closingAfter[index] =
        quote === "'" && text[index + 1] === "'" ? closingAfter[index + 2]! || closing : closing;
    } else if (character !== "\\") {
      closingAfter[index] = closingAfter[index + 1]!;
    } else if (index + 1 < text.length && !/[\r\n\u2028\u2029]/.test(text[index + 1]!)) {
      closingAfter[index] =
        quote === "'" && text[index + 1] === "'" && text[index + 2] === "'"
          ? closingAfter[index + 3]! || closingAfter[index + 2]!
          : closingAfter[index + 2]!;
    } else if (allowSingleMultiline && quote === "'" && index + 1 < text.length) {
      closingAfter[index] = closingAfter[index + 1]!;
    }
  }
  // Keep all starts: an earlier match of the other quote kind can hide an overlapping candidate.
  for (let index = firstQuote; index < text.length; index++) {
    if (text[index] !== quote) continue;
    const closing = closingAfter[index + 1]!;
    if (closing) yield { index, closing, end: separatorEnds[closing - 1]! };
  }
}

function* quotedFields(text: string, allowSingleMultiline = false): Generator<QuotedFieldMatch> {
  if (!text.includes("'") && !text.includes('"')) return;
  const separatorEnds = new Uint32Array(text.length);
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "'" && text[index] !== '"') continue;
    QUOTED_FIELD_SEPARATOR.lastIndex = index + 1;
    if (QUOTED_FIELD_SEPARATOR.exec(text)) separatorEnds[index] = QUOTED_FIELD_SEPARATOR.lastIndex;
  }
  const single = fieldsWithQuote(text, "'", separatorEnds, allowSingleMultiline);
  const double = fieldsWithQuote(text, '"', separatorEnds, allowSingleMultiline);
  let a = single.next();
  let b = double.next();
  let end = 0;
  while (!a.done || !b.done) {
    let match: QuotedFieldSpan;
    if (b.done || (!a.done && a.value.index < b.value.index)) {
      match = a.value!;
      a = single.next();
    } else {
      match = b.value!;
      b = double.next();
    }
    if (match.index < end) continue;
    end = match.end;
    yield {
      index: match.index,
      0: text.slice(match.index, match.end),
      1: text.slice(match.index, match.closing),
      2: text.slice(match.closing, match.end),
    };
  }
}

function hasOddSlashLineBreak(text: string): boolean {
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "\\") {
      index++;
      continue;
    }
    const start = index;
    while (text[index] === "\\") index++;
    if ((index - start) % 2 === 1 && /[\r\n\u2028\u2029]/.test(text[index] ?? "")) return true;
  }
  return false;
}

function redactNamedValues(
  text: string,
  json: boolean,
  policy: TextRedactionPolicy,
  allowSingleMultiline = false,
): string {
  if (allowSingleMultiline && !hasOddSlashLineBreak(text)) return text;
  const encodedStrings = jsonStringSpans(text);
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
  for (const match of json
    ? quotedFields(text, allowSingleMultiline)
    : text.matchAll(ASSIGNMENT_SEPARATOR)) {
    let index = match.index;
    if (index < end) continue;
    while (encodedStrings[encodedIndex] && encodedStrings[encodedIndex]!.end <= index)
      encodedIndex += 1;
    const encoded = encodedStrings[encodedIndex];
    // Encoded diagnostic content is cleaned after decoding, with its own logical newlines.
    if (encoded && encoded.start < index && index < encoded.end) continue;
    let key: string;
    if (json) {
      if (allowSingleMultiline && (!match[1]!.startsWith("'") || !hasOddSlashLineBreak(match[1]!)))
        continue;
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
    const portableKeyAssignment =
      policy === "portable" && !json && match[0].trim() === "=" && /[_-]keys?$/i.test(key);
    if (
      !SECRET_KEY.test(normalized) &&
      !portableKeyAssignment &&
      !(json && policy === "diagnostic" && normalized === "email")
    )
      continue;
    const separator = (json ? match[2]! : match[0]).trim();
    if (
      /^(?:is\b|->)/i.test(separator) &&
      !NATURAL_CREDENTIAL_KEY.test(normalized) &&
      !TOKEN_COUNT_KEY.test(normalized)
    )
      continue;
    const start = match.index + match[0].length;
    if (
      (!json || policy === "portable") &&
      TOKEN_COUNT_KEY.test(normalized) &&
      NUMERIC_VALUE.test(text.slice(start))
    )
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

function wordBoundaryAt(text: string, at: number): boolean {
  const before = at > 0 && WORD_CHARACTER.test(text[at - 1]!);
  const after = at < text.length && WORD_CHARACTER.test(text[at]!);
  return before !== after;
}

function redactEmails(text: string): string {
  let output = "";
  let end = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf("@", cursor);
    if (at < 0) break;
    let start = at;
    while (start > cursor && EMAIL_LOCAL_CHARACTER.test(text[start - 1]!)) start--;
    while (start < at && !wordBoundaryAt(text, start)) start++;
    EMAIL.lastIndex = start;
    const match = start < at ? EMAIL.exec(text) : null;
    if (!match) {
      cursor = at + 1;
      continue;
    }
    output += text.slice(end, start) + REDACTED;
    end = EMAIL.lastIndex;
    cursor = end;
  }
  return output + text.slice(end);
}

function base64urlEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && BASE64URL_CHARACTER.test(text[end]!)) end++;
  return end;
}

type SecretSpan = { index: number; end: number; prefix?: string };

function* jwtSpans(text: string): Generator<SecretSpan> {
  for (let index = 0; index < text.length; ) {
    if (!BASE64URL_CHARACTER.test(text[index]!)) {
      index++;
      continue;
    }
    const firstEnd = base64urlEnd(text, index);
    let end = 0;
    if (text[firstEnd] === ".") {
      const secondStart = firstEnd + 1;
      const secondEnd = base64urlEnd(text, secondStart);
      if (secondEnd > secondStart && text[secondEnd] === ".") {
        const thirdStart = secondEnd + 1;
        let thirdEnd = base64urlEnd(text, thirdStart);
        while (thirdEnd > thirdStart && !WORD_CHARACTER.test(text[thirdEnd - 1]!)) thirdEnd--;
        if (thirdEnd > thirdStart) end = thirdEnd;
      }
    }
    if (end) {
      // Preserve every viable start; another secret may consume an earlier overlapping candidate.
      for (let start = index; start + 3 < firstEnd; start++) {
        if (text.startsWith("eyJ", start) && wordBoundaryAt(text, start))
          yield { index: start, end };
      }
    }
    index = firstEnd;
  }
}

function* otherBareSpans(text: string): Generator<SecretSpan> {
  for (const match of text.matchAll(BARE_SECRET)) {
    yield {
      index: match.index,
      end: match.index + match[0].length,
      prefix: match[1] ?? "",
    };
  }
}

function redactBareSecrets(text: string): string {
  const other = otherBareSpans(text);
  const jwt = jwtSpans(text);
  let a = other.next();
  let b = jwt.next();
  let output = "";
  let end = 0;
  while (!a.done || !b.done) {
    let span: SecretSpan;
    if (b.done || (!a.done && a.value.index <= b.value.index)) {
      span = a.value!;
      a = other.next();
    } else {
      span = b.value!;
      b = jwt.next();
    }
    if (span.index < end) continue;
    output += text.slice(end, span.index) + (span.prefix ?? "") + REDACTED;
    end = span.end;
  }
  return output + text.slice(end);
}

const PORTABLE_SECRET =
  /\bom[dg]_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\bxox[abposr]-[A-Za-z0-9-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bLLM\|\d{6,}\|[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{30,}|\bnpm_[A-Za-z0-9]{20,}/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:'"?#]*:)([^\s/'"?#]+)(@)/iy;
const SECRET_FLAG =
  /--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|[ \t]+)/gi;

function redactUrlPasswords(text: string): string {
  let output = "";
  let end = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const separator = text.indexOf("://", cursor);
    if (separator < 0) break;
    let start = separator;
    while (start > cursor && URL_SCHEME_CHARACTER.test(text[start - 1]!)) start--;
    while (start < separator && (!/[A-Za-z]/.test(text[start]!) || !wordBoundaryAt(text, start)))
      start++;
    URL_PASSWORD.lastIndex = start;
    const match = start < separator ? URL_PASSWORD.exec(text) : null;
    if (!match) {
      cursor = separator + 3;
      continue;
    }
    output += text.slice(end, start) + match[1] + REDACTED + match[3];
    end = URL_PASSWORD.lastIndex;
    cursor = end;
  }
  return output + text.slice(end);
}

function redactSecretFlags(text: string): string {
  const encodedStrings = jsonStringSpans(text);
  let stringIndex = 0;
  let end = 0;
  let output = "";
  for (const match of text.matchAll(SECRET_FLAG)) {
    if (match.index < end) continue;
    while (encodedStrings[stringIndex] && encodedStrings[stringIndex]!.end <= match.index)
      stringIndex += 1;
    const encoded = encodedStrings[stringIndex];
    if (encoded && encoded.start < match.index && match.index < encoded.end) continue;
    const start = match.index + match[0].length;
    if (text.slice(start, start + 2) === "--") continue;
    const next = valueEnd(text, start);
    if (next <= start || ["''", '""'].includes(text.slice(start, next))) continue;
    output += text.slice(end, start) + REDACTED;
    end = next;
  }
  return output + text.slice(end);
}

function redactText(text: string, depth: number, policy: TextRedactionPolicy): string {
  let prepared = redactPrivateKeyBlocks(text);
  if (policy === "diagnostic") prepared = redactEmails(prepared);
  else {
    prepared = redactUrlPasswords(prepared.replace(PORTABLE_SECRET, REDACTED));
    prepared = redactSecretFlags(prepared);
  }
  // Clean existing quoted fields before a broader single-quoted key can hide an inner field.
  const legacyNamed = redactNamedValues(prepared, true, policy);
  const named = redactNamedValues(legacyNamed, true, policy, true);
  let decoded = "";
  let end = 0;
  for (const { index, token } of jsonStrings(named)) {
    let value: string;
    try {
      value = JSON.parse(token);
    } catch {
      continue;
    }
    // Uninspectable deeper encoded values must not pass through with credentials intact.
    const cleaned =
      depth >= MAX_ENCODED_STRING_DEPTH ? REDACTED : redactText(value, depth + 1, policy);
    decoded += named.slice(end, index) + (cleaned === value ? token : JSON.stringify(cleaned));
    end = index + token.length;
  }
  decoded += named.slice(end);
  const headers = redactNamedValues(decoded, false, policy);
  return redactBareSecrets(headers.replace(BEARER, `Bearer ${REDACTED}`));
}

export function redactSensitiveText(text: string): string {
  return redactText(text, 0, "diagnostic");
}

/** Remove recognized credential material while preserving ordinary portable content, including email. */
export function redactSecretText(text: string): string {
  return redactText(text, 0, "portable");
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Match credential names for user-visible data while retaining real numeric token counters. */
export function isSecretFieldForDisplay(key: string, value: unknown): boolean {
  const normalized = normalizeKey(key);
  const text = typeof value === "string" ? value.trim() : "";
  const numeric =
    typeof value === "number" || (text !== "" && NUMERIC_VALUE.exec(text)?.[0] === text);
  const counter = TOKEN_COUNT_KEY.test(normalized) || normalized === "tokenbudget";
  if (counter) return !numeric || (normalized === "tokens" && typeof value !== "number");
  const credentialName = normalized.replace(
    /(?:confirmation|confirm|text|base64|b64|pem|der|jwk|pkcs8)$/,
    "",
  );
  return NATURAL_CREDENTIAL_KEY.test(normalized) || NATURAL_CREDENTIAL_KEY.test(credentialName);
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
