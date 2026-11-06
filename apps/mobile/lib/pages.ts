import type { PageDetail } from "@rakazo/contracts";
import { isServerUnreachable, pageViewerDocument } from "@rakazo/core";
import {
  captureApiRequestContext,
  currentApiBase,
  currentApiBaseGeneration,
  currentSpaceSelectionGeneration,
  rpc,
  selectedSpaceId,
  subscribeApiBase,
  subscribeSelectedSpace,
} from "./api";
import { getActiveUiLocale } from "./i18n";
import { loadPageRuntime } from "./page-runtime";
import {
  currentSessionGeneration,
  registerSessionDiskCache,
  subscribeSessionGeneration,
} from "./session";

/** Pages draw at desktop width and shrink into the card, so a preview reads like the page. */
const PAGE_PREVIEW_SCALE = 0.6;
const PAGE_PREVIEW_ASPECT = 630 / 1200;

/** The card's live preview: the page laid out at `frame` size, scaled from its top-left corner. */
export function pagePreviewLayout(cardWidth: number) {
  const height = cardWidth * PAGE_PREVIEW_ASPECT;
  return {
    height,
    frameWidth: cardWidth / PAGE_PREVIEW_SCALE,
    frameHeight: height / PAGE_PREVIEW_SCALE,
    scale: PAGE_PREVIEW_SCALE,
  };
}

type PageCardState =
  | { status: "loading"; title: string }
  | { status: "failed"; title: string }
  | { status: "deleted"; title: string }
  | { status: "ready"; title: string; detail: PageDetail };

/** What a page block in the chat shows: the page's current title; the card opens the latest. */
export function pageCardState(
  block: { version: number; title: string },
  detail: PageDetail | null | "failed" | "deleted",
): PageCardState {
  if (detail === "failed" || detail === "deleted") return { status: detail, title: block.title };
  if (!detail) return { status: "loading", title: block.title };
  return {
    status: "ready",
    title: detail.title,
    detail,
  };
}

/** Why a page could not be read: it is gone, the server is out of reach, or anything else. */
export function pageLoadProblem(error: unknown): "gone" | "offline" | "failed" {
  if (pageReadFailure(error) === "deleted") return "gone";
  return isServerUnreachable(error) ? "offline" : "failed";
}

/** A card whose page is gone stays calm and opens nothing; any other failure may pass. */
export function pageReadFailure(error: unknown): "deleted" | "failed" {
  return (error as { code?: unknown } | null)?.code === "NOT_FOUND" ? "deleted" : "failed";
}

/** How long after a tap on a page it may still copy or open a link, as a browser's activation. */
const PAGE_ACTION_WINDOW_MS = 1_000;
/** Points a finger may drift and still tap; further is a scroll or a drag. */
const PAGE_TAP_SLOP = 10;

type PageTouch = { pageX: number; pageY: number };

/**
 * Where a touch on a page started, while it can still end as a tap: past the slop it is a scroll
 * or a drag, which a browser never counts as the person acting either.
 */
export function pageTapStart(start: PageTouch | null, touch: PageTouch): PageTouch | null {
  if (!start) return null;
  const moved = Math.hypot(touch.pageX - start.pageX, touch.pageY - start.pageY);
  return moved <= PAGE_TAP_SLOP ? start : null;
}

/** A page acts for the person only right after they tapped it, never on load or on its own. */
export function pageActionAllowed(tappedAt: number | null, now: number): boolean {
  return tappedAt !== null && now >= tappedAt && now - tappedAt <= PAGE_ACTION_WINDOW_MS;
}

/** The chat recorded on a Page; reply availability is checked against active chats separately. */
export function pageChat(page: Pick<PageDetail, "botId" | "groupId">) {
  if (page.groupId) return { pathname: "/group-thread", key: "groupId", threadKey: page.groupId };
  if (page.botId) return { pathname: "/thread", key: "botId", threadKey: page.botId };
  return null;
}

/** Archived or missing chats leave their Pages readable, with no reply destination. */
export async function getPageReplyChat(page: Pick<PageDetail, "botId" | "groupId">) {
  const chat = pageChat(page);
  if (!chat) return null;
  const active = await pageRpc<Array<{ id: string }>>(
    page.groupId ? "groups/list" : "bots/list",
    {},
  );
  return active.some((candidate) => candidate.id === chat.threadKey) ? chat : null;
}

type PageReply = { text: string; page: { id: string; title: string } };
let pendingReply: (PageReply & { threadKey: string; scope: string }) | null = null;

/** A reply tapped on a full-screen page waits for its chat's composer; the user still sends it. */
export function offerPageReply(threadKey: string, reply: PageReply) {
  pendingReply = { threadKey, scope: pageScopeKey(), ...reply };
}

/** The reply waiting for this chat, with the page it is about, taken once. */
export function takePageReply(threadKey: string | undefined): PageReply | null {
  if (!threadKey || pendingReply?.threadKey !== threadKey || pendingReply.scope !== pageScopeKey())
    return null;
  const { text, page } = pendingReply;
  pendingReply = null;
  return { text, page };
}

/** A message a page's kit posted through the WebView; anything unreadable is null. */
export function pageMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type PageRead = { read: Promise<PageDetail>; at: number; refresh?: Promise<PageDetail> };
const pageReads = new Map<string, PageRead>();
const pageReadKey = (pageId: string, version?: number) =>
  JSON.stringify([pageScopeKey(), pageId, version ?? null]);

