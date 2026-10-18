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

describe("explicit thread resume checkpoints", () => {
  it("uses the consumed event cursor despite a newer head and snapshot, without duplicate effects", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup({ ...head, cursor: 30 });
    const initial = { ...head, cursor: 20 };
    callbacks.loadInitial.mockResolvedValue(initial);
    const order: string[] = [];
    callbacks.applyEvent.mockImplementation(() => order.push("apply"));
    callbacks.onEvent.mockImplementation(() => order.push("effect"));
    const onCursor = vi.fn((checkpoint: typeof head) => order.push(`cursor:${checkpoint.cursor}`));
    const running = runThreadSubscription({
      ...callbacks,
      resume: head,
      beforeEvent: () => order.push("receipt"),
      onCursor,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(callbacks.subscribe).toHaveBeenCalledWith(10);
    expect.soft(onCursor).not.toHaveBeenCalled();
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(onCursor).not.toHaveBeenCalled();
    const replay = {
      ...event(11),
      type: "thread.message.created" as const,
      payload: { seq: 900, messageId: "missed-message" },
    };
    channel.send(replay);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(replay);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    channel.end();
    await running;
    expect(order).toEqual(["receipt", "apply", "effect", "cursor:11"]);
    expect(onCursor).toHaveBeenCalledExactlyOnceWith({ ...head, cursor: 11 });
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(replay, initial);
  });

  it("ignores a different thread's resume and seeds a trusted initial snapshot without an event", async () => {
    vi.useFakeTimers();
    const snapshot = { ...head, cursor: 20 };
    const { abort, channel, callbacks } = setup(snapshot);
    const onCursor = vi.fn();
    const running = runThreadSubscription({
      ...callbacks,
      resume: { threadId: "other-thread", cursor: 3 },
      onCursor,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(callbacks.subscribe).toHaveBeenCalledWith(20);
    abort.abort();
    channel.end();
    await running;
    expect(onCursor).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it.each([false, true])(
    "only seeds a first hydrated snapshot when there is no existing resume (%s)",
    async (resuming) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup(null);
      callbacks.loadInitial.mockResolvedValue(null);
      callbacks.refresh.mockImplementation(async () => {
        state.committed = { ...head, cursor: 15 };
      });
      const onCursor = vi.fn();
      const running = runThreadSubscription({
        ...callbacks,
        ...(resuming ? { resume: head } : {}),
        onCursor,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(onCursor).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      abort.abort();
      channel.end();
      await running;
      expect(onCursor.mock.calls).toEqual(resuming ? [] : [[{ ...head, cursor: 15 }]]);
    },
  );

  it("does not checkpoint buffered events before they are applied or covered by hydration", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 11 };
    });
    callbacks.applyEvent.mockImplementation((item) => {
      state.committed = { ...head, cursor: item.seq };
    });
    const onCursor = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onCursor });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(onCursor).not.toHaveBeenCalled();
    expect.soft(callbacks.applyEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    abort.abort();
    channel.end();
    await running;
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12]);
    expect(onCursor.mock.calls.map(([checkpoint]) => checkpoint.cursor)).toEqual([11, 12]);
  });

  it("applies buffered resume events below a newer hydrated snapshot without repeating effects", async () => {
    vi.useFakeTimers();
    const retained = { ...head, cursor: 149 };
    const latest = { ...head, cursor: 270 };
    const { abort, channel, state, callbacks } = setup(retained);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValue(latest);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = latest;
    });
    const onCursor = vi.fn();
    const running = runThreadSubscription({ ...callbacks, resume: retained, onCursor });
    await vi.advanceTimersByTimeAsync(0);
    channel.send({ ...event(150), type: "thread.cleared" });
    await vi.advanceTimersByTimeAsync(0);
    channel.send({ ...event(151), type: "thread.message.created", payload: { seq: 21 } });
    await vi.advanceTimersByTimeAsync(0);
    channel.send({ ...event(151), type: "thread.message.created", payload: { seq: 21 } });
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(onCursor).not.toHaveBeenCalled();
    expect.soft(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([150, 151]);
    await vi.advanceTimersByTimeAsync(250);
    abort.abort();
    channel.end();
    await running;
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([150, 151]);
    expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([150, 151]);
    expect(callbacks.onEvent.mock.calls.every(([, initial]) => initial === latest)).toBe(true);
    expect(onCursor.mock.calls.map(([checkpoint]) => checkpoint.cursor)).toEqual([150, 151]);
  });

  it.each(["failure", "abort"])("does not acknowledge a resumed hydration %s", async (kind) => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 30 };
    });
    callbacks.applyEvent.mockImplementationOnce(() => {
      if (kind === "abort") abort.abort();
      else throw new Error("projection unavailable");
    });
    const onCursor = vi.fn();
    const running = runThreadSubscription({ ...callbacks, resume: head, onCursor });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(250);
    expect.soft(callbacks.applyEvent).toHaveBeenCalledOnce();
    expect.soft(onCursor).not.toHaveBeenCalled();
    if (kind === "failure") {
      await vi.advanceTimersByTimeAsync(500);
      expect.soft(callbacks.applyEvent).toHaveBeenCalledTimes(2);
      expect.soft(onCursor).toHaveBeenCalledExactlyOnceWith({ ...head, cursor: 11 });
    }
    abort.abort();
    channel.end();
    await running;
    expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(11), head);
  });

  it.each(["apply", "effect"])(
    "does not consume a failed %s callback before retrying",
    async (phase) => {
      vi.useFakeTimers();
      const { abort, channel, callbacks } = setup();
      const callback = phase === "apply" ? callbacks.applyEvent : callbacks.onEvent;
      callback.mockImplementationOnce(() => {
        throw new Error("temporary read projection failure");
      });
      const onCursor = vi.fn();
      const running = runThreadSubscription({ ...callbacks, resume: head, onCursor });
      await vi.advanceTimersByTimeAsync(0);
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(onCursor).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect.soft(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      channel.end();
      await running;
      expect(onCursor).toHaveBeenCalledExactlyOnceWith({ ...head, cursor: 11 });
    },
  );

  it("does not seed over a failed first event while its initial snapshot is still missing", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 30 };
    });
    callbacks.onEvent.mockImplementationOnce(() => {
      throw new Error("effect unavailable");
    });
    const onCursor = vi.fn();
    const running = runThreadSubscription({ ...callbacks, onCursor });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(250);
    expect.soft(onCursor).not.toHaveBeenCalled();
    expect.soft(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10]);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    channel.end();
    await running;
    expect(onCursor).toHaveBeenCalledExactlyOnceWith({ ...head, cursor: 11 });
  });

  it.each(["receipt", "apply", "effect"])(
    "does not checkpoint or continue callbacks after abort in %s",
    async (phase) => {
      vi.useFakeTimers();
      const { abort, channel, callbacks } = setup();
      const beforeEvent = vi.fn(() => {
        if (phase === "receipt") abort.abort();
      });
      callbacks.applyEvent.mockImplementation(() => {
        if (phase === "apply") abort.abort();
      });
      callbacks.onEvent.mockImplementation(() => {
        if (phase === "effect") abort.abort();
      });
      const onCursor = vi.fn();
      const running = runThreadSubscription({ ...callbacks, resume: head, beforeEvent, onCursor });
      await vi.advanceTimersByTimeAsync(0);
      channel.send(event(11));
      await vi.advanceTimersByTimeAsync(0);
      channel.end();
      await running;
      expect(onCursor).not.toHaveBeenCalled();
      expect(callbacks.applyEvent).toHaveBeenCalledTimes(phase === "receipt" ? 0 : 1);
      expect(callbacks.onEvent).toHaveBeenCalledTimes(phase === "effect" ? 1 : 0);
    },
  );
});

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

  it.each([false, true])(
    "does not replay committed messages or effects from a newer retained snapshot with observer %s",
    async (observed) => {
      vi.useFakeTimers();
      const newer = { ...head, cursor: 20 };
      const fallback = { ...head, cursor: 15 };
      const { abort, channel, state, callbacks } = setup(newer);
      let messages = ["already-rendered"];
      const backlog: ProductEvent[] = [
        { ...event(16), type: "thread.cleared" },
        {
          ...event(17),
          type: "thread.message.created",
          payload: { messageId: "old-already-rendered", role: "bot", blocks: [] },
        },
        { ...event(19), type: "thread.call.ended", payload: { farewell: "Old farewell" } },
        {
          ...event(21),
          type: "thread.message.created",
          payload: { messageId: "new-after-retained-snapshot", role: "bot", blocks: [] },
        },
      ];
      callbacks.loadInitial.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      callbacks.loadHead.mockResolvedValue(fallback);
      // Match the server's seq > cursor replay contract, including clear/call effects.
      callbacks.subscribe.mockImplementation(async (cursor) =>
        (async function* () {
          for (const item of backlog) if (item.seq > cursor) yield item;
          yield* channel.events;
        })(),
      );
      callbacks.applyEvent.mockImplementation((item) => {
        if (item.type === "thread.cleared") messages = [];
        if (item.type === "thread.message.created") messages.push(String(item.payload.messageId));
        state.committed = { ...head, cursor: item.seq };
      });
      const beforeEvent = vi.fn();
      const onStatus = vi.fn();
      const running = runThreadSubscription({
        ...callbacks,
        beforeEvent,
        ...(observed ? { onStatus } : {}),
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect.soft(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([21]);
        expect(messages).toEqual(["already-rendered", "new-after-retained-snapshot"]);
        expect(callbacks.subscribe).toHaveBeenCalledWith(20);
        expect(state.committed).toEqual({ ...head, cursor: 21 });
        expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([21]);
        expect(beforeEvent.mock.calls.map(([item]) => item.seq)).toEqual([21]);
        expect(callbacks.onEvent.mock.calls.map(([item]) => item.seq)).toEqual([21]);
        expect(callbacks.onEvent).toHaveBeenLastCalledWith(backlog[3], fallback);
        if (observed) expect(onStatus).toHaveBeenLastCalledWith("ready");
        expect(callbacks.refresh).not.toHaveBeenCalled();
        channel.end();
        await vi.advanceTimersByTimeAsync(250);
        expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([20, 21]);
        channel.send(heartbeat());
        await vi.advanceTimersByTimeAsync(0);
        expect(messages).toEqual(["already-rendered", "new-after-retained-snapshot"]);
        expect(callbacks.onEvent).toHaveBeenCalledOnce();
      } finally {
        abort.abort();
        channel.end();
        await running;
      }
    },
  );

  it.each([false, true])(
    "ignores another thread's retained cursor when starting head recovery with observer %s",
    async (observed) => {
      vi.useFakeTimers();
      const { abort, channel, state, callbacks } = setup({ threadId: "other-thread", cursor: 50 });
      const fallback = { ...head, cursor: 15 };
      callbacks.loadInitial.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      callbacks.loadHead.mockResolvedValue(fallback);
      callbacks.refresh.mockImplementation(async () => {
        state.committed = fallback;
      });
      const running = runThreadSubscription({
        ...callbacks,
        ...(observed ? { onStatus: vi.fn() } : {}),
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.subscribe).toHaveBeenCalledWith(15);
        channel.send(event(16));
        await vi.advanceTimersByTimeAsync(0);
        expect(callbacks.applyEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(16));
        expect(callbacks.onEvent).toHaveBeenCalledExactlyOnceWith(event(16), fallback);
      } finally {
        abort.abort();
        channel.end();
        await running;
      }
    },
  );

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
