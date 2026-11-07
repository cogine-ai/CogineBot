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
  const refreshed = useRef<number | null>(null);
  useEffect(() => {
    if (
      !updated &&
      current.data &&
      current.data.currentVersion < block.version &&
      refreshed.current !== block.version
    ) {
      refreshed.current = block.version;
      pages?.store.invalidate(block.pageId);
    }
  }, [updated, current.data, block.version, block.pageId, pages]);
  const shown = updated ? saved : current;
  const viewer = usePageDocument(shown.data?.code);
  const deleted = errorCode(current.error) === "NOT_FOUND";
  return (
    <PageCard
      title={current.data?.title ?? block.title}
      document={deleted ? null : viewer.document}
      failed={viewer.failed || shown.error !== undefined}
      updated={updated}
      updatedAt={current.data?.updatedAt}
      onOpen={deleted ? undefined : () => openPage(block.pageId)}
    />
  );
}
