import { PAGE_RUNTIME_PATH, pageViewerDocument, readBoundedResponseBytes } from "@rakazo/core";

type Runtime = { text: string; etag: string | null };

const RUNTIME_TIMEOUT_MS = 15_000;
const MAX_RUNTIME_BYTES = 2 * 1024 * 1024;
const runtimes = new Map<string, Runtime>();
const pending = new Map<string, Promise<string>>();

async function readRuntime(url: string, fetcher: typeof fetch, cached?: Runtime): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      ...(cached?.etag ? { headers: { "if-none-match": cached.etag } } : {}),
    });
    if (response.redirected || (response.url && response.url !== url))
      throw new Error("Page runtime redirected");
    if (response.status === 304 && cached?.etag) return cached.text;
    if (!response.ok) throw new Error(`Page runtime returned ${response.status}`);
    if (
      !/^(?:text|application)\/javascript(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new Error("Page runtime did not return JavaScript");
    if (Number(response.headers.get("content-length")) > MAX_RUNTIME_BYTES)
      throw new Error("Page runtime is too large");
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: MAX_RUNTIME_BYTES,
      tooLargeMessage: "Page runtime is too large",
      read: (read) => read(),
    });
    const text = new TextDecoder().decode(bytes);
    // The public script is inlined as HTML. A broken asset must not escape its script element.
    if (!text.trim() || /<\/script(?=[\t\n\f\r />])/i.test(text))
      throw new Error("Page runtime is not safe to inline");
    runtimes.set(url, { text, etag: response.headers.get("etag") });
    return text;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Revalidate the configured server's public kit; concurrent viewers share a single request. */
export function loadPageRuntime(apiBase: string, fetcher: typeof fetch = fetch): Promise<string> {
  const endpoint = new URL(PAGE_RUNTIME_PATH, apiBase);
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error("Invalid page runtime server");
  const url = endpoint.href;
  let runtime = pending.get(url);
  if (!runtime) {
    runtime = readRuntime(url, fetcher, runtimes.get(url)).finally(() => pending.delete(url));
    pending.set(url, runtime);
  }
  return runtime;
}

/** The authorized caller supplies the server captured for the current Page read. */
export async function pageDocument(
  apiBase: string,
  code: string,
  theme: "light" | "dark",
  errorTitle: string,
  options: { reply?: boolean; lang?: string } = {},
): Promise<string> {
  return pageViewerDocument({
    runtime: await loadPageRuntime(apiBase),
    code,
    theme,
    errorTitle,
    touch: true,
    ...options,
  });
}
