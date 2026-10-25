const PRELOAD_RECOVERY_KEY = "rk:preload-recovery";
const PRELOAD_RECOVERY_COOLDOWN_MS = 30_000;

type PreloadRecoveryWindow = Pick<
  Window,
  | "addEventListener"
  | "clearTimeout"
  | "location"
  | "navigator"
  | "removeEventListener"
  | "sessionStorage"
  | "setTimeout"
>;

/**
 * Vite emits this event when a lazy chunk from an older deployment no longer
 * exists. Reload once so the browser receives the current asset manifest.
 * While offline a reload would only reach the browser's offline page, so the
 * failure is left to the app's error boundaries, which offer a retry.
 */
export function installPreloadRecovery(target: PreloadRecoveryWindow = window): () => void {
  let storage: Storage;
  try {
    storage = target.sessionStorage;
    preparePreloadRecoverySnapshot(storage);
  } catch {
    // Restricted storage must not crash the app or create a reload loop.
    return () => {};
  }
  const clearRecovery = target.setTimeout(() => {
    try {
      storage.removeItem(PRELOAD_RECOVERY_KEY);
    } catch {
      /* Storage can become unavailable. */
    }
  }, PRELOAD_RECOVERY_COOLDOWN_MS);
  const onPreloadError = (event: Event) => {
    if (!target.navigator.onLine) return;
    try {
      if (storage.getItem(PRELOAD_RECOVERY_KEY)) return;
      storage.setItem(PRELOAD_RECOVERY_KEY, "1");
    } catch {
      return;
    }
    event.preventDefault();
    try {
      const snapshot = currentPreloadRecoverySnapshot();
      if (snapshot) storage.setItem(PRELOAD_RECOVERY_STATE_KEY, JSON.stringify(snapshot));
      else storage.removeItem(PRELOAD_RECOVERY_STATE_KEY);
    } catch {
      // A failed panel snapshot does not prevent the one permitted recovery reload.
    }
    target.location.reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    target.clearTimeout(clearRecovery);
    target.removeEventListener("vite:preloadError", onPreloadError);
  };
}

import {
  currentPreloadRecoverySnapshot,
  PRELOAD_RECOVERY_STATE_KEY,
  preparePreloadRecoverySnapshot,
} from "./preload-recovery-state";
