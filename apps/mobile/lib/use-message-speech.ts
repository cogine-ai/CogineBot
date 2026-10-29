import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
export function useMessageSpeechAvailable(): boolean {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const focused = useIsFocused();
  const active = useAppActive();
  const owner = useMemo(() => ({ scope: captureMobileScope() }), [key, focused, active]);
  const [result, setResult] = useState<{ owner: typeof owner; available: boolean } | null>(null);
  useEffect(() => {
    if (!focused || !active) return;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && isMobileScopeCurrent(owner.scope);
    void (async () => {
      try {
        const device = await loadDeviceVoiceEnabled();
        if (!current()) return;
        let available: boolean;
        if (device) available = await deviceSpeechAvailable();
        else {
          const requestContext = await captureApiRequestContext();
          if (!current()) return;
          const status = await rpc<{ ready: boolean }>(
            "voice/status",
            {},
            { requestContext, signal: abort.signal },
          );
          available = status.ready === true;
        }
        if (current()) setResult({ owner, available });
      } catch {
        if (current()) setResult({ owner, available: false });
      }
    })();
    return () => abort.abort();
  }, [owner, focused, active]);
  return Boolean(
    focused &&
      active &&
      result?.owner === owner &&
      result.available &&
      isMobileScopeCurrent(owner.scope),
  );
}
