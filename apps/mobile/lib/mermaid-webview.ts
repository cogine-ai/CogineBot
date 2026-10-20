import type { ChatMermaidConfig } from "@rakazo/chat-ui/mermaid";

export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";
export const DIAGRAM_TIMEOUT_MS = 20_000;
export const MAX_DIAGRAM_HEIGHT = 10_000;
const MAX_DIAGRAM_ALT = 1_024;

export type DiagramMessage =
  | { type: "drawn"; width: number; height: number; alt: string }
  | { type: "failed" };

export function diagramScriptUrl(apiBase: string): string {
  const url = new URL(DIAGRAM_SCRIPT_PATH, apiBase);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Invalid diagram server");
  }
  return url.href;
}

export function isDiagramDocument(url: string): boolean {
  return url === "about:blank" || url === "about:blank/";
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function diagramDocument(scriptUrl: string): string {
  const url = new URL(scriptUrl);
  if (diagramScriptUrl(url.href) !== url.href) throw new Error("Invalid diagram script");
  const policy = [
    "default-src 'none'",
    `script-src ${url.href}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`,
    "<style>html,body{margin:0;padding:0;background:transparent;overflow-x:auto;overflow-y:hidden}",
    "#diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}</style>",
    `<script src="${escapeAttribute(url.href)}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`,
    '</head><body><div id="diagram"></div></body></html>',
  ].join("");
}

/** Native injection starts only after the isolated document and its fixed script have loaded. */
export function diagramBootScript(
  source: string,
  config: ChatMermaidConfig,
  requestId: string,
): string {
  return `(function () {
  var requestId = ${scriptData(requestId)};
  var finished = false;
  var observer;
  var post = function (message) {
    if (finished) return;
    message.requestId = requestId;
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var fail = function () {
    post({ type: "failed" });
    finished = true;
    if (observer) observer.disconnect();
  };
  var source = ${scriptData(source)};
  var mermaid = window.mermaid;
  if (!mermaid) return fail();
  Promise.resolve().then(function () {
    mermaid.initialize(${scriptData(config)});
    return mermaid.parse(source, { suppressErrors: true });
  }).then(function (valid) {
    if (!valid) return fail();
    return mermaid.render("chat-diagram", source).then(function (result) {
      if (finished) return;
      var root = document.getElementById("diagram");
      root.innerHTML = result.svg;
      var svg = root.querySelector("svg");
      var box = svg && svg.viewBox && svg.viewBox.baseVal;
      var validSize = function (value) {
        return Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.ceil(value));
      };
      if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !validSize(box.width) ||
          !validSize(box.height) || box.height > ${MAX_DIAGRAM_HEIGHT}) return fail();
      svg.style.minWidth = Math.ceil(box.width * 0.8) + "px";
      var title = svg.querySelector("title");
      var alt = title && title.textContent ? title.textContent.trim().slice(0, ${MAX_DIAGRAM_ALT}) : "";
      var report = function () {
        var height = Math.ceil(root.getBoundingClientRect().height);
        if (!validSize(height) || height > ${MAX_DIAGRAM_HEIGHT}) return fail();
        post({ type: "drawn", width: box.width, height: height, alt: alt });
      };
      report();
      if (!finished && window.ResizeObserver) {
        observer = new ResizeObserver(report);
        observer.observe(root);
      }
      window.addEventListener("pagehide", function () {
        finished = true;
        if (observer) observer.disconnect();
      }, { once: true });
    });
  }).catch(fail);
})();
true;`;
}

export function parseDiagramMessage(data: string, requestId: string): DiagramMessage | null {
  try {
    const message: unknown = JSON.parse(data);
    if (!message || typeof message !== "object" || Array.isArray(message)) return null;
    const value = message as Record<string, unknown>;
    if (value.requestId !== requestId) return null;
    if (value.type === "failed" && Object.keys(value).length === 2) return { type: "failed" };
    if (
      value.type !== "drawn" ||
      Object.keys(value).length !== 5 ||
      typeof value.width !== "number" ||
      typeof value.height !== "number" ||
      typeof value.alt !== "string" ||
      value.alt.length > MAX_DIAGRAM_ALT
    ) {
      return null;
    }
    const { width, height, alt } = value;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(Math.ceil(width)) ||
      height > MAX_DIAGRAM_HEIGHT
    ) {
      return { type: "failed" };
    }
    return { type: "drawn", width, height, alt };
  } catch {
    return null;
  }
}
