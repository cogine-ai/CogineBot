import type { ConnectorTool } from "@rakazo/adapter-kit";
import { z } from "zod";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);
// Correction arguments are stored as JSONB in the approval effect and as text in memory.
const literal = z
  .string()
  .regex(/\S/)
  .refine((text) => !text.includes("\0") && !/[\uD800-\uDFFF]/u.test(text));

export const MemoryCorrection = z.strictObject({
  original: literal.describe("The exact old text from the current document."),
  expectedRevision: z.int().positive().describe("The revision shown with that original text."),
});

export const RememberCorrectionInput = z.strictObject({
  path: literal.describe("Exact path of the current Bot memory document."),
  content: literal.describe("Replacement text. Keep the desired whitespace."),
  correction: MemoryCorrection,
});

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

/** Applies one literal replacement, preserving all bytes outside the unique match. */
export function correctMemoryFact(
  existing: string,
  original: string,
  replacement: string,
): string | undefined {
  const start = existing.indexOf(original);
  if (start < 0 || existing.indexOf(original, start + 1) !== -1) return undefined;
  return existing.slice(0, start) + replacement + existing.slice(start + original.length);
}

/** Adds a remembered fact without changing the document's existing bytes. */
export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}
