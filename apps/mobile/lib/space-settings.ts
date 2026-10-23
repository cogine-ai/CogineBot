import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { ApiRequestContext, MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { t } from "./i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";

/** A settings target is separate from the selected conversation's authority. */
export function createSpaceSettingsClient(spaceId: string) {
  const origin = captureMobileScope();
  let active = true;
  let generation = 0;
  let lifetime = new AbortController();
  let context: Promise<ApiRequestContext> | undefined;
  const isCurrent = () => active && isMobileScopeCurrent(origin);
  function assertCurrent(expected = generation) {
    if (!isCurrent() || expected !== generation)
      throw new Error(t("Something went wrong. Try again."));
  }
  function capture() {
    const expected = generation;
    assertCurrent(expected);
    if (context) return context;
    const signal = lifetime.signal;
    const pending = (async () => {
      const captured = await captureApiRequestContext();
      assertCurrent(expected);
      const target = {
        ...captured,
        headers: { ...captured.headers, "x-rakazo-space-id": spaceId },
      };
      const me = await rpc<MobileMe>("me", {}, { requestContext: target, signal });
      assertCurrent(expected);
      if (me.spaceId !== spaceId) throw new Error(t("Something went wrong. Try again."));
      return target;
    })().catch((error: unknown) => {
      if (context === pending) context = undefined;
      throw error;
    });
    context = pending;
    return pending;
  }
  const call: typeof rpc = async <T>(
    procedure: string,
    input: unknown = {},
    options: Parameters<typeof rpc>[2] = {},
  ): Promise<T> => {
    const expected = generation;
    const requestContext = await capture();
    assertCurrent(expected);
    const controller = new AbortController();
    const signals = [lifetime.signal, options.signal].filter((signal): signal is AbortSignal =>
      Boolean(signal),
    );
    const abort = () => controller.abort();
    for (const signal of signals) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const value = await rpc<T>(procedure, input, {
        ...options,
        requestContext,
        signal: controller.signal,
      });
      if (
        (!isCurrent() || expected !== generation || controller.signal.aborted) &&
        procedure === "models/beginOAuth" &&
        value &&
        typeof value === "object" &&
        "loginId" in value &&
        typeof value.loginId === "string"
      ) {
        void rpc("models/cancelOAuth", { loginId: value.loginId }, { requestContext }).catch(
          () => undefined,
        );
      }
      assertCurrent(expected);
      if (controller.signal.aborted) throw new Error(t("Something went wrong. Try again."));
      return value;
    } finally {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  };
  /** Cleanup retains the original context even after this settings lifetime ends. */
  async function cancelOAuth(loginId: string) {
    const original = context;
    if (!original) return;
    const requestContext = await original;
    await rpc("models/cancelOAuth", { loginId }, { requestContext });
  }
  return {
    rpc: call,
    captureApiRequestContext: capture,
    cancelOAuth,
    isCurrent,
    signal: () => lifetime.signal,
    activate() {
      if (active) return;
      generation += 1;
      active = true;
      context = undefined;
      lifetime = new AbortController();
    },
    dispose() {
      active = false;
      generation += 1;
      lifetime.abort();
    },
  };
}

const ignoreScope = () => () => {};
const emptyScope = () => "";
const current = () => true;
const noSignal = () => undefined;
const cancelOAuth = (loginId: string) => rpc("models/cancelOAuth", { loginId });

/** Changing target or owner remounts only the settings form, clearing its drafts. */
export function useSpaceSettingsKey(spaceId?: string): string {
  const owner = useSyncExternalStore(
    spaceId ? subscribeMobileScope : ignoreScope,
    spaceId ? mobileScopeKey : emptyScope,
    emptyScope,
  );
  return `${spaceId ?? ""}:${owner}`;
}

export function useSpaceSettings(spaceId?: string) {
  const client = useMemo(() => (spaceId ? createSpaceSettingsClient(spaceId) : null), [spaceId]);
  useLayoutEffect(() => {
    client?.activate();
    return () => client?.dispose();
  }, [client]);
  return {
    rpc: client?.rpc ?? rpc,
    captureApiRequestContext: client?.captureApiRequestContext ?? captureApiRequestContext,
    cancelOAuth: client?.cancelOAuth ?? cancelOAuth,
    isCurrent: client?.isCurrent ?? current,
    signal: client?.signal ?? noSignal,
    spaceId,
  };
}
