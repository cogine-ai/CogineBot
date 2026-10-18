import type { AppBootstrap } from "@rakazo/contracts";
import { initialBootstrapTarget } from "./bootstrap-target";
import { markOnce } from "./performance";
import { rpc } from "./rpc";

const BOOTSTRAP_TIMEOUT_MS = 15_000;

let ticketBoardEnabled: boolean | undefined;
const capabilityListeners = new Set<() => void>();
export function getTicketBoardEnabled() {
  return ticketBoardEnabled;
}
export function subscribeTicketBoardEnabled(listener: () => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

let primedBootstrap: { botId?: string; promise: Promise<AppBootstrap> } | null = null;

const initialTarget = initialBootstrapTarget(
  window.location.pathname,
  Boolean(window.rakazoDesktop),
);
if (initialTarget) {
  const { botId } = initialTarget;
  const promise = requestBootstrap(botId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, promise };
}

/** The speculative first-load bootstrap, left in place for the shell to take. */
export function peekInitialBootstrap(): Promise<AppBootstrap> | undefined {
  return primedBootstrap?.promise;
}

export function takeInitialBootstrap(botId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (primed && primed.botId === botId) return primed.promise;
  return requestBootstrap(botId);
}

async function requestBootstrap(botId?: string) {
  markOnce("rk:renderer:bootstrap-request-start");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new DOMException("Bootstrap request timed out", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, BOOTSTRAP_TIMEOUT_MS);
  });
  try {
    const bootstrap = await Promise.race([
      rpc.bootstrap(botId ? { botId } : {}, { signal: controller.signal }),
      deadline,
    ]);
    markOnce("rk:renderer:bootstrap-response");
    ticketBoardEnabled = bootstrap.me.ticketBoardEnabled;
    for (const listener of capabilityListeners) listener();
    return bootstrap;
  } finally {
    clearTimeout(timeout);
  }
}
