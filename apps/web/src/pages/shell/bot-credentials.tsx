import { Trans, useLingui } from "@lingui/react/macro";
import type {
  BotSecretMetadata,
  NamedLoginSecretValue,
  RevealedBotCredential,
  SpaceBotCredentials,
} from "@rakazo/contracts";
import {
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
  encodeLoginSecret,
  isIdentityConfirmationRequired,
  LOGIN_FIELD_LIMIT,
  LOGIN_VALUE_TOO_LONG,
  NamedLoginSecretValue as LoginFieldsSchema,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmIdentityDialog } from "../../components/ConfirmIdentityDialog";
import { rpc } from "../../lib/rpc";
import { useSpaceRpc, useSpaceRpcCurrent } from "../../lib/space-rpc";
import { errorCode, errorText } from "../../lib/user-error";

type ReadableCredentialAuth = NonNullable<BotSecretMetadata["auth"]>;
type CredentialAuthType = ReadableCredentialAuth["type"];
type CredentialRow = BotSecretMetadata & { botId: string; botName?: string };
type EditorProps =
  | { botId: string; defaultBotId?: never }
  | { botId?: never; defaultBotId?: string };

function credentialKey(credential: CredentialRow) {
  return JSON.stringify([credential.botId, credential.name]);
}

function byDestination(left: CredentialRow, right: CredentialRow) {
  return (left.origin || left.name).localeCompare(right.origin || right.name);
}

const fieldLabelClass = "mt-3 block text-[13px] text-muted-foreground";

/** The stored value: a website login is saved as one encoded username and password pair. */
function credentialPlaintext(type: CredentialAuthType, username: string, value: string) {
  return type === "login" ? encodeLoginSecret({ username, password: value }) : value;
}

/** A command variable has no site, so its destination carries no origin. */
function credentialDestination(name: string, origin: string, auth: ReadableCredentialAuth) {
  return auth.type === "command" ? { name, auth } : { name, origin, auth };
}

async function readCredentials(botId: string) {
  try {
    return { rows: await rpc.botSecrets.listForEdit({ botId }), editable: true };
  } catch (error) {
    if (errorCode(error) !== "NOT_FOUND") throw error;
    return { rows: await rpc.botSecrets.list({ botId }), editable: false };
  }
}

