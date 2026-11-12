import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@rakazo/ui-web";
import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  confirmIdentity,
  fetchAccountSecurity,
  requestIdentityCode,
} from "../lib/account-security";
import { authClient } from "../lib/auth";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText } from "../lib/user-error";

/**
 * Asks the signed-in person to confirm it's them: their password, or for accounts without one,
 * a fresh SSO sign-in or an emailed code. SSO returns to this page, so the action runs again
 * when the person repeats it.
 */
export function ConfirmIdentityDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: (confirmed: boolean) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each opening is its own attempt; a request still running from a dismissed one is ignored.
  const attempt = useRef(0);
  const proofAttempt = useRef(0);
  useLayoutEffect(() => {
    const started = ++attempt.current;
    setPending(false);
    if (!open) return;
    setSecurity(null);
    setPassword("");
    setCode("");
    setSent(false);
    setError(null);
    void fetchAccountSecurity()
      .then((value) => {
        if (attempt.current !== started) return;
        setSecurity(value);
        if (
          !(value.passwordChangeEnabled !== false && (value.hasPassword || value.emailDeletion)) &&
          !(value.sso && value.ssoLinked)
        )
          setError(t`Could not continue`);
      })
      .catch(() => {
        if (attempt.current === started) setError(t`Could not continue`);
      });
    const clearProof = () => {
      proofAttempt.current++;
      setPassword("");
      setCode("");
    };
    const clearWhenHidden = () => {
      if (document.hidden) clearProof();
    };
    window.addEventListener("blur", clearProof);
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => {
      window.removeEventListener("blur", clearProof);
      document.removeEventListener("visibilitychange", clearWhenHidden);
      attempt.current += 1;
    };
  }, [open]);
  /** Runs a request; `then` runs on success only if the same attempt is still open. */
  async function action(run: () => Promise<unknown>, then?: () => void) {
    const started = attempt.current;
    setPending(true);
    setError(null);
    try {
      await run();
      if (attempt.current === started) then?.();
    } catch (cause) {
      if (attempt.current === started)
        setError(cause instanceof Error ? cause.message : t`Could not continue`);
    } finally {
      if (attempt.current === started) setPending(false);
    }
  }
  const passwordEnabled = security?.passwordChangeEnabled !== false && security?.hasPassword;
  const emailEnabled = security?.passwordChangeEnabled !== false && security?.emailDeletion;
  const proof = passwordEnabled ? password : sent ? code.trim() : "";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDone(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Confirm it's you</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!proof || pending) return;
            const input = passwordEnabled ? { password } : { code: proof };
            const submitted = proofAttempt.current;
            setPassword("");
            setCode("");
            void action(
              () => confirmIdentity(input),
              () => onDone(proofAttempt.current === submitted),
            );
          }}
        >
          {passwordEnabled ? (
            <div>
              <Label htmlFor={`${id}-password`}>
                <Trans>Password</Trans>
              </Label>
              <Input
                id={`${id}-password`}
                type="password"
                autoComplete="current-password"
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : security ? (
            <>
              {security.sso && security.ssoLinked ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const result = await runSsoFlow(
                        (disableRedirect, callbackURL) =>
                          authClient.signIn.social({
                            disableRedirect,
                            provider: "oidc",
                            additionalData: { reauthenticate: true },
                            callbackURL: callbackURL(window.location.href),
                            errorCallbackURL: callbackURL(window.location.href),
                          }),
                        [window.location.href],
                      );
                      if (result.error)
                        throw new Error(authErrorText(result.error, t`Could not continue`));
                    })
                  }
                >
                  <Trans>Sign in again</Trans>
                </Button>
              ) : null}
              {emailEnabled && sent ? (
                <div>
                  <Label htmlFor={`${id}-code`}>
                    <Trans>Code</Trans>
                  </Label>
                  <Input
                    id={`${id}-code`}
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              ) : null}
              {/* Stays available after sending, as a code expires and locks after three tries. */}
              {emailEnabled ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    void action(requestIdentityCode, () => {
                      setCode("");
                      setSent(true);
                    })
                  }
                >
                  <Trans>Email me a code</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {passwordEnabled || sent ? (
            <Button type="submit" className="w-full" disabled={pending || !proof}>
              <Trans>Continue</Trans>
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
