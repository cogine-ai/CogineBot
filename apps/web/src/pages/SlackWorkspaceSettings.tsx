import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
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
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { createSpaceRpc } from "../lib/rpc";

type Api = Pick<
  ReturnType<typeof createSpaceRpc>["messaging"]["installations"],
  "list" | "start" | "attempt" | "cancel" | "pause" | "remove"
>;
type List = Awaited<ReturnType<Api["list"]>>;
type Workspace = List["workspaces"][number];
type Attempt = Awaited<ReturnType<Api["start"]>>;
const SLACK_POPUP = "coginebot-slack-oauth";

export function SlackWorkspaceSettings({
  api,
  bots,
  current,
  outcome,
}: {
  api: Api;
  bots: Bot[];
  current: () => boolean;
  outcome?: string;
}) {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState<List | null>(null);
  const [botId, setBotId] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [confirm, setConfirm] = useState<Workspace | null>(null);
  const [error, setError] = useState(outcome === "failed");
  const [readFailed, setReadFailed] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    async function refresh() {
      const request = ++generation.current;
      try {
        const result = attempt
          ? await api.attempt({ attemptId: attempt.attemptId }, { signal: controller.signal })
          : null;
        const list = await api.list(undefined, { signal: controller.signal });
        if (controller.signal.aborted || !currentRef.current() || request !== generation.current)
          return;
        setLoaded(list);
        setReadFailed(false);
        if (result && result.status !== "pending") {
          setAttempt(null);
          if (result.status === "failed") setError(true);
          if (result.status === "expired") setExpired(true);
        }
      } catch {
        if (!controller.signal.aborted && currentRef.current() && request === generation.current)
          setReadFailed(true);
      }
    }
    void refresh();
    if (!attempt) return () => controller.abort();
    const interval = window.setInterval(() => void refresh(), 2_000);
    const deadline = window.setTimeout(
      () => {
        if (!currentRef.current()) return;
        setExpired(true);
        setAttempt(null);
      },
      Math.max(0, Date.parse(attempt.expiresAt) - Date.now()),
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.clearTimeout(deadline);
    };
  }, [api, attempt, readRevision]);

  async function perform(work: () => Promise<void>) {
    if (!current() || busy) return;
    setBusy(true);
    setError(false);
    setExpired(false);
    try {
      await work();
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) setBusy(false);
    }
  }

  async function start(selected: string, workspace?: Workspace) {
    const popup = window.open("about:blank", SLACK_POPUP, "popup,width=560,height=720");
    let opened = false;
    try {
      if (popup) popup.opener = null;
      const issued = await api.start({
        botId: selected,
        ...(workspace && { reconnect: { id: workspace.id, expectedRevision: workspace.revision } }),
      });
      if (!current()) return;
      const url = new URL(issued.url);
      if (
        url.origin !== "https://slack.com" ||
        url.pathname !== "/oauth/v2/authorize" ||
        url.username ||
        url.password
      )
        throw new Error("Invalid Slack authorization URL");
      setAttempt(issued);
      if (popup && !popup.closed) {
        popup.location.replace(url.href);
        opened = true;
      }
    } finally {
      if (!opened) popup?.close();
    }
  }

  async function update(work: () => Promise<unknown>) {
    try {
      await work();
    } finally {
      if (current()) {
        const request = ++generation.current;
        try {
          const list = await api.list();
          if (current() && request === generation.current) {
            setLoaded(list);
            setReadFailed(false);
          }
        } catch {
          // A write can commit even when its response is lost. Disable stale
          // revision actions until a fresh read establishes the actual state.
          if (current() && request === generation.current) setReadFailed(true);
        }
      }
    }
  }

  if (!api) return null;
  return (
    <section aria-label="Slack" className="mt-6 space-y-4 rounded-xl border border-border p-4">
      <h3 className="text-[15px] font-medium">Slack</h3>
      {!loaded?.available && loaded ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Slack installation is unavailable.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Couldn't update the Slack connection.</Trans>
        </p>
      ) : null}
      {readFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <Trans>Couldn't load messaging settings</Trans>
          <Button variant="ghost" size="xs" onClick={() => setReadRevision((value) => value + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {expired ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Slack authorization expired. Try again.</Trans>
        </p>
      ) : null}
      {loaded?.workspaces.map((row) => (
        <div key={row.id} className="space-y-2 border-t border-border pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{row.workspaceName}</span>
            <span className="text-xs text-muted-foreground">
              {!loaded.available
                ? t`Unavailable`
                : row.status === "active"
                  ? t`Connected`
                  : row.status === "paused"
                    ? t`Paused`
                    : row.status === "unavailable"
                      ? t`Bot unavailable`
                      : t`Reconnect required`}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {bots.find((bot) => bot.id === row.botId)?.name ?? t`Bot unavailable`}
            {row.installerName ? ` · ${row.installerName}` : ""}
          </p>
          {loaded.available && row.status === "active" ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                The bot replies to your direct messages and mentions in channels the app has joined.
                Invite the app to private channels first.
              </Trans>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                readFailed ||
                Boolean(attempt) ||
                !loaded.available ||
                row.status === "unavailable"
              }
              onClick={() => void perform(() => start(row.botId, row))}
            >
              <Trans>Reconnect</Trans>
            </Button>
            {loaded.available && (row.status === "active" || row.status === "paused") ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || readFailed || Boolean(attempt)}
                onClick={() =>
                  void perform(() =>
                    update(() =>
                      api.pause({
                        id: row.id,
                        expectedRevision: row.revision,
                        paused: row.status === "active",
                      }),
                    ),
                  )
                }
              >
                {row.status === "active" ? t`Pause` : t`Resume`}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || readFailed || Boolean(attempt)}
              onClick={() => setConfirm(row)}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        </div>
      ))}
      {loaded?.available && !attempt ? (
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label={t`Bot for Slack`}
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
          >
            <NativeSelectOption value="">{t`Choose a bot…`}</NativeSelectOption>
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={!botId || busy || readFailed}
            onClick={() => void perform(() => start(botId))}
          >
            <Trans>Connect Slack</Trans>
          </Button>
        </div>
      ) : null}
      {attempt ? (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <span className="text-sm text-muted-foreground">
            <Trans>Waiting for Slack authorization</Trans>
          </span>
          <a className="text-sm underline" href={attempt.url} target={SLACK_POPUP} rel="noreferrer">
            <Trans>Open Slack</Trans>
          </a>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api.cancel({ attemptId: attempt.attemptId });
                if (current()) setAttempt(null);
              })
            }
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Disconnect Slack?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                The bot will stop receiving and sending messages in this workspace. Conversation
                history stays in CogineBot.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return;
                const row = confirm;
                setConfirm(null);
                void perform(() =>
                  update(() => api.remove({ id: row.id, expectedRevision: row.revision })),
                );
              }}
            >
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
