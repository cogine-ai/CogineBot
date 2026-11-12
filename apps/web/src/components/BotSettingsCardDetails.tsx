import { Trans, useLingui } from "@lingui/react/macro";
import { useBotSettingsCard } from "@rakazo/chat-ui/bot-settings";
import type { BotSettingsCardSchema, BotSettingsChange } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import {
  captureRpcRecoveryScope,
  isRpcRecoveryScopeCurrent,
  rpc,
  rpcRecoveryScopeKey,
  subscribeRpcRecoveryScope,
} from "../lib/rpc";

const client = {
  captureScope: captureRpcRecoveryScope,
  isScopeCurrent: isRpcRecoveryScopeCurrent,
  scopeKey: rpcRecoveryScopeKey,
  subscribeScope: subscribeRpcRecoveryScope,
  load: (botId: string, signal: AbortSignal) => rpc.bots.settingsHistory({ botId }, { signal }),
  undo: (request: Parameters<typeof rpc.bots.undoSettings>[0], signal: AbortSignal) =>
    rpc.bots.undoSettings(request, { signal }),
};

function SettingsChange({
  change,
  current = false,
}: {
  change: BotSettingsChange;
  current?: boolean;
}) {
  const { t } = useLingui();
  const labels = {
    instructions: t`Instructions`,
    model: t`Model`,
    thinkingLevel: t`Thinking`,
    voice: t`Voice`,
    readAloud: t`Read aloud`,
  };
  const diff = current ? (
    <p className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-sm" dir="auto">
      {change.after || "—"}
    </p>
  ) : (
    <dl className="my-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words text-sm">
      <dt className="text-muted-foreground">
        <Trans>Before</Trans>
      </dt>
      <dd className="max-h-44 overflow-auto whitespace-pre-wrap" dir="auto">
        {change.before || "—"}
      </dd>
      <dt className="text-muted-foreground">
        <Trans>After</Trans>
      </dt>
      <dd className="max-h-44 overflow-auto whitespace-pre-wrap" dir="auto">
        {change.after || "—"}
      </dd>
    </dl>
  );
  return change.field === "instructions" ? (
    <details>
      <summary className="cursor-pointer text-sm font-medium">{labels[change.field]}</summary>
      {diff}
    </details>
  ) : (
    <div className="text-sm">
      <div className="font-medium">{labels[change.field]}</div>
      {diff}
    </div>
  );
}

export function BotSettingsCardDetails({
  settings,
  answered,
  proposal,
}: {
  settings: ReturnType<typeof BotSettingsCardSchema.parse>;
  answered: boolean;
  proposal: boolean;
}) {
  const { t } = useLingui();
  const { history, pending, status, viewSettings, undo } = useBotSettingsCard(
    settings.botId,
    client,
  );
  const conflict = answered && !proposal && !settings.versionId;
  const runChange =
    !conflict && settings.changes.some(({ field }) => field !== "voice" && field !== "readAloud");
  const playbackChange =
    !conflict && settings.changes.some(({ field }) => field === "voice" || field === "readAloud");
  const labels = {
    instructions: t`Instructions`,
    model: t`Model`,
    thinkingLevel: t`Thinking`,
    voice: t`Voice`,
    readAloud: t`Read aloud`,
  };
  const sources = {
    bot: t`This Bot`,
    space: t`This Space`,
    model: t`Model default`,
    system: t`System default`,
  };
  return (
    <div className="mt-2 space-y-2" data-testid="bot-settings-card-details">
      <p className="text-sm text-muted-foreground">
        <Trans>This Bot</Trans> · <bdi>{settings.botName}</bdi>
      </p>
      {settings.changes.map((change) => (
        <SettingsChange key={change.field} change={change} current={conflict} />
      ))}
      <div className="text-xs text-muted-foreground">
        {runChange ? (
          <div>
            <Trans>Applies to new runs.</Trans>
          </div>
        ) : null}
        {playbackChange ? (
          <div>
            <Trans>Applies to new playback.</Trans>
          </div>
        ) : null}
      </div>
      {answered && !proposal ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void viewSettings()}
          >
            {history ? (
              <Trans>Refresh settings</Trans>
            ) : conflict ? (
              <Trans>Review current settings</Trans>
            ) : (
              <Trans>View settings</Trans>
            )}
          </Button>
          {settings.versionId &&
          settings.revision !== undefined &&
          status !== "updated" &&
          status !== "changed" &&
          status !== "connection" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void undo(settings.versionId!, settings.revision!)}
            >
              <Trans>Undo</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {status ? (
        <p role="status" className="text-sm">
          {status === "updated"
            ? t`Change undone`
            : status === "changed"
              ? t`Settings changed elsewhere.`
              : status === "connection"
                ? t`The previous connection is unavailable.`
                : t`Could not update settings. Try again.`}
        </p>
      ) : null}
      {history ? (
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">
            <Trans>Current settings</Trans>
          </h3>
          {history.current.map(({ field, after, source }) =>
            field === "instructions" ? (
              <details key={field}>
                <summary className="cursor-pointer">
                  {labels[field]} · {sources[source]}
                </summary>
                <p className="max-h-44 overflow-auto whitespace-pre-wrap break-words" dir="auto">
                  {after || "—"}
                </p>
              </details>
            ) : (
              <p key={field}>
                {labels[field]} · <bdi>{after}</bdi>{" "}
                <span className="text-muted-foreground">· {sources[source]}</span>
              </p>
            ),
          )}
          {history.versions.length ? (
            <details>
              <summary className="cursor-pointer">
                <Trans>Settings history</Trans>
              </summary>
              {history.versions.map((version) => (
                <div className="mt-2 space-y-1 border-t border-border pt-2" key={version.id}>
                  <time dateTime={version.createdAt}>
                    {new Date(version.createdAt).toLocaleString()}
                  </time>
                  {version.changes.map((change) => (
                    <SettingsChange key={change.field} change={change} />
                  ))}
                  {version.canUndo ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => void undo(version.id, history.revision)}
                    >
                      <Trans>Undo</Trans>
                    </Button>
                  ) : null}
                </div>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
