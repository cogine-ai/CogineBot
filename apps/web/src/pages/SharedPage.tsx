import type { SharedPage } from "@rakazo/contracts";
import {
  pageShareTokenFromSlug,
  SHARED_PAGE_PATH_PREFIX,
  SharedPageSchema,
} from "@rakazo/contracts";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { PublicPageMessage, PublicPageShell } from "../components/pages/PublicPageShell";
import { pageShareSlug } from "../lib/page-share-links";
import { usePageDocument } from "../lib/pages";

type Result = { kind: "ready"; page: SharedPage } | { kind: "unavailable" | "failed" };

async function readSharedPage(token: string, signal: AbortSignal): Promise<Result> {
  const response = await fetch(`${SHARED_PAGE_PATH_PREFIX}${token}`, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (response.status === 404) return { kind: "unavailable" };
  if (!response.ok) return { kind: "failed" };
  const page = SharedPageSchema.safeParse(await response.json());
  return page.success ? { kind: "ready", page: page.data } : { kind: "failed" };
}

export function SharedPagePage({ pathname }: { pathname: string }) {
  const slug = pageShareSlug(pathname);
  const token = slug ? pageShareTokenFromSlug(slug) : null;
  return (
    <>
      <meta name="robots" content="noindex, nofollow" />
      {token && slug ? (
        <SharedPageReader key={pathname} token={token} slug={slug} />
      ) : (
        <PublicPageMessage unavailable />
      )}
    </>
  );
}

function SharedPageReader({ token, slug }: { token: string; slug: string }) {
  const [attempt, setAttempt] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [read, setRead] = useState<{ attempt: number; result: Result }>();
  const retry = () => {
    setRead(undefined);
    setAttempt((previous) => previous + 1);
  };
  useLayoutEffect(() => {
    const hide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        flushSync(() => {
          setRead(undefined);
          setSuspended(true);
        });
      }
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        flushSync(() => {
          setAttempt((previous) => previous + 1);
          setSuspended(false);
        });
      }
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);

  useEffect(() => {
    if (suspended) return;
    const controller = new AbortController();
    const { signal } = controller;
    const finish = (result: Result) => {
      if (!signal.aborted) setRead({ attempt, result });
    };
    void readSharedPage(token, signal).then(finish, () => finish({ kind: "failed" }));
    return () => controller.abort();
  }, [token, attempt, suspended]);

  const result = !suspended && read?.attempt === attempt ? read.result : undefined;
  if (result?.kind === "unavailable") return <PublicPageMessage unavailable />;
  if (result?.kind === "failed") return <PublicPageMessage unavailable={false} onRetry={retry} />;
  if (result?.kind !== "ready") {
    return (
      <main className="grid min-h-dvh place-items-center bg-background text-muted-foreground">
        <Spinner />
      </main>
    );
  }
  return (
    <SharedPageDocument
      key={`${attempt}:${result.page.version}`}
      page={result.page}
      url={new URL(`/p/${slug}`, window.location.origin).href}
      onRetry={retry}
    />
  );
}

function SharedPageDocument({
  page,
  url,
  onRetry,
}: {
  page: SharedPage;
  url: string;
  onRetry: () => void;
}) {
  const viewer = usePageDocument(page.code, "card", false, 0, String(page.version));
  useLayoutEffect(() => {
    const previous = document.title;
    document.title = page.title;
    return () => {
      document.title = previous;
    };
  }, [page.title]);
  if (viewer.failed) return <PublicPageMessage unavailable={false} onRetry={onRetry} />;
  return (
    <PublicPageShell
      title={page.title}
      document={viewer.document}
      documentKey={viewer.documentKey}
      url={url}
      onRetry={onRetry}
    />
  );
}