export function BotCredentialsSection({ botId, defaultBotId }: EditorProps) {
  const { t } = useLingui();
  const ids = useId();
  const spaceView = botId === undefined;
  const spaceRpc = useSpaceRpc();
  const scopeCurrent = useSpaceRpcCurrent();
  const client = spaceView ? spaceRpc : rpc;
  const [secrets, setSecrets] = useState<CredentialRow[] | null>(null);
  const [bots, setBots] = useState<SpaceBotCredentials[]>([]);
  const [addBot, setAddBot] = useState("");
  const [fields, setFields] = useState<NamedLoginSecretValue["fields"]>([]);
  const [challenge, setChallenge] = useState<CredentialRow | null>(null);
  const [shown, setShown] = useState<{
    row: CredentialRow;
    credential: RevealedBotCredential;
  } | null>(null);
  const revealAttempt = useRef(0);
  const revealTimer = useRef<number | undefined>(undefined);
  const [editable, setEditable] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [authType, setAuthType] = useState<CredentialAuthType>("bearer");
  const [headerName, setHeaderName] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  // Protected fields: held only in component state and cleared on every submit or cancel.
  const [loginUsername, setLoginUsername] = useState("");
  const [value, setValue] = useState("");

  const load = useCallback(async () => {
    if (!spaceView) {
      const { rows, editable } = await readCredentials(botId);
      return { rows: rows.map((row) => ({ ...row, botId })), editable, bots: [] };
    }
    const groups = await client.botSecrets.listForSpace({});
    return {
      rows: groups
        .flatMap(({ botId, botName, credentials }) =>
          credentials.map((row) => ({ ...row, botId, botName })),
        )
        .sort((left, right) =>
          (left.origin || left.name).localeCompare(right.origin || right.name),
        ),
      editable: true,
      bots: groups,
    };
  }, [spaceView, botId, client]);

  function receive(latest: Awaited<ReturnType<typeof load>>) {
    setSecrets(latest.rows);
    setBots(latest.bots);
    setEditable(latest.editable);
    setLoadFailed(false);
  }

  useEffect(() => {
    let active = true;
    void load()
      .then((latest) => {
        if (active && scopeCurrent()) receive(latest);
      })
      .catch(() => {
        if (active && scopeCurrent()) setLoadFailed(true);
      });
    return () => {
      active = false;
      revealAttempt.current++;
      window.clearTimeout(revealTimer.current);
    };
  }, [load, scopeCurrent]);

  async function refresh() {
    try {
      const latest = await load();
      if (!scopeCurrent()) return false;
      receive(latest);
      return true;
    } catch {
      if (scopeCurrent()) setLoadFailed(true);
      return false;
    }
  }

  const hide = useCallback(() => {
    revealAttempt.current++;
    window.clearTimeout(revealTimer.current);
    setChallenge(null);
    setShown(null);
  }, []);

  useEffect(() => {
    if (!spaceView) return;
    const hideWhenHidden = () => {
      if (document.hidden) hide();
    };
    document.addEventListener("visibilitychange", hideWhenHidden);
    return () => document.removeEventListener("visibilitychange", hideWhenHidden);
  }, [hide, spaceView]);

  function clearProtectedFields() {
    setValue("");
    setLoginUsername("");
    setFields([]);
    hide();
  }

  async function reveal(row: CredentialRow, afterConfirmation = false) {
    if (!row.revision || busy || !scopeCurrent()) return;
    clearProtectedFields();
    setAdding(false);
    setReplacing(null);
    setConfirmingRemove(null);
    setError(null);
    const attempt = revealAttempt.current;
    const current = () => scopeCurrent() && revealAttempt.current === attempt;
    try {
      const credential = await client.botSecrets.reveal({
        botId: row.botId,
        name: row.name,
        expectedRevision: row.revision,
      });
      if (!current()) return;
      setShown({ row, credential });
      revealTimer.current = window.setTimeout(hide, 30_000);
    } catch (cause) {
      if (!current()) return;
      if (!afterConfirmation && isIdentityConfirmationRequired(cause)) setChallenge(row);
      else setError(t`Could not show the credential`);
    }
  }

  async function beginReplace(row: CredentialRow) {
    clearProtectedFields();
    setConfirmingRemove(null);
    setAdding(false);
    setError(null);
    if (spaceView && row.auth?.type === "login" && row.revision) {
      setBusy(true);
      try {
        const layout = await client.botSecrets.loginFieldsForEdit({
          botId: row.botId,
          name: row.name,
          expectedRevision: row.revision,
        });
        if (!scopeCurrent()) return;
        setFields(layout.map((field) => ({ ...field, value: "" })));
      } catch {
        if (scopeCurrent()) setError(t`Could not load credentials.`);
        return;
      } finally {
        if (scopeCurrent()) setBusy(false);
      }
    }
    if (scopeCurrent()) setReplacing(credentialKey(row));
  }

  function authLabel(auth: ReadableCredentialAuth) {
    if (auth.type === "header") {
      const header = auth.name;
      return t`Header "${header}"`;
    }
    if (auth.type === "basic") {
      const username = auth.username;
      return t`Basic auth (${username})`;
    }
    if (auth.type === "login") return t`Website login`;
    if (auth.type === "command") return t`Command variable`;
    return t`Bearer token`;
  }

  function newAuth(): ReadableCredentialAuth {
    if (authType === "header") return { type: "header", name: headerName.trim() };
    if (authType === "basic") return { type: "basic", username: basicUsername.trim() };
    if (authType === "login") return { type: "login" };
    if (authType === "command") return { type: "command" };
    return { type: "bearer" };
  }

  async function save(
    targetBotId: string,
    destination: { name: string; origin?: string; auth: ReadableCredentialAuth },
    expectedRevision: string | null,
  ) {
    if (!scopeCurrent()) return false;
    const username = loginUsername.trim();
    const secretValue = value;
    const loginFields = fields;
    clearProtectedFields();
    if (spaceView) setFields(loginFields.map((field) => ({ ...field, value: "" })));
    setError(null);
    let plaintext: string;
    try {
      plaintext =
        spaceView && destination.auth.type === "login"
          ? encodeLoginSecret({ fields: loginFields })
          : credentialPlaintext(destination.auth.type, username, secretValue);
    } catch {
      setError(t`Enter a username and password`);
      return false;
    }
    setBusy(true);
    try {
      const saved = await client.botSecrets.putForEdit({
        botId: targetBotId,
        destination,
        value: plaintext,
        expectedRevision,
      });
      if (!scopeCurrent()) return false;
      if (await refresh()) return true;
      if (!spaceView || !scopeCurrent()) {
        setError(t`Could not load credentials.`);
        return false;
      }
      const botName = bots.find((entry) => entry.botId === targetBotId)?.botName;
      const row = { ...saved, botId: targetBotId, botName };
      setSecrets((current) =>
        [
          ...(current ?? []).filter((entry) => credentialKey(entry) !== credentialKey(row)),
          row,
        ].sort(byDestination),
      );
      return true;
    } catch (err) {
      if (!scopeCurrent()) return false;
      setError(errorText(err, t`Could not save the credential`));
      const code = errorCode(err);
      if (code === "CONFLICT" || code === "NOT_FOUND") {
        setReplacing(null);
        if (!(await refresh())) setEditable(false);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitAdd() {
    if (busy || !canAdd || !targetBot) return;
    const saved = await save(
      targetBot,
      credentialDestination(name.trim(), origin.trim(), newAuth()),
      null,
    );
    if (!saved) return;
    setAdding(false);
    setName("");
    setOrigin("");
    setAuthType("bearer");
    setHeaderName("");
    setBasicUsername("");
  }

  async function submitReplace(secret: CredentialRow) {
    if (busy || !editable || !secret.auth || !secret.revision || (!spaceView && secret.namedLogin))
      return;
    const saved = await save(
      secret.botId,
      credentialDestination(secret.name, secret.origin, secret.auth),
      secret.revision,
    );
    if (saved) setReplacing(null);
  }

  async function confirmRemove(secret: CredentialRow) {
    if (busy || !editable || !secret.revision || !scopeCurrent()) return;
    setError(null);
    setBusy(true);
    try {
      await client.botSecrets.removeForEdit({
        botId: secret.botId,
        name: secret.name,
        expectedRevision: secret.revision,
      });
      if (!scopeCurrent()) return;
      setConfirmingRemove(null);
      if (!(await refresh())) {
        setSecrets(
          (prev) => prev?.filter((row) => credentialKey(row) !== credentialKey(secret)) ?? null,
        );
        setError(t`Could not load credentials.`);
      }
    } catch (err) {
      if (!scopeCurrent()) return;
      setError(errorText(err, t`Could not remove the credential`));
      const code = errorCode(err);
      if (code === "CONFLICT" || code === "NOT_FOUND") {
        setConfirmingRemove(null);
        if (!(await refresh())) setEditable(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const login = LoginFieldsSchema.safeParse({ fields });
  const tooLong =
    !login.success && login.error.issues.some((issue) => issue.message === LOGIN_VALUE_TOO_LONG);

  const loginFields = (type: CredentialAuthType, testIdPrefix: string) =>
    spaceView && type === "login" ? (
      <div className="mt-3 space-y-2">
        {fields.map((field, index) => {
          const change = (next: Partial<typeof field>) =>
            setFields((old) =>
              old.map((entry, i) => (i === index ? { ...entry, ...next } : entry)),
            );
          return (
            <fieldset className="space-y-2 rounded-md border border-border p-2" key={index}>
              <Input
                aria-label={t`Field label`}
                value={field.label}
                maxLength={64}
                onChange={(event) => change({ label: event.target.value })}
              />
              <Input
                aria-label={field.label || t`Value`}
                value={field.value}
                maxLength={4096}
                type={field.hidden ? "password" : "text"}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => change({ value: event.target.value })}
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.hidden}
                    onChange={(event) => change({ hidden: event.target.checked })}
                  />
                  <Trans>Hide value</Trans>
                </label>
                {fields.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setFields((old) => old.filter((_, i) => i !== index))}
                  >
                    <Trans>Remove field</Trans>
                  </Button>
                ) : null}
              </div>
            </fieldset>
          );
        })}
        {tooLong ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>These login values are too long together. Shorten one or more fields.</Trans>
          </p>
        ) : null}
        {fields.length < LOGIN_FIELD_LIMIT ? (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setFields((old) => [...old, { label: "", value: "", hidden: true }])}
          >
            <Trans>Add field</Trans>
          </Button>
        ) : null}
      </div>
    ) : (
      <>
        {type === "login" ? (
          <label htmlFor={`${ids}-${testIdPrefix}-username`} className={fieldLabelClass}>
            <Trans>Username</Trans>
            <Input
              id={`${ids}-${testIdPrefix}-username`}
              data-testid={`${testIdPrefix}-username`}
              // "off" is ignored for username fields; this stops browsers saving the pair.
              autoComplete="new-password"
              spellCheck={false}
              value={loginUsername}
              onChange={(event) => setLoginUsername(event.target.value)}
              className="mt-1.5"
            />
          </label>
        ) : null}
        <label htmlFor={`${ids}-${testIdPrefix}-value`} className={fieldLabelClass}>
          {type === "login" ? <Trans>Password</Trans> : <Trans>Value</Trans>}
          <Input
            id={`${ids}-${testIdPrefix}-value`}
            data-testid={`${testIdPrefix}-value`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="mt-1.5"
          />
        </label>
      </>
    );

  const valueReady = (type: CredentialAuthType) =>
    spaceView && type === "login"
      ? login.success
      : value.length > 0 && (type !== "login" || loginUsername.trim().length > 0);

  const targetBot =
    botId ??
    (addBot ||
      (bots.some((bot) => bot.botId === defaultBotId)
        ? defaultBotId
        : bots.length === 1
          ? bots[0]?.botId
          : undefined));

  const nameValid = BotSecretName.safeParse(name.trim()).success;
  // Shown live while a command variable is named, so a reserved name is caught before saving.
  const commandVariable =
    authType === "command" && nameValid ? `$${commandVariableName(name.trim())}` : null;
  const commandVariableError =
    commandVariable && commandVariableProblem(commandVariable.slice(1))
      ? t`${commandVariable} is reserved and cannot be used as a command variable. Choose another name.`
      : null;

  const canAdd =
    editable &&
    !busy &&
    !!targetBot &&
    nameValid &&
    (authType === "command" ? !commandVariableError : origin.trim().length > 0) &&
    (authType !== "header" || headerName.trim().length > 0) &&
    (authType !== "basic" || basicUsername.trim().length > 0) &&
    valueReady(authType);

  return (
    <section
      data-testid={spaceView ? "space-credentials" : "bot-credentials"}
      className={spaceView ? undefined : "mt-5 border-t border-border/20 pt-4"}
    >
      {spaceView ? null : (
        <div className="text-[13.5px] font-medium text-foreground">
          <Trans>Credentials</Trans>
        </div>
      )}
      {loadFailed ? (
        <div className="space-y-2">
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            <Trans>Could not load credentials.</Trans>
          </p>
          {spaceView ? (
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <Trans>Retry</Trans>
            </Button>
          ) : null}
        </div>
      ) : secrets === null && spaceView ? (
        <p>
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {secrets && !editable && !loadFailed ? (
        <p className="mt-3 text-[13px] text-muted-foreground">
          <Trans>Credential changes are unavailable on this server.</Trans>
        </p>
      ) : null}
      {secrets && secrets.length === 0 ? (
        <p data-testid="bot-credentials-empty" className="mt-3 text-[13px] text-muted-foreground">
          {spaceView ? (
            <Trans>No credentials saved in this Space.</Trans>
          ) : (
            <Trans>No credentials saved for this bot.</Trans>
          )}
        </p>
      ) : null}
      {secrets?.length ? (
        <ul className="mt-3 space-y-2">
          {secrets.map((secret) => {
            const secretName = secret.name;
            const key = credentialKey(secret);
            const updated = new Date(secret.updatedAt).toLocaleDateString();
            // A readable auth on a name outside the current pattern cannot be replaced:
            // only the loose remove input accepts it, so show the unreadable row instead.
            const readableAuth =
              secret.auth !== null && BotSecretName.safeParse(secret.name).success
                ? secret.auth
                : null;
            const canReplace = editable && (spaceView || !secret.namedLogin) ? readableAuth : null;
            return (
              <li
                key={key}
                data-testid="bot-credential-row"
                className="rounded-lg border border-border/40 px-3 py-2.5"
              >
                <div className="truncate text-[13.5px] font-medium text-foreground">
                  {spaceView && secret.origin ? secret.origin : secret.name}
                </div>
                {spaceView && secret.botName ? (
                  <div className="break-all text-[12.5px] text-muted-foreground">
                    {secret.origin ? `${secret.name} · ` : ""}
                    {secret.botName}
                  </div>
                ) : secret.origin ? (
                  <div className="break-all text-[12.5px] text-muted-foreground">
                    {secret.origin}
                  </div>
                ) : null}
                {readableAuth === null ? (
                  <div className="text-[12px] text-destructive">
                    <Trans>These saved settings can't be read. Remove it and add it again.</Trans> ·{" "}
                    {t`Updated ${updated}`}
                  </div>
                ) : (
                  <div className="text-[12px] text-muted-foreground/70">
                    {authLabel(readableAuth)}
                    {readableAuth.type === "command"
                      ? ` · $${commandVariableName(secret.name)}`
                      : null}{" "}
                    · {t`Updated ${updated}`}
                  </div>
                )}
                {secret.namedLogin && !spaceView ? (
                  <div className="text-[12px] text-muted-foreground">
                    <Trans>This form can't edit named fields.</Trans>
                  </div>
                ) : null}
                {canReplace !== null && replacing === key ? (
                  <form
                    className="mt-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitReplace(secret);
                    }}
                  >
                    {loginFields(canReplace.type, "credential-replace")}
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        data-testid="credential-replace-save"
                        disabled={busy || !valueReady(canReplace.type)}
                      >
                        <Trans>Save new value</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          clearProtectedFields();
                          setReplacing(null);
                        }}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </form>
                ) : editable && confirmingRemove === key ? (
                  <div className="mt-2">
                    <p className="text-[13px] text-foreground">
                      <Trans>Remove {secretName}? This bot will no longer be able to use it.</Trans>
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        data-testid={`credential-remove-confirm-${secret.name}`}
                        disabled={busy}
                        onClick={() => void confirmRemove(secret)}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingRemove(null)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    </div>
                  </div>
                ) : editable ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {spaceView && readableAuth ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void reveal(secret)}
                      >
                        <Trans>Show value</Trans>
                      </Button>
                    ) : null}
                    {canReplace !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="-ms-2.5"
                        data-testid={`credential-replace-${secret.name}`}
                        disabled={busy}
                        onClick={() => void beginReplace(secret)}
                      >
                        <Trans>Replace value</Trans>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      data-testid={`credential-remove-${secret.name}`}
                      disabled={busy}
                      onClick={() => {
                        clearProtectedFields();
                        setReplacing(null);
                        setConfirmingRemove(key);
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {editable && adding ? (
        <form
          data-testid="credential-add-form"
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAdd();
          }}
        >
          {spaceView ? (
            <label htmlFor={`${ids}-bot`} className={fieldLabelClass}>
              <Trans>Bot</Trans>
              <NativeSelect
                id={`${ids}-bot`}
                value={targetBot ?? ""}
                className="mt-1.5 w-full"
                onChange={(event) => {
                  setValue("");
                  setFields((current) => current.map((field) => ({ ...field, value: "" })));
                  setAddBot(event.target.value);
                }}
              >
                <NativeSelectOption value="" disabled>{t`Choose a Bot`}</NativeSelectOption>
                {bots.map((bot) => (
                  <NativeSelectOption key={bot.botId} value={bot.botId}>
                    {bot.botName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          <label htmlFor={`${ids}-name`} className={fieldLabelClass}>
            <Trans>Name</Trans>
            <Input
              id={`${ids}-name`}
              data-testid="credential-name"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="github"
              className="mt-1.5"
            />
            <span className="mt-1 block text-[12px] text-muted-foreground/70">
              <Trans>
                Lowercase letters, numbers, hyphens and underscores, starting with a letter.
              </Trans>
            </span>
            {commandVariableError ? (
              <span
                data-testid="credential-command-variable-error"
                className="mt-1 block text-[12px] text-destructive"
              >
                {commandVariableError}
              </span>
            ) : commandVariable ? (
              <span
                data-testid="credential-command-variable"
                className="mt-1 block text-[12px] text-muted-foreground"
              >
                {t`Available to this bot's shell commands as ${commandVariable}`}
              </span>
            ) : null}
          </label>
          {authType === "command" ? null : (
            <label htmlFor={`${ids}-origin`} className={fieldLabelClass}>
              <Trans>Site</Trans>
              <Input
                id={`${ids}-origin`}
                data-testid="credential-origin"
                autoComplete="off"
                spellCheck={false}
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder="https://api.example.com"
                className="mt-1.5"
              />
            </label>
          )}
          <label htmlFor={`${ids}-auth`} className={fieldLabelClass}>
            <Trans>Type</Trans>
            <NativeSelect
              id={`${ids}-auth`}
              data-testid="credential-auth-type"
              className="mt-1.5 w-full"
              value={authType}
              onChange={(event) => {
                const type = event.target.value as CredentialAuthType;
                if (spaceView) clearProtectedFields();
                setAuthType(type);
                if (spaceView && type === "login")
                  setFields([
                    { label: t`Username`, value: "", hidden: false },
                    { label: t`Password`, value: "", hidden: true },
                  ]);
              }}
            >
              <NativeSelectOption value="bearer">{t`Bearer token`}</NativeSelectOption>
              <NativeSelectOption value="header">{t`Custom header`}</NativeSelectOption>
              <NativeSelectOption value="basic">{t`Basic auth`}</NativeSelectOption>
              <NativeSelectOption value="login">{t`Website login`}</NativeSelectOption>
              <NativeSelectOption value="command">{t`Command variable`}</NativeSelectOption>
            </NativeSelect>
          </label>
          {authType === "header" ? (
            <label htmlFor={`${ids}-header`} className={fieldLabelClass}>
              <Trans>Header name</Trans>
              <Input
                id={`${ids}-header`}
                data-testid="credential-header-name"
                autoComplete="off"
                spellCheck={false}
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
                placeholder="X-Api-Key"
                className="mt-1.5"
              />
            </label>
          ) : null}
          {authType === "basic" ? (
            <label htmlFor={`${ids}-basic-username`} className={fieldLabelClass}>
              <Trans>Username</Trans>
              <Input
                id={`${ids}-basic-username`}
                data-testid="credential-basic-username"
                autoComplete="off"
                spellCheck={false}
                value={basicUsername}
                onChange={(event) => setBasicUsername(event.target.value)}
                className="mt-1.5"
              />
            </label>
          ) : null}
          {loginFields(authType, "credential")}
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" data-testid="credential-add-save" disabled={!canAdd}>
              {busy ? <Trans>Saving…</Trans> : <Trans>Save credential</Trans>}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                clearProtectedFields();
                setAdding(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : editable && (!spaceView || bots.length > 0) ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          data-testid="credential-add"
          onClick={() => {
            clearProtectedFields();
            setReplacing(null);
            setConfirmingRemove(null);
            setAdding(true);
            if (spaceView && authType === "login")
              setFields([
                { label: t`Username`, value: "", hidden: false },
                { label: t`Password`, value: "", hidden: true },
              ]);
          }}
        >
          <Trans>Add credential</Trans>
        </Button>
      ) : null}
      {challenge ? (
        <ConfirmIdentityDialog
          open
          onDone={(confirmed) => {
            if (confirmed) void reveal(challenge, true);
            else hide();
          }}
        />
      ) : null}
      {shown ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) hide();
          }}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogTitle>{shown.row.origin || shown.row.name}</DialogTitle>
            <p className="text-sm text-muted-foreground">{shown.row.botName}</p>
            <dl className="max-h-64 space-y-2 overflow-auto">
              {("value" in shown.credential
                ? [{ label: t`Value`, value: shown.credential.value }]
                : shown.credential.fields
              ).map(({ label, value }) => (
                <div key={label}>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="break-all whitespace-pre-wrap font-mono text-sm select-text">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <Button type="button" variant="outline" onClick={hide}>
              <Trans>Done</Trans>
            </Button>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
