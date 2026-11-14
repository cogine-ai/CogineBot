import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Api from "../../mobile/lib/api";
import * as api from "../../mobile/lib/api";
import type { MobileScope } from "../../mobile/lib/mobile-scope";
import type { PeerConversationState } from "../../mobile/lib/peer-conversation";
import { runPeerConversation } from "../../mobile/lib/peer-conversation";

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), scope: {} }));
vi.mock("../../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock("../../mobile/lib/ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("../../mobile/lib/live-notifications", () => ({
  resumeLiveNotifications: vi.fn(),
  stopLiveNotifications: vi.fn(),
}));
vi.mock("../../mobile/lib/network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("../../mobile/lib/i18n", () => ({ t: (text: string) => text }));
vi.mock("../../mobile/lib/mobile-scope", () => ({
  isMobileScopeCurrent: (scope: unknown) => scope === fixture.scope,
}));
vi.mock("../../mobile/lib/space-request-context", () => ({
  spaceRequestContext: () => api.captureApiRequestContext("space-test"),
}));
vi.mock("../../mobile/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  rpc: fixture.rpc,
}));

// Keep the transport real: the locked RPCHandler serializes the generator's
// ORPCError, and production subscribeThread consumes that Response directly.
function deniedStream(code: "UNAUTHORIZED" | "FORBIDDEN", gate: Promise<void> = Promise.resolve()) {
  const handler = new RPCHandler({
    threads: {
      subscribe: os.handler(async function* () {
        yield { type: "heartbeat" };
        await gate;
        throw new ORPCError(code);
      }),
    },
  });
  return handler
    .handle(
      new Request("https://example.test/rpc/threads/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "origin", cursor: 10 } }),
      }),
      { prefix: "/rpc" },
    )
    .then(({ response }) => response!);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const runs: Array<{ abort: AbortController; done: Promise<void> }> = [];
function start(groupId?: string, readOnly = false) {
  const abort = new AbortController();
  const states: PeerConversationState[] = [];
  const done = runPeerConversation({
    scope: fixture.scope as MobileScope,
    target: {
      botId: "origin",
      botName: "Origin",
      botColor: "ink",
      peerBotId: "peer",
      peerBotName: "Peer",
      peerBotColor: "ink",
      groupId,
      readOnly,
    },
    signal: abort.signal,
    onState: (state) => states.push(state),
  });
  const run = { abort, states, done };
  runs.push(run);
  return run;
}
beforeEach(() => {
  fixture.scope = {};
  fixture.rpc.mockReset().mockImplementation(async (proc, target) => {
    const threadId = target.groupId ? "group" : "direct";
    const messages = [
      {
        id: "receipt",
        threadId,
        seq: 1,
        botId: "origin",
        role: "bot",
        createdAt: "2026-01-01T00:00:00Z",
        blocks: [
          { kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Authorized body" },
        ],
      },
    ];
    return proc === "threads/get"
      ? { threadId, cursor: 10, messages, olderCursor: null, run: null }
      : { messages, olderCursor: null };
  });
});
afterEach(async () => {
  for (const run of runs) run.abort.abort();
  await Promise.all(runs.splice(0).map((run) => run.done));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["UNAUTHORIZED", "FORBIDDEN"] as const)(
  "rejects the real RPCHandler %s SSE error",
  async (code) => {
    const response = await deniedStream(code);
    const wire = await response.clone().text();
    expect(wire).toContain("event: error");
    expect(wire).toContain(`"code":"${code}"`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const heartbeat = vi.fn();
    await expect(
      api.subscribeThread(
        { botId: "origin" },
        10,
        vi.fn(),
        new AbortController().signal,
        heartbeat,
      ),
    ).rejects.toMatchObject({ code, status: code === "UNAUTHORIZED" ? 401 : 403 });
    expect(heartbeat).toHaveBeenCalledOnce();
  },
);

it.each(["origin", "group"])(
  "clears bodies and cancels both viewer sources immediately when %s emits a real error",
  async (deniedTarget) => {
    const gate = deferred();
    const signals: AbortSignal[] = [];
    const canceled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        const target = JSON.parse(String(init.body)).json;
        if ((target.botId ?? target.groupId) === deniedTarget)
          return deniedStream("FORBIDDEN", gate.promise);
        return new Response(
          new ReadableStream({
            start(controller) {
              init.signal!.addEventListener(
                "abort",
                () => {
                  canceled();
                  controller.close();
                },
                { once: true },
              );
            },
          }),
        );
      }),
    );
    const run = start("group");
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(run.states.at(-1)?.status).toBe("ready");
    const reads = fixture.rpc.mock.calls.length;
    gate.resolve();
    await vi.waitFor(() => expect(run.states.at(-1)).toEqual({ status: "error" }), {
      timeout: 200,
    });
    await run.done;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(canceled).toHaveBeenCalledOnce();
    expect(fixture.rpc).toHaveBeenCalledTimes(reads);
  },
);

it("a late real SSE error from an obsolete scope cannot clear or cancel a replacement viewer", async () => {
  const gate = deferred();
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      if (signals.length === 1) return deniedStream("UNAUTHORIZED", gate.promise);
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => controller.close(), { once: true });
          },
        }),
      );
    }),
  );
  const old = start();
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  fixture.scope = {};
  const replacement = start();
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  gate.resolve();
  await old.done;
  expect(old.states.some((state) => state.status === "error")).toBe(false);
  expect(replacement.states.at(-1)?.status).toBe("ready");
  expect(signals[1]!.aborted).toBe(false);
});

it("keeps authorized archived history without opening or retrying live subscriptions", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => deniedStream("FORBIDDEN"));
  vi.stubGlobal("fetch", fetcher);
  const run = start(undefined, true);
  await vi.waitFor(() => expect(run.states.at(-1)?.status).toBe("ready"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetcher).not.toHaveBeenCalled();
  expect(fixture.rpc).toHaveBeenCalledTimes(2);
  expect(run.states.at(-1)).toMatchObject({
    status: "ready",
    conversation: { lastText: "Authorized body" },
  });
  run.abort.abort();
  await run.done;
});
