import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Hono } from "hono";
import { cachedScript, mountRevalidatedAsset } from "./revalidated-asset.js";

export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";

const require = createRequire(import.meta.url);
const loadDiagramScript = cachedScript(async () => {
  const [bundle, license] = await Promise.all([
    readFile(require.resolve("mermaid/dist/mermaid.min.js")),
    readFile(require.resolve("mermaid/LICENSE"), "utf8"),
  ]);
  const body = Buffer.concat([Buffer.from(`/*! Mermaid\n${license}\n*/\n`), bundle]);
  return {
    body: new Uint8Array(body),
    etag: `"mermaid-${createHash("sha256").update(body).digest("hex")}"`,
  };
});

/** A fixed public asset shared by anonymous native diagram documents. */
export function mountDiagramScript(app: Hono) {
  mountRevalidatedAsset(app, DIAGRAM_SCRIPT_PATH, loadDiagramScript, {
    cacheControl: "public, max-age=86400",
    unavailableMessage: "Diagram renderer unavailable",
  });
}
