import { useLingui } from "@lingui/react/macro";
import type { MessageBlock, PageDetail } from "@rakazo/contracts";
import { PAGE_RUNTIME_PATH, pageReply, pageReplyText, pageViewerDocument } from "@rakazo/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { RpcClient } from "./rpc";
import { captureRpcRecoveryScope, createSpaceRpc, isRpcRecoveryScopeCurrent } from "./rpc";

export const PAGE_PARAM = "page";
export const PAGE_SHARE_PARAM = "share-page";
function readTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function readSurface(on: "card" | "background"): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${on}`).trim();
}

export function useMedia(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

type Dock = { node: HTMLElement | null; page: { id: string; title: string } | null };

/**
 * One chat's open-page state: what opened the page (for focus) and where the composer docks. Shared by the shell, the open page and the composer through context.
 */
export function createPageSession() {
  let opener: { element: HTMLElement; ring: boolean } | null = null;
  let dock: Dock = { node: null, page: null };
  const dockListeners = new Set<() => void>();
  const replyListeners = new Set<(text: string) => void>();
  return {
    rememberOpener() {
      const element = document.activeElement;
      opener =
        element instanceof HTMLElement
          ? { element, ring: element.matches(":focus-visible") }
          : null;
    },
    /** Focus goes back to what opened the page, with a ring only if it had one. */
    restoreFocus() {
      if (!opener?.element.isConnected) return true;
      opener.element.focus({ focusVisible: opener.ring } as FocusOptions);
      return false;
    },
    dock: {
      set(next: Partial<Dock>) {
        const merged = { ...dock, ...next };
        if (
          merged.node === dock.node &&
          merged.page?.title === dock.page?.title &&
          merged.page?.id === dock.page?.id
        )
          return;
        dock = merged;
        for (const listener of dockListeners) listener();
      },
      subscribe(listener: () => void) {
        dockListeners.add(listener);
        return () => dockListeners.delete(listener);
      },
      get: () => dock,
    },
    /** A page's reply button hands its text to the chat's composer; the user still sends it. */
    offerReply(text: unknown) {
      const clean = pageReplyText(text);
      if (!clean || !dock.page) return;
      for (const listener of replyListeners) listener(clean);
    },
    subscribeReply(listener: (text: string) => void) {
      replyListeners.add(listener);
      return () => {
        replyListeners.delete(listener);
      };
    },
    /** From the open page: reply to its card, or name the page if this chat has none. */
    send(
      text: string,
      messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
      chosenReplyId?: string,
    ): ReturnType<typeof pageReply> {
      return pageReply(text, messages, dock.page, chosenReplyId);
    },
  };
}
export type PageSession = ReturnType<typeof createPageSession>;

type Runtime = { text: string; etag: string | null };
const runtimes = new Map<string, Runtime>();
const pendingRuntimes = new Map<string, Promise<string>>();

/** Public kit bytes are keyed by server and revalidated for every use. */
export function loadPageRuntime(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const pending = pendingRuntimes.get(url);
  if (pending) return pending;
  const cached = runtimes.get(url);
  const read = fetcher(url, {
    credentials: "omit",
    ...(cached?.etag ? { headers: { "if-none-match": cached.etag } } : {}),
  })
    .then(async (response) => {
      if (response.status === 304 && cached) return cached.text;
      if (!response.ok) throw new Error(`Page runtime returned ${response.status}`);
      const runtime = { text: await response.text(), etag: response.headers.get("etag") };
      runtimes.set(url, runtime);
      return runtime.text;
    })
    .finally(() => pendingRuntimes.delete(url));
  pendingRuntimes.set(url, read);
  return read;
}

export function usePageDocument(
  code: string | undefined,
  on: "card" | "background" = "card",
  reply = false,
  bottomInset = 0,
  documentKey?: string,
) {
  const { t, i18n } = useLingui();
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as const);
  const surface = useMemo(() => (theme ? readSurface(on) : ""), [theme, on]);
  const touch = useMedia("(pointer: coarse)");
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<{
    code: string | undefined;
    documentKey?: string;
    text?: string;
    failed: boolean;
  }>({ code, documentKey, failed: false });
  useEffect(() => {
    let active = true;
    setRuntime({ code, documentKey, failed: false });
    if (code === undefined) return;
    void loadPageRuntime(new URL(PAGE_RUNTIME_PATH, window.location.origin).href).then(
      (text) => {
        if (active) setRuntime({ code, documentKey, text, failed: false });
      },
      () => {
        if (active) setRuntime({ code, documentKey, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [code, documentKey, attempt]);
  const current = runtime.code === code && runtime.documentKey === documentKey;
  const runtimeText = current ? runtime.text : undefined;
  const document = useMemo(
    () =>
      runtimeText === undefined || code === undefined
        ? null
        : pageViewerDocument({
            runtime: runtimeText,
            code,
            theme,
            errorTitle: t`This page couldn't be shown.`,
            surface,
            touch,
            reply,
            bottomInset,
            lang: i18n.locale,
          }),
    [runtimeText, code, theme, t, surface, touch, reply, bottomInset, i18n.locale],
  );
  return {
    document,
    documentKey: JSON.stringify([documentKey, attempt]),
    failed: current && runtime.failed,
    retry: () => setAttempt((n) => n + 1),
  };
}

