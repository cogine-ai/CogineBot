import type { PageDetail } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import {
  chatOnScreen,
  getLatestPage,
  getPageVersion,
  pageReadFailure,
  pageScopeKey,
  subscribePageScope,
} from "./pages";

/** Re-read cards when the chat returns, including after another device changed a page. */
export function useChatOnScreen() {
  const focused = useRef(false);
  const visited = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (visited.current) chatOnScreen.mark();
      visited.current = true;
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );
  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (focused.current && state === "active" && previous !== "active") chatOnScreen.mark();
      previous = state;
    });
    return () => subscription.remove();
  }, []);
}

type CardDetail = PageDetail | null | "failed" | "deleted";

/** Current metadata owns availability; only a superseded card reads its saved preview. */
export function usePageCardDetail(block: { pageId: string; version: number }, updated = false) {
  const onScreen = useSyncExternalStore(chatOnScreen.subscribe, chatOnScreen.get);
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const key = JSON.stringify([scope, block.pageId, block.version, updated]);
  const [loaded, setLoaded] = useState<{
    key: string;
    current: CardDetail;
    preview: CardDetail;
  }>({ key, current: null, preview: null });
  useEffect(() => {
    let active = true;
    const current = () => active && scope === pageScopeKey() && onScreen === chatOnScreen.get();
    setLoaded((previous) =>
      previous.key === key ? previous : { key, current: null, preview: null },
    );
    void getLatestPage(block.pageId, { atLeastVersion: block.version, since: onScreen }).then(
      (detail) => {
        if (current())
          setLoaded((previous) => ({
            ...previous,
            current: detail,
            ...(!updated ? { preview: detail } : {}),
          }));
      },
      (error: unknown) => {
        if (current()) setLoaded((previous) => ({ ...previous, current: pageReadFailure(error) }));
      },
    );
    if (updated)
      void getPageVersion(block.pageId, block.version).then(
        (detail) => {
          if (current()) setLoaded((previous) => ({ ...previous, preview: detail }));
        },
        () => {
          // A missing saved version does not mean its current Page was deleted.
          if (current()) setLoaded((previous) => ({ ...previous, preview: "failed" }));
        },
      );
    return () => {
      active = false;
    };
  }, [block.pageId, block.version, updated, key, onScreen, scope]);
  if (loaded.key !== key) return { current: null, preview: null };
  return {
    current: loaded.current,
    preview: loaded.current !== null && typeof loaded.current === "object" ? loaded.preview : null,
  };
}
