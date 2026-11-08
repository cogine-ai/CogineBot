import { Trans, useLingui } from "@lingui/react/macro";
import type { PageDetail, PageShareInput, PageShareState } from "@rakazo/contracts";
import { PageShareStateSchema } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { ArrowUpRight, Check, Copy, Globe, Lock, Share } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { usablePageShareUrl } from "../../lib/page-share-links";
import { usePages } from "../../lib/pages";
import { ManualPageLinkCopy, usePageLinkCopy } from "./PageLinkCopy";

export function PageShareControl({
  page,
  open,
  onOpenChange,
  compact,
  drawn,
}: {
  page: PageDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact: boolean;
  drawn: boolean;
}) {
  const { t } = useLingui();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={page.sharedByLink ? t`Share, link is on` : t`Share`}
        className={`${compact ? "size-11 justify-center" : "h-[35px] px-[15px]"} flex items-center gap-1.5 rounded-full border border-foreground/[0.06] text-body text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/[0.06]`}
      >
        {page.sharedByLink ? <Globe className="size-4" /> : <Share className="size-4" />}
        {compact ? null : <Trans>Share</Trans>}
      </PopoverTrigger>
      {open ? <OpenPageShare page={page} drawn={drawn} /> : null}
    </Popover>
  );
}

