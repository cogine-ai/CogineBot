import type {
  BotSettingsHistorySchema,
  UndoBotSettingsInput,
  UndoBotSettingsResult,
} from "@rakazo/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type BotSettingsHistory = ReturnType<typeof BotSettingsHistorySchema.parse>;
type UndoRequest = ReturnType<typeof UndoBotSettingsInput.parse>;
type UndoResult = ReturnType<typeof UndoBotSettingsResult.parse>;

interface SettingsClient<Scope> {
  captureScope(): Scope;
  isScopeCurrent(scope: Scope): boolean;
  scopeKey(): string;
  subscribeScope(callback: () => void): () => void;
  load(botId: string, signal: AbortSignal): Promise<BotSettingsHistory>;
  undo(request: UndoRequest, signal: AbortSignal): Promise<UndoResult>;
}

type CardState = {
  history?: BotSettingsHistory;
  pending?: boolean;
  status?: "updated" | "changed" | "connection" | "failed";
};

export function useBotSettingsCard<Scope>(botId: string, client: SettingsClient<Scope>) {
  const scopeKey = useSyncExternalStore(client.subscribeScope, client.scopeKey, client.scopeKey);
  const [state, setState] = useState<{ key: string; value: CardState }>();
  const key = `${scopeKey}:${botId}`;
  const active = useRef<AbortController | null>(null);
  const nonce = useRef<{ key: string; value: string } | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
      nonce.current = null;
    },
    [key],
  );
  const view = state?.key === key ? state.value : {};

  async function perform(operation: (signal: AbortSignal) => Promise<CardState>) {
    if (active.current) return;
    const scope = client.captureScope();
    const controller = new AbortController();
    active.current = controller;
    setState({ key, value: { ...view, pending: true } });
    try {
      const result = await operation(controller.signal);
      if (!controller.signal.aborted && client.isScopeCurrent(scope))
        setState({ key, value: result });
    } catch {
      if (!controller.signal.aborted && client.isScopeCurrent(scope))
        setState({ key, value: { history: view.history, status: "failed" } });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  function viewSettings() {
    return perform(async (signal) => ({ history: await client.load(botId, signal) }));
  }

  function undo(versionId: string, expectedRevision: number) {
    const requestKey = `${key}:${versionId}:${expectedRevision}`;
    return perform(async (signal) => {
      if (nonce.current?.key !== requestKey)
        nonce.current = {
          key: requestKey,
          value:
            globalThis.crypto?.randomUUID?.() ??
            `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      const result = await client.undo(
        {
          botId,
          versionId,
          expectedRevision,
          clientNonce: nonce.current.value,
        },
        signal,
      );
      if (result.status === "updated") return { status: "updated" };
      return { status: result.reason, history: result.history };
    });
  }

  return { ...view, viewSettings, undo };
}
