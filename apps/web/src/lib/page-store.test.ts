// @vitest-environment jsdom
import type { PageDetail } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createPageStore, loadPageRuntime } from "./pages";
import type { RpcClient } from "./rpc";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));

const page = {
  id: "p1",
  title: "Plan",
  currentVersion: 2,
  version: 2,
  code: "private",
} as PageDetail;

describe("private page read ownership", () => {
  it("shares same-version reads but separates current and immutable historical versions", async () => {
    const get = vi.fn(
      async (_input: { pageId: string; version?: number }, _options?: { signal?: AbortSignal }) =>
        page,
    );
    const store = createPageStore({ pages: { get } } as unknown as RpcClient, () => true);
    expect(store.get("p1")).toBe(store.get("p1"));
    await store.get("p1");
    await store.get("p1", 1);
    expect(get.mock.calls).toHaveLength(2);
    expect(get.mock.calls[1]?.[0]).toEqual({ pageId: "p1", version: 1 });
    store.invalidate("p1");
    await store.get("p1");
    expect(get.mock.calls).toHaveLength(3);
  });

  it("rejects an old owner's successful late response and makes no request after scope revocation", async () => {
    let settle!: (value: PageDetail) => void;
    let current = true;
    const get = vi.fn(
      (_input: { pageId: string }, _options?: { signal?: AbortSignal }) =>
        new Promise<PageDetail>((resolve) => {
          settle = resolve;
        }),
    );
    const store = createPageStore({ pages: { get } } as unknown as RpcClient, () => current);
    const read = store.get("p1");
    current = false;
    store.dispose();
    settle(page);
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    await expect(store.get("p1")).rejects.toMatchObject({ name: "AbortError" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("evicts a failed read so the next opening can recover", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page);
    const store = createPageStore({ pages: { get } } as unknown as RpcClient, () => true);
    await expect(store.get("p1")).rejects.toThrow("offline");
    await expect(store.get("p1")).resolves.toBe(page);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("server runtime revalidation", () => {
  it("coalesces in-flight uses, revalidates ETags, and separates servers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("kit-a", { headers: { etag: '"a"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response("kit-b"));
    const url = "https://page-store-test-a.example/runtime";
    expect(loadPageRuntime(url, fetcher)).toBe(loadPageRuntime(url, fetcher));
    await expect(loadPageRuntime(url, fetcher)).resolves.toBe("kit-a");
    await expect(loadPageRuntime(url, fetcher)).resolves.toBe("kit-a");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { "if-none-match": '"a"' },
      credentials: "omit",
    });
    await expect(
      loadPageRuntime("https://page-store-test-b.example/runtime", fetcher),
    ).resolves.toBe("kit-b");
  });

  it("retries a failed load instead of retaining a rejected promise", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("kit"));
    const url = "https://page-store-retry.example/runtime";
    await expect(loadPageRuntime(url, fetcher)).rejects.toThrow("503");
    await expect(loadPageRuntime(url, fetcher)).resolves.toBe("kit");
  });
});
