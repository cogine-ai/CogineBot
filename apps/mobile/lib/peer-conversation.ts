import type { PeerConversation } from "@rakazo/core";
import { abortableDelay, loadPeerHistory, mergePeerHistory, peerConversations } from "@rakazo/core";
import type { MobileMessage, MobileSnapshot } from "./api";
import { applyMobileThreadEvent, rpc, subscribeThread } from "./api";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent } from "./mobile-scope";
import { spaceRequestContext } from "./space-request-context";

export type PeerConversationTarget = {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  groupId?: string;
  /** Archived chat routes allow history reads but not live subscriptions. */
  readOnly: boolean;
};

export type PeerConversationState =
  | { status: "loading" | "error" }
  | { status: "ready"; conversation: PeerConversation | undefined };

/** A viewer owns its reads and streams, never the underlying chat's draft or snapshot. */
export async function runPeerConversation({
  target,
  scope,
  signal,
  onState,
}: {
  target: PeerConversationTarget;
  scope: MobileScope;
  signal: AbortSignal;
  onState: (state: PeerConversationState) => void;
}): Promise<void> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) abort.abort();
  const sessionSignal = abort.signal;
  const current = () => !sessionSignal.aborted && isMobileScopeCurrent(scope);
  const snapshots = new Map<string, MobileSnapshot>();
  const targets: Array<{ botId: string } | { groupId: string }> = [
    { botId: target.botId },
    ...(target.groupId ? [{ groupId: target.groupId }] : []),
  ];
  const publish = () => {
    if (!current() || snapshots.size !== targets.length) return;
    const messages = mergePeerHistory(
      [],
      [...snapshots.entries()].flatMap(([key, snapshot]) =>
        key === target.groupId
          ? snapshot.messages.filter((message) => message.botId === target.botId)
          : snapshot.messages,
      ),
    );
    onState({
      status: "ready",
      conversation: peerConversations(messages, target.botId).find(
        (conversation) => conversation.peerBotId === target.peerBotId,
      ),
    });
  };
  if (!current()) {
    signal.removeEventListener("abort", cancel);
    return;
  }
  onState({ status: "loading" });
  try {
    const captured = await spaceRequestContext(scope, current);
    const requestContext = { ...captured, isCurrent: current };
    // Pin the same verified Space, identity and cancellation guard for history AND SSE.
    const load = async (threadTarget: { botId: string } | { groupId: string }) => {
      if (!current()) return null;
      const initial = await rpc<MobileSnapshot>("threads/get", threadTarget, {
        requestContext,
        signal: sessionSignal,
      });
      if (!current()) return null;
      const messages = await loadPeerHistory<MobileMessage>({
        signal: sessionSignal,
        loadPage: (before, pageSignal) =>
          rpc(
            "threads/messages",
            {
              ...threadTarget,
              before,
              includePeerRuns: true,
            },
            { requestContext, signal: pageSignal },
          ),
      });
      if (!current()) return null;
      // Subscribe from the pre-history cursor: events during paging are replayed,
      // including edits and clears, instead of racing a slower historical copy.
      return { ...initial, messages: mergePeerHistory(initial.messages, messages) };
    };
    // Authorize every source before exposing any receipt body. A group-origin
    // conversation also needs access to the originating Bot's direct thread.
    for (const threadTarget of targets) {
      const snapshot = await load(threadTarget);
      if (!snapshot) return;
      snapshots.set("botId" in threadTarget ? threadTarget.botId : threadTarget.groupId, snapshot);
    }
    publish();
    if (target.readOnly) return;
    await Promise.all(
      targets.map(async (threadTarget) => {
        const key = "botId" in threadTarget ? threadTarget.botId : threadTarget.groupId;
        while (current()) {
          await subscribeThread(
            threadTarget,
            snapshots.get(key)?.cursor ?? -1,
            (event) => {
              if (!current()) return;
              const previous = snapshots.get(key);
              if (!previous || (event.threadId && event.threadId !== previous.threadId)) return;
              const next = applyMobileThreadEvent(previous, event);
              if (!next) return;
              snapshots.set(key, next);
              publish();
            },
            sessionSignal,
            undefined,
            requestContext,
          );
          if (!current()) return;
          await abortableDelay(1_000, sessionSignal);
          const refreshed = await load(threadTarget);
          if (!refreshed) return;
          snapshots.set(key, refreshed);
          publish();
        }
      }),
    );
  } catch {
    // Permission revocation must remove even previously loaded bodies. The same
    // explicit retry also recovers transient failures without a hot reconnect loop.
    if (current()) {
      abort.abort();
      snapshots.clear();
      onState({ status: "error" });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    abort.abort();
  }
}
