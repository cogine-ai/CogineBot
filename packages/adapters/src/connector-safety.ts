export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/** The SDK retains its abort listener after a response. Stop forwarding once it settles. */
export async function withRequestSignal<T>(
  source: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  source.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    source.removeEventListener("abort", abort);
  }
}

export function sanitizeConnectorError(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactConnectorPayload(message, secrets);
  if (typeof redacted !== "string") return "redaction_error";
  return redacted
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2_000);
}

export const CONNECTOR_REDACTION_MAX_DEPTH = 64;
export const CONNECTOR_REDACTION_MAX_NODES = 100_000;

export type ConnectorPayloadFormat = "mcp-schema" | "mcp-result";
type PayloadPosition =
  | ConnectorPayloadFormat
  | "schema-map"
  | "schema-list"
  | "content-list"
  | "content-block"
  | "embedded-resource";

const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const childSchemas = new Set([
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);
const schemaBooleanFields = new Set(["uniqueItems", "readOnly", "writeOnly", "deprecated"]);
const contentTypes = new Set(["text", "image", "audio", "resource", "resource_link"]);
const mcpResultFields = new Set(["content", "structuredContent", "isError", "_meta"]);
const mcpBlockFields = new Set([
  "type",
  "text",
  "data",
  "mimeType",
  "resource",
  "uri",
  "name",
  "title",
  "description",
  "size",
  "icons",
  "annotations",
  "_meta",
]);
const mcpResourceFields = new Set(["uri", "mimeType", "text", "blob", "_meta"]);

export function isMcpProtocolLabel(value: string): boolean {
  return schemaTypes.has(value) || contentTypes.has(value);
}

function objectFieldPosition(
  position: PayloadPosition | undefined,
  key: string,
  value: unknown,
): PayloadPosition | undefined {
  if (position === "mcp-result" && key === "content") return "content-list";
  if (position === "content-block" && key === "resource") return "embedded-resource";
  if (position === "schema-map") return "mcp-schema";
  if (position !== "mcp-schema") return undefined;
  if (schemaMaps.has(key)) return "schema-map";
  if (schemaLists.has(key) || (key === "items" && Array.isArray(value))) return "schema-list";
  if (key === "items" || childSchemas.has(key)) return "mcp-schema";
}

function isSchemaType(value: unknown): boolean {
  return typeof value === "string" && schemaTypes.has(value);
}

/** Include the JSON-escaped spellings that can appear inside serialized strings. */
export function knownJsonSecretRedactions(secrets: string[], sourceLength: number): string[] {
  const active = secrets.filter(Boolean);
  const redactions = new Set(active);
  for (const secret of active) {
    let encoded = secret;
    for (;;) {
      const next = JSON.stringify(encoded).slice(1, -1);
      if (next === encoded || next.length > sourceLength) break;
      redactions.add(next);
      encoded = next;
    }
  }
  return [...redactions].sort((a, b) => b.length - a.length);
}

type TextRange = [start: number, end: number];

function splitOnCredential(
  value: string,
  range: TextRange,
  credential: string,
  wholeWord: boolean,
): TextRange[] {
  const leftWord = /[\p{L}\p{N}_]$/u;
  const rightWord = /^[\p{L}\p{N}_]/u;
  const [from, to] = range;
  if (credential.length > to - from) return [range];
  const text = value.slice(from, to);
  const parts: TextRange[] = [];
  let start = from;
  let at = text.indexOf(credential);
  while (at !== -1) {
    const match = from + at;
    const end = match + credential.length;
    if (
      wholeWord &&
      (leftWord.test(value.slice(Math.max(match - 2, 0), match)) ||
        rightWord.test(value.slice(end, end + 2)))
    ) {
      at = text.indexOf(credential, at + 1);
      continue;
    }
    parts.push([start, match]);
    start = end;
    at = text.indexOf(credential, at + credential.length);
  }
  if (!parts.length) return [range];
  parts.push([start, to]);
  return parts;
}

/** Redact complete JSON values and embedded JSON text before results leave a provider. */
export function redactConnectorPayload(
  value: unknown,
  secrets: string[],
  format?: ConnectorPayloadFormat,
): unknown {
  const redacted = tryRedactConnectorPayload(value, secrets, format);
  return redacted.ok ? redacted.value : { error: redacted.error };
}

/** Persistence callers must distinguish processing failure from a service's own error payload. */
export function tryRedactConnectorPayload(
  value: unknown,
  secrets: string[],
  format?: ConnectorPayloadFormat,
  credentialComponents: string[] = [],
): { ok: true; value: unknown } | { ok: false; error: "redaction_error" } {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    const source = JSON.stringify(value);
    if (source === undefined) throw new Error("redaction_error");
    const known = new Set(knownJsonSecretRedactions(secrets, source.length));
    const components = knownJsonSecretRedactions(credentialComponents, source.length);
    const spellings = [...new Set([...known, ...components])].sort((a, b) => b.length - a.length);
    const redactText = (value: string): string => {
      let parts: TextRange[] = [[0, value.length]];
      for (const spelling of spellings) {
        if (spelling.length > value.length) continue;
        const wholeWord = !known.has(spelling);
        parts = parts.flatMap((part) => splitOnCredential(value, part, spelling, wholeWord));
      }
      // Insert markers after scanning literals so a short secret cannot match
      // inside a marker created by redacting a longer one.
      return parts.map(([from, to]) => value.slice(from, to)).join("[redacted]");
    };
    const sourceBytes = Buffer.byteLength(source, "utf8");
    // Work scales with the caller-bounded payload; large opaque images get no new size cap.
    const maxWorkBytes = Math.max(sourceBytes * 8, 1_048_576);
    let workBytes = sourceBytes;
    let nodes = 0;
    const visit = (
      item: unknown,
      depth: number,
      jsonText = false,
      position?: PayloadPosition,
    ): unknown => {
      nodes += 1;
      if (depth > CONNECTOR_REDACTION_MAX_DEPTH || nodes > CONNECTOR_REDACTION_MAX_NODES)
        throw new Error("redaction_error");
      if (typeof item === "string") {
        workBytes += Buffer.byteLength(item, "utf8");
        if (workBytes > maxWorkBytes) throw new Error("redaction_error");
        // Scalar business strings stay strings; MCP text also supports scalar JSON documents.
        if (!jsonText && !["{", "[", '"'].includes(item.trimStart()[0] ?? ""))
          return redactText(item);
        let parsed: unknown;
        try {
          parsed = JSON.parse(item);
        } catch {
          return redactText(item);
        }
        const redacted = visit(parsed, depth + 1);
        // Preserve original formatting unless a JSON value changed; quote redacted numeric leaves.
        return JSON.stringify(redacted) === JSON.stringify(parsed)
          ? item
          : JSON.stringify(redacted);
      }
      if (Array.isArray(item)) {
        const childPosition =
          position === "schema-list"
            ? "mcp-schema"
            : position === "content-list"
              ? "content-block"
              : undefined;
        return item.map((child) => visit(child, depth + 1, false, childPosition));
      }
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => {
            // These values are protocol vocabulary at these positions. Values in
            // tool data (including defaults and structuredContent) still get scanned.
            if (
              key === "type" &&
              ((position === "content-block" &&
                typeof child === "string" &&
                contentTypes.has(child)) ||
                (position === "mcp-schema" &&
                  (isSchemaType(child) || (Array.isArray(child) && child.every(isSchemaType)))))
            )
              return [key, child];
            if (position === "mcp-result" && key === "isError" && typeof child === "boolean")
              return [key, child];
            if (
              position === "mcp-schema" &&
              schemaBooleanFields.has(key) &&
              typeof child === "boolean"
            )
              return [key, child];
            if (
              position === "content-block" &&
              key === "mimeType" &&
              typeof child === "string" &&
              "type" in item &&
              (item.type === "image" || item.type === "audio")
            ) {
              const prefix = `${item.type}/`;
              if (child.startsWith(prefix)) {
                const subtype = child.slice(prefix.length);
                // Scan the full value and the provider-supplied subtype. The
                // major type is already present in the block's discriminator.
                const mimeType =
                  [...known].some((secret) => secret !== item.type && child.includes(secret)) ||
                  redactText(subtype) !== subtype
                    ? "application/octet-stream"
                    : child;
                return [key, mimeType];
              }
            }
            const childPosition = objectFieldPosition(position, key, child);
            const stableField =
              (position === "mcp-result" && mcpResultFields.has(key)) ||
              (position === "content-block" && mcpBlockFields.has(key)) ||
              (position === "embedded-resource" && mcpResourceFields.has(key)) ||
              (position === "mcp-schema" && childPosition !== undefined);
            return [
              stableField ? key : redactText(key),
              visit(
                child,
                depth + 1,
                key === "text" && "type" in item && item.type === "text",
                childPosition,
              ),
            ];
          }),
        );
      if (item === null || typeof item === "number" || typeof item === "boolean") {
        if (position === "mcp-schema" && typeof item === "boolean") return item;
        const serialized = String(item);
        return redactText(serialized) === serialized ? item : "[redacted]";
      }
      return item;
    };
    const redacted = visit(JSON.parse(source), 0, false, format);
    return { ok: true, value: redacted };
  } catch {
    return { ok: false, error: "redaction_error" };
  }
}
