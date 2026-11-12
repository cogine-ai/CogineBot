import { randomUUID } from "node:crypto";
import type { MessagingSurface } from "@rakazo/adapter-kit";
import { providerOfThreadId } from "@rakazo/adapters";
import { getLogger } from "@rakazo/logging";

const SLACK_RECEIPT_DELAY_MS = 60_000;

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge" | "sendTyping">,
) {
  const capabilities = new Map(
    messaging.platforms().map(({ provider, capabilities }) => [provider, capabilities]),
  );
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = new AbortController();

  const send = (threadId: string, handle: string) => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    const context = {
      operationId,
      traceId: operationId,
      spaceId: "",
      userId: "",
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(2000)]),
    };
    return messaging.acknowledge
      ? messaging.acknowledge(threadId, handle, context)
      : messaging.sendTyping(threadId, context);
  };
  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  return {
    acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>) {
      if (stop.signal.aborted) return;
      const platform = capabilities.get(providerOfThreadId(threadId));
      const receipt = platform?.receipt ?? (platform?.typing ? "typing" : undefined);
      if (!receipt) return;
      if (receipt === "typing") {
        void send(threadId, handle).catch(logFailure);
        return;
      }
      const key = JSON.stringify([threadId, handle]);
      if (timers.has(key) || timers.size >= 256) return;
      const timer = setTimeout(() => {
        void (async () => {
          if ((await handled()) || stop.signal.aborted) return;
          await send(threadId, handle);
        })()
          .catch(logFailure)
          .finally(() => timers.delete(key));
      }, SLACK_RECEIPT_DELAY_MS);
      timer.unref();
      timers.set(key, timer);
    },
    stop() {
      stop.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
