import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import type { Hono } from "hono";

export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";

const require = createRequire(import.meta.url);
type DiagramScript = { body: Uint8Array<ArrayBuffer>; etag: string };
let script: Promise<DiagramScript> | undefined;
let chartScript: Promise<DiagramScript> | undefined;
export const CHART_SCRIPT_PATH = "/api/v1/assets/chart.js";

function loadChartScript(): Promise<DiagramScript> {
  chartScript ??= build({
    entryPoints: [require.resolve("@rakazo/core/plot/browser")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RakazoChart",
    platform: "browser",
    target: ["es2020", "safari15"],
    minify: true,
    legalComments: "eof",
    logLevel: "silent",
  })
    .then((result) => {
      const body = result.outputFiles[0]?.contents;
      if (!body) throw new Error("Chart renderer unavailable");
      return {
        body: new Uint8Array(body),
        etag: `"chart-${createHash("sha256").update(body).digest("hex")}"`,
      };
    })
    .catch((error: unknown) => {
      chartScript = undefined;
      throw error;
    });
  return chartScript;
}

function loadDiagramScript(): Promise<DiagramScript> {
  script ??= Promise.all([
    readFile(require.resolve("mermaid/dist/mermaid.min.js")),
    readFile(require.resolve("mermaid/LICENSE"), "utf8"),
  ])
    .then(([bundle, license]) => {
      const body = Buffer.concat([Buffer.from(`/*! Mermaid\n${license}\n*/\n`), bundle]);
      return {
        body: new Uint8Array(body),
        etag: `"mermaid-${createHash("sha256").update(body).digest("hex")}"`,
      };
    })
    .catch((error: unknown) => {
      script = undefined;
      throw error;
    });
  return script;
}

/** A fixed public asset shared by anonymous native diagram documents. */
export function mountDiagramScript(app: Hono) {
  mountScript(app, DIAGRAM_SCRIPT_PATH, loadDiagramScript);
  mountScript(app, CHART_SCRIPT_PATH, loadChartScript);
}

function mountScript(app: Hono, path: string, load: () => Promise<DiagramScript>) {
  app.get(path, async (c) => {
    let asset: DiagramScript;
    try {
      asset = await load();
    } catch {
      return c.text("Diagram renderer unavailable", 503, { "cache-control": "no-store" });
    }
    const { body, etag } = asset;
    const headers = {
      "cache-control": "public, max-age=86400",
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
