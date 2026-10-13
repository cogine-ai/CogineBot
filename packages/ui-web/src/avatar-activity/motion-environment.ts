const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;
let pageActive = true;

export function motionEnvironmentEnabled(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState !== "hidden" &&
    pageActive &&
    !(media ?? window.matchMedia("(prefers-reduced-motion: reduce)")).matches
  );
}

function notify() {
  for (const listener of listeners) listener();
}

function pageHide() {
  pageActive = false;
  notify();
}

function pageShow() {
  pageActive = true;
  notify();
}

export function subscribeMotionEnvironment(listener: () => void): () => void {
  if (listeners.size === 0) {
    media = window.matchMedia("(prefers-reduced-motion: reduce)");
    document.addEventListener("visibilitychange", notify);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    media.addEventListener("change", notify);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    document.removeEventListener("visibilitychange", notify);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", pageShow);
    media?.removeEventListener("change", notify);
    media = null;
    pageActive = true;
  };
}
