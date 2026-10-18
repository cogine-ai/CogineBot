import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_TIMEOUT_MS, runThreadSubscription } from "./thread-subscription.js";

const head = { threadId: "thread", cursor: 10 };
function event(seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    seq,
    type: "thread.progress",
    payload: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function heartbeat(): ProductEvent {
  return { ...event(0), id: "heartbeat", type: "heartbeat" };
}
function stream() {
  let deliver: ((result: IteratorResult<ProductEvent>) => void) | undefined;
  const events: AsyncIterable<ProductEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      };
    },
  };
  return {
    events,
    send: (value: ProductEvent) => deliver?.({ value, done: false }),
    end: () => deliver?.({ value: undefined, done: true }),
  };
}
function setup(committed: typeof head | null = head) {
  const abort = new AbortController();
  const channel = stream();
  const state = { committed };
  const callbacks = {
    signal: abort.signal,
    loadInitial: vi.fn(async () => head as typeof head | null),
    loadHead: vi.fn(async () => head as typeof head | null),
    refresh: vi.fn(async () => {}),
    currentSnapshot: () => state.committed,
    subscribe: vi.fn(async (_cursor: number) => channel.events),
    applyEvent: vi.fn(),
    onEvent: vi.fn(),
  };
  return { abort, channel, state, callbacks };
}
afterEach(() => vi.useRealTimers());

