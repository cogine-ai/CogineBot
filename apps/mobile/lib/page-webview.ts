import {
  PAGE_COPY_MAX_LENGTH,
  pageCopyRequest,
  pageLinkRequest,
  pageReplyText,
  SANDBOXED_PAGE_CSP,
  withSandboxedPageCsp,
} from "@rakazo/core";

export const PAGE_ACTION_WINDOW_MS = 1_000;
export const PAGE_TAP_SLOP = 10;

export const isPageShellUrl = (url: string) => url === "about:blank" || url === "about:blank/";

export function allowPageFrameNavigation(url: string, isTopFrame?: boolean): boolean {
  return isPageShellUrl(url) || (url === "about:srcdoc" && isTopFrame !== true);
}

// The WebView's top document is an isolated local shell. The authored document has a separate
// opaque origin and cannot navigate the shell. The shell CSP also blocks remote child navigation.
export const NATIVE_PAGE_SHELL = `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${SANDBOXED_PAGE_CSP}; frame-src about:; child-src 'none'"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{height:100%;margin:0;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style><iframe id="preview" title="Page preview" sandbox="allow-scripts" referrerpolicy="no-referrer" csp="${SANDBOXED_PAGE_CSP}"></iframe><script>
(() => {
  const preview = document.getElementById("preview");
  let instance = null;
  let gestureKey = null;
  let tappedAt = null;

  // Only the native host can call this across the inner document's opaque origin.
  window.coginePage = {
    mount(nextInstance, html, key) {
      if (instance !== null) return;
      instance = nextInstance;
      gestureKey = key;
      preview.srcdoc = html;
    },
    answer(currentInstance, message) {
      if (gestureKey && instance === currentInstance)
        preview.contentWindow.postMessage(message, "*");
    },
  };

  addEventListener("message", (event) => {
    if (!gestureKey || event.source !== preview.contentWindow || event.origin !== "null") return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "rakazo-page:drawn") {
      if (message.key === gestureKey && typeof message.drawn === "boolean") {
        const status = { type: message.type, drawn: message.drawn };
        window.ReactNativeWebView?.postMessage(JSON.stringify({ instance, message: status }));
      }
      return;
    }
    if (message.type === "rakazo-page:gesture") {
      if (message.key === gestureKey) tappedAt = Date.now();
      return;
    }
    const now = Date.now();
    if (tappedAt === null || now < tappedAt || now - tappedAt > ${PAGE_ACTION_WINDOW_MS}) return;
    let action;
    if (message.type === "rakazo-page:open-link" && typeof message.url === "string" &&
        message.url.length <= 4096) {
      action = { type: message.type, url: message.url };
    } else if (message.type === "rakazo-page:reply" && typeof message.text === "string" &&
        message.text.length <= 300) {
      action = { type: message.type, text: message.text };
    } else if (message.type === "rakazo-page:copy" && typeof message.id === "string" &&
        message.id.length > 0 && message.id.length <= 64 && typeof message.text === "string" &&
        message.text.length <= ${PAGE_COPY_MAX_LENGTH}) {
      action = { type: message.type, id: message.id, text: message.text };
    } else {
      return;
    }
    tappedAt = null;
    window.ReactNativeWebView?.postMessage(JSON.stringify({ instance, message: action }));
  });
})();
</script>`;

function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The boot code runs in the shell, ahead of the authored content in the opaque child. */
export function nativePageMountScript(
  document: string,
  instance: string,
  gestureKey: string | null,
  reportDraw = false,
): string {
  const guard = gestureKey
    ? `<script>(() => {
  const key = ${scriptData(gestureKey)};
  const send = parent.postMessage.bind(parent);
  document.currentScript.remove();
  addEventListener("pointerup", (event) => {
    if (event.isTrusted) send({ type: "rakazo-page:gesture", key }, "*");
  }, true);
  ${reportDraw ? 'window.__coginePageReportDraw = (drawn) => send({ type: "rakazo-page:drawn", key, drawn }, "*");' : ""}
})();</script>`
    : "";
  const html = withSandboxedPageCsp(document, guard);
  return `window.coginePage?.mount(${scriptData(instance)}, ${scriptData(html)}, ${scriptData(gestureKey)});true;`;
}

export function nativePageAnswerScript(instance: string, message: object): string {
  return `window.coginePage?.answer(${scriptData(instance)}, ${scriptData(message)});true;`;
}

type NativePageMessage =
  | { kind: "drawn"; drawn: boolean }
  | { kind: "copy"; id: string; text: string }
  | { kind: "link"; url: string }
  | { kind: "reply"; text: string };

export function readNativePageMessage(data: string, instance: string): NativePageMessage | null {
  // JSON can take six characters to encode each code unit of the allowed clipboard payload.
  if (data.length > (PAGE_COPY_MAX_LENGTH + 512) * 6) return null;
  let envelope: { instance?: unknown; message?: unknown } | null;
  try {
    envelope = JSON.parse(data);
  } catch {
    return null;
  }
  if (envelope?.instance !== instance) return null;
  const { message } = envelope;
  const status = message as { type?: unknown; drawn?: unknown } | null;
  if (status?.type === "rakazo-page:drawn" && typeof status.drawn === "boolean")
    return { kind: "drawn", drawn: status.drawn };
  const copy = pageCopyRequest(message);
  if (copy) return { kind: "copy", ...copy };
  const url = pageLinkRequest(message);
  if (url) return { kind: "link", url };
  const reply = message as { type?: unknown; text?: unknown } | null;
  const text = reply?.type === "rakazo-page:reply" ? pageReplyText(reply.text) : null;
  return text ? { kind: "reply", text } : null;
}
