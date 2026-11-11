import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage, WebsiteLoginAnswer } from "@rakazo/contracts";
import { commandVariableName, loginCardFields, NamedLoginSecretValue } from "@rakazo/contracts";
import {
  isApprovalAskBlock,
  isSecretAskBlock,
  selectedAskActionLabel,
  WebsiteLoginAnswerUnconfirmed,
} from "@rakazo/core";
import { Button, Input, Switch } from "@rakazo/ui-web";
import { useState } from "react";
import { errorText } from "../lib/user-error";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
  site?: string,
  approvalScope?: AskBlock["approvalScope"],
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return t`Allow once`;
  if (id === "always") {
    if (approvalScope === "connector_batch") return t`Always allow these actions`;
    return site ? t`Always allow ${site}` : t`Always allow this tool`;
  }
  if (id === "deny") return t`Deny`;
  return fallback;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

function WebsiteLoginForm({
  labels,
  onClose,
  onProvide,
  onUnconfirmed,
}: {
  labels: readonly string[];
  onClose: () => void;
  onProvide: (login: WebsiteLoginAnswer) => Promise<void>;
  onUnconfirmed: (receipt: WebsiteLoginAnswerUnconfirmed) => void;
}) {
  const { t } = useLingui();
  const [fields, setFields] = useState(() => loginCardFields(labels));
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const login = NamedLoginSecretValue.safeParse({ fields });

  async function provide() {
    if (submitting || !login.success) return;
    setSubmitting(true);
    setFailed(false);
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
    try {
      await onProvide({ fields: login.data.fields, remember });
    } catch (error) {
      if (error instanceof WebsiteLoginAnswerUnconfirmed) onUnconfirmed(error);
      else setFailed(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="mt-3.5 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void provide();
      }}
    >
      {fields.map((field, index) => {
        const change = (update: Partial<WebsiteLoginAnswer["fields"][number]>) =>
          setFields((current) =>
            current.map((entry, at) => (at === index ? { ...entry, ...update } : entry)),
          );
        const label = field.label.toLowerCase();
        return (
          <div key={field.label} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="break-all">{field.label}</span>
              <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <span>{field.hidden ? t`Hidden` : t`Visible`}</span>
                <Switch
                  size="sm"
                  aria-label={t`Hide ${field.label}`}
                  checked={field.hidden}
                  disabled={submitting}
                  onCheckedChange={(hidden) => change({ hidden })}
                />
              </div>
            </div>
            <Input
              aria-label={field.label}
              type={field.hidden ? "password" : "text"}
              autoComplete={
                field.hidden && label === "password"
                  ? "current-password"
                  : !field.hidden && label === "username"
                    ? "username"
                    : "off"
              }
              autoCapitalize="none"
              spellCheck={false}
              maxLength={4096}
              disabled={submitting}
              value={field.value}
              onChange={(event) => change({ value: event.target.value })}
            />
          </div>
        );
      })}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch
          size="sm"
          aria-label={t`Save for this Bot`}
          checked={remember}
          disabled={submitting}
          onCheckedChange={setRemember}
        />
        <Trans>Save for this Bot</Trans>
      </div>
      {!remember ? (
        <p className="text-sm text-muted-foreground">
          <Trans>For this task only</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!login.success || submitting}>
          {submitting ? <Trans>Sending…</Trans> : <Trans>Provide information</Trans>}
        </Button>
        <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not submit this answer</Trans>
        </p>
      ) : null}
    </form>
  );
}

