import { useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PAGE_PARAM, useMedia, usePageDetail, usePageDocument, usePages } from "../../lib/pages";
import { usePrivatePageMutation } from "../../lib/private-page-list";
import { errorCode } from "../../lib/user-error";
import { PageNotice } from "./PageNotice";
import { PageView } from "./PageView";

/** A private page over its chat, with that chat's composer docked at the bottom. */
export function PageViewHost({
  bots,
  groups,
}: {
  bots: readonly Pick<Bot, "id">[];
  groups: readonly Pick<Group, "id">[];
}) {
  const [search] = useSearchParams();
  const pageId = search.get(PAGE_PARAM);
  const pages = usePages();
  return pageId && pages ? (
    <OpenPage key={`${pages.scopeKey}:${pageId}`} pageId={pageId} bots={bots} groups={groups} />
  ) : null;
}

function OpenPage({
  pageId,
  bots,
  groups,
}: {
  pageId: string;
  bots: readonly Pick<Bot, "id">[];
  groups: readonly Pick<Group, "id">[];
}) {
  const { t } = useLingui();
  const pages = usePages()!;
  const [search, setSearch] = useSearchParams();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const compact = useMedia("(pointer: coarse)");
  const sheet = useMedia("(pointer: coarse) and (min-width: 900px)");
  const page = usePageDetail(pageId);
  const data = page.data;
  // A Page belongs to its recorded group, or to its bot when it has no group.
  // A missing/archived chat remains readable without borrowing another chat's composer.
  const target = data?.groupId
    ? `/app/g/${encodeURIComponent(data.groupId)}`
    : data?.botId
      ? `/app/${encodeURIComponent(data.botId)}`
      : null;
  const available = data?.groupId
    ? groups.some((group) => group.id === data.groupId)
    : Boolean(data?.botId && bots.some((bot) => bot.id === data.botId));
  const matches = Boolean(
    data &&
      !search.has("new-chat") &&
      (data.groupId ? groupId === data.groupId : !groupId && botId === data.botId),
  );
  const canReply = available && matches && pages.store.isCurrent();
  useEffect(() => {
    if (!target || !available || matches || !pages.store.isCurrent()) return;
    navigate(
      { pathname: target, search: new URLSearchParams({ [PAGE_PARAM]: pageId }).toString() },
      { replace: true },
    );
  }, [target, available, matches, pages, navigate, pageId]);
  const viewer = usePageDocument(
    data?.code,
    sheet ? "background" : "card",
    canReply,
    canReply ? 72 : 0,
  );
  const rename = usePrivatePageMutation(
    (input: { pageId: string; title: string }) => pages.store.client.pages.rename(input),
    pageId,
  );
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
  const replyEnabled = useRef(false);
  useLayoutEffect(() => {
    replyEnabled.current = canReply;
    pages.session.dock.set({
      page: canReply && data ? { id: data.id, title: data.title } : null,
      ...(!canReply ? { node: null } : {}),
    });
    return () => {
      replyEnabled.current = false;
      pages.session.dock.set({ page: null });
    };
  }, [pages, canReply, data?.id, data?.title]);
  const reply = useCallback(
    (text: unknown) => {
      if (replyEnabled.current && pages.store.isCurrent()) pages.session.offerReply(text);
    },
    [pages],
  );
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
      composer={canReply ? <div ref={setDock} /> : undefined}
      onReply={canReply ? reply : undefined}
      share={null}
      renameError={rename.isError ? t`Could not rename this page. Try again.` : null}
      onRename={!data || rename.isPending ? undefined : (title) => rename.mutate({ pageId, title })}
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
