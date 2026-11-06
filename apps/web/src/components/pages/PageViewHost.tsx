import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PAGE_PARAM, useMedia, usePageDetail, usePageDocument, usePages } from "../../lib/pages";
import { errorCode } from "../../lib/user-error";
import { PageNotice } from "./PageNotice";
import { PageView } from "./PageView";

/** A private page over its chat, with that chat's composer docked at the bottom. */
export function PageViewHost() {
  const [search] = useSearchParams();
  const pageId = search.get(PAGE_PARAM);
  const pages = usePages();
  return pageId && pages ? <OpenPage key={`${pages.scopeKey}:${pageId}`} pageId={pageId} /> : null;
}

function OpenPage({ pageId }: { pageId: string }) {
  const { t } = useLingui();
  const pages = usePages()!;
  const [, setSearch] = useSearchParams();
  const compact = useMedia("(pointer: coarse)");
  const sheet = useMedia("(pointer: coarse) and (min-width: 900px)");
  const page = usePageDetail(pageId);
  const viewer = usePageDocument(page.data?.code, sheet ? "background" : "card", true, 72);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const close = useCallback(
    () =>
      setSearch((current) => {
        const next = new URLSearchParams(current);
        next.delete(PAGE_PARAM);
        return next;
      }),
    [setSearch],
  );
  const setDock = useCallback(
    (node: HTMLDivElement | null) => pages.session.dock.set({ node }),
    [pages],
  );
  const data = page.data;
  useEffect(() => {
    pages.session.dock.set({ page: data ? { id: data.id, title: data.title } : null });
    return () => pages.session.dock.set({ page: null });
  }, [pages, data?.id, data?.title]);
  const failed = page.error !== undefined;
  const gone = failed && ["NOT_FOUND", "FORBIDDEN"].includes(errorCode(page.error) ?? "");
  return (
    <PageView
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={data?.title ?? ""}
      document={viewer.document}
      compact={compact}
      returnFocus={pages.session.restoreFocus}
      composer={<div ref={setDock} />}
      onReply={pages.session.offerReply}
      share={null}
      renameError={renameError ? t`Could not rename this page. Try again.` : null}
      onRename={
        !data || renaming
          ? undefined
          : (title) => {
              setRenaming(true);
              setRenameError(false);
              void pages.store.client.pages
                .rename({ pageId, title })
                .then(
                  () => {
                    if (pages.store.isCurrent()) pages.store.invalidate(pageId);
                  },
                  () => {
                    if (pages.store.isCurrent()) {
                      setRenameError(true);
                      pages.store.invalidate(pageId);
                    }
                  },
                )
                .finally(() => {
                  if (pages.store.isCurrent()) setRenaming(false);
                });
            }
      }
      notice={
        gone ? (
          <PageNotice
            title={t`This page isn't available`}
            detail={t`It may have been deleted, or it belongs to someone else.`}
            onClose={close}
          />
        ) : failed || viewer.failed ? (
          <PageNotice
            title={t`This page couldn't load`}
            detail={t`Check your connection and try again.`}
            onRetry={() => {
              if (failed) pages.store.invalidate(pageId);
              if (viewer.failed) viewer.retry();
            }}
            onClose={close}
          />
        ) : null
      }
    />
  );
}
