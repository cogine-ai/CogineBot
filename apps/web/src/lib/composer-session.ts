import { clearComposerDrafts } from "./composer-draft";
import { observeRejectedComposerSession } from "./composer-rejected-draft";
import { composerSendAttempts } from "./composer-send-attempt";
import type { SessionGate } from "./session-gate";

export function createComposerSessionGuard(clear: () => void) {
  let knownUserId: string | null | undefined;
  return (gate: SessionGate, userId: string | undefined): void => {
    // Failed or pending session reads are not evidence of a logout.
    if (gate === "loading" || gate === "unreachable") return;
    if (gate === "authenticated" && !userId) return;
    const nextUserId = gate === "authenticated" ? userId! : null;
    if (nextUserId === knownUserId) return;
    const shouldClear = nextUserId === null || knownUserId !== undefined;
    knownUserId = nextUserId;
    if (shouldClear) clear();
  };
}

// Module lifetime survives leaving Shell for the file library or a sign-in route.
const synchronize = createComposerSessionGuard(() => {
  clearComposerDrafts();
  composerSendAttempts.clear();
});

export function synchronizeComposerSession(
  gate: SessionGate,
  userId: string | undefined,
  sessionId?: string,
): void {
  observeRejectedComposerSession(gate, userId, sessionId, window.location.origin);
  synchronize(gate, userId);
}
