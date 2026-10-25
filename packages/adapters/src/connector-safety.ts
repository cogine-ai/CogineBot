import { redactSecrets } from "@rakazo/core";

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
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

/** Redact complete JSON values and embedded JSON text before results leave a provider. */
export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  const redacted = tryRedactConnectorPayload(value, secrets);
  return redacted.ok ? redacted.value : { error: redacted.error };
}

/** Persistence callers must distinguish processing failure from a service's own error payload. */
export function tryRedactConnectorPayload(
  value: unknown,
  secrets: string[],
): { ok: true; value: unknown } | { ok: false; error: "redaction_error" } {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    const source = JSON.stringify(value);
    if (source === undefined) throw new Error("redaction_error");
    const redactions = new Set(secrets.filter(Boolean));
    for (const secret of secrets.filter(Boolean)) {
      let encoded = secret;
      for (;;) {
        const next = JSON.stringify(encoded).slice(1, -1);
        if (next === encoded || next.length > source.length) break;
        redactions.add(next);
        encoded = next;
      }
    }
    const known = [...redactions].sort((a, b) => b.length - a.length);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    // Work scales with the caller-bounded payload; large opaque images get no new size cap.
    const maxWorkBytes = Math.max(sourceBytes * 8, 1_048_576);
    let workBytes = sourceBytes;
    let nodes = 0;
    const visit = (item: unknown, depth: number, jsonText = false): unknown => {
      nodes += 1;
      if (depth > CONNECTOR_REDACTION_MAX_DEPTH || nodes > CONNECTOR_REDACTION_MAX_NODES)
        throw new Error("redaction_error");
      if (typeof item === "string") {
        workBytes += Buffer.byteLength(item, "utf8");
        if (workBytes > maxWorkBytes) throw new Error("redaction_error");
        // Scalar business strings stay strings; MCP text also supports scalar JSON documents.
        if (!jsonText && !["{", "[", '"'].includes(item.trimStart()[0] ?? ""))
          return redactSecrets(item, known);
        let parsed: unknown;
        try {
          parsed = JSON.parse(item);
        } catch {
          return redactSecrets(item, known);
        }
        const redacted = visit(parsed, depth + 1);
        // Preserve original formatting unless a JSON value changed; quote redacted numeric leaves.
        return JSON.stringify(redacted) === JSON.stringify(parsed)
          ? item
          : JSON.stringify(redacted);
      }
      if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1));
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [
            redactSecrets(key, known),
            visit(child, depth + 1, key === "text" && "type" in item && item.type === "text"),
          ]),
        );
      if (item === null || typeof item === "number" || typeof item === "boolean") {
        const serialized = String(item);
        return redactSecrets(serialized, known) === serialized ? item : "[redacted]";
      }
      return item;
    };
    const redacted = visit(JSON.parse(source), 0);
    return { ok: true, value: redacted };
  } catch {
    return { ok: false, error: "redaction_error" };
  }
}