function clearPageReads(scope: string, pageId: string) {
  for (const key of pageReads.keys()) {
    const [owner, id] = JSON.parse(key) as [string, string];
    if (owner === scope && id === pageId) pageReads.delete(key);
  }
}
// Another account or server never sees this one's pages.
const clearPages = () => {
  pageReads.clear();
  pendingReply = null;
};
registerSessionDiskCache(clearPages);
subscribeSelectedSpace(clearPages);
subscribeApiBase(clearPages);

export function pageScopeKey(): string {
  return JSON.stringify([
    currentApiBase(),
    currentApiBaseGeneration(),
    currentSessionGeneration(),
    selectedSpaceId(),
    currentSpaceSelectionGeneration(),
  ]);
}
export function subscribePageScope(listener: () => void): () => void {
  const off = [
    subscribeSessionGeneration(listener),
    subscribeApiBase(listener),
    subscribeSelectedSpace(listener),
  ];
  return () => {
    for (const unsubscribe of off) unsubscribe();
  };
}

async function pageRpc<T>(proc: string, body: unknown): Promise<T> {
  const scope = pageScopeKey();
  const context = await captureApiRequestContext();
  const current = () => scope === pageScopeKey();
  const result = await rpc<T>(proc, body, { requestContext: { ...context, isCurrent: current } });
  if (!current()) throw new Error("Page scope changed");
  return result;
}

// Module-level beside the read cache it governs: cards in any thread and the page screen share it.
let lastOnScreen = 0;
const onScreenListeners = new Set<() => void>();

/** When a chat last came back on screen; a page read before then is read again once. */
export const chatOnScreen = {
  get: () => lastOnScreen,
  subscribe(listener: () => void) {
    onScreenListeners.add(listener);
    return () => onScreenListeners.delete(listener);
  },
  mark() {
    lastOnScreen = Date.now();
    for (const listener of onScreenListeners) listener();
  },
};

/** The latest version: one read per page until a newer version is known or the chat refocuses. */
export function getLatestPage(
  pageId: string,
  options: { refresh?: boolean; atLeastVersion?: number; since?: number } = {},
): Promise<PageDetail> {
  const scope = pageScopeKey();
  const key = pageReadKey(pageId);
  const cached = options.refresh ? undefined : pageReads.get(key);
  if (cached && cached.at >= (options.since ?? lastOnScreen)) {
    const wanted = options.atLeastVersion ?? 0;
    return cached.read.then((page) => {
      if (scope !== pageScopeKey()) throw new Error("Page scope changed");
      if (page.currentVersion >= wanted) return page;
      const refreshed = pageReads.get(key);
      return refreshed && refreshed !== cached
        ? refreshed.read.then((page) => {
            if (scope !== pageScopeKey()) throw new Error("Page scope changed");
            return page.currentVersion >= wanted ? page : refreshLatestPage(pageId, refreshed);
          })
        : refreshLatestPage(pageId, cached);
    });
  }
  return readPage(pageId);
}

/** Share one fresh attempt after an insufficient read, without repeatedly chasing a version. */
function refreshLatestPage(pageId: string, previous: PageRead): Promise<PageDetail> {
  if (previous.refresh) return previous.refresh;
  const refresh = getLatestPage(pageId, { refresh: true });
  previous.refresh = refresh;
  const clear = () => {
    if (previous.refresh === refresh) delete previous.refresh;
  };
  void refresh.then(clear, clear);
  return refresh;
}

/** Saved card previews share immutable version reads without replacing the live Page. */
export function getPageVersion(pageId: string, version: number): Promise<PageDetail> {
  return pageReads.get(pageReadKey(pageId, version))?.read ?? readPage(pageId, version);
}

function readPage(pageId: string, version?: number): Promise<PageDetail> {
  const key = pageReadKey(pageId, version);
  const read = pageRpc<PageDetail>("pages/get", {
    pageId,
    ...(version === undefined ? {} : { version }),
  });
  const entry = { read, at: Date.now() };
  pageReads.set(key, entry);
  read.catch(() => {
    if (pageReads.get(key) === entry) pageReads.delete(key);
  });
  return read;
}

export function renamePage(pageId: string, title: string) {
  const scope = pageScopeKey();
  return pageRpc("pages/rename", { pageId, title }).finally(() => clearPageReads(scope, pageId));
}

export function removePage(pageId: string) {
  const scope = pageScopeKey();
  return pageRpc<{ ok: true }>("pages/remove", { pageId })
    .catch((error: unknown) => {
      // NOT_FOUND: another device deleted it first, which is the outcome asked for.
      if (pageReadFailure(error) === "deleted") return { ok: true as const };
      throw error;
    })
    .finally(() => clearPageReads(scope, pageId));
}

export async function pageDocument(
  apiBase: string,
  code: string,
  theme: "light" | "dark",
  errorTitle: string,
  options: { reply?: boolean; lang?: string } = {},
): Promise<string> {
  const runtime = await loadPageRuntime(apiBase);
  return pageViewerDocument({
    runtime,
    code,
    theme,
    errorTitle,
    touch: true,
    lang: getActiveUiLocale(),
    ...options,
  });
}

export function pinPage(pageId: string, pinned: boolean) {
  const scope = pageScopeKey();
  return pageRpc("pages/pin", { pageId, pinned }).finally(() => clearPageReads(scope, pageId));
}
export const privatePageRpc = pageRpc;