describe("thread subscription recovery", () => {
  it.each([false, true])(
    "recovers missing messages after a stale-snapshot head fallback with observer %s",
    async (observed) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup();
      const latest = { ...head, cursor: 15 };
      const timeout = new DOMException("Snapshot read timed out", "TimeoutError");
      let messages = ["seen-before-disconnect"];
      callbacks.loadInitial.mockRejectedValueOnce(timeout);
      callbacks.loadHead.mockResolvedValue(latest);
      callbacks.refresh
        .mockRejectedValueOnce(timeout)
        .mockImplementationOnce(async () => {
          state.committed = { ...head, cursor: 14 };
          messages = ["seen-before-disconnect", "missed-during-outage"];
        })
        .mockImplementation(async () => {
          state.committed = { ...head, cursor: 16 };
          messages = ["seen-before-disconnect", "missed-during-outage", "already-in-snapshot"];
        });
      callbacks.applyEvent.mockImplementation((item) => {
        messages.push(String(item.payload.messageId));
        state.committed = { ...head, cursor: item.seq };
      });
      const onStatus = vi.fn();
      const running = runThreadSubscription({
        ...callbacks,
        ...(observed ? { onStatus } : {}),
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.subscribe).toHaveBeenCalledWith(15);
        channel.send(heartbeat());
        await vi.advanceTimersByTimeAsync(0);
        expect(onStatus.mock.calls.some(([status]) => status === "ready")).toBe(false);
        channel.send({
          ...event(16),
          type: "thread.message.created",
          payload: { messageId: "already-in-snapshot", role: "bot", blocks: [] },
        });
        await vi.advanceTimersByTimeAsync(0);
        channel.send({
          ...event(17),
          type: "thread.message.created",
          payload: { messageId: "buffered-after-snapshot", role: "bot", blocks: [] },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.applyEvent).not.toHaveBeenCalled();
        expect(messages).toEqual(["seen-before-disconnect"]);
        await vi.advanceTimersByTimeAsync(250);
        expect(callbacks.refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(callbacks.refresh).toHaveBeenCalledTimes(2);
        expect(callbacks.applyEvent).not.toHaveBeenCalled();
        expect(onStatus.mock.calls.some(([status]) => status === "ready")).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(callbacks.refresh).toHaveBeenCalledTimes(3);
        expect(messages).toEqual([
          "seen-before-disconnect",
          "missed-during-outage",
          "already-in-snapshot",
          "buffered-after-snapshot",
        ]);
        expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([17]);
        // Existing onEvent effects retain the head boundary and run once per live event.
        expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([16, 17]);
        expect(callbacks.onEvent.mock.calls.every(([, initial]) => initial === latest)).toBe(true);
        if (observed) expect(onStatus).toHaveBeenLastCalledWith("ready");
      } finally {
        abort.abort();
        channel.end();
        await running;
      }
    },
  );

  it.each([16, 17])(
    "does not resurrect messages while catching up across a clear at event %s",
    async (clearSeq) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup();
      let messages = ["before-clear"];
      callbacks.loadInitial.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      callbacks.loadHead.mockResolvedValue({ ...head, cursor: 15 });
      callbacks.refresh.mockImplementation(async () => {
        state.committed = { ...head, cursor: 16 };
        messages = clearSeq === 16 ? [] : ["before-clear", "from-snapshot"];
      });
      callbacks.applyEvent.mockImplementation((item) => {
        if (item.type === "thread.cleared") messages = [];
        else messages.push(String(item.payload.messageId));
        state.committed = { ...head, cursor: item.seq };
      });
      const running = runThreadSubscription(callbacks);
      try {
        await vi.advanceTimersByTimeAsync(0);
        channel.send({ ...event(clearSeq), type: "thread.cleared" });
        await vi.advanceTimersByTimeAsync(0);
        channel.send({
          ...event(18),
          type: "thread.message.created",
          payload: { messageId: "after-clear", role: "bot", blocks: [] },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(messages).toEqual(["before-clear"]);
        await vi.advanceTimersByTimeAsync(250);
        expect(messages).toEqual(["after-clear"]);
        expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual(
          clearSeq === 16 ? [18] : [17, 18],
        );
      } finally {
        abort.abort();
        channel.end();
        await running;
      }
    },
  );

  it("retains a same-thread snapshot already newer than the fallback head", async () => {
    vi.useFakeTimers();
    const newer = { ...head, cursor: 20 };
    const { abort, channel, state, callbacks } = setup(newer);
    callbacks.loadInitial.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    callbacks.loadHead.mockResolvedValue({ ...head, cursor: 15 });
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    expect(state.committed).toBe(newer);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    abort.abort();
    channel.end();
    await running;
  });

  it("falls back to head with backoff and buffers until a snapshot commits", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValueOnce(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 11 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledWith(10);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("reconnects from the highest event cursor and resets backoff after delivery", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.subscribe.mockRejectedValueOnce(new Error("offline"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 12]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenLastCalledWith(event(11), head);
    abort.abort();
    channel.end();
    await running;
  });

  it("cancels a reconnect delay without rejecting or starting another request", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps receipt handling before applying events and effects afterward", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const order: string[] = [];
    callbacks.applyEvent.mockImplementation(() => {
      order.push("apply");
    });
    callbacks.onEvent.mockImplementation(() => {
      order.push("effect");
    });
    const running = runThreadSubscription({
      ...callbacks,
      beforeEvent: () => {
        order.push("receipt");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["receipt", "apply", "effect"]);
    abort.abort();
    channel.end();
    await running;
  });

  it.each([null, head])(
    "does not replay after cancellation with a retained snapshot %j",
    async (snapshot) => {
      vi.useFakeTimers();
      const { abort, channel, callbacks } = setup(snapshot);
      callbacks.loadInitial.mockResolvedValue(null);
      callbacks.loadHead.mockResolvedValue({ ...head, cursor: 15 });
      const running = runThreadSubscription(callbacks);
      await vi.advanceTimersByTimeAsync(0);
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      channel.end();
      await running;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callbacks.refresh).not.toHaveBeenCalled();
      expect(callbacks.applyEvent).not.toHaveBeenCalled();
    },
  );

  it("ignores a late initial response after switching away", async () => {
    const { abort, callbacks } = setup();
    let resolve!: (value: typeof head) => void;
    callbacks.loadInitial.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const running = runThreadSubscription(callbacks);
    abort.abort();
    resolve(head);
    await running;
    expect(callbacks.subscribe).not.toHaveBeenCalled();
    expect(callbacks.loadHead).not.toHaveBeenCalled();
  });

  it("skips displaced-snapshot events while retaining effects and subsequent live updates", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    state.committed = { threadId: "replacement-thread", cursor: 0 };
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledWith(event(11), head);
    state.committed = head;
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.refresh).not.toHaveBeenCalled();
    abort.abort();
    channel.end();
    await running;
  });

  it("swallows heartbeats without applying them or advancing the cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    channel.end();
    await running;
  });

  it("abandons a silent stream and resubscribes from the same cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("keeps a heartbeat alive as liveness so the idle timer never fires", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
      channel.send(heartbeat());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    abort.abort();
    channel.end();
    await running;
  });

  it("reports ready only after a valid snapshot and an active stream frame", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus.mock.calls).toEqual([["loading"]]);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus.mock.calls).toEqual([["loading"], ["ready"]]);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledTimes(2);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("recovering");
    await vi.advanceTimersByTimeAsync(250);
    expect(onStatus).toHaveBeenLastCalledWith("recovering");
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("keeps a failed snapshot recovering despite healthy heartbeats", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    const failure = new Error("snapshot offline");
    callbacks.refresh.mockRejectedValueOnce(failure).mockImplementation(async () => {
      state.committed = head;
    });
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(250);
    expect(onStatus).toHaveBeenLastCalledWith("recovering", failure);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus.mock.calls.some(([status]) => status === "ready")).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("reports failed initial and head reads while preserving head recovery", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const initialFailure = new Error("initial offline");
    const headFailure = new Error("head offline");
    callbacks.loadInitial.mockRejectedValueOnce(initialFailure);
    callbacks.loadHead.mockRejectedValueOnce(headFailure);
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(250);
    expect(onStatus.mock.calls).toEqual([
      ["loading"],
      ["recovering", initialFailure],
      ["recovering", headFailure],
    ]);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(2);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("reports stream and reconnect snapshot failures without marking a heartbeat ready", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const streamFailure = new Error("stream offline");
    const snapshotFailure = new Error("refresh offline");
    let finishSnapshot!: () => void;
    callbacks.subscribe.mockRejectedValueOnce(streamFailure);
    callbacks.refresh.mockRejectedValueOnce(snapshotFailure).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = resolve;
        }),
    );
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(250);
    expect(onStatus.mock.calls).toEqual([
      ["loading"],
      ["recovering", streamFailure],
      ["recovering", snapshotFailure],
    ]);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus.mock.calls.some(([status]) => status === "ready")).toBe(false);
    finishSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("recovers a failed reconnect snapshot while the replacement stream keeps heartbeating", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const snapshotFailure = new Error("refresh offline");
    callbacks.refresh.mockRejectedValueOnce(snapshotFailure);
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("recovering", snapshotFailure);
    await vi.advanceTimersByTimeAsync(250);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(2);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("shares a pending snapshot recovery with another reconnect instead of starting parallel reads", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    let finishSnapshot!: () => void;
    callbacks.refresh.mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSnapshot = resolve;
        }),
    );
    const running = runThreadSubscription({ ...callbacks, onStatus: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    channel.end();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    finishSnapshot();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    abort.abort();
    channel.end();
    await running;
  });

  it("preserves snapshot request cadence for callers without a status observer", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.refresh.mockRejectedValueOnce(new Error("offline"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    abort.abort();
    channel.end();
    await running;
  });

  it("reports an idle stream as recovering and waits for a fresh frame", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(onStatus).toHaveBeenLastCalledWith("recovering");
    await vi.advanceTimersByTimeAsync(250);
    expect(onStatus).toHaveBeenLastCalledWith("recovering");
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith("ready");
    abort.abort();
    channel.end();
    await running;
  });

  it("isolates observer exceptions and suppresses late frames after abort", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const onStatus = vi.fn(() => {
      throw new Error("observer failed");
    });
    const running = runThreadSubscription({ ...callbacks, onStatus });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    expect(onStatus.mock.calls).toEqual([["loading"], ["ready"]]);
    abort.abort();
    channel.send(event(12));
    await running;
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(callbacks.applyEvent).toHaveBeenCalledTimes(1);
    expect(callbacks.onEvent).toHaveBeenCalledTimes(1);
  });

  it("lets a scoped observer stop recovery after a permanent read error", async () => {
    const { abort, callbacks } = setup();
    const forbidden = new Error("forbidden");
    callbacks.loadInitial.mockRejectedValueOnce(forbidden);
    const onStatus = vi.fn((_status: string, error?: unknown) => {
      if (error === forbidden) abort.abort();
    });
    await runThreadSubscription({ ...callbacks, onStatus });
    expect(onStatus.mock.calls).toEqual([["loading"], ["recovering", forbidden]]);
    expect(callbacks.loadHead).not.toHaveBeenCalled();
    expect(callbacks.subscribe).not.toHaveBeenCalled();
  });

  it("does not notify after an aborted initial read settles late", async () => {
    const { abort, callbacks } = setup();
    let reject!: (reason: unknown) => void;
    callbacks.loadInitial.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const onStatus = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onStatus });
    abort.abort();
    reject(new Error("late failure"));
    await running;
    expect(onStatus.mock.calls).toEqual([["loading"]]);
  });
});
