import type { PageDetail } from "@rakazo/contracts";
import { isServerUnreachable } from "@rakazo/core";
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
import {
  currentReadySessionGeneration,
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
  const code = (error as { code?: unknown } | null)?.code;
  return code === "NOT_FOUND" || code === "FORBIDDEN" ? "deleted" : "failed";
}

type PageChat =
  | { pathname: "/group-thread"; key: "groupId"; threadKey: string }
  | { pathname: "/thread"; key: "botId"; threadKey: string };

/** The chat recorded on a Page; reply availability is checked against active chats separately. */
export function pageChat(page: Pick<PageDetail, "botId" | "groupId">): PageChat | null {
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
let pendingReply:
  | (PageReply & { pathname: PageChat["pathname"]; threadKey: string; scope: string })
  | null = null;

/** A reply tapped on a full-screen page waits for its chat's composer; the user still sends it. */
export function offerPageReply(
  pathname: PageChat["pathname"],
  threadKey: string,
  reply: PageReply,
) {
  pendingReply = { pathname, threadKey, scope: pageScopeKey(), ...reply };
}

/** The reply waiting for this chat, with the page it is about, taken once. */
export function takePageReply(
  pathname: PageChat["pathname"],
  threadKey: string | undefined,
): PageReply | null {
  if (
    !threadKey ||
    pendingReply?.pathname !== pathname ||
    pendingReply.threadKey !== threadKey ||
    pendingReply.scope !== pageScopeKey()
  )
    return null;
  const { text, page } = pendingReply;
  pendingReply = null;
  return { text, page };
}

let pageShareView: {
  id: string;
  pageId: string;
  page: Pick<PageDetail, "title" | "version">;
  scope: string;
} | null = null;

/** Only a rendered viewer can confirm the Page title and version for publication. */
export function offerPageShareView(
  id: string,
  { id: pageId, title, version }: Pick<PageDetail, "id" | "title" | "version">,
) {
  pageShareView = { id, pageId, page: { title, version }, scope: pageScopeKey() };
}

export function viewedPageShare(pageId: string | undefined, id: string | undefined) {
  if (
    pageShareView?.id === id &&
    pageShareView?.pageId === pageId &&
    pageShareView?.scope === pageScopeKey()
  )
    return pageShareView.page;
}

export function clearPageShareView(id: string | undefined) {
  if (id && pageShareView?.id === id) pageShareView = null;
}

type PageRead = {
  read: Promise<PageDetail>;
  onScreen: number;
  settled: boolean;
  refresh?: Promise<PageDetail>;
};
// Retain a small set of successful snapshots, like the mobile saved-chat cache.
// Pending reads keep their shared promise until they settle.
const PAGE_READ_CACHE_LIMIT = 40;
const pageReads = new Map<string, PageRead>();
const pageReadKey = (pageId: string, version?: number) =>
  JSON.stringify([pageScopeKey(), pageId, version ?? null]);

function trimPageReads() {
  let retained = 0;
  for (const entry of pageReads.values()) if (entry.settled) retained++;
  for (const [key, entry] of pageReads) {
    if (retained <= PAGE_READ_CACHE_LIMIT) break;
    if (entry.settled) {
      pageReads.delete(key);
      retained--;
    }
  }
}

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
  pageShareView = null;
};
registerSessionDiskCache(clearPages);
subscribeSelectedSpace(clearPages);
subscribeApiBase(clearPages);

export function pageScopeKey(): string {
  return JSON.stringify([
    currentApiBase(),
    currentApiBaseGeneration(),
    currentSessionGeneration(),
    currentReadySessionGeneration(),
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

async function pageRpc<T>(proc: string, body: unknown, isCurrent?: () => boolean): Promise<T> {
  const scope = pageScopeKey();
  const current = () => scope === pageScopeKey() && isCurrent?.() !== false;
  if (!current() || currentSessionGeneration() !== currentReadySessionGeneration())
    throw new Error("Page scope changed");
  const context = await captureApiRequestContext();
  if (!current()) throw new Error("Page scope changed");
  const result = await rpc<T>(proc, body, { requestContext: { ...context, isCurrent: current } });
  if (!current()) throw new Error("Page scope changed");
  return result;
}

// Module-level beside the read cache it governs: cards in any thread and the page screen share it.
let lastOnScreen = 0;
const onScreenListeners = new Set<() => void>();

/** Advances when a chat returns on screen, so each latest read is revalidated once per return. */
export const chatOnScreen = {
  get: () => lastOnScreen,
  subscribe(listener: () => void) {
    onScreenListeners.add(listener);
    return () => onScreenListeners.delete(listener);
  },
  mark() {
    lastOnScreen += 1;
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
  if (cached && cached.onScreen >= Math.max(options.since ?? 0, lastOnScreen)) {
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
  const scope = pageScopeKey();
  const key = pageReadKey(pageId, version);
  const read = pageRpc<PageDetail>("pages/get", {
    pageId,
    ...(version === undefined ? {} : { version }),
  });
  const entry: PageRead = { read, onScreen: lastOnScreen, settled: false };
  pageReads.delete(key);
  pageReads.set(key, entry);
  void read.then(
    () => {
      if (pageReads.get(key) !== entry) return;
      entry.settled = true;
      trimPageReads();
    },
    (error: unknown) => {
      if (pageReads.get(key) !== entry) return;
      if (version === undefined && pageReadFailure(error) === "deleted") {
        clearPageReads(scope, pageId);
      } else pageReads.delete(key);
    },
  );
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
      if ((error as { code?: unknown } | null)?.code === "NOT_FOUND") return { ok: true as const };
      throw error;
    })
    .finally(() => clearPageReads(scope, pageId));
}

export function pinPage(pageId: string, pinned: boolean) {
  const scope = pageScopeKey();
  return pageRpc("pages/pin", { pageId, pinned }).finally(() => clearPageReads(scope, pageId));
}
export const privatePageRpc = pageRpc;