export function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string, username?: string, login?: WebsiteLoginAnswer) => Promise<void>;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [loginFormOpen, setLoginFormOpen] = useState(true);
  const [loginProvided, setLoginProvided] = useState(false);
  const [loginUnconfirmed, setLoginUnconfirmed] = useState<WebsiteLoginAnswerUnconfirmed | null>(
    null,
  );
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [answer, setAnswer] = useState("");
  const [username, setUsername] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);
  const loginInput = secretInput && block.credential?.auth.type === "login";
  const namedFields = loginInput ? block.loginFields : undefined;
  const secretLabel = loginInput ? t`Password` : secretFieldLabel(block.purpose);

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitUsername = loginInput ? username.trim() : undefined;
    if (loginInput && !submitUsername) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) {
      setAnswer("");
      setUsername("");
    }
    try {
      await onAnswer(submitValue, submitUsername);
    } catch (err) {
      // A secret answer's failure may echo the secret, so never show its message.
      setError(
        secretInput
          ? t`Could not submit this answer`
          : errorText(err, t`Could not submit this answer`),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div
      data-testid={secretInput ? "secret-ask-card" : undefined}
      className={`rounded-2xl border border-border bg-card px-5 py-4 ${namedFields ? "w-80 max-w-full" : "max-w-[74%]"}`}
    >
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        {namedFields && block.loginBotName ? (
          <div className="mb-1 text-sm font-medium">{block.loginBotName}</div>
        ) : null}
        {block.reviewMode === "screen" || namedFields ? (
          block.text
        ) : (
          <ChatMarkdown>{block.text}</ChatMarkdown>
        )}
      </div>
      {secretInput && block.credential ? (
        <div
          data-testid="secret-ask-destination"
          className="mt-2 break-all text-[13px] text-muted-foreground"
        >
          {block.credential.auth.type === "command"
            ? `${t`Command variable`} · $${commandVariableName(block.credential.name)}`
            : block.credential.origin}
        </div>
      ) : null}
      {block.detail && !secretInput ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {block.detail}
        </pre>
      ) : null}
      {approvalActions && block.approvalDetails ? (
        <details
          data-testid="action-approval-details"
          className="mt-3 text-[13.5px] text-muted-foreground"
          onToggle={(event) => setDetailsExpanded(event.currentTarget.open)}
        >
          <summary className="cursor-pointer focus-visible:outline-ring">
            <Trans>Details</Trans>
          </summary>
          {detailsExpanded ? (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7]">
              {block.approvalDetails}
            </pre>
          ) : null}
        </details>
      ) : null}
      {block.status === "answered" || loginProvided ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-success">
          {namedFields
            ? t`Information provided`
            : formatAnsweredState(
                block.answer,
                Boolean(approvalActions),
                secretInput,
                approvalActions?.find((action) => action.id === block.answer)?.outcome,
                askActions,
              )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : askActions?.length ? (
        <div className="mt-3.5 space-y-1.5">
          {askActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActions && action.id === "allow" ? "default" : "outline"}
              className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : approvalActions ? (
                approvalActionLabel(
                  action.id,
                  action.label,
                  action.outcome,
                  block.site,
                  block.approvalScope,
                )
              ) : (
                action.label
              )}
            </Button>
          ))}
        </div>
      ) : namedFields && loginUnconfirmed ? (
        <div className="mt-3.5 flex flex-col items-start gap-2 text-sm">
          <p role="status">
            <Trans>Could not confirm receipt. Check before entering the information again.</Trans>
          </p>
          <Button
            disabled={submitting}
            onClick={() => {
              setPendingAction("check");
              void loginUnconfirmed
                .check()
                .then((confirmed) => {
                  setLoginProvided(confirmed);
                  setLoginUnconfirmed(null);
                })
                .catch(() => undefined)
                .finally(() => setPendingAction(null));
            }}
          >
            <Trans>Check again</Trans>
          </Button>
        </div>
      ) : namedFields ? (
        loginFormOpen ? (
          <WebsiteLoginForm
            key={block.loginRequestEffectId}
            labels={namedFields}
            onClose={() => setLoginFormOpen(false)}
            onProvide={(login) => onAnswer("", undefined, login)}
            onUnconfirmed={setLoginUnconfirmed}
          />
        ) : (
          <Button className="mt-3.5" onClick={() => setLoginFormOpen(true)}>
            <Trans>Provide information</Trans>
          </Button>
        )
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          {loginInput ? (
            <Input
              aria-label={t`Username`}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t`Username`}
            />
          ) : null}
          <Input
            aria-label={secretLabel}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={secretLabel}
          />
          <Button
            type="submit"
            className="self-start"
            disabled={answer.length === 0 || (loginInput && !username.trim()) || submitting}
          >
            {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </form>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={t`Answer`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!answer.trim() || submitting}>
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
          <Button variant="outline" disabled={submitting} onClick={() => setEditing(true)}>
            <Trans>Edit first</Trans>
          </Button>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
