import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureApiRequestContext } from "./api";
import { querySpaceSearch } from "./search";
import { saveSessionToken } from "./session";

const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => disk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    disk.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    disk.delete(key);
  }),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(),
  stopLiveNotifications: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  disk.clear();
  await saveSessionToken("fake-query-token");
});
afterEach(() => vi.unstubAllGlobals());

it("sends the explicit verified query Space through the existing RPC transport", async () => {
  const captured = await captureApiRequestContext();
  const requestContext = {
    ...captured,
    headers: { ...captured.headers, "x-rakazo-space-id": "verified-query-space" },
  };
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ json: { hits: [] } }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);

  await expect(querySpaceSearch("  a note  ", { requestContext })).resolves.toEqual([]);

  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    `${captured.apiBase}/rpc/search/query`,
    expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer fake-query-token",
        "x-rakazo-space-id": "verified-query-space",
      }),
      body: JSON.stringify({ json: { q: "a note" } }),
    }),
  );
});

it("cancels the actual search fetch when the caller's scope is invalidated", async () => {
  const captured = await captureApiRequestContext();
  const requestContext = {
    ...captured,
    headers: { ...captured.headers, "x-rakazo-space-id": "verified-query-space" },
  };
  let requestSignal: AbortSignal | undefined;
  const fetch = vi.fn(
    (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = options.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const abort = new AbortController();
  const pending = querySpaceSearch("cancelled note", { requestContext, signal: abort.signal });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

  abort.abort(new Error("Synthetic scope invalidated"));

  await expect(pending).rejects.toThrow("Synthetic scope invalidated");
  expect(requestSignal?.aborted).toBe(true);
});
