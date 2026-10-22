import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./domain.js";
import { modelConnectionLabel } from "./openai-compatible-ui.js";

export type ConnectedBackupOption = ModelBackupChoice & {
  label: string;
  providerName: string;
};

export function backupChoiceKey(choice: ModelBackupChoice): string {
  return JSON.stringify(
    choice.modelCredentialId
      ? [choice.provider, choice.modelId, choice.modelCredentialId]
      : [choice.provider, choice.modelId],
  );
}

export function connectedBackupOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
): ConnectedBackupOption[] {
  const options: ConnectedBackupOption[] = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const models =
      credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? (credential.enabledModelIds ?? [credential.modelId ?? ""])
            .map((id) => ({
              provider: credential.provider,
              id: id.trim(),
              label: id.trim(),
              providerName: credential.label,
            }))
            .filter((entry) => entry.id)
        : catalog.filter((entry) => entry.provider === credential.provider && !entry.placeholder);
    for (const entry of models) {
      const option: ConnectedBackupOption = {
        provider: credential.provider,
        modelId: entry.id,
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
        label: entry.label,
        providerName:
          credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
            ? modelConnectionLabel(credential)
            : (entry.providerName ?? credential.label),
      };
      const key = backupChoiceKey(option);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(option);
    }
  }
  return options;
}

export function moveBackupChoice(
  choices: ModelBackupChoice[],
  index: number,
  direction: -1 | 1,
): ModelBackupChoice[] {
  const target = index + direction;
  if (index < 0 || index >= choices.length || target < 0 || target >= choices.length) {
    return choices;
  }
  const next = [...choices];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function sameBackupChoices(left: ModelBackupChoice[], right: ModelBackupChoice[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (choice, index) =>
        choice.provider === right[index]?.provider &&
        choice.modelId === right[index]?.modelId &&
        (choice.modelCredentialId ?? null) === (right[index]?.modelCredentialId ?? null),
    )
  );
}
