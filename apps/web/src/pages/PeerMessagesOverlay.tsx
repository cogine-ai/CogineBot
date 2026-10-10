import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { formatMessageTime, runThreadSubscription, timeSeparatorIds } from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadPeerHistory, mergePeerHistory } from "../lib/peer-history";
import { peerConversations } from "../lib/peer-messages";
import { rpc, selectedSpaceId } from "../lib/rpc";
import { reduceThreadSnapshot } from "../lib/thread-events";
import { transcriptIsNearEnd, transcriptMovedDown } from "../lib/transcript-scroll";
import { TimeSeparator } from "./shell/chat-context";

type PeerMessagesProps = {
  botId: string;
  botName: string;
  botColor: string;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  messages: readonly ThreadMessage[];
  threadId?: string;
  groupId?: string;
  spaceId?: string | null;
  onClose: () => void;
};

/** Read-only peer exchange inside the same chat shell, without replacing its draft or scroll state. */
export function PeerMessagesOverlay(props: PeerMessagesProps) {
  const spaceId = props.spaceId === undefined ? selectedSpaceId() : props.spaceId;
  return (
    <PeerMessagesContent
      key={`${spaceId}:${props.botId}:${props.peerBotId}:${props.groupId ?? ""}:${props.threadId ?? ""}`}
      {...props}
      spaceId={spaceId}
    />
  );
}

