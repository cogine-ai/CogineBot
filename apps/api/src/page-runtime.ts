import { createHash } from "node:crypto";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import { buildPageRuntime } from "@rakazo/page-kit/runtime-build";
import type { Hono } from "hono";
import { cachedScript, mountRevalidatedAsset } from "./revalidated-asset.js";

const loadPageRuntime = cachedScript(async () => {
  const body = new TextEncoder().encode(await buildPageRuntime());
  const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
  return { body, etag: `"page-runtime-${hash}"` };
});

/** The public runtime is identical for every viewer and revalidated on every use. */
export function mountPageRuntime(app: Hono) {
  mountRevalidatedAsset(app, PAGE_RUNTIME_PATH, loadPageRuntime, {
    cacheControl: "public, no-cache",
    unavailableMessage: "Page renderer unavailable",
  });
}
