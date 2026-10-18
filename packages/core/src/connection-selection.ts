import { canonicalConnectionAppId } from "./connection-catalog.js";

export interface ConnectionSelectionReference {
  id: string;
  connectorId: string;
  provider: string;
}

/** A later explicit mention replaces this app's selection, not other apps' accounts. */
export function mergeConnectionSelections(
  previous: readonly string[],
  batches: readonly (readonly string[])[],
  references: readonly ConnectionSelectionReference[],
): string[] {
  const keys = new Map(
    references.map((row) => [
      row.id,
      canonicalConnectionAppId(row.provider) ?? JSON.stringify([row.connectorId, row.provider]),
    ]),
  );
  let selected = [...new Set(previous)];
  for (const batch of batches) {
    if (!batch.length) continue;
    const replacing = new Set(batch.flatMap((id) => (keys.has(id) ? [keys.get(id)!] : [])));
    selected = [
      ...new Set([...selected.filter((id) => !replacing.has(keys.get(id) ?? "")), ...batch]),
    ];
  }
  return selected;
}
