import type { ThreadMessage } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPeerHistory, mergePeerHistory } from "./peer-history";

function message(id: string, seq: number): ThreadMessage {
  return { id, seq } as ThreadMessage;
}

afterEach(() => vi.useRealTimers());

describe("peer history loading", () => {
  it("collects paginated messages in chronological page order", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message("new", 2)], olderCursor: 2 })
      .mockResolvedValueOnce({ messages: [message("old", 1)], olderCursor: null });

    const messages = await loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
    });

    expect(messages.map(({ id }) => id)).toEqual(["old", "new"]);
    expect(loadPage.mock.calls.map(([before]) => before)).toEqual([undefined, 2]);
  });

  it("aborts a page that never settles before the full-history deadline", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("bounds the full-history scan independently of the per-page timeout", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 1_000,
      totalTimeoutMs: 100,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("aborts an in-flight page when the viewer closes", async () => {
    const lifecycle = new AbortController();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({ signal: lifecycle.signal, loadPage });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    lifecycle.abort();

    await rejected;
  });

  it("does not request a second page after cancellation even when a transport ignores abort", async () => {
    const lifecycle = new AbortController();
    let resolvePage!: (page: { messages: ThreadMessage[]; olderCursor: number | null }) => void;
    const loadPage = vi.fn(
      () =>
        new Promise<{ messages: ThreadMessage[]; olderCursor: number | null }>((resolve) => {
          resolvePage = resolve;
        }),
    );
    const loading = loadPeerHistory({ signal: lifecycle.signal, loadPage });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    lifecycle.abort();
    await rejected;
    resolvePage({ messages: [message("late", 20)], olderCursor: 20 });
    await Promise.resolve();
    expect(loadPage).toHaveBeenCalledOnce();
  });

  it("rejects an already cancelled request before calling the transport", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const loadPage = vi.fn();
    await expect(loadPeerHistory({ signal: lifecycle.signal, loadPage })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("keeps the viewer bounded when a page repeats its cursor", async () => {
    const loadPage = vi.fn().mockResolvedValue({ messages: [message("row", 10)], olderCursor: 10 });
    await expect(
      loadPeerHistory({ signal: new AbortController().signal, loadPage }),
    ).rejects.toThrow("cursor did not advance");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("does not turn a failed page into an empty successful history", async () => {
    const loadPage = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      loadPeerHistory({ signal: new AbortController().signal, loadPage }),
    ).rejects.toThrow("offline");
  });
});

describe("peer history and live overlap", () => {
  it("deduplicates replayed IDs without replacing a newer live update with slow history", () => {
    const old = {
      ...message("reply", 4),
      threadId: "direct",
      createdAt: "2026-10-11T09:00:00Z",
      blocks: [{ kind: "text" as const, text: "old" }],
    };
    const live = { ...old, seq: 8, blocks: [{ kind: "text" as const, text: "updated" }] };
    const newer = { ...message("next", 9), threadId: "direct", createdAt: "2026-10-11T09:01:00Z" };
    expect(mergePeerHistory([live, newer], [old, live])).toEqual([live, newer]);
  });

  it("merges group sends and direct replies chronologically without colliding on thread IDs", () => {
    const direct = {
      ...message("same-id", 1),
      threadId: "direct",
      createdAt: "2026-10-11T09:01:00Z",
    };
    const group = {
      ...message("same-id", 30),
      threadId: "group",
      createdAt: "2026-10-11T09:00:00Z",
    };
    expect(mergePeerHistory([direct], [group])).toEqual([group, direct]);
  });
});
