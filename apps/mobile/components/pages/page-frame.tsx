import { useNativeLinkConfirm } from "@rakazo/chat-ui/native";
import { pageCopyResult } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { uuid } from "expo-modules-core";
import { useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { NativeTouchEvent } from "react-native";
import { AppState, Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  allowPageFrameNavigation,
  isPageShellUrl,
  NATIVE_PAGE_SHELL,
  nativePageAnswerScript,
  nativePageMountScript,
  PAGE_ACTION_WINDOW_MS,
  PAGE_TAP_SLOP,
  readNativePageAction,
} from "../../lib/page-webview";

type PageFrameProps = {
  document: string;
  /** Includes the identity, actual version and retry of the Page being displayed. */
  documentKey: string;
  background: string;
  interactive?: boolean;
  active?: boolean;
  isCurrent?: () => boolean;
  onReply?: (text: string) => void;
  onError?: () => void;
  scrollEnabled?: boolean;
};

const shell = { html: NATIVE_PAGE_SHELL, baseUrl: "about:blank" };

export function PageFrame({ documentKey, ...props }: PageFrameProps) {
  const { document, interactive = false, onReply } = props;
  const canReply = onReply !== undefined;
  const [frame, setFrame] = useState({
    document,
    documentKey,
    interactive,
    canReply,
    generation: 0,
  });
  if (
    frame.document !== document ||
    frame.documentKey !== documentKey ||
    frame.interactive !== interactive ||
    frame.canReply !== canReply
  )
    setFrame({ document, documentKey, interactive, canReply, generation: frame.generation + 1 });
  return <PageFrameDocument key={frame.generation} {...props} />;
}

type Tap = Pick<NativeTouchEvent, "identifier" | "pageX" | "pageY"> & { startedAt: number };

function sameTap(start: Tap, touch: NativeTouchEvent): boolean {
  return (
    touch.identifier === start.identifier &&
    Math.hypot(touch.pageX - start.pageX, touch.pageY - start.pageY) <= PAGE_TAP_SLOP
  );
}

function PageFrameDocument({
  document,
  background,
  interactive = false,
  active = true,
  isCurrent,
  onReply,
  onError,
  scrollEnabled,
}: Omit<PageFrameProps, "documentKey">) {
  const view = useRef<WebView>(null);
  const load = useRef<{ view: WebView; instance: string } | null>(null);
  const mounted = useRef(false);
  const tap = useRef<Tap | null>(null);
  const tappedAt = useRef<number | null>(null);
  const actionGeneration = useRef(0);
  const navigation = useNavigation();
  const openLink = useNativeLinkConfirm();
  const handlers = useRef({ active, isCurrent, onReply, onError, openLink });

  const clearTap = useCallback(() => {
    tap.current = null;
    tappedAt.current = null;
  }, []);
  const revoke = useCallback(() => {
    actionGeneration.current += 1;
    clearTap();
  }, [clearTap]);
  const resetLoad = useCallback(() => {
    load.current = null;
    revoke();
  }, [revoke]);

  useLayoutEffect(() => {
    handlers.current = { active, isCurrent, onReply, onError, openLink };
  }, [active, isCurrent, onReply, onError, openLink]);
  useLayoutEffect(() => {
    if (!active) revoke();
  }, [active, revoke]);
  useLayoutEffect(() => {
    mounted.current = true;
    const blur = navigation.addListener("blur", revoke);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state !== "active") revoke();
    });
    return () => {
      mounted.current = false;
      resetLoad();
      blur();
      foreground.remove();
    };
  }, [navigation, resetLoad, revoke]);

  const canAct = () =>
    interactive &&
    mounted.current &&
    handlers.current.active &&
    handlers.current.isCurrent?.() !== false &&
    navigation.isFocused() &&
    AppState.currentState === "active";
  const failed = () => {
    resetLoad();
    if (mounted.current && handlers.current.isCurrent?.() !== false) handlers.current.onError?.();
  };

  function receive(data: string) {
    const current = load.current;
    const now = Date.now();
    const at = tappedAt.current;
    if (!current || current.view !== view.current || !canAct() || at === null) return;
    if (now < at || now - at > PAGE_ACTION_WINDOW_MS) return;
    const action = readNativePageAction(data, current.instance);
    if (!action || (action.kind === "reply" && !handlers.current.onReply)) return;
    // One native tap permits one validated action from the current opaque child.
    tappedAt.current = null;
    if (action.kind === "reply") handlers.current.onReply?.(action.text);
    else if (action.kind === "link") handlers.current.openLink(action.url);
    else {
      const generation = actionGeneration.current;
      void Clipboard.setStringAsync(action.text)
        .catch(() => false)
        .then((ok) => {
          if (
            load.current === current &&
            view.current === current.view &&
            actionGeneration.current === generation &&
            canAct()
          )
            current.view.injectJavaScript(
              nativePageAnswerScript(current.instance, pageCopyResult(action.id, ok !== false)),
            );
        });
    }
  }

  return (
    <View
      style={styles.container}
      onTouchStart={
        interactive
          ? ({ nativeEvent }) => {
              clearTap();
              if (!load.current || !canAct() || nativeEvent.touches.length !== 1) return;
              const { identifier, pageX, pageY } = nativeEvent;
              tap.current = { identifier, pageX, pageY, startedAt: Date.now() };
            }
          : undefined
      }
      onTouchMove={
        interactive
          ? ({ nativeEvent }) => {
              if (
                tap.current &&
                (nativeEvent.touches.length !== 1 || !sameTap(tap.current, nativeEvent))
              )
                clearTap();
            }
          : undefined
      }
      onTouchEnd={
        interactive
          ? ({ nativeEvent }) => {
              const start = tap.current;
              tap.current = null;
              const now = Date.now();
              if (
                start &&
                canAct() &&
                nativeEvent.touches.length === 0 &&
                now >= start.startedAt &&
                now - start.startedAt <= PAGE_ACTION_WINDOW_MS &&
                sameTap(start, nativeEvent)
              )
                tappedAt.current = now;
            }
          : undefined
      }
      onTouchCancel={interactive ? clearTap : undefined}
    >
      <WebView
        ref={view}
        source={shell}
        style={[styles.webview, { backgroundColor: background }]}
        scrollEnabled={scrollEnabled}
        onMessage={interactive ? (event) => receive(event.nativeEvent.data) : undefined}
        onLoadStart={({ nativeEvent }) => {
          if (nativeEvent.url !== "about:srcdoc") resetLoad();
        }}
        onLoad={({ nativeEvent }) => {
          const current = view.current;
          if (
            !mounted.current ||
            handlers.current.isCurrent?.() === false ||
            !current ||
            load.current ||
            !isPageShellUrl(nativeEvent.url)
          )
            return;
          const instance = uuid.v4();
          load.current = { view: current, instance };
          current.injectJavaScript(
            nativePageMountScript(document, instance, interactive ? uuid.v4() : null),
          );
        }}
        onError={failed}
        onContentProcessDidTerminate={failed}
        onRenderProcessGone={failed}
        javaScriptEnabled
        incognito={Platform.OS === "ios"}
        cacheEnabled={false}
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        mixedContentMode="never"
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={({ url, isTopFrame }) =>
          allowPageFrameNavigation(url, isTopFrame)
        }
        onOpenWindow={() => undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
