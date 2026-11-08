import { redactSecrets } from "@rakazo/core";

/** A failed output recovery can keep the reply text already shown to the user. */
export class ModelOutputRecoveryError extends Error {}

/** A cut can end inside a credential that the live redactor had not released. */
export function redactInterruptedOutput(text: string, secrets: string[]): string {
  const safe = redactSecrets(text, secrets);
  let prefixLength = 0;
  for (const secret of secrets) {
    for (
      let length = Math.min(safe.length, secret.length - 1);
      length >= 4 && length > prefixLength;
      length--
    ) {
      if (safe.endsWith(secret.slice(0, length))) {
        prefixLength = length;
        break;
      }
    }
  }
  return prefixLength ? `${safe.slice(0, -prefixLength)}[redacted]` : safe;
}
