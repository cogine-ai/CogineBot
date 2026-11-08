import { Trans, useLingui } from "@lingui/react/macro";
import { useLayoutEffect, useRef, useState } from "react";
import { writeClipboard } from "../../lib/copy-text";

export function usePageLinkCopy() {
  const [copied, setCopied] = useState(false);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const revision = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(
    () => () => {
      revision.current++;
      window.clearTimeout(timer.current);
    },
    [],
  );

  function copy(url: string, isCurrent: () => boolean = () => true) {
    const action = ++revision.current;
    const current = () => action === revision.current && isCurrent();
    void writeClipboard(url, current).then((ok) => {
      if (!current()) return;
      window.clearTimeout(timer.current);
      setManualUrl(ok ? null : url);
      setCopied(ok);
      if (ok) timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  }

  return { copied, copy, manualUrl };
}

export function ManualPageLinkCopy({ url }: { url: string }) {
  const { t } = useLingui();
  return (
    <label className="flex flex-col gap-1 text-label text-muted-foreground">
      <span role="alert">
        <Trans>Couldn't copy. Select the link and copy it.</Trans>
      </span>
      <input
        readOnly
        value={url}
        aria-label={t`Page link`}
        // biome-ignore lint/a11y/noAutofocus: this is revealed when copying fails.
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 w-full min-w-0 rounded-sm bg-muted px-2.5 text-body-sm text-foreground ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}
