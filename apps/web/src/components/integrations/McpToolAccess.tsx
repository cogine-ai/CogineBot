import { Trans, useLingui } from "@lingui/react/macro";
import type { McpServer } from "@rakazo/contracts";
import { Button, Field, FieldGroup, FieldLabel, Switch, Textarea } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export function McpToolAccess({
  server,
  onSaved,
}: {
  server: McpServer;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {server.allowAllTools
            ? t`All tools shared in this space`
            : server.allowedTools.length
              ? t`${server.allowedTools.length} tools shared in this space`
              : t`No tools shared in this space`}
        </span>
        <Button variant="outline" size="sm" onClick={() => setOpen((value) => !value)}>
          <Trans>Tool access</Trans>
        </Button>
      </div>
      {open ? (
        <ToolAccessEditor
          server={server}
          onSaved={async () => {
            await onSaved();
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function ToolAccessEditor({
  server,
  onSaved,
}: {
  server: McpServer;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [revision] = useState(server.revision);
  const [all, setAll] = useState(server.allowAllTools);
  const [names, setNames] = useState(server.allowedTools.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await rpc.mcp.servers.setTools({
        id: server.id,
        revision,
        allowAllTools: all,
        allowedTools: all
          ? []
          : [
              ...new Set(
                names
                  .split(/\r?\n/)
                  .map((name) => name.trim())
                  .filter(Boolean),
              ),
            ],
      });
      await onSaved();
    } catch (reason) {
      setError(errorText(reason, t`Could not save tool access`));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <FieldGroup>
        <Field orientation="horizontal">
          <Switch
            id={`mcp-tools-${server.id}`}
            checked={all}
            disabled={busy}
            onCheckedChange={setAll}
          />
          <FieldLabel htmlFor={`mcp-tools-${server.id}`}>
            <Trans>Share all tools with this space</Trans>
          </FieldLabel>
        </Field>
        {!all ? (
          <Field>
            <FieldLabel htmlFor={`mcp-tool-names-${server.id}`}>
              <Trans>Tool names, one per line</Trans>
            </FieldLabel>
            <Textarea
              id={`mcp-tool-names-${server.id}`}
              value={names}
              disabled={busy}
              onChange={(event) => setNames(event.target.value)}
            />
          </Field>
        ) : null}
      </FieldGroup>
      {revision !== server.revision ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Server changed. Close and reopen tool access to review it.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button disabled={busy || revision !== server.revision} onClick={() => void save()}>
        <Trans>Save tool access</Trans>
      </Button>
    </div>
  );
}
