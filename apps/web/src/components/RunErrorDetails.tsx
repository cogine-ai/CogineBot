import { Trans, useLingui } from "@lingui/react/macro";
import { CHATGPT_USAGE_SETTINGS_URL, normalizeRunError } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useCopyText } from "../lib/copy-text";
import { translateRunError } from "../lib/run-error";

/** Diagnostics are plain, bounded, cleaned text; expanding them never repeats work. */
export function RunErrorDetails({ error, onAddKey }: { error: string; onAddKey?: () => void }) {
  const { i18n, t } = useLingui();
  const [copied, copy] = useCopyText();
  const normalized = normalizeRunError(error, translateRunError, i18n.locale);
  return (
    <div className="min-w-0 flex-1" data-testid="run-error-details">
      <p>{normalized.summary}</p>
      {normalized.action === "chatgpt-usage" ? (
        <a
          href={CHATGPT_USAGE_SETTINGS_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[13px] underline underline-offset-4"
        >
          <Trans>Manage usage</Trans>
        </a>
      ) : null}
      {normalized.action === "add_key" && onAddKey ? (
        <Button size="xs" variant="ghost" onClick={onAddKey}>
          <Trans>Add API key</Trans>
        </Button>
      ) : null}
      <details key={error} className="mt-1">
        <summary className="w-fit cursor-pointer text-[12px] underline underline-offset-2">
          <Trans>Details</Trans>
        </summary>
        <pre className="rk-scroll mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-[12px] text-foreground">
          {normalized.details}
        </pre>
        <Button
          size="xs"
          variant="ghost"
          aria-label={t`Copy diagnostics`}
          onClick={() => copy(normalized.details)}
        >
          {copied ? <Trans>Copied</Trans> : <Trans>Copy diagnostics</Trans>}
        </Button>
      </details>
    </div>
  );
}
