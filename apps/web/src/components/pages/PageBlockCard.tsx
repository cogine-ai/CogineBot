import { useEffect, useRef } from "react";
import type { PageBlock } from "../../lib/page-cards";
import { useOpenPage, usePageDetail, usePageDocument, usePages } from "../../lib/pages";
import { errorCode } from "../../lib/user-error";
import { PageCard } from "./PageCard";

/** Older cards retain their saved preview; every card opens the current page. */
export function PageBlockCard({ block, updated = false }: { block: PageBlock; updated?: boolean }) {
  const pages = usePages();
  const openPage = useOpenPage();
  const current = usePageDetail(block.pageId);
  const saved = usePageDetail(updated ? block.pageId : null, block.version);
  const refreshed = useRef<string | null>(null);
  const freshnessKey = JSON.stringify([pages?.scopeKey, block.pageId, block.version]);
  useEffect(() => {
    if (
      !updated &&
      current.data &&
      current.data.currentVersion < block.version &&
      refreshed.current !== freshnessKey
    ) {
      refreshed.current = freshnessKey;
      pages?.store.invalidate(block.pageId);
    }
  }, [updated, current.data, block.version, block.pageId, pages, freshnessKey]);
  const shown = updated ? saved : current;
  const currentError = errorCode(current.error);
  const deleted = currentError === "NOT_FOUND";
  const denied = currentError === "UNAUTHORIZED" || currentError === "FORBIDDEN";
  const data = deleted || denied ? undefined : shown.data;
  const documentKey = data && JSON.stringify([block.pageId, data.version]);
  const viewer = usePageDocument(data?.code, "card", false, 0, documentKey);
  return (
    <PageCard
      title={current.data?.title ?? block.title}
      document={viewer.document}
      documentKey={viewer.documentKey}
      failed={denied || viewer.failed || shown.error !== undefined}
      updated={updated}
      updatedAt={current.data?.updatedAt}
      sharedByLink={current.data?.sharedByLink}
      onOpen={deleted ? undefined : () => openPage(block.pageId)}
    />
  );
}
