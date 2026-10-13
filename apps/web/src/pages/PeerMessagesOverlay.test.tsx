// @vitest-environment jsdom
import type { ProductEvent, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { runThreadSubscription } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { PeerMessagesOverlay } from "./PeerMessagesOverlay";

const streams = vi.hoisted(() => [] as Parameters<typeof runThreadSubscription>[0][]);
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  runThreadSubscription: vi.fn(async (options: Parameters<typeof runThreadSubscription>[0]) => {
    streams.push(options);
    await options.loadInitial();
  }),
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => "space-default",
  rpc: { threads: { messages: vi.fn(), get: vi.fn(), head: vi.fn(), subscribe: vi.fn() } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en-US" },
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: ({ identity }: { identity: string }) => <span data-avatar-id={identity} />,
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./shell/chat-context", () => ({
  TimeSeparator: ({ createdAt }: { createdAt: string }) => <h3>{createdAt}</h3>,
}));

const props = {
  botId: "chief",
  botName: "Chief",
  botColor: "orange",
  peerBotId: "peer",
  peerBotName: "Researcher",
  peerBotColor: "blue",
  spaceId: "space-one",
  threadId: "direct",
  messages: [] as ThreadMessage[],
  onClose: vi.fn(),
};
function receipt(
  id: string,
  seq: number,
  text: string,
  direction: "sent" | "received" = "sent",
  threadId = "direct",
): ThreadMessage {
  return {
    id,
    threadId,
    seq,
    role: "bot",
    botId: "chief",
    createdAt: `2026-10-11T09:${String(seq).padStart(2, "0")}:00Z`,
    blocks:
      direction === "sent"
        ? [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Researcher", text }]
        : [{ kind: "bot_message_received", fromBotId: "peer", fromBotName: "Researcher", text }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function snapshot(messages: ThreadMessage[]): ThreadSnapshot {
  return { threadId: "direct", cursor: 5, botId: "chief", messages, olderCursor: null, run: null };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  streams.length = 0;
  vi.mocked(rpc.threads.messages).mockResolvedValue({
    threadId: "direct",
    messages: [],
    olderCursor: null,
  });
  vi.mocked(rpc.threads.get).mockResolvedValue(snapshot([]));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(next: Parameters<typeof PeerMessagesOverlay>[0] = props) {
  return act(async () => root.render(<PeerMessagesOverlay {...next} />));
}
function rows() {
  return [...container.querySelectorAll<HTMLElement>("[data-peer-message-id]")];
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
}

describe("inline peer chat", () => {
  it("buffers live receipts during history loading and deduplicates a slower overlapping row", async () => {
    const history = deferred<Awaited<ReturnType<typeof rpc.threads.messages>>>();
    vi.mocked(rpc.threads.messages).mockReturnValueOnce(history.promise);
    const first = receipt("first", 1, "First send");
    await render({ ...props, messages: [first] });
    const reply = receipt("reply", 2, "Live reply", "received");
    await render({ ...props, messages: [first, reply] });
    await act(async () =>
      history.resolve({
        threadId: "direct",
        messages: [
          first,
          {
            ...reply,
            seq: 1,
            blocks: [
              {
                kind: "bot_message_received",
                fromBotId: "peer",
                fromBotName: "Researcher",
                text: "Stale reply",
              },
            ],
          },
        ],
        olderCursor: null,
      }),
    );
    expect(rows()).toHaveLength(2);
    expect(rows()[1]?.textContent).toContain("Live reply");
    expect(container.textContent).not.toContain("Stale reply");
    expect(container.querySelector("[role=dialog]")).toBeNull();
    expect(container.querySelectorAll("input,textarea,[contenteditable=true]")).toHaveLength(0);
    expect(
      container
        .querySelector('[data-testid="peer-conversation-header"]')
        ?.querySelectorAll("[data-avatar-id]"),
    ).toHaveLength(2);
    expect(button("Close chat")).toBeDefined();
    expect(runThreadSubscription).not.toHaveBeenCalled();
    expect(rpc.threads.messages).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "chief", includePeerRuns: true }),
      expect.objectContaining({ context: { spaceId: "space-one" } }),
    );
  });

  it("keeps live messages available when history fails and retries without duplicating them", async () => {
    vi.mocked(rpc.threads.messages).mockRejectedValueOnce(new Error("offline"));
    const first = receipt("first", 1, "Still here");
    await render({ ...props, messages: [first] });
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Could not load this chat.");
    vi.mocked(rpc.threads.messages).mockResolvedValueOnce({
      threadId: "direct",
      messages: [first, receipt("reply", 2, "Now connected", "received")],
      olderCursor: null,
    });
    await act(async () => button("Retry now").click());
    expect(rows()).toHaveLength(2);
    expect(container.textContent).not.toContain("Could not load this chat.");
    expect(container.textContent).toContain("Now connected");
  });

  it("aborts stale history on Bot and Space changes and ignores the late response", async () => {
    const old = deferred<Awaited<ReturnType<typeof rpc.threads.messages>>>();
    vi.mocked(rpc.threads.messages).mockReturnValueOnce(old.promise);
    await render({ ...props, messages: [receipt("old", 1, "Old chat")] });
    const signal = vi.mocked(rpc.threads.messages).mock.calls[0]?.[1]?.signal;
    await render({
      ...props,
      botId: "other",
      botName: "Other",
      spaceId: "space-two",
      messages: [],
    });
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      old.resolve({
        threadId: "direct",
        messages: [receipt("late", 2, "Late old reply")],
        olderCursor: null,
      }),
    );
    expect(container.textContent).not.toContain("Old chat");
    expect(container.textContent).not.toContain("Late old reply");
    expect(rpc.threads.messages).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: "other" }),
      expect.objectContaining({ context: { spaceId: "space-two" } }),
    );
  });

  it("aborts requests when closed and closes from the existing Escape shortcut", async () => {
    const pending = deferred<Awaited<ReturnType<typeof rpc.threads.messages>>>();
    vi.mocked(rpc.threads.messages).mockReturnValueOnce(pending.promise);
    await render();
    const signal = vi.mocked(rpc.threads.messages).mock.calls[0]?.[1]?.signal;
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
    );
    expect(props.onClose).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      pending.resolve({
        threadId: "direct",
        messages: [receipt("late", 1, "After close")],
        olderCursor: null,
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("does not force a reader back to the newest message when live receipts arrive", async () => {
    const first = receipt("first", 1, "First send");
    await render({ ...props, messages: [first] });
    const transcript = container.querySelector<HTMLElement>(
      '[data-testid="peer-conversation-transcript"]',
    )!;
    Object.defineProperties(transcript, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    });
    transcript.scrollTop = 120;
    act(() => transcript.dispatchEvent(new Event("scroll", { bubbles: true })));
    await render({ ...props, messages: [first, receipt("reply", 2, "New reply", "received")] });
    expect(transcript.scrollTop).toBe(120);
    expect(rows()).toHaveLength(2);
  });

  it("keeps the visible message anchored when older history arrives above it", async () => {
    const history = deferred<Awaited<ReturnType<typeof rpc.threads.messages>>>();
    vi.mocked(rpc.threads.messages).mockReturnValueOnce(history.promise);
    const first = receipt("first", 3, "Visible first");
    const visibleMessages = [
      first,
      receipt("second", 4, "Visible second"),
      receipt("third", 5, "Visible third"),
    ];
    await render({ ...props, messages: visibleMessages });
    const transcript = container.querySelector<HTMLElement>(
      '[data-testid="peer-conversation-transcript"]',
    )!;
    Object.defineProperties(transcript, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    });
    const rect = (top: number) => ({
      top,
      bottom: top + 100,
      left: 0,
      right: 100,
      x: 0,
      y: top,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(transcript, "getBoundingClientRect").mockReturnValue(rect(0));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.peerMessageId)
        return rect(rows().indexOf(this) * 100 - transcript.scrollTop);
      return rect(0);
    });
    transcript.scrollTop = 120;
    act(() => transcript.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(async () =>
      history.resolve({
        threadId: "direct",
        messages: [receipt("older", 1, "Older send"), ...visibleMessages],
        olderCursor: null,
      }),
    );
    expect(transcript.scrollTop).toBe(220);
    vi.restoreAllMocks();
  });

  it("combines a group send with live direct replies and suppresses cleared history", async () => {
    const groupSend = receipt("group-send", 1, "Group request", "sent", "group-thread");
    const anotherMember = {
      ...groupSend,
      id: "other-member",
      botId: "another-member",
      blocks: [
        {
          kind: "bot_message_sent" as const,
          toBotId: "peer",
          toBotName: "Researcher",
          text: "Other member request",
        },
      ],
    };
    const reply = receipt("direct-reply", 2, "Direct response", "received");
    let directHistory = [reply];
    vi.mocked(rpc.threads.messages).mockImplementation(async (input) => ({
      threadId: input.groupId ? "group-thread" : "direct",
      messages: input.groupId ? [groupSend, anotherMember] : directHistory,
      olderCursor: null,
    }));
    await render({
      ...props,
      groupId: "group-one",
      threadId: "group-thread",
      messages: [groupSend],
    });
    expect(rows()).toHaveLength(2);
    expect(container.textContent).not.toContain("Other member request");
    expect(streams).toHaveLength(1);
    const stream = streams[0]!;
    expect(stream.signal.aborted).toBe(false);
    const event = {
      id: "live",
      spaceId: "space-one",
      threadId: "direct",
      botId: "chief",
      seq: 6,
      createdAt: "2026-10-11T09:03:00Z",
      type: "thread.message.created",
      payload: {
        messageId: "live-reply",
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "peer",
            fromBotName: "Researcher",
            text: "Live direct response",
          },
        ],
      },
    } as ProductEvent;
    act(() => stream.applyEvent(event));
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain("Live direct response");
    directHistory = [];
    act(() => stream.applyEvent({ ...event, seq: 7, type: "thread.cleared", payload: {} }));
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Group request");
    await act(async () => button("Close chat").click());
    expect(props.onClose).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(stream.signal.aborted).toBe(true);
  });

  it("clears one thread without treating its event cursor as a message cutoff", async () => {
    const groupSend = receipt("group-send", 1, "Group request", "sent", "group-thread");
    const oldReply = receipt("old-reply", 2, "Before clear", "received");
    const pendingHistory = deferred<Awaited<ReturnType<typeof rpc.threads.messages>>>();
    let directHistory: ThreadMessage[] = [];
    vi.mocked(rpc.threads.messages).mockImplementation((input) => {
      if (input.groupId) {
        return Promise.resolve({
          threadId: "group-thread",
          messages: [groupSend],
          olderCursor: null,
        });
      }
      if (vi.mocked(rpc.threads.messages).mock.calls.length === 1) return pendingHistory.promise;
      return Promise.resolve({ threadId: "direct", messages: directHistory, olderCursor: null });
    });
    vi.mocked(rpc.threads.get).mockResolvedValue(snapshot([oldReply]));
    await render({
      ...props,
      groupId: "group-one",
      threadId: "group-thread",
      messages: [groupSend],
    });
    expect(container.textContent).toContain("Before clear");
    const historySignal = vi.mocked(rpc.threads.messages).mock.calls[0]?.[1]?.signal;
    const stream = streams[0]!;
    const staleSnapshot = deferred<ThreadSnapshot>();
    vi.mocked(rpc.threads.get).mockReturnValueOnce(staleSnapshot.promise);
    const refreshingBeforeClear = stream.refresh();
    const clear = {
      id: "clear-event",
      spaceId: "space-one",
      threadId: "direct",
      botId: "chief",
      seq: 100,
      createdAt: "2026-10-11T09:03:00Z",
      type: "thread.cleared",
      payload: {},
    } as ProductEvent;
    act(() => stream.applyEvent(clear));
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain("Group request");
    expect(container.textContent).not.toContain("Before clear");

    // Message sequences continue independently of the much larger event cursor.
    const fresh = receipt("fresh-reply", 3, "After clear", "received");
    directHistory = [fresh];
    vi.mocked(rpc.threads.get).mockResolvedValue({ ...snapshot([fresh]), cursor: 100 });
    await act(async () => stream.refresh());
    expect(container.textContent).toContain("After clear");
    expect(rows()).toHaveLength(2);
    expect(historySignal?.aborted).toBe(true);
    const nextReply = receipt("next-reply", 4, "Newer reply", "received");
    act(() =>
      stream.applyEvent({
        ...clear,
        id: "live-after-clear",
        seq: 101,
        type: "thread.message.created",
        payload: { messageId: nextReply.id, role: "bot", blocks: nextReply.blocks },
      }),
    );
    expect(container.textContent).toContain("Newer reply");
    await act(async () => {
      staleSnapshot.resolve(snapshot([oldReply]));
      await refreshingBeforeClear;
    });
    expect(container.textContent).not.toContain("Before clear");
    expect(container.textContent).toContain("After clear");
    expect(container.textContent).toContain("Newer reply");
    await act(async () =>
      pendingHistory.resolve({
        threadId: "direct",
        messages: [oldReply],
        olderCursor: null,
      }),
    );
    expect(container.textContent).not.toContain("Before clear");
    expect(container.textContent).toContain("After clear");
    expect(container.textContent).toContain("Group request");

    vi.mocked(rpc.threads.get).mockResolvedValue({ ...snapshot([fresh, nextReply]), cursor: 101 });
    await act(async () => stream.refresh());
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain("Newer reply");

    vi.mocked(rpc.threads.get).mockResolvedValue({ ...snapshot([fresh, nextReply]), cursor: 120 });
    await act(async () => stream.refresh());
    const historyReads = vi.mocked(rpc.threads.messages).mock.calls.length;
    act(() => {
      stream.applyEvent({ ...clear, seq: 110 });
      stream.applyEvent(clear);
    });
    expect(stream.currentSnapshot()?.cursor).toBe(120);
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain("After clear");
    expect(container.textContent).toContain("Newer reply");
    expect(vi.mocked(rpc.threads.messages).mock.calls).toHaveLength(historyReads);
  });
});
