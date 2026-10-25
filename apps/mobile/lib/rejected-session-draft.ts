import type { PickedAttachment } from "./pick-attachments-filter";

export type RejectedDraftScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  targetKind: "bot" | "group";
  targetId: string;
  threadId: string;
};

/** Editable content only: never a send attempt, permission, server handle or file URI. */
export type RejectedDraftContent = {
  text: string;
  attachments: Array<Pick<PickedAttachment, "name" | "mimeType" | "contentBase64">>;
};

export type RejectedDraftCapture = {
  scope: RejectedDraftScope;
  sessionGeneration: number;
  content: RejectedDraftContent;
};

let capture: (() => RejectedDraftCapture | null) | null = null;
let held:
  | {
      draft: RejectedDraftCapture;
      rejectedGeneration: number;
      authenticatedGeneration: number | null;
      verified: boolean;
    }
  | undefined;
let revision = 0;
let invalidation = 0;
const listeners = new Set<() => void>();

function changed(): void {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // An editor observer cannot interrupt credential removal.
    }
  }
}

export function rejectedSessionDraftRevision(): number {
  return revision;
}

export function rejectedSessionDraftInvalidation(): number {
  return invalidation;
}

export function subscribeRejectedSessionDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only the currently focused, verified editor registers a capture callback. */
export function registerRejectedSessionDraftCapture(
  next: () => RejectedDraftCapture | null,
): () => void {
  capture = next;
  return () => {
    if (capture === next) capture = null;
  };
}

export function captureRejectedSessionDraft(generation: number): RejectedDraftCapture | null {
  try {
    const value = capture?.();
    if (
      !value ||
      value.sessionGeneration !== generation ||
      (!value.content.text && value.content.attachments.length === 0)
    )
      return null;
    // Copy a strict allowlist, even if an editor's object also contains live request state.
    const { apiBase, userId, spaceId, targetKind, targetId, threadId } = value.scope;
    if (!apiBase || !userId || !spaceId || !targetId || !threadId) return null;
    return {
      scope: { apiBase, userId, spaceId, targetKind, targetId, threadId },
      sessionGeneration: generation,
      content: {
        text: value.content.text,
        attachments: value.content.attachments.map(({ name, mimeType, contentBase64 }) => ({
          name,
          mimeType,
          contentBase64,
        })),
      },
    };
  } catch {
    // Draft preservation must not prevent invalid credentials being removed.
    return null;
  }
}

export function discardRejectedSessionDraft(): void {
  invalidation += 1;
  held = undefined;
  changed();
}

/** Called only after the rejected session and its ordinary caches/outbox were cleared. */
export function retainRejectedSessionDraft(
  draft: RejectedDraftCapture | null,
  rejectedGeneration: number,
): void {
  held =
    draft && rejectedGeneration === draft.sessionGeneration + 1
      ? { draft, rejectedGeneration, authenticatedGeneration: null, verified: false }
      : undefined;
  changed();
}

/** A single successful authentication may claim the held editor; another session change drops it. */
export function authenticateRejectedSessionDraft(generation: number): void {
  if (!held) return;
  if (held.authenticatedGeneration !== null || generation !== held.rejectedGeneration + 1) {
    discardRejectedSessionDraft();
    return;
  }
  held.authenticatedGeneration = generation;
  changed();
}

/** Only a fresh authenticated `me` response, never a cached identity, supplies this proof. */
export function verifyRejectedSessionDraftOwner(input: {
  apiBase: string;
  userId: string;
  spaceId: string;
  sessionGeneration: number;
}): void {
  if (!held || held.authenticatedGeneration !== input.sessionGeneration) return;
  const scope = held.draft.scope;
  if (scope.apiBase !== input.apiBase || scope.userId !== input.userId) {
    discardRejectedSessionDraft();
    return;
  }
  // Sign-in initially reads the default Space. Wait for proof of the original Space;
  // opening any other verified thread below still consumes and discards the old draft.
  if (scope.spaceId === input.spaceId && !held.verified) {
    held.verified = true;
    changed();
  }
}

/** Explicit navigation only. Home's automatic default-Space bootstrap is not a user decision. */
export function observeRejectedSessionDraftSpace(spaceId: string | null, generation: number): void {
  if (held?.authenticatedGeneration === generation && held.draft.scope.spaceId !== spaceId) {
    discardRejectedSessionDraft();
  }
}

/** Consume once, only into the same verified target and an editor which accepts the insertion. */
export function restoreRejectedSessionDraft(
  scope: RejectedDraftScope,
  generation: number,
  restore: (content: RejectedDraftContent) => boolean,
): boolean {
  const saved = held;
  if (!saved) return false;
  const original = saved.draft.scope;
  if (
    saved.authenticatedGeneration !== generation ||
    original.apiBase !== scope.apiBase ||
    original.userId !== scope.userId ||
    original.spaceId !== scope.spaceId ||
    original.targetKind !== scope.targetKind ||
    original.targetId !== scope.targetId ||
    original.threadId !== scope.threadId
  ) {
    discardRejectedSessionDraft();
    return false;
  }
  if (!saved.verified) return false;
  held = undefined;
  changed();
  return restore(saved.draft.content);
}
