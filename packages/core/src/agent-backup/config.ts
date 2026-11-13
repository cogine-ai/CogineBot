import type { AgentBackupSource } from "@rakazo/contracts";
import JSON5 from "json5";
import { parseDocument } from "yaml";

export function readBackupConfig(
  source: AgentBackupSource,
  content: string,
): Record<string, unknown> | null {
  try {
    const value = parseConfig(source, content);
    return validConfig(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseConfig(source: AgentBackupSource, content: string): unknown {
  const input = content.replace(/^\uFEFF/, "");
  if (source === "openclaw") return JSON5.parse(input);
  const document = parseDocument(input, { schema: "core", logLevel: "silent" });
  if (document.errors.length || document.warnings.length)
    throw new Error("Invalid backup settings");
  return document.toJS({ maxAliasCount: 20 });
}

function validConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let remaining = 20_000;
  function visit(node: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 32) return false;
    if (!node || typeof node !== "object") return true;
    return Object.entries(node).every(
      ([key, child]) =>
        !["__proto__", "constructor", "prototype", "$include"].includes(key) &&
        visit(child, depth + 1),
    );
  }
  return visit(value, 0);
}
