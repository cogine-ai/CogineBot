import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { captureApiRequestContext, rpc } from "./api";
import { useAppActive } from "./app-active";
import { loadDeviceVoiceEnabled } from "./device-voice";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";
import { deviceSpeechAvailable } from "./voice";

/** Message actions follow the same selected device/provider path as actual speech. */
export function useMessageSpeechAvailable() {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const focused = useIsFocused();
  const active = useAppActive();
  const owner = useMemo(() => ({ scope: captureMobileScope() }), [key, focused, active]);
  const [result, setResult] = useState<{
    owner: typeof owner;
    available: boolean;
    hostedConfigured: boolean;
  } | null>(null);
  useEffect(() => {
    if (!focused || !active) return;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && isMobileScopeCurrent(owner.scope);
    void (async () => {
      try {
        const device = await loadDeviceVoiceEnabled();
        if (!current()) return;
        let available: boolean;
        let hostedConfigured = false;
        if (device) available = await deviceSpeechAvailable();
        else {
          const requestContext = await captureApiRequestContext();
          if (!current()) return;
          const status = await rpc<{ ready: boolean; configured?: boolean }>(
            "voice/status",
            {},
            { requestContext, signal: abort.signal },
          );
          available = status.ready === true;
          hostedConfigured = status.configured === true;
        }
        if (current()) setResult({ owner, available, hostedConfigured });
      } catch {
        if (current()) setResult({ owner, available: false, hostedConfigured: false });
      }
    })();
    return () => abort.abort();
  }, [owner, focused, active]);
  return useCallback(
    (botVoiceId?: string | null) =>
      Boolean(
        focused &&
          active &&
          result?.owner === owner &&
          (result.available || (result.hostedConfigured && botVoiceId)) &&
          isMobileScopeCurrent(owner.scope),
      ),
    [focused, active, result, owner],
  );
}
