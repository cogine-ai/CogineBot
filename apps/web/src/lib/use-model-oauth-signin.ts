import type { ModelCredential, ModelOAuthBegin, ThinkingLevel } from "@rakazo/contracts";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopBridge, oauthStateOf, onDesktopOAuthCallback } from "./desktop";
import { waitForModelOAuth } from "./model-auth";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, currentSpaceSelectionGeneration, selectedSpaceId } from "./rpc";
import { useBoundSpaceId, useSpaceRpcCurrent } from "./space-rpc";
import { errorText } from "./user-error";

type OAuthRequest = {
  controller: AbortController;
  client: RpcClient;
  loginId: string | null;
  isCurrent: () => boolean;
  cancel: () => void;
};

export type ModelOAuthSignInBegin = {
  provider: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel | null;
  label?: string;
  registrationId?: string;
  newRegistration?: boolean;
};

/**
 * Shared subscription sign-in lifecycle for desktop loopback capture and the
 * paste fallback. Preserves attempt-owned capture unsubscribe and submitting
 * guards so cancel-and-retry cannot drop a newer callback.
 */
export function useModelOAuthSignIn(options: {
  onFinished: (controller: AbortController, credential: ModelCredential) => void | Promise<void>;
  onError: (message: string) => void;
  onClearError?: () => void;
}) {
  const { onFinished, onError, onClearError } = options;
  const boundSpaceId = useBoundSpaceId();
  const contextCurrent = useSpaceRpcCurrent();
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPending, setOauthPending] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthRequestRef = useRef<OAuthRequest | null>(null);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const oauthCodeSubmittingRef = useRef(false);
  const oauthCaptureRef = useRef<(() => void) | null>(null);
  const onFinishedRef = useRef(onFinished);
  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  onFinishedRef.current = onFinished;
  onErrorRef.current = onError;
  onClearErrorRef.current = onClearError;

  function releaseOAuthCapture(expected?: (() => void) | null) {
    if (expected !== undefined && oauthCaptureRef.current !== expected) return;
    oauthCaptureRef.current?.();
    oauthCaptureRef.current = null;
  }

  function cancelOAuthAttempt(resetState = true) {
    releaseOAuthCapture();
    oauthCodeSubmittingRef.current = false;
    const request = oauthRequestRef.current;
    oauthRequestRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      if (resetState) {
        setOauth(null);
        setOauthPending(false);
        setPopupBlocked(false);
      }
    });
    request?.cancel();
  }

  async function finishSubscriptionSignIn(loginId: string, request: OAuthRequest) {
    const { controller, client } = request;
    await waitForModelOAuth(loginId, controller.signal, client);
    if (!request.isCurrent()) return;
    const credential = await client.models.finishOAuth({ loginId }, { signal: controller.signal });
    if (!request.isCurrent()) return;
    request.loginId = null;
    setOauth(null);
    // Keep post-connect UI work outside the OAuth try/catch so a refresh failure
    // is not reported as a failed sign-in (finishOAuth already persisted).
    try {
      await onFinishedRef.current(controller, credential);
    } catch (err) {
      if (!request.isCurrent()) return;
      onErrorRef.current(errorText(err, "Connected, but could not refresh"));
    }
  }

  async function submitOAuthCode(captured?: string, login?: ModelOAuthBegin) {
    const attempt = login ?? oauth;
    const request = oauthRequestRef.current;
    if (
      !request?.isCurrent() ||
      attempt?.mode !== "auth-url" ||
      attempt.loginId !== request.loginId ||
      oauthCodeSubmittingRef.current
    )
      return;
    const { controller, client } = request;
    const capture = oauthCaptureRef.current;
    const code = (captured ?? pasteCode).trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setPasteCode("");
    onClearErrorRef.current?.();
    let submitted = false;
    let retryable = false;
    try {
      await client.models.submitOAuthCode(
        { loginId: attempt.loginId, code },
        { signal: controller.signal },
      );
      submitted = true;
      await finishSubscriptionSignIn(attempt.loginId, request);
    } catch (err) {
      if (!request.isCurrent()) return;
      if (submitted) {
        setOauth(null);
        request.cancel();
      } else {
        retryable = true;
        setPasteCode(code);
      }
      onErrorRef.current(errorText(err, "Could not finish sign-in"));
    } finally {
      // A cancelled attempt may already have started another sign-in; do not clear
      // its submitting guard or the newer desktop callback is dropped.
      if (request.isCurrent() && oauthAbortRef.current === controller) {
        oauthCodeSubmittingRef.current = false;
      }
      if (!retryable) {
        // Only drop this attempt's listener — a newer sign-in may already own the ref.
        releaseOAuthCapture(capture);
        finishModelOAuthAttempt(oauthAbortRef, controller, () => {
          if (request.isCurrent()) setOauthPending(false);
        });
      }
    }
  }

  async function startSubscriptionSignIn(begin: ModelOAuthSignInBegin) {
    if (!mountedRef.current || !contextCurrent()) return;
    cancelOAuthAttempt(false);
    onClearErrorRef.current?.();
    setOauthPending(true);
    setPopupBlocked(false);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    const originSpaceId = selectedSpaceId();
    const originGeneration = currentSpaceSelectionGeneration();
    const target = boundSpaceId ?? originSpaceId;
    // Cleanup is restricted to the server login returned to this attempt. It
    // remains usable after the UI is revoked and never carries an aborted signal.
    const cleanupClient = createSpaceRpc(target);
    const request: OAuthRequest = {
      controller,
      client: createSpaceRpc(target, () => request.isCurrent()),
      loginId: null,
      isCurrent: () =>
        mountedRef.current &&
        oauthRequestRef.current === request &&
        !controller.signal.aborted &&
        contextCurrent() &&
        originSpaceId === selectedSpaceId() &&
        originGeneration === currentSpaceSelectionGeneration(),
      cancel: () => {
        const loginId = request.loginId;
        request.loginId = null;
        if (loginId)
          void Promise.resolve()
            .then(() => cleanupClient.models.cancelOAuth({ loginId }))
            .catch(() => undefined);
      },
    };
    oauthRequestRef.current = request;
    let waitingForCode = false;
    try {
      const browserAuth = desktopBridge()?.oauth;
      if (
        begin.provider === "chatgpt-plan" &&
        desktopBridge() &&
        (!browserAuth?.fullCallback || !browserAuth.open)
      ) {
        throw new Error("Update the desktop app to connect a ChatGPT plan.");
      }
      const started = await request.client.models.beginOAuth(
        {
          provider: begin.provider,
          modelId: begin.modelId,
          thinkingLevel: begin.thinkingLevel,
          label: begin.label,
          ...(begin.provider === "chatgpt-plan"
            ? {
                callbackTransport:
                  browserAuth?.fullCallback && browserAuth.open
                    ? ("desktop" as const)
                    : ("loopback" as const),
                registrationId: begin.registrationId,
                newRegistration: begin.newRegistration,
              }
            : {}),
        },
        { signal: controller.signal },
      );
      request.loginId = started.loginId;
      if (!request.isCurrent()) {
        request.cancel();
        return;
      }
      setPasteCode("");
      setOauth(started);
      if (started.mode === "auth-url" && started.callbackTransport !== "loopback") {
        // Subscribe before the popup exists: a provider that is already
        // authorized can redirect before React commits the state above.
        releaseOAuthCapture();
        oauthCaptureRef.current = onDesktopOAuthCallback(
          (code) => void submitOAuthCode(code, started),
          oauthStateOf(started.verificationUri),
        );
      }
      if (
        browserAuth?.open &&
        !(started.mode === "auth-url" && started.callbackTransport === "loopback")
      ) {
        const cancelBrowser = () =>
          void browserAuth.cancel?.(started.verificationUri).catch(() => undefined);
        controller.signal.addEventListener("abort", cancelBrowser, { once: true });
        const releaseCapture = oauthCaptureRef.current;
        oauthCaptureRef.current = () => {
          releaseCapture?.();
          controller.signal.removeEventListener("abort", cancelBrowser);
          cancelBrowser();
        };
        await browserAuth.open(started.verificationUri);
        if (!request.isCurrent()) return;
      } else {
        // null means the browser blocked the popup — the card keeps showing the
        // URL, and callers can flag that nothing opened.
        if (!window.open(started.verificationUri, "rakazo-model-oauth", "noopener,noreferrer")) {
          setPopupBlocked(true);
        }
      }
      waitingForCode = started.mode === "auth-url" && started.callbackTransport !== "loopback";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, request);
    } catch (err) {
      if (!request.isCurrent()) return;
      request.cancel();
      onErrorRef.current(errorText(err, "Could not start sign-in"));
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        if (oauthAbortRef.current === controller) releaseOAuthCapture();
        finishModelOAuthAttempt(oauthAbortRef, controller, () => {
          if (request.isCurrent()) setOauthPending(false);
        });
      }
    }
  }

  useEffect(() => () => cancelOAuthAttempt(false), []);

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
