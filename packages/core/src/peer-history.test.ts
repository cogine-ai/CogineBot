import { afterEach, expect, it, vi } from "vitest";
import { loadPeerHistory } from "./peer-history.js";

afterEach(() => vi.unstubAllGlobals());

it("loads history with the limited AbortSignal API available in React Native", async () => {
  const abort = new AbortController();
  Object.defineProperty(abort.signal, "throwIfAborted", { value: undefined });
  vi.stubGlobal("AbortSignal", {});
  const loadPage = vi.fn(async (before?: number) => ({
    messages: [{ id: before === undefined ? "new" : "old", seq: before === undefined ? 2 : 1 }],
    olderCursor: before === undefined ? 2 : null,
  }));
  await expect(loadPeerHistory({ signal: abort.signal, loadPage })).resolves.toEqual([
    { id: "old", seq: 1 },
    { id: "new", seq: 2 },
  ]);
});

it("cancels native transports without relying on AbortSignal.reason", async () => {
  const abort = new AbortController();
  Object.defineProperty(abort.signal, "reason", { value: undefined });
  Object.defineProperty(abort.signal, "throwIfAborted", { value: undefined });
  vi.stubGlobal("AbortSignal", {});
  const loading = loadPeerHistory({
    signal: abort.signal,
    loadPage: () => new Promise<never>(() => {}),
  });
  abort.abort();
  await expect(loading).rejects.toThrow("Request canceled");
});
