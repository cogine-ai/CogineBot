import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Spinner } from "@rakazo/ui-web";
import { Check, Link } from "lucide-react";
import { useEffect, useState } from "react";
import { DownloadPdfButton } from "./DownloadPdfButton";
import { PageFrame } from "./PageFrame";
import { ManualPageLinkCopy, usePageLinkCopy } from "./PageLinkCopy";

const ACTION =
  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-body-sm font-medium whitespace-nowrap text-foreground ring-[0.5px] ring-border outline-none hover:bg-foreground/[0.08] focus-visible:ring-2 focus-visible:ring-ring";

export function PublicPageShell({
  title,
  document,
  documentKey,
  url,
  onRetry,
}: {
  title: string;
  document: string | null;
  documentKey: string;
  url: string;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const { copied, copy, manualUrl } = usePageLinkCopy();
  const [height, setHeight] = useState(0);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (height > 0) return;
    const timer = window.setTimeout(() => setStalled(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [height]);

  if (stalled) return <PublicPageMessage unavailable={false} onRetry={onRetry} />;
  return (
    <main
      data-page-print
      className="flex min-h-dvh flex-col bg-card text-foreground print:bg-transparent"
    >
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 bg-card pr-2 pl-3.5 print:hidden">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-2 text-body-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src="/favicon-32x32.png" alt="" className="size-4 rounded-full" />
          <Trans>Open CogineBot</Trans>
        </a>
        <h1 className="sr-only">{title}</h1>
        <nav aria-label={t`Page actions`} className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            className={`${ACTION} ${copied ? "text-success" : ""}`}
            onClick={() => copy(url)}
          >
            {copied ? <Check className="size-4" /> : <Link className="size-4" />}
            <span className="max-[560px]:sr-only">
              {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </span>
          </Button>
          {height > 0 ? (
            <DownloadPdfButton className={ACTION} labelClassName="max-[560px]:sr-only" />
          ) : null}
          <span role="status" className="sr-only">
            {copied ? t`Link copied` : ""}
          </span>
        </nav>
      </header>
      {manualUrl ? (
        <div className="sticky top-12 z-10 mx-auto w-full max-w-[480px] bg-card px-3.5 pb-3 print:hidden">
          <ManualPageLinkCopy url={manualUrl} />
        </div>
      ) : null}
      <div
        className="relative min-h-[calc(100dvh-48px)] print:min-h-0"
        style={{ height: height || undefined }}
      >
        {height === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-muted-foreground print:hidden">
            <Spinner />
          </div>
        ) : null}
        {document !== null ? (
          <PageFrame
            document={document}
            documentKey={documentKey}
            title={title}
            interactive
            onHeight={setHeight}
          />
        ) : null}
      </div>
    </main>
  );
}

export function PublicPageMessage({
  unavailable,
  onRetry,
}: {
  unavailable: boolean;
  onRetry?: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 text-center">
      <div className="flex max-w-[360px] flex-col items-center gap-3">
        {unavailable ? (
          <>
            <img src="/favicon-32x32.png" alt="" className="size-8 rounded-full" />
            <h1 className="text-heading3 font-medium text-foreground">
              <Trans>This page isn't available</Trans>
            </h1>
            <p className="text-body text-muted-foreground">
              <Trans>The owner may have turned off its link or deleted it.</Trans>
            </p>
            <Button variant="outline" size="sm" render={<a href="/" />} nativeButton={false}>
              <Trans>Open CogineBot</Trans>
            </Button>
          </>
        ) : (
          <>
            <p role="alert" className="text-body text-muted-foreground">
              <Trans>Couldn't load this page. Try again.</Trans>
            </p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <Trans>Try again</Trans>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
