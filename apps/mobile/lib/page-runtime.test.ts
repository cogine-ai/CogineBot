import { expect, it, vi } from "vitest";
import { loadPageRuntime } from "./page-runtime";

function script(body: string, etag?: string) {
  return new Response(body, {
    headers: { "content-type": "text/javascript; charset=utf-8", ...(etag ? { etag } : {}) },
  });
}

it("coalesces and anonymously revalidates only the configured server's fixed asset", async () => {
  const api = "https://page-cache.example.test/nested?ignored=yes";
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(script("first()", '"first"'))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(script("next()", '"next"'));
  const first = loadPageRuntime(api, fetcher);
  expect(loadPageRuntime(api, fetcher)).toBe(first);
  await expect(first).resolves.toBe("first()");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://page-cache.example.test/api/v1/assets/page-runtime.js",
    { credentials: "omit", redirect: "error", signal: expect.any(AbortSignal) },
  );
  await expect(loadPageRuntime(api, fetcher)).resolves.toBe("first()");
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://page-cache.example.test/api/v1/assets/page-runtime.js",
    expect.objectContaining({ headers: { "if-none-match": '"first"' } }),
  );
  await expect(loadPageRuntime("https://another-page.example.test", fetcher)).resolves.toBe(
    "next()",
  );
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://another-page.example.test/api/v1/assets/page-runtime.js",
    { credentials: "omit", redirect: "error", signal: expect.any(AbortSignal) },
  );
});

it.each(["file:///private/app", "javascript:alert(1)", "https://user:password@page.example.test"])(
  "rejects a non-HTTP or credentialed server before a request",
  (url) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => loadPageRuntime(url, fetcher)).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("never caches an invalid response and retries after rejection", async () => {
  const api = "https://page-retry.example.test";
  const crossOrigin = script("wrongOrigin()", '"wrong"');
  Object.defineProperty(crossOrigin, "url", { value: "https://other.example.test/runtime.js" });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(crossOrigin)
    .mockResolvedValueOnce(new Response("<html>old server</html>", { headers: { etag: '"html"' } }))
    .mockResolvedValueOnce(script("x </script><script>rogue()", '"unsafe"'))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(script("valid()", '"valid"'));
  await expect(loadPageRuntime(api, fetcher)).rejects.toThrow("redirected");
  await expect(loadPageRuntime(api, fetcher)).rejects.toThrow("JavaScript");
  await expect(loadPageRuntime(api, fetcher)).rejects.toThrow("safe to inline");
  await expect(loadPageRuntime(api, fetcher)).rejects.toThrow("304");
  await expect(loadPageRuntime(api, fetcher)).resolves.toBe("valid()");
  for (const [, request] of fetcher.mock.calls) expect(request?.headers).toBeUndefined();
});

it("aborts a stalled fetch so another attempt can recover", async () => {
  vi.useFakeTimers();
  try {
    const api = "https://page-timeout.example.test";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_url, request) =>
          new Promise((_resolve, reject) =>
            request?.signal?.addEventListener("abort", () => reject(new Error("Timed out"))),
          ),
      )
      .mockResolvedValueOnce(script("recovered()"));
    const rejected = expect(loadPageRuntime(api, fetcher)).rejects.toThrow("Timed out");
    await vi.runAllTimersAsync();
    await rejected;
    await expect(loadPageRuntime(api, fetcher)).resolves.toBe("recovered()");
  } finally {
    vi.useRealTimers();
  }
});

it("bounds bytes even when a large runtime omits its content length", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(body, { headers: { "content-type": "application/javascript" } }),
    );
  await expect(loadPageRuntime("https://page-oversized.example.test", fetcher)).rejects.toThrow(
    "too large",
  );
});
