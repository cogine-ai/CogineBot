import { useExternalLinkOpener } from "@rakazo/chat-ui/web";
import { pageCopyRequest, pageCopyResult, pageLinkRequest, pageReplyText } from "@rakazo/core";
import type { CSSProperties } from "react";
import { useCallback, useRef, useState } from "react";
import { writeClipboard } from "../../lib/copy-text";
import { pageFrameHeight } from "../../lib/page-cards";
import { SandboxedHtmlViewer } from "../SandboxedHtmlViewer";

/**
 * A page document in the sandboxed viewer. Only an `interactive` frame acts for its page (copy,
 * open a link, offer a reply), and only right after the person used that frame: the viewer
 * shell vouches for a click or key inside it, the frame still has focus, and that click or key
 * has not been used for another action yet. Previews draw only.
 * An interactive frame prints whole: on paper it keeps the width the page was drawn at, so the
 * page's last reported height still fits it, and the browser scales it to the paper.
 */
export function PageFrame({
  document,
  documentKey,
  title,
  interactive = false,
  onHeight,
  onPageDrawn,
  onReply,
}: {
  document: string;
  /** Changes when the Page, shown version, or compile retry changes even if HTML is identical. */
  documentKey?: string;
  title: string;
  interactive?: boolean;
  onHeight?: (height: number) => void;
  /** Trusted runtime commit or render failure, separate from layout measurement. */
  onPageDrawn?: (drawn: boolean) => void;
  /** Where a page's reply button puts its text; without it the page offers no replies. */
  onReply?: (text: string) => void;
}) {
  const { open, dialog } = useExternalLinkOpener();
  const box = useRef<HTMLDivElement>(null);
  const [drawnAt, setDrawnAt] = useState<{
    document: string;
    documentKey?: string;
    style: CSSProperties;
  }>();
  const usedGesture = useRef<string | null>(null);
  const receive = useCallback(
    (data: unknown, answer: (message: object) => void, focused: boolean) => {
      if (!data || typeof data !== "object") return;
      const message = data as {
        type?: unknown;
        height?: unknown;
        drawn?: unknown;
        text?: unknown;
        gesture?: unknown;
      };
      if (
        message.type === "rakazo-page:height" &&
        typeof message.height === "number" &&
        Number.isFinite(message.height)
      ) {
        const height = pageFrameHeight(message.height);
        if (interactive && box.current) {
          setDrawnAt({
            document,
            documentKey,
            style: {
              "--page-width": `${box.current.offsetWidth}px`,
              "--page-height": `${height}px`,
            } as CSSProperties,
          });
        }
        onHeight?.(height);
        return;
      }
      if (message.type === "rakazo-page:drawn" && typeof message.drawn === "boolean") {
        onPageDrawn?.(message.drawn);
        return;
      }
      const { gesture } = message;
      if (!interactive || !focused || typeof gesture !== "string" || gesture.length === 0) return;
      if (gesture === usedGesture.current) return;
      const copy = pageCopyRequest(data);
      const url = copy ? null : pageLinkRequest(data);
      const reply =
        !copy && !url && message.type === "rakazo-page:reply" && onReply
          ? pageReplyText(message.text)
          : null;
      if (!copy && !url && !reply) return;
      usedGesture.current = gesture;
      if (copy) void writeClipboard(copy.text).then((ok) => answer(pageCopyResult(copy.id, ok)));
      else if (url) open(url);
      else if (reply) onReply?.(reply);
    },
    [document, documentKey, interactive, onHeight, onPageDrawn, onReply, open],
  );
  return (
    <>
      <div
        ref={box}
        style={
          interactive && drawnAt?.document === document && drawnAt.documentKey === documentKey
            ? drawnAt.style
            : undefined
        }
        className={`h-full ${interactive ? "print:mx-auto print:h-(--page-height) print:w-(--page-width)" : ""}`}
      >
        <SandboxedHtmlViewer
          html={document}
          kind="page"
          documentKey={documentKey}
          interactive={interactive}
          title={title}
          className="bg-transparent"
          onFrameMessage={receive}
        />
      </div>
      {dialog}
    </>
  );
}
