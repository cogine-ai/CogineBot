import type { ThreadMessage } from "@rakazo/contracts";
import { newClientId } from "./client-id";
import type { ComposerDraft } from "./composer-draft";
import { makeComposerDraftKey, readComposerDraft, writeComposerDraft } from "./composer-draft";
import { composerSendAttempts } from "./composer-send-attempt";
import type { SessionGate } from "./session-gate";

export type VerifiedComposerRecoveryTarget = {
  apiOrigin: string;
  userId: string;
  sessionId: string;
  spaceId: string;
  selectionId: string | null;
  selectionGeneration: number;
  targetKind: "bot" | "group";
  targetId: string;
  threadId: string;
};

type RecoveryRequest = Omit<VerifiedComposerRecoveryTarget, "spaceId" | "threadId">;
type VerifiedEditor = { target: VerifiedComposerRecoveryTarget; key: string; blocked: boolean };
let verifiedEditor: VerifiedEditor | undefined;
let held:
  | {
      target: VerifiedComposerRecoveryTarget;
      text: string;
      files: File[];
      stage: "prepared" | "anonymous" | "authenticated";
      authenticatedSessionId: string | null;
    }
  | undefined;

function sameTarget(left: VerifiedComposerRecoveryTarget, right: VerifiedComposerRecoveryTarget) {
  return (
    left.apiOrigin === right.apiOrigin &&
    left.userId === right.userId &&
    left.spaceId === right.spaceId &&
    left.targetKind === right.targetKind &&
    left.targetId === right.targetId &&
    left.threadId === right.threadId
  );
}

/** A verified descriptor survives a Files route unmount, but carries no draft or send attempt. */
export function rememberVerifiedComposerRecoveryTarget(
  target: VerifiedComposerRecoveryTarget,
  key: string,
  blocked: boolean,
): void {
  if (!target.sessionId || !target.threadId || key !== makeComposerDraftKey(target)) return;
  if (held?.stage === "authenticated" && !sameTarget(held.target, target))
    discardRejectedComposerDraft();
  verifiedEditor = { target: { ...target }, key, blocked };
}

/** Explicit rejected-session recovery only; a normal logout never prepares this isolated copy. */
export function prepareRejectedComposerDraft(
  request: RecoveryRequest,
  previewReply: (message: ThreadMessage) => string,
): boolean {
  held = undefined;
  const editor = verifiedEditor;
  if (
    !editor ||
    editor.blocked ||
    composerSendAttempts.isInFlight(editor.key) ||
    editor.target.apiOrigin !== request.apiOrigin ||
    editor.target.userId !== request.userId ||
    editor.target.sessionId !== request.sessionId ||
    editor.target.selectionId !== request.selectionId ||
    editor.target.selectionGeneration !== request.selectionGeneration ||
    editor.target.targetKind !== request.targetKind ||
    editor.target.targetId !== request.targetId
  )
    return false;
  const draft = readComposerDraft(editor.key);
  try {
    const quote = draft.replyQuote ?? (draft.replyTarget ? previewReply(draft.replyTarget) : null);
    const context = [
      ...(draft.selectedSkill ? [`/${draft.selectedSkill.name}`] : []),
      ...draft.selectedMentions.map((mention) => `@${mention.name}`),
    ];
    let text = context.length ? `${context.join("\n")}\n${draft.text}` : draft.text;
    if (quote !== null)
      text = `${quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n${text}`;
    if (!text && draft.attachments.length === 0) return false;
    held = {
      target: { ...editor.target },
      text,
      // A new immutable File retains bytes/name/MIME, without IDs, old previews or upload receipts.
      files: draft.attachments.map(
        ({ file }) =>
          new File([file.slice()], file.name, {
            type: file.type,
            lastModified: file.lastModified,
          }),
      ),
      stage: "prepared",
      authenticatedSessionId: null,
    };
    return true;
  } catch {
    // A failed editable copy cannot block rejected-session removal.
    return false;
  }
}

export function discardRejectedComposerDraft(): void {
  held = undefined;
  verifiedEditor = undefined;
}

/** The ordinary anonymous boundary still clears every draft and send attempt outside this RAM copy. */
export function observeRejectedComposerSession(
  gate: SessionGate,
  userId: string | undefined,
  sessionId: string | undefined,
  apiOrigin: string,
): void {
  if (gate === "loading" || gate === "unreachable") return;
  if (gate === "anonymous") {
    verifiedEditor = undefined;
    if (held?.stage === "prepared") held.stage = "anonymous";
    else if (held?.stage === "authenticated") discardRejectedComposerDraft();
    return;
  }
  if (!userId || !sessionId || !held) return;
  if (held.target.userId !== userId || held.target.apiOrigin !== apiOrigin) {
    discardRejectedComposerDraft();
  } else if (held.stage === "anonymous") {
    if (sessionId === held.target.sessionId) discardRejectedComposerDraft();
    else {
      held.stage = "authenticated";
      held.authenticatedSessionId = sessionId;
    }
  } else if (
    sessionId !== (held.stage === "prepared" ? held.target.sessionId : held.authenticatedSessionId)
  ) {
    discardRejectedComposerDraft();
  }
}

function isEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text === "" &&
    draft.attachments.length === 0 &&
    draft.selectedSkill === null &&
    draft.selectedMentions.length === 0 &&
    draft.replyTarget === null &&
    draft.replyQuote === null
  );
}

/** Fresh bootstrap plus the actual thread supply the proof; consume once without sending. */
export function restoreRejectedComposerDraft(
  target: VerifiedComposerRecoveryTarget,
  key: string,
  canRestore: boolean,
  isCurrent: () => boolean,
): boolean {
  const saved = held;
  if (saved?.stage !== "authenticated") return false;
  if (!isCurrent()) return false;
  held = undefined;
  if (
    !canRestore ||
    !sameTarget(saved.target, target) ||
    saved.authenticatedSessionId !== target.sessionId ||
    key !== makeComposerDraftKey(target) ||
    !isEmpty(readComposerDraft(key)) ||
    composerSendAttempts.isInFlight(key) ||
    !isCurrent()
  )
    return false;
  writeComposerDraft(key, {
    text: saved.text,
    attachments: saved.files.map((file) => ({ id: newClientId(), threadKey: key, file })),
  });
  return true;
}
