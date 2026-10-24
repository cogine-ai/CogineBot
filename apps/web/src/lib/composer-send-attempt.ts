import { newClientId } from "./client-id";
import type { PendingComposerAttachment } from "./composer-draft";

export type ComposerSendAttempt = {
  clientNonce: string;
  signature: string;
  inFlight: boolean;
  uploadedArtifactIds: Map<string, string>;
  completedRoutineIds: Set<string>;
};

const fileIdentities = new WeakMap<File, number>();
let nextFileIdentity = 1;

function fileIdentity(file: File): number {
  const known = fileIdentities.get(file);
  if (known !== undefined) return known;
  const identity = nextFileIdentity++;
  fileIdentities.set(file, identity);
  return identity;
}

export function composerAttachmentUploadKey(attachment: PendingComposerAttachment): string {
  return JSON.stringify([attachment.id, fileIdentity(attachment.file)]);
}

/** Mirrors the actual send payload; file identity avoids treating different same-named files as retries. */
export function composerSendSignature(input: {
  text: string;
  target: { botId?: string; groupId?: string };
  mentions?: readonly unknown[];
  routineIds?: readonly string[];
  attachments: readonly PendingComposerAttachment[];
  replyToMessageId?: string;
  replyQuote?: string | null;
}): string {
  return JSON.stringify({
    text: input.text,
    target: input.target,
    mentions: input.mentions ?? [],
    routineIds: input.routineIds ?? [],
    attachments: input.attachments.map(composerAttachmentUploadKey),
    replyToMessageId: input.replyToMessageId ?? null,
    replyQuote: input.replyQuote ?? null,
  });
}

export function createComposerSendAttemptStore(makeNonce: () => string = newClientId) {
  const attempts = new Map<string, ComposerSendAttempt>();
  return {
    acquire(key: string, signature: string): ComposerSendAttempt | null {
      const previous = attempts.get(key);
      // Synchronous lock: React has not necessarily rendered `sending` after the first click.
      if (previous?.inFlight) return null;
      const attempt =
        previous?.signature === signature
          ? previous
          : {
              clientNonce: makeNonce(),
              signature,
              inFlight: false,
              uploadedArtifactIds: new Map<string, string>(),
              completedRoutineIds: new Set<string>(),
            };
      attempt.inFlight = true;
      attempts.set(key, attempt);
      return attempt;
    },
    finish(key: string, attempt: ComposerSendAttempt, succeeded: boolean): void {
      if (attempts.get(key) !== attempt) return;
      if (succeeded) attempts.delete(key);
      else attempt.inFlight = false;
    },
    isCurrent(key: string, attempt: ComposerSendAttempt): boolean {
      return attempts.get(key) === attempt;
    },
    isInFlight(key: string): boolean {
      return attempts.get(key)?.inFlight === true;
    },
    clear(key?: string): void {
      if (key !== undefined) attempts.delete(key);
      else attempts.clear();
    },
  };
}

export const composerSendAttempts = createComposerSendAttemptStore();
