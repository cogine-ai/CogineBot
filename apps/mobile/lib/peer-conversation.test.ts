import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Api from "./api";
import type { MobileMessage, MobileSnapshot } from "./api";
import type { MobileScope } from "./mobile-scope";
import type { PeerConversationState } from "./peer-conversation";
import { runPeerConversation } from "./peer-conversation";

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), subscribe: vi.fn(), current: true }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(),
  stopLiveNotifications: vi.fn(),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./mobile-scope", () => ({ isMobileScopeCurrent: () => fixture.current }));
vi.mock("./space-request-context", () => ({
  spaceRequestContext: async () => ({
    apiBase: "https://example.test",
    headers: { "x-rakazo-space-id": "space-a" },
  }),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  rpc: fixture.rpc,
  subscribeThread: fixture.subscribe,
}));

const scope = {} as MobileScope;
const target = {
  readOnly: false,
  botId: "origin",
  botName: "Origin",
  botColor: "ink",
  peerBotId: "peer",
  peerBotName: "Peer",
  peerBotColor: "ink",
};
const aborts: AbortController[] = [];
const states: PeerConversationState[] = [];
const streams = new Map<string, Parameters<typeof Api.subscribeThread>[2]>();
function row(id: string, seq: number, threadId = "direct", botId = "origin"): MobileMessage {
  return {
    id,
    seq,
    threadId,
    botId,
    role: "bot",
    createdAt: `2026-01-01T00:00:0${seq}Z`,
    blocks: [{ kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: id }],
  };
}
function snapshot(threadId = "direct"): MobileSnapshot {
  return { threadId, cursor: 10, olderCursor: null, messages: [], run: null };
}
function start(groupId?: string) {
  const abort = new AbortController();
  aborts.push(abort);
  const done = runPeerConversation({
    target: { ...target, groupId },
    scope,
    signal: abort.signal,
    onState: (state) => states.push(state),
  });
  return { abort, done };
}
function texts() {
  const state = states.at(-1);
  return state?.status === "ready"
    ? (state.conversation?.messages.map((message) => message.text) ?? [])
    : [];
}
beforeEach(() => {
  fixture.current = true;
  states.length = 0;
  streams.clear();
  fixture.rpc.mockReset();
  fixture.subscribe.mockReset();
  fixture.rpc.mockImplementation(async (proc, input) =>
    proc === "threads/get"
      ? snapshot(input.groupId ? "group" : "direct")
      : { messages: [row("old", 1, input.groupId ? "group" : "direct")], olderCursor: null },
  );
  fixture.subscribe.mockImplementation((input, _cursor, event, signal) => {
    streams.set(input.botId ?? input.groupId, event);
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
});
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  vi.useRealTimers();
});

it("loads all pages, orders and deduplicates them, pins history and subscriptions to the same Space", async () => {
  fixture.rpc.mockImplementation(async (proc, input) =>
    proc === "threads/get"
      ? snapshot()
      : input.before === undefined
        ? { messages: [row("new", 3), row("middle", 2)], olderCursor: 2 }
        : { messages: [row("middle", 2), row("old", 1)], olderCursor: null },
  );
  start();
  await vi.waitFor(() => expect(streams.size).toBe(1));
  expect(texts()).toEqual(["old", "middle", "new"]);
  expect(
    fixture.rpc.mock.calls
      .filter(([proc]) => proc === "threads/messages")
      .map(([, input]) => input.before),
  ).toEqual([undefined, 2]);
  const context = fixture.rpc.mock.calls[0]![2].requestContext;
  expect(fixture.subscribe.mock.calls[0]![5]).toBe(context);
  expect(fixture.subscribe.mock.calls[0]![1]).toBe(10);
  expect(context.headers["x-rakazo-space-id"]).toBe("space-a");
});

it("combines group sends with live direct replies only for the originating Bot pair", async () => {
  fixture.rpc.mockImplementation(async (proc, input) =>
    proc === "threads/get"
      ? snapshot(input.groupId ? "group" : "direct")
      : {
          messages: input.groupId
            ? [row("group-send", 1, "group"), row("other-bot", 2, "group", "other")]
            : [],
          olderCursor: null,
        },
  );
  start("group");
  await vi.waitFor(() => expect(streams.size).toBe(2));
  expect(texts()).toEqual(["group-send"]);
  streams.get("origin")!({
    type: "thread.message.created",
    threadId: "direct",
    seq: 11,
    botId: "origin",
    createdAt: "2026-01-01T00:00:03Z",
    payload: {
      messageId: "reply",
      messageSeq: 3,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer",
          fromBotName: "Peer",
          text: "live reply",
        },
      ],
    },
  });
  expect(texts()).toEqual(["group-send", "live reply"]);
  streams.get("group")!({ type: "thread.cleared", threadId: "group", seq: 12 });
  expect(texts()).toEqual(["live reply"]);
});

it("does not reveal direct bodies when group authorization fails; retry can recover", async () => {
  const original = fixture.rpc.getMockImplementation()!;
  fixture.rpc.mockImplementation(async (proc, input, opts) => {
    if (input.groupId) throw new Error("FORBIDDEN");
    return original(proc, input, opts);
  });
  await start("group").done;
  expect(states.map((state) => state.status)).toEqual(["loading", "error"]);
  expect(streams.size).toBe(0);
  fixture.rpc.mockImplementation(original);
  start("group");
  await vi.waitFor(() => expect(streams.size).toBe(2));
  expect(states.at(-1)?.status).toBe("ready");
});

it("cancels all streams and hides loaded bodies on subscription permission failure", async () => {
  let reject!: (error: Error) => void;
  fixture.subscribe.mockImplementation(
    (_input, _cursor, _event, signal) =>
      new Promise<void>((resolve, fail) => {
        reject = fail;
        signal.addEventListener("abort", () => resolve());
      }),
  );
  const run = start("group");
  await vi.waitFor(() => expect(fixture.subscribe).toHaveBeenCalledTimes(2));
  reject(new Error("FORBIDDEN"));
  await run.done;
  expect(states.at(-1)?.status).toBe("error");
  expect(fixture.subscribe.mock.calls.every((call) => call[3].aborted)).toBe(true);
});

it.each(["close", "scope"])(
  "ignores delayed history after %s, even when transport ignores abort",
  async (reason) => {
    let resolve!: (value: unknown) => void;
    fixture.rpc.mockImplementation(async (proc) =>
      proc === "threads/get"
        ? snapshot()
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const run = start();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    if (reason === "close") run.abort.abort();
    else fixture.current = false;
    resolve({ messages: [row("late-private-body", 1)], olderCursor: null });
    await run.done;
    expect(states.map((state) => state.status)).toEqual(["loading"]);
    expect(streams.size).toBe(0);
  },
);

it("ignores stale callbacks after closing and starts a new conversation with fresh state", async () => {
  const first = start();
  await vi.waitFor(() => expect(streams.size).toBe(1));
  const stale = streams.get("origin")!;
  first.abort.abort();
  await first.done;
  start();
  await vi.waitFor(() => expect(fixture.subscribe).toHaveBeenCalledTimes(2));
  const count = states.length;
  stale({ type: "thread.cleared", threadId: "direct", seq: 12 });
  expect(states).toHaveLength(count);
  expect(texts()).toEqual(["old"]);
});
