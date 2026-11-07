import type { MouseEvent, ReactNode } from "react";
import { Children, Fragment } from "react";

/** The frame cannot open windows itself; the host opens web links it is asked to. */
const OPEN_LINK_MESSAGE = "rakazo-page:open-link";

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function openViaHost(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  window.parent?.postMessage({ type: OPEN_LINK_MESSAGE, url: event.currentTarget.href }, "*");
}

export function Link({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="rk-link" href={href} rel="noopener noreferrer" onClick={openViaHost}>
      {children ?? href}
    </a>
  );
}

const WORD = /[\p{L}\p{N}_]/u;
const URL_END = /[\s<>"]/;
// Match the viewer host's maximum open-link URL length.
const MAX_BARE_URL_LENGTH = 4096;
/** Punctuation that ends a sentence rather than the link, trimmed by walking back from the end. */
const URL_TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "'"]);

// A backwards walk, not a `[...]+$` regex: the regex retries from every start in a long run.
function trimmedUrlEnd(text: string, start: number, end: number): number {
  while (end > start && URL_TRAILING.has(text[end - 1]!)) end--;
  return end;
}

/**
 * **strong**, *em* or _em_, `code` and bare http(s) or www. links in one pass over the text.
 * Link candidates share token boundaries and have bounded parsing work.
 */
export function inlineMarkup(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = 0;
  let tokenEnd = 0;
  let linkEnd = 0;
  const emit = (start: number, end: number, node: ReactNode) => {
    if (start > plain) out.push(text.slice(plain, start));
    out.push(<Fragment key={out.length}>{node}</Fragment>);
    plain = end;
  };
  const boundary = (index: number) => index < 0 || index >= text.length || !WORD.test(text[index]!);
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) {
        emit(index, close + 1, <code className="rk-code">{text.slice(index + 1, close)}</code>);
        index = close;
      }
    } else if (char === "_" && boundary(index - 1)) {
      const close = text.indexOf("_", index + 1);
      const inner = close > index + 1 ? text.slice(index + 1, close) : "";
      if (inner && !/^\s|\s$|\n/.test(inner) && boundary(close + 1)) {
        emit(index, close + 1, <em>{inlineMarkup(inner)}</em>);
        index = close;
      }
    } else if (char === "*" && boundary(index - 1)) {
      const strong = text[index + 1] === "*";
      const marker = strong ? "**" : "*";
      const from = index + marker.length;
      const close = text.indexOf(marker, from);
      const inner = close > from ? text.slice(from, close) : "";
      if (
        inner &&
        !/^\s|\s$|\n/.test(inner) &&
        !(strong ? false : inner.includes("*")) &&
        boundary(close + marker.length)
      ) {
        const content = inlineMarkup(inner);
        emit(
          index,
          close + marker.length,
          strong ? <strong>{content}</strong> : <em>{content}</em>,
        );
        index = close + marker.length - 1;
      } else if (strong) {
        index += 1;
      }
    } else if (
      (char === "h" || char === "w") &&
      boundary(index - 1) &&
      /^(?:https?:\/\/|www\.[\p{L}\p{N}])/u.test(text.slice(index, index + 8))
    ) {
      if (index >= tokenEnd) {
        tokenEnd = index;
        while (tokenEnd < text.length && !URL_END.test(text[tokenEnd]!)) tokenEnd++;
        linkEnd = trimmedUrlEnd(text, index, tokenEnd);
      }
      if (linkEnd - index > MAX_BARE_URL_LENGTH) continue;
      const raw = text.slice(index, linkEnd);
      const href = webUrl(char === "w" ? `https://${raw}` : raw);
      if (href && href.length <= MAX_BARE_URL_LENGTH) {
        emit(index, linkEnd, <Link href={href}>{raw}</Link>);
        index = linkEnd - 1;
      }
    }
  }
  if (plain < text.length) out.push(text.slice(plain));
  return out;
}

/** Applies inline markup to the string children, leaving elements as they are. */
export function Inline({ children }: { children?: ReactNode }) {
  return (
    <>
      {Children.map(children, (child) => (typeof child === "string" ? inlineMarkup(child) : child))}
    </>
  );
}
