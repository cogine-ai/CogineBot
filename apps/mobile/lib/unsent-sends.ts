import { Alert, AppState } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  rpc,
  selectedSpaceId,
  subscribeServerReachable,
} from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import { t } from "./i18n";
import { integrationsCacheScope } from "./integrations-cache";
import { outboxDisk } from "./outbox-disk";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  subscribeSessionGeneration,
} from "./session";
import type { OutboxScope } from "./thread-feedback";
import { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { errorText } from "./user-error";

let activeScope: (OutboxScope & { generation: number }) | null = null;
function scope() {
  return activeScope &&
    activeScope.generation === currentSessionGeneration() &&
    activeScope.apiBase === currentApiBase()
    ? activeScope
    : null;
}
async function prepareUnsentScope(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  if (!scope() || activeScope?.spaceId !== spaceId) {
    const saved = await loadVerifiedIntegrationsScope();
    const verified =
      saved?.apiBase === apiBase && (spaceId || saved.selectionId === null)
        ? saved
        : await integrationsCacheScope();
    const cacheSession = await artifactCacheSession(await loadSessionToken());
    if (
      generation !== currentSessionGeneration() ||
      apiBase !== currentApiBase() ||
      spaceId !== selectedSpaceId()
    )
      throw new Error(t("Failed to send message"));
    activeScope = {
      apiBase,
      spaceId: spaceId ?? verified.spaceId,
      userId: verified.userId,
      cacheSession,
      generation,
    };
  }
}
export async function prepareUnsentSends(): Promise<void> {
  await prepareUnsentScope();
  restoreUnsentSends();
}
// Configure the wipe before bootstrap can replace credentials or the saved server.
configureUnsentSends({
  request: async <T>(
    proc: string,
    body: unknown,
    options: Parameters<typeof rpc>[2],
    spaceId: string | null,
  ) => {
    const generation = currentSessionGeneration();
    const context = await captureApiRequestContext();
    if (generation !== currentSessionGeneration()) throw new Error("Session changed");
    const headers = { ...context.headers };
    if (spaceId) headers["x-rakazo-space-id"] = spaceId;
    else delete headers["x-rakazo-space-id"];
    return rpc<T>(proc, body, { ...options, requestContext: { ...context, headers } });
  },
  serverReachable: isServerReachable,
  scope,
  disk: outboxDisk,
  errorText: (error) => errorText(error, t("Failed to send message")),
  notDelivered: (attempt) => {
    // The scoped thread keeps the refused payload and offers Models without replaying it.
    if (attempt.error === "platform_model_forbidden") return;
    Alert.alert(t("Failed to send message"), attempt.error);
  },
});
const RESTORE_RETRY_MIN_MS = 250;
const RESTORE_RETRY_MAX_MS = 5_000;
type RestoreRetry = {
  id: ReturnType<typeof setTimeout>;
  force: boolean;
  generation: number;
  apiBase: string;
};

export function startUnsentSends(): () => void {
  let stopped = false;
  let timer: RestoreRetry | undefined;
  let delay = RESTORE_RETRY_MIN_MS;
  const cancelRetry = () => {
    if (timer !== undefined) clearTimeout(timer.id);
    timer = undefined;
  };
  const retry = (force = false) => {
    if (stopped) return;
    const generation = currentSessionGeneration();
    const apiBase = currentApiBase();
    force ||= timer?.generation === generation && timer.apiBase === apiBase && timer.force;
    const isCurrent = () =>
      !stopped && generation === currentSessionGeneration() && apiBase === currentApiBase();
    cancelRetry();
    void prepareUnsentScope()
      .then(() => {
        if (!isCurrent()) return;
        try {
          restoreUnsentSends();
        } catch {
          // Retry only a storage restore, never failed authentication or network preparation.
          if (isCurrent()) {
            if (timer) timer.force ||= force;
            else {
              const wait = delay;
              delay = Math.min(RESTORE_RETRY_MAX_MS, delay * 2);
              const pending: RestoreRetry = {
                force,
                generation,
                apiBase,
                id: setTimeout(() => {
                  if (timer !== pending) return;
                  timer = undefined;
                  if (isCurrent()) retry(pending.force);
                }, wait),
              };
              timer = pending;
            }
          }
          return;
        }
        force ||= timer?.force ?? false;
        cancelRetry();
        delay = RESTORE_RETRY_MIN_MS;
        return sendWaitingMessages(force);
      })
      .catch(() => undefined);
  };
  retry();
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) retry();
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") retry(true);
  });
  const session = subscribeSessionGeneration(() => {
    cancelRetry();
    delay = RESTORE_RETRY_MIN_MS;
    if (currentReadySessionGeneration() === currentSessionGeneration()) retry();
  });
  return () => {
    stopped = true;
    cancelRetry();
    reachable();
    appState.remove();
    session();
  };
}
