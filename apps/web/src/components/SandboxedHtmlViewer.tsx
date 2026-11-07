import { SANDBOXED_PAGE_CSP, withSandboxedArtifactCsp, withSandboxedPageCsp } from "@rakazo/core";
import { useLayoutEffect, useRef, useState } from "react";

export const HTML_VIEWER_PATH = "/html-viewer.html";

const PREVIEW_GUARD = `<meta name="referrer" content="no-referrer"><script>
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  event.preventDefault();
  if (href.startsWith("#")) location.hash = href;
}, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
</script>`;

type ViewerSession = { frame: HTMLIFrameElement; source: Window; instance: string };
type ViewerEnvelope = { type?: unknown; instance?: unknown; message?: unknown };

function newInstance(): string {
  // getRandomValues also works on local HTTP deployments.
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (word) =>
    word.toString(16).padStart(8, "0"),
  ).join("");
}

/** A network shell avoids inheriting the app CSP, with the actual document inside a second opaque frame. */
export function SandboxedHtmlViewer({
  html,
  title,
  className = "bg-white",
  kind = "artifact",
  documentKey,
  interactive = false,
  onFrameMessage,
}: {
  html: string;
  title: string;
  className?: string;
  kind?: "artifact" | "page";
  documentKey?: string;
  interactive?: boolean;
  /** Receives messages from the current shell only. Replies are bound to the same shell load. */
  onFrameMessage?: (data: unknown, answer: (message: object) => void, focused: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<ViewerSession | undefined>(undefined);
  const [document, setDocument] = useState({ html, documentKey, kind, interactive, generation: 0 });
  if (
    document.html !== html ||
    document.documentKey !== documentKey ||
    document.kind !== kind ||
    document.interactive !== interactive
  )
    setDocument({ html, documentKey, kind, interactive, generation: document.generation + 1 });

  useLayoutEffect(() => {
    if (!onFrameMessage) return;
    function receive(event: MessageEvent<ViewerEnvelope | null>) {
      const current = session.current;
      if (
        !current ||
        current.frame !== frame.current ||
        event.source !== current.source ||
        event.origin !== "null" ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "rakazo-viewer:message" ||
        event.data.instance !== current.instance
      )
        return;
      onFrameMessage?.(
        event.data.message,
        (message) => {
          if (session.current !== current || frame.current !== current.frame) return;
          current.source.postMessage(
            { type: "rakazo-viewer:answer", instance: current.instance, message },
            "*",
          );
        },
        window.document.activeElement === current.frame,
      );
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onFrameMessage]);

  return (
    <iframe
      key={document.generation}
      ref={frame}
      title={title}
      src={HTML_VIEWER_PATH}
      onLoad={(event) => {
        const current = event.currentTarget;
        const source = current.contentWindow;
        if (current !== frame.current || !source) return;
        const instance = newInstance();
        session.current = { frame: current, source, instance };
        const withCsp = kind === "page" ? withSandboxedPageCsp : withSandboxedArtifactCsp;
        // An opaque frame can be addressed only with "*"; its Window and load identity are pinned.
        source.postMessage(
          {
            type: "rakazo-viewer:load",
            instance,
            document: withCsp(html, PREVIEW_GUARD),
            interactive,
          },
          "*",
        );
      }}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={`h-full w-full border-0 [color-scheme:light] ${className}`}
    />
  );
}

export const PREVIEW_CSP = SANDBOXED_PAGE_CSP;