function PeerMessagesContent({
  botId,
  botName,
  botColor,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  messages: liveMessages,
  groupId,
  spaceId,
  onClose,
}: PeerMessagesProps) {
  const { i18n } = useLingui();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>(() =>
    mergePeerHistory([], liveMessages),
  );
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const clearedThrough = useRef(new Map<string, number>());
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef<number | null>(null);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const conversation = useMemo(
    () => peerConversations(messages, botId).find((entry) => entry.peerBotId === peerBotId),
    [messages, botId, peerBotId],
  );
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const peerMessages = conversation?.messages;
  const separatorIds = useMemo(() => timeSeparatorIds(peerMessages ?? []), [peerMessages]);

  function rememberReadingPosition() {
    const element = transcript.current;
    if (!element || following.current) return;
    const top = element.getBoundingClientRect().top;
    const first = [...element.querySelectorAll<HTMLElement>("[data-peer-message-id]")].find(
      (node) => node.getBoundingClientRect().bottom >= top,
    );
    anchor.current = first
      ? { id: first.dataset.peerMessageId!, top: first.getBoundingClientRect().top }
      : null;
  }

  function appendMessages(incoming: readonly ThreadMessage[]) {
    rememberReadingPosition();
    setMessages((current) => mergePeerHistory(current, incoming, clearedThrough.current));
  }

  useEffect(() => {
    appendMessages(liveMessages);
  }, [liveMessages]);

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    const targets = [{ botId }, ...(groupId ? [{ groupId }] : [])];
    void Promise.allSettled(
      targets.map((target) =>
        loadPeerHistory({
          signal: abort.signal,
          loadPage: (before, signal) =>
            rpc.threads.messages(
              { ...target, before, includePeerRuns: true },
              { signal, context: { spaceId } },
            ),
        }).then((loaded) => {
          if (!abort.signal.aborted) appendMessages(loaded);
        }),
      ),
    ).then((results) => {
      if (abort.signal.aborted) return;
      setHistoryFailed(results.some((result) => result.status === "rejected"));
      setHistoryReady(true);
    });
    return () => abort.abort();
  }, [botId, groupId, spaceId, reloadKey]);

  useEffect(() => {
    if (!groupId) return;
    // Group sends are stored in the group; peer replies return to the originating Bot's direct chat.
    // The group stream remains owned by Shell. This one viewer stream supplies those direct replies.
    const abort = new AbortController();
    let snapshot: ThreadSnapshot | null = null;
    const refresh = async () => {
      const next = await rpc.threads.get(
        { botId },
        {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
          context: { spaceId },
        },
      );
      if (abort.signal.aborted) return null;
      snapshot = next;
      appendMessages(next.messages);
      return next;
    };
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: refresh,
      loadHead: () =>
        rpc.threads.head(
          { botId },
          {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
            context: { spaceId },
          },
        ),
      refresh,
      currentSnapshot: () => snapshot,
      subscribe: (cursor) =>
        rpc.threads.subscribe({ botId, cursor }, { signal: abort.signal, context: { spaceId } }),
      applyEvent: (event) => {
        snapshot = reduceThreadSnapshot(snapshot, event);
        if (event.type === "thread.cleared") {
          clearedThrough.current.set(event.threadId, event.seq);
          appendMessages([]);
        } else if (
          event.type === "thread.message.created" ||
          event.type === "thread.message.updated"
        ) {
          appendMessages(snapshot?.messages ?? []);
        }
      },
      onEvent: () => {},
    });
    return () => abort.abort();
  }, [botId, groupId, spaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const element = transcript.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const saved = anchor.current;
      const node = [...element.querySelectorAll<HTMLElement>("[data-peer-message-id]")].find(
        (candidate) => candidate.dataset.peerMessageId === saved.id,
      );
      if (node) element.scrollTop += node.getBoundingClientRect().top - saved.top;
    }
    anchor.current = null;
    lastScrollTop.current = element.scrollTop;
  }, [peerMessages]);

  return (
    <div
      data-testid="peer-conversation-view"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      <header
        data-testid="peer-conversation-header"
        className="flex min-h-[72px] shrink-0 items-center justify-center px-5 py-3"
      >
        <h2 className="flex min-w-0 max-w-full items-center gap-2.5 rounded-full bg-muted/60 px-3 py-2 text-[13px] font-medium">
          <BotAvatar color={botColor} identity={botId} size={26} />
          <span className="min-w-0 truncate" dir="auto" title={botName}>
            {botName}
          </span>
          <span aria-hidden="true" className="shrink-0 font-normal text-muted-foreground">
            ·
          </span>
          <BotAvatar color={peerBotColor} identity={peerBotId} size={26} />
          <span className="min-w-0 truncate" dir="auto" title={peerBotName}>
            {peerBotName}
          </span>
        </h2>
      </header>
      <div
        ref={transcript}
        data-testid="peer-conversation-transcript"
        onWheel={(event) => {
          if (event.deltaY < 0) {
            following.current = false;
            lastScrollTop.current = event.currentTarget.scrollTop;
          }
        }}
        onTouchStart={(event) => {
          following.current = false;
          lastScrollTop.current = event.currentTarget.scrollTop;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const movedDown = transcriptMovedDown(lastScrollTop.current, element.scrollTop);
          if (transcriptIsNearEnd(element)) {
            if (movedDown) following.current = true;
          } else following.current = false;
          lastScrollTop.current = element.scrollTop;
        }}
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 @[480px]/conversation:px-7 @[480px]/conversation:py-6"
      >
        <div className="mx-auto flex w-full max-w-[764px] flex-col gap-5">
          {historyFailed ? (
            <div className="flex items-center justify-center gap-3 text-[13px] text-muted-foreground">
              <Trans>Could not load this chat.</Trans>
              <Button variant="ghost" size="sm" onClick={() => setReloadKey((value) => value + 1)}>
                <Trans>Retry now</Trans>
              </Button>
            </div>
          ) : !historyReady && !peerMessages?.length ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              <Trans>Loading…</Trans>
            </div>
          ) : historyReady && !peerMessages?.length ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              <Trans>No messages with {peerBotName} yet.</Trans>
            </div>
          ) : null}
          {peerMessages?.map((peerMessage) => {
            const sent = peerMessage.direction === "sent";
            const speakerName = sent ? botName : peerBotName;
            return (
              <Fragment key={peerMessage.id}>
                {separatorIds.has(peerMessage.id) ? (
                  <TimeSeparator createdAt={peerMessage.createdAt} locale={i18n.locale || "en"} />
                ) : null}
                <article
                  data-peer-message-id={peerMessage.id}
                  className="flex flex-col items-start gap-2"
                >
                  <div className="flex min-w-0 max-w-full items-center gap-2 text-[11px]">
                    <BotAvatar
                      color={sent ? botColor : peerBotColor}
                      identity={sent ? botId : peerBotId}
                      size={24}
                    />
                    <span className="truncate font-medium" dir="auto" title={speakerName}>
                      {speakerName}
                    </span>
                    <time
                      dateTime={peerMessage.createdAt}
                      title={formatMessageTime(peerMessage.createdAt, i18n.locale || "en")}
                      className="shrink-0 tabular-nums text-muted-foreground"
                    >
                      {new Date(peerMessage.createdAt).toLocaleTimeString(i18n.locale || "en", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <div
                    className="ms-8 min-w-0 max-w-[min(88%,calc(100%_-_2rem),720px)] rounded-[18px] rounded-ss-[5px] bg-muted px-[15px] py-2.5 text-[14px] leading-[1.7] text-foreground/90"
                    dir="auto"
                  >
                    <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
                  </div>
                </article>
              </Fragment>
            );
          })}
        </div>
      </div>
      <footer className="flex min-h-[72px] shrink-0 items-center justify-center px-5 py-3">
        <Button variant="secondary" className="rounded-full px-5 text-[13px]" onClick={onClose}>
          <Trans>Close chat</Trans>
        </Button>
      </footer>
    </div>
  );
}