export function createPageStore(client: RpcClient, isCurrent: () => boolean) {
  const reads = new Map<string, Promise<PageDetail>>();
  const controllers = new Set<AbortController>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  return {
    client,
    isCurrent,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revision: () => revision,
    get(pageId: string, version?: number) {
      const key = JSON.stringify([pageId, version ?? null]);
      let read = reads.get(key);
      if (!read) {
        const controller = new AbortController();
        controllers.add(controller);
        read = client.pages
          .get(
            { pageId, ...(version === undefined ? {} : { version }) },
            { signal: controller.signal },
          )
          .then((page) => {
            if (!isCurrent()) throw new DOMException("Page scope changed", "AbortError");
            return page;
          })
          .finally(() => controllers.delete(controller));
        reads.set(key, read);
        const entry = read;
        void read.catch(() => {
          if (reads.get(key) === entry) reads.delete(key);
        });
      }
      return read;
    },
    invalidate(pageId?: string) {
      if (pageId)
        for (const key of reads.keys()) {
          if (JSON.parse(key)[0] === pageId) reads.delete(key);
        }
      else reads.clear();
      notify();
    },
    dispose() {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      reads.clear();
    },
  };
}

type PageStore = ReturnType<typeof createPageStore>;
type Pages = {
  open: (pageId: string, share?: boolean) => void;
  session: PageSession;
  store: PageStore;
  scopeKey: string;
};
const PagesContext = createContext<Pages | null>(null);
export const PagesProvider = PagesContext.Provider;
export function usePages() {
  return useContext(PagesContext);
}
export function useOpenPage() {
  return usePages()?.open ?? (() => {});
}
export function usePageSession() {
  return usePages()?.session ?? null;
}

export function usePagesForChat(scopeKey: string, spaceId: string | null) {
  const [, setSearchParams] = useSearchParams();
  const committed = useRef<object | null>(null);
  const binding = useMemo(
    () => ({ scopeKey, scope: captureRpcRecoveryScope(spaceId), ready: false }),
    [scopeKey, spaceId],
  );
  const pages = useMemo(() => {
    const isCurrent = () =>
      binding.ready && committed.current === binding && isRpcRecoveryScopeCurrent(binding.scope);
    const store = createPageStore(createSpaceRpc(spaceId, isCurrent), isCurrent);
    return { scopeKey, store, session: createPageSession() };
  }, [binding, scopeKey, spaceId]);
  useLayoutEffect(() => {
    committed.current = binding;
    const refocus = () => {
      if (pages.store.isCurrent()) pages.store.invalidate();
    };
    const visible = () => {
      if (document.visibilityState === "visible") refocus();
    };
    window.addEventListener("focus", refocus);
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (committed.current === binding) committed.current = null;
      pages.store.dispose();
      pages.session.dock.set({ node: null, page: null });
      window.removeEventListener("focus", refocus);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [binding, pages]);
  // The owning app commits its session generation in a parent layout effect. Bind only
  // after that commit, then wake reader effects that waited for the authenticated scope.
  useEffect(() => {
    if (committed.current !== binding) return;
    binding.scope = captureRpcRecoveryScope(spaceId);
    binding.ready = true;
    pages.store.invalidate();
    return () => {
      binding.ready = false;
    };
  }, [binding, pages, spaceId]);
  const open = useCallback(
    (pageId: string, share = false) => {
      if (!pages.store.isCurrent()) return;
      pages.session.rememberOpener();
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.set(PAGE_PARAM, pageId);
        if (share) next.set(PAGE_SHARE_PARAM, "1");
        else next.delete(PAGE_SHARE_PARAM);
        return next;
      });
    },
    [pages, setSearchParams],
  );
  return useMemo(() => ({ ...pages, open }), [pages, open]);
}

export function usePageDetail(
  pageId: string | null,
  version?: number,
): { key: string; data?: PageDetail; error?: unknown } {
  const pages = usePages();
  const store = pages?.store;
  const revision = useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.revision ?? zero,
    zero,
  );
  const key = JSON.stringify([pages?.scopeKey, pageId, version, revision]);
  const resource = useMemo(() => ({ store, pageId, version }), [store, pageId, version]);
  const [loaded, setLoaded] = useState<{
    key: string;
    resource: typeof resource;
    data?: PageDetail;
    error?: unknown;
  }>({
    key,
    resource,
  });
  useEffect(() => {
    let active = true;
    // Revalidating this resource keeps its drawn frame and controls mounted.
    // A different owner, Space, page or version must never inherit that content.
    setLoaded((previous) =>
      previous.resource === resource ? { key, resource, data: previous.data } : { key, resource },
    );
    if (store && pageId && store.isCurrent())
      void store.get(pageId, version).then(
        (data) => {
          if (active && store.isCurrent()) setLoaded({ key, resource, data });
        },
        (error: unknown) => {
          if (active && store.isCurrent()) setLoaded({ key, resource, error });
        },
      );
    return () => {
      active = false;
    };
  }, [store, key, pageId, version, resource]);
  return loaded.resource === resource && store?.isCurrent() ? loaded : { key };
}
const emptySubscribe = () => () => {};
const zero = () => 0;
