import type { ResolvedAppearance } from "@rakazo/ui-tokens";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url";
import mermaidLicenseUrl from "mermaid/LICENSE?url";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CHAT_DIAGRAM_MAX_TEXT_SIZE, chatMermaidConfig, mermaidSvgImage } from "./mermaid";

export const MERMAID_RENDER_TIMEOUT_MS = 15_000;
const MAX_RENDERED = 64;
const rendered = new Map<string, string | null>();
type ScriptLoad = { result: Promise<string>; controller: AbortController };
let scriptLoad: ScriptLoad | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

// These fixed build assets are fetched only for a diagram, never executed in the parent page.
function loadScript(): ScriptLoad {
  if (!scriptLoad) {
    const controller = new AbortController();
    const result = Promise.all(
      [mermaidScriptUrl, mermaidLicenseUrl].map(async (url) => {
        const response = await fetch(url, {
          credentials: "omit",
          cache: "no-cache",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Diagram asset unavailable");
        return response.text();
      }),
    )
      .then(([script, license]) => `/*! Mermaid\n${license}\n*/\n${script}`)
      .catch((error: unknown) => {
        discardScript(load);
        throw error;
      });
    const load = { result, controller };
    scriptLoad = load;
  }
  return scriptLoad;
}

function discardScript(load: ScriptLoad) {
  if (scriptLoad === load) scriptLoad = undefined;
  load.controller.abort();
}

// Source and configuration arrive as structured data after this trusted boot script has loaded.
const BOOT = `(() => {
  const send = (message) => parent.postMessage(message, "*");
  if (!globalThis.mermaid) { send({ type: "failed" }); return; }
  let started = false;
  addEventListener("message", async (event) => {
    const data = event.data;
    if (started || event.source !== parent || !data || data.type !== "draw" ||
        typeof data.id !== "string" || typeof data.source !== "string" ||
        !data.config || typeof data.config !== "object") return;
    started = true;
    const reply = (type, svg) => send(svg === undefined ? { type, id: data.id } : { type, id: data.id, svg });
    try {
      mermaid.initialize(data.config);
      if (!(await mermaid.parse(data.source, { suppressErrors: true }))) {
        reply("invalid"); return;
      }
      const result = await mermaid.render("diagram", data.source);
      reply("drawn", result.svg);
    } catch { reply("invalid"); }
  });
  send({ type: "ready" });
})();
`;

function renderKey(source: string, appearance: ResolvedAppearance) {
  return `${appearance}\n${source}`;
}

function remember(key: string, svg: string | null) {
  rendered.delete(key);
  rendered.set(key, svg);
  if (rendered.size > MAX_RENDERED) {
    const oldest = rendered.keys().next().value;
    if (oldest !== undefined) rendered.delete(oldest);
  }
}

function nonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type DrawResult = { svg: string | null; cache: boolean };

function draw(
  source: string,
  appearance: ResolvedAppearance,
  signal?: AbortSignal,
): Promise<DrawResult> {
  return new Promise((resolve) => {
    let frame: HTMLIFrameElement | undefined;
    let done = false;
    let started = false;
    const id = `diagram-${++renderCount}`;
    const load = loadScript();
    const finish = (svg: string | null, cache = false) => {
      if (done) return;
      done = true;
      if (!frame) discardScript(load);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      window.removeEventListener("message", receive);
      frame?.remove();
      resolve({ svg, cache });
    };
    const abort = () => finish(null);
    const receive = (event: MessageEvent<unknown>) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const data = message as Record<string, unknown>;
      const keys = Object.keys(data).sort().join(",");
      if (data.type === "ready" && keys === "type" && !started) {
        started = true;
        frame.contentWindow?.postMessage(
          {
            type: "draw",
            id,
            source,
            config: chatMermaidConfig(tokensForAppearance(appearance), appearance),
          },
          "*",
        );
      } else if (data.type === "failed" && keys === "type") {
        discardScript(load);
        finish(null);
      } else if (started && data.id === id) {
        if (data.type === "invalid" && keys === "id,type") finish(null, true);
        if (data.type === "drawn" && keys === "id,svg,type" && typeof data.svg === "string") {
          finish(mermaidSvgImage(data.svg) ? data.svg : null, true);
        }
      }
    };
    const timer = setTimeout(() => {
      // A new task gets a new realm, including a fresh library execution queue.
      finish(null);
    }, MERMAID_RENDER_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    window.addEventListener("message", receive);
    if (signal?.aborted) {
      finish(null);
      return;
    }
    load.result.then(
      (script) => {
        if (done) return;
        try {
          const token = nonce();
          const trustedScript = `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`;
          frame = document.createElement("iframe");
          frame.style.cssText =
            "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none";
          frame.tabIndex = -1;
          frame.setAttribute("sandbox", "allow-scripts");
          frame.setAttribute("aria-hidden", "true");
          frame.referrerPolicy = "no-referrer";
          frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"></head><body><script nonce="${token}" src="${trustedScript}"></script><script nonce="${token}">${BOOT}</script></body></html>`;
          document.body.appendChild(frame);
        } catch {
          finish(null);
        }
      },
      () => finish(null),
    );
  });
}

/** The SVG, or null when drawing is unavailable. Aborted work never changes the cache. */
export function renderMermaidSvg(
  source: string,
  appearance: ResolvedAppearance,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted || source.length > CHAT_DIAGRAM_MAX_TEXT_SIZE) return Promise.resolve(null);
  const key = renderKey(source, appearance);
  const known = rendered.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const run = renderQueue.then(async () => {
    if (signal?.aborted) return null;
    const cached = rendered.get(key);
    if (cached !== undefined) return cached;
    const result = await draw(source, appearance, signal);
    if (result.cache && !signal?.aborted) remember(key, result.svg);
    return result.svg;
  });
  renderQueue = run.catch(() => undefined);
  return run;
}

function readAppearance(): ResolvedAppearance {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribeAppearance(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Undefined while drawing; null preserves the caller's readable source fallback. */
export function useMermaidSvg(source: string): string | null | undefined {
  const appearance = useSyncExternalStore<ResolvedAppearance>(
    subscribeAppearance,
    readAppearance,
    () => "dark",
  );
  const key = renderKey(source, appearance);
  const [result, setResult] = useState<{ key: string; svg: string | null }>();
  useEffect(() => {
    const controller = new AbortController();
    renderMermaidSvg(source, appearance, controller.signal).then(
      (svg) => {
        if (!controller.signal.aborted) setResult({ key, svg });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key, svg: null });
      },
    );
    return () => controller.abort();
  }, [source, appearance, key]);
  return result?.key === key ? result.svg : rendered.get(key);
}