function OpenPageShare({ page, drawn }: { page: PageDetail; drawn: boolean }) {
  const { t } = useLingui();
  const { store } = usePages()!;
  const [state, setState] = useState<PageShareState>();
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const busy = useRef(true);
  const pendingTab = useRef<Window | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const { copy, copied, manualUrl } = usePageLinkCopy();
  const pageId = page.id;
  const visibility = state?.visibility ?? (page.sharedByLink ? "link" : null);
  const publishingEnabled = state?.publishingEnabled === true;
  const shareUrl =
    publishingEnabled && state?.visibility === "link" && state.generation
      ? usablePageShareUrl(state.shareUrl)
      : null;

  useLayoutEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    lifetime.current = controller;
    busy.current = true;
    setPending(true);
    const current = () => !signal.aborted && store.isCurrent();
    void store.client.pages
      .getShare({ pageId }, { signal })
      .then((result) => {
        if (current()) setState(PageShareStateSchema.parse(result));
      })
      .catch(() => {
        if (current()) setError(t`Couldn't load sharing settings. Try again.`);
      })
      .finally(() => {
        if (current()) {
          busy.current = false;
          setPending(false);
        }
      });
    return () => {
      controller.abort();
      pendingTab.current?.close();
      pendingTab.current = null;
    };
  }, [pageId, store, t]);

  async function perform(work: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !store.isCurrent() || busy.current) return;
    const current = () => !signal.aborted && store.isCurrent();
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await work(signal, current);
    } finally {
      if (current()) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  async function readShare(signal: AbortSignal) {
    return PageShareStateSchema.parse(await store.client.pages.getShare({ pageId }, { signal }));
  }

  function refresh() {
    void perform(async (signal, current) => {
      const actual = await readShare(signal).catch(() => undefined);
      if (!current()) return;
      setState(actual);
      if (!actual) setError(t`Couldn't load sharing settings. Try again.`);
    });
  }

  function changeVisibility(input: PageShareInput) {
    if (input.visibility === visibility) return;
    void perform(async (signal, current) => {
      try {
        const result = await store.client.pages.setShare(input, { signal });
        if (current()) setState(PageShareStateSchema.parse(result));
      } catch {
        // A lost response can follow a committed change. Read back before offering either action.
        if (!current()) return;
        const actual = await readShare(signal).catch(() => undefined);
        if (current()) {
          setState(actual);
          setError(t`Couldn't change who can view this page. Try again.`);
        }
      } finally {
        if (current()) store.invalidate(pageId);
      }
    });
  }

  function actOnLink(action: "copy" | "open") {
    const generation = state?.generation;
    if (!generation || !shareUrl) return;
    void perform(async (signal, current) => {
      const native = Boolean(desktopBridge());
      let tab: Window | null = null;
      try {
        if (action === "open" && !native) {
          // Reserve a window during the click, before the network round trip can consume activation.
          tab = window.open("about:blank", "_blank");
          if (!tab) {
            setError(t`Couldn't open the link. Copy it and open it in your browser.`);
            return;
          }
          tab.opener = null;
          pendingTab.current = tab;
        }
        const latest = await readShare(signal);
        if (!current()) return;
        setState(latest);
        if (
          !latest.publishingEnabled ||
          latest.visibility !== "link" ||
          latest.generation !== generation
        ) {
          setError(t`The page link changed. Try again.`);
          store.invalidate(pageId);
          return;
        }
        const url = usablePageShareUrl(latest.shareUrl);
        if (!url) throw new Error("Link unavailable");
        if (action === "copy") copy(url, current);
        else if (native) window.open(url, "_blank", "noopener,noreferrer");
        else if (tab && !tab.closed) {
          const link = tab.document.createElement("a");
          link.href = url;
          link.rel = "noopener noreferrer";
          tab.document.body.append(link);
          link.click();
          pendingTab.current = null;
          tab = null;
        }
      } catch {
        if (current()) {
          setState(undefined);
          setError(t`Couldn't verify the page link. Try again.`);
        }
      } finally {
        tab?.close();
        if (pendingTab.current === tab) pendingTab.current = null;
      }
    });
  }

  const owner = page.owner.name.trim() || t`You`;
  const initial = owner.match(/\p{L}/u)?.[0]?.toLocaleUpperCase();
  return (
    <PopoverContent
      align="end"
      sideOffset={8}
      data-testid="page-share"
      className="w-[360px] max-w-[calc(100vw-32px)] gap-3 rounded-xl px-4 py-4"
    >
      <PopoverTitle
        ref={title}
        tabIndex={-1}
        className="truncate text-body-lg font-medium outline-none"
      >
        <Trans>Share “{page.title}”</Trans>
      </PopoverTitle>
      <div className="flex min-h-10 items-center gap-3">
        {page.owner.image ? (
          <img
            src={page.owner.image}
            alt=""
            className="size-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-label text-muted-foreground">
            {initial}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-body">{owner}</span>
        <span className="text-label text-muted-foreground">
          <Trans>Owner</Trans>
        </span>
      </div>
      <fieldset disabled={pending} className="-mx-1.5 flex flex-col gap-0.5">
        <legend className="sr-only">
          <Trans>Who can open this page</Trans>
        </legend>
        <ShareChoice
          value="private"
          title={t`Only you`}
          detail={visibility === "link" ? t`The shared link stops working` : undefined}
          checked={visibility === "private"}
          onSelect={() => changeVisibility({ pageId, visibility: "private" })}
        />
        <ShareChoice
          value="link"
          title={t`Anyone with the link`}
          detail={
            publishingEnabled ? t`Can view without signing in` : t`Sharing by link isn't available`
          }
          disabled={!publishingEnabled || !drawn}
          checked={visibility === "link"}
          onSelect={() => setConfirmVersion(page.version)}
        />
      </fieldset>
      {shareUrl ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => actOnLink("copy")}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={pending}
              onClick={() => actOnLink("open")}
            >
              <ArrowUpRight />
              <Trans>Open link</Trans>
            </Button>
          </div>
          {!pending && manualUrl === shareUrl ? <ManualPageLinkCopy url={manualUrl} /> : null}
          <span role="status" className="sr-only">
            {copied ? t`Link copied` : ""}
          </span>
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-label text-destructive">
            {error}
          </p>
          {!state ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={refresh}>
              <Trans>Try again</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      <AlertDialog
        open={confirmVersion !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmVersion(null);
        }}
      >
        <AlertDialogContent finalFocus={title}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Share this page?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Anyone with the link can view version {confirmVersion} and future approved updates.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending || !drawn || !publishingEnabled || confirmVersion !== page.version}
              onClick={() => {
                if (drawn && publishingEnabled && confirmVersion === page.version) {
                  setConfirmVersion(null);
                  changeVisibility({ pageId, visibility: "link", expectedVersion: confirmVersion });
                }
              }}
            >
              <Trans>Share</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PopoverContent>
  );
}

function ShareChoice({
  value,
  title,
  detail,
  disabled,
  checked,
  onSelect,
}: {
  value: "private" | "link";
  title: string;
  detail?: string;
  disabled?: boolean;
  checked: boolean;
  onSelect: () => void;
}) {
  const Icon = value === "private" ? Lock : Globe;
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-foreground/[0.04] has-checked:bg-foreground/[0.06] has-disabled:cursor-default">
      <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body">{title}</span>
        {detail ? <span className="text-label text-muted-foreground">{detail}</span> : null}
      </span>
      <input
        type="radio"
        name="page-sharing-visibility"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="me-1.5 size-4 shrink-0 accent-foreground"
      />
    </label>
  );
}
