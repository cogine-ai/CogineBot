import type { PageDetail } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import {
  chatOnScreen,
  getLatestPage,
  pageReadFailure,
  pageScopeKey,
  subscribePageScope,
} from "./pages";

/** Re-read cards when the chat returns, including after another device changed a page. */
export function useChatOnScreen() {
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) chatOnScreen.mark();
      focused.current = true;
    }, []),
  );
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") chatOnScreen.mark();
      previous = state;
    });
    return () => subscription.remove();
  }, []);
}

export function usePageCardDetail(block: { pageId: string; version: number }) {
  const onScreen = useSyncExternalStore(chatOnScreen.subscribe, chatOnScreen.get);
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const key = JSON.stringify([scope, block.pageId, block.version, onScreen]);
  const [loaded, setLoaded] = useState<{
    key: string;
    detail: PageDetail | null | "failed" | "deleted";
  }>({ key, detail: null });
  useEffect(() => {
    let active = true;
    setLoaded({ key, detail: null });
    void getLatestPage(block.pageId, { atLeastVersion: block.version, since: onScreen }).then(
      (detail) => {
        if (active && scope === pageScopeKey()) setLoaded({ key, detail });
      },
      (error: unknown) => {
        if (active && scope === pageScopeKey()) setLoaded({ key, detail: pageReadFailure(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [block.pageId, block.version, key, onScreen, scope]);
  return loaded.key === key ? loaded.detail : null;
}
