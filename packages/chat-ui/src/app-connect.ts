import type { Connection, MessageBlock } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type AppConnectBlock = Extract<MessageBlock, { kind: "app_connect" }>;
type Card = { botId: string; messageId: string };
type App = Pick<AppConnectBlock, "connectorId" | "provider">;
type Grant = { connectionId: string; authorizationUrl: string | null };
type ConnectError = { kind: "authorization" | "pending" } | { kind: "request"; cause: unknown };
type LaunchResult = "opened" | "activation-required" | "failed";

export type AppConnectClient = {
  readback(
    card: Card & App,
    signal: AbortSignal,
  ): Promise<{
    connected: boolean;
    pendingConnectionId: string | null;
  }>;
  begin(
    app: App & { displayName: string; reuseAppGrant: true },
    signal: AbortSignal,
  ): Promise<Grant>;
  complete(
    input: { connectionId: string; card: Card },
    signal: AbortSignal,
  ): Promise<Pick<Connection, "status">>;
  openAuthorization(url: string, afterRequest: boolean): LaunchResult | Promise<LaunchResult>;
};

export function useAppConnectCard(
  {
    botId,
    messageId,
    block,
    readOnly = false,
  }: Card & { block: AppConnectBlock; readOnly?: boolean },
  client: AppConnectClient,
) {
  const { connectorId, provider, name, status: savedStatus } = block;
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState(savedStatus);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [error, setError] = useState<ConnectError | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const authorizationGeneration = useRef(0);
  const verifyBeforeReopen = useRef(false);
  const cardConnected = useRef(savedStatus === "connected");
  const status = savedStatus === "connected" ? "connected" : localStatus;

  useLayoutEffect(() => {
    cardConnected.current = savedStatus === "connected";
  }, [savedStatus]);
  useEffect(() => () => connectionAttempt.current?.abort(), []);
  useEffect(() => {
    if (readOnly || savedStatus === "connected" || connectionAttempt.current) return;
    const controller = new AbortController();
    const generation = authorizationGeneration.current;
    void client
      .readback({ botId, messageId, connectorId, provider }, controller.signal)
      .then(({ connected, pendingConnectionId }) => {
        // This read can finish after a failed launch has already saved a grant.
        if (controller.signal.aborted || generation !== authorizationGeneration.current) return;
        if (connected) setLocalStatus("connected");
        setGrant(
          pendingConnectionId
            ? { connectionId: pendingConnectionId, authorizationUrl: null }
            : null,
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [readOnly, savedStatus, client, botId, messageId, connectorId, provider]);

  function markConnected() {
    setGrant(null);
    setError(null);
    setLocalStatus("connected");
  }

  function prepareToManage() {
    verifyBeforeReopen.current = Boolean(grant?.authorizationUrl);
  }

  async function authorize(onConnected?: () => void) {
    if (readOnly || connectorId === "native") return;
    authorizationGeneration.current += 1;
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const grantToRecheck = verifyBeforeReopen.current && grant?.authorizationUrl ? grant : null;
      if (grantToRecheck) {
        const { connected, pendingConnectionId } = await client.readback(
          { botId, messageId, connectorId, provider },
          signal,
        );
        if (signal.aborted) return;
        verifyBeforeReopen.current = false;
        if (connected) {
          markConnected();
          onConnected?.();
          return;
        }
        if (pendingConnectionId !== grantToRecheck.connectionId) {
          setGrant(
            pendingConnectionId
              ? { connectionId: pendingConnectionId, authorizationUrl: null }
              : null,
          );
          return;
        }
      }
      const started =
        grant ??
        (await client.begin(
          { connectorId, provider, displayName: name, reuseAppGrant: true },
          signal,
        ));
      // A saved update can make a delayed pending response obsolete before the launch.
      if (signal.aborted || cardConnected.current) return;
      setGrant({ connectionId: started.connectionId, authorizationUrl: null });
      if (started.authorizationUrl) {
        let launch: LaunchResult = "failed";
        try {
          launch = await client.openAuthorization(
            started.authorizationUrl,
            !grant || grantToRecheck !== null,
          );
        } catch {
          // Retain the link in memory so a second explicit attempt can reopen it.
        }
        if (signal.aborted) return;
        if (launch !== "opened") {
          setGrant(started);
          if (launch === "failed") setError({ kind: "authorization" });
          return;
        }
      }
      const checks = started.authorizationUrl ? 60 : 1;
      for (let attempt = 0; attempt < checks; attempt += 1) {
        if (signal.aborted) return;
        const row = await client
          .complete({ connectionId: started.connectionId, card: { botId, messageId } }, signal)
          .catch(() => undefined);
        if (signal.aborted) return;
        if (row?.status === "connected") {
          markConnected();
          onConnected?.();
          return;
        }
        if (row?.status === "revoked" || row?.status === "error") {
          setGrant(null);
          setError({ kind: "authorization" });
          return;
        }
        if (attempt + 1 < checks) await abortableDelay(2_000, signal);
      }
      if (!signal.aborted) setError({ kind: "pending" });
    } catch (cause) {
      if (!signal.aborted) setError({ kind: "request", cause });
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }

  const pending = status === "pending";
  return {
    status,
    busy: pending && busy,
    error: pending ? error : null,
    readyToOpen: pending && Boolean(grant?.authorizationUrl) && !error,
    checkOnly: pending && Boolean(grant && !grant.authorizationUrl),
    needsAttention: pending && Boolean(grant && error),
    authorize,
    markConnected,
    prepareToManage,
  };
}
