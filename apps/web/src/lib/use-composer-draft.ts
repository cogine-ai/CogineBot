import { useCallback, useSyncExternalStore } from "react";
import type { ComposerDraftChange } from "./composer-draft";
import {
  clearSubmittedComposerDraft,
  readComposerDraft,
  subscribeComposerDraft,
  writeComposerDraft,
} from "./composer-draft";

export function useComposerDraft(key: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeComposerDraft(key, listener),
    [key],
  );
  const getSnapshot = useCallback(() => readComposerDraft(key), [key]);
  const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const updateDraft = useCallback(
    (change: ComposerDraftChange) => writeComposerDraft(key, change),
    [key],
  );
  const clearSubmittedDraft = useCallback(
    (version: number) => clearSubmittedComposerDraft(key, version),
    [key],
  );
  return { draft, updateDraft, clearSubmittedDraft };
}
