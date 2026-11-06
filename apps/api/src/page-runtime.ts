import { createHash } from "node:crypto";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import { buildPageRuntime } from "@rakazo/page-kit/runtime-build";
import type { Hono } from "hono";

type Script = { body: Uint8Array<ArrayBuffer>; etag: string };
let script: Promise<Script> | undefined;

function loadPageRuntime(): Promise<Script> {
  script ??= buildPageRuntime()
    .then((text) => {
      const body = new TextEncoder().encode(text);
      const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
      return { body, etag: `"page-runtime-${hash}"` };
    })
    .catch((error: unknown) => {
      script = undefined;
      throw error;
    });
  return script;
}

/** The public runtime is identical for every viewer and revalidated on every use. */
export function mountPageRuntime(app: Hono) {
  app.get(PAGE_RUNTIME_PATH, async (c) => {
    let asset: Script;
    try {
      asset = await loadPageRuntime();
    } catch {
      return c.text("Page renderer unavailable", 503, { "cache-control": "no-store" });
    }
    const { body, etag } = asset;
    const headers = {
      "cache-control": "public, no-cache",
      etag,
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    };
    const validator = c.req.header("if-none-match") ?? "";
    const tags = [...validator.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g)];
    if (validator.trim() === "*" || tags.some(([, tag]) => tag === etag)) {
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
  });
}
