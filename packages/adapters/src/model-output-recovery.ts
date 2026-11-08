import { createStreamingRedactor, protectedContinuationLength } from "@rakazo/core";

/** A failed output recovery can keep the reply text already shown to the user. */
export class ModelOutputRecoveryError extends Error {}

/** Mask a credential tail that the live redactor had not released when output stopped. */
export function redactInterruptedOutput(
  text: string,
  secrets: string[],
  preceding: readonly string[] = [],
): string {
  if (!text) return text;
  let tailLength = 0;
  for (const context of ["", ...preceding]) {
    const raw = context + text;
    for (const secret of secrets) {
      for (let length = Math.min(raw.length, secret.length - 1); length > tailLength; length--) {
        if (raw.endsWith(secret.slice(0, length))) {
          tailLength = Math.min(length, text.length);
          break;
        }
      }
    }
    if (tailLength === text.length) break;
  }

  let cutoff = text.length - tailLength;
  if (tailLength > 0) {
    // Keep exact matches that overlap the interrupted tail masked as a whole.
    const covered = protectedContinuationLength(text, preceding, secrets);
    let previous: number;
    do {
      previous = cutoff;
      if (covered > cutoff) cutoff = 0;
      for (const secret of secrets) {
        const start = text.indexOf(secret, Math.max(0, cutoff - secret.length + 1));
        if (start >= 0 && start < cutoff) cutoff = start;
      }
    } while (cutoff < previous);
  }

  const redactor = createStreamingRedactor(secrets, preceding);
  return (
    redactor.push(text.slice(0, cutoff)) + redactor.finish() + (tailLength ? "[redacted]" : "")
  );
}
