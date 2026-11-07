import type { Hono } from "hono";

type Script = { body: Uint8Array<ArrayBuffer>; etag: string };

export function cachedScript(load: () => Promise<Script>): () => Promise<Script> {
  let script: Promise<Script> | undefined;
  return () => {
    script ??= load().catch((error: unknown) => {
      script = undefined;
      throw error;
    });
    return script;
  };
}

/** Public JavaScript bytes shared by every caller, including anonymous opaque viewers. */
export function mountRevalidatedAsset(
  app: Hono,
  path: string,
  load: () => Promise<Script>,
  options: { cacheControl: string; unavailableMessage: string },
) {
  app.get(path, async (c) => {
    let asset: Script;
    try {
      asset = await load();
    } catch {
      return c.text(options.unavailableMessage, 503, { "cache-control": "no-store" });
    }
    const { body, etag } = asset;
    const headers = {
      "cache-control": options.cacheControl,
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
