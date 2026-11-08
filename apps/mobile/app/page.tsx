import type { PageDetail } from "@rakazo/contracts";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { uuid } from "expo-modules-core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { PageFrame } from "../components/pages/page-frame";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { currentApiBase } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { HEADER_CONTROL_SIZE } from "../lib/native-controls";
import { pageDocument } from "../lib/page-runtime";
import {
  getLatestPage,
  getPageReplyChat,
  offerPageReply,
  offerPageShareView,
  pageScopeKey,
  subscribePageScope,
} from "../lib/pages";

type Loaded =
  | { status: "loading"; scope: string }
  | { status: "error"; error: unknown; scope: string }
  | {
      status: "ready";
      page: PageDetail;
      document: string;
      drawKey: symbol;
      chat: Awaited<ReturnType<typeof getPageReplyChat>>;
      scope: string;
    };

/** A private page full screen, with a native close button. */
export default function PageScreen() {
  const { pageId } = useLocalSearchParams<{ pageId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  // Pages paint the web palette's background; the screen around them matches it.
  const pageBackground = tokensForAppearance(theme).background;
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const [attempt, setAttempt] = useState(0);
  const documentKey = JSON.stringify([scope, pageId, theme, locale, attempt]);
  const [state, setLoaded] = useState<Loaded>({ status: "loading", scope: documentKey });
  const loaded: Loaded =
    state.scope === documentKey ? state : { status: "loading", scope: documentKey };
  const currentPage = useRef<Loaded | null>(null);
  const drawnPage = useRef<symbol | null>(null);
  const [drawn, setDrawn] = useState<symbol | null>(null);
  useLayoutEffect(() => {
    currentPage.current = loaded;
    return () => {
      currentPage.current = null;
      drawnPage.current = null;
    };
  }, [loaded]);
  // iOS keeps the native glass button as it is; Android's bordered button becomes a card circle.
  const round =
    Platform.OS === "ios" ? undefined : [styles.round, { backgroundColor: tokens.card }];

  useEffect(() => {
    let active = true;
    setLoaded({ status: "loading", scope: documentKey });
    if (typeof pageId !== "string" || !pageId) {
      setLoaded({ status: "error", error: { code: "NOT_FOUND" }, scope: documentKey });
      return;
    }
    const apiBase = currentApiBase();
    void getLatestPage(pageId, { refresh: true })
      .then(async (page) => {
        if (!active || scope !== pageScopeKey()) return;
        const chatRead = getPageReplyChat(page).catch(() => null);
        const document = await pageDocument(
          apiBase,
          page.code,
          theme,
          t("This page couldn't be shown."),
          { reply: false, lang: locale },
        );
        if (!active || scope !== pageScopeKey()) return;
        setLoaded({
          status: "ready",
          page,
          document,
          drawKey: Symbol(),
          chat: null,
          scope: documentKey,
        });
        const chat = await chatRead;
        if (!chat || !active || scope !== pageScopeKey()) return;
        const interactive = await pageDocument(
          apiBase,
          page.code,
          theme,
          t("This page couldn't be shown."),
          { reply: true, lang: locale },
        ).catch(() => null);
        if (!interactive || !active || scope !== pageScopeKey()) return;
        setLoaded((previous) =>
          previous.status === "ready" && previous.scope === documentKey
            ? {
                status: "ready",
                page,
                document: interactive,
                drawKey: Symbol(),
                chat,
                scope: documentKey,
              }
            : previous,
        );
      })
      .catch((error: unknown) => {
        if (active && scope === pageScopeKey())
          setLoaded({ status: "error", error, scope: documentKey });
      });
    return () => {
      active = false;
    };
  }, [pageId, theme, locale, t, attempt, scope, documentKey]);

  function offerReply(text: string) {
    if (scope !== pageScopeKey() || loaded.status !== "ready" || !loaded.chat) return;
    const { chat, page } = loaded;
    offerPageReply(chat.pathname, chat.threadKey, {
      text,
      page: { id: page.id, title: page.title },
    });
    const state = navigation.getState();
    const below = state?.routes[state.index - 1];
    const params = below?.params as Record<string, unknown> | undefined;
    if (
      `/${below?.name}` === chat.pathname &&
      params?.[chat.key] === chat.threadKey &&
      params.readOnly !== "1"
    ) {
      router.back();
    } else {
      router.replace({ pathname: chat.pathname, params: { [chat.key]: chat.threadKey } });
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: pageBackground }]}>
      {loaded.status === "ready" ? (
        <View style={[styles.screen, { paddingTop: insets.top + HEADER_CONTROL_SIZE }]}>
          <PageFrame
            document={loaded.document}
            documentKey={JSON.stringify([
              documentKey,
              loaded.page.id,
              loaded.page.version,
              loaded.chat,
            ])}
            background={pageBackground}
            interactive
            isCurrent={() => currentPage.current === loaded && scope === pageScopeKey()}
            onDrawnChange={(ready) => {
              if (currentPage.current !== loaded || scope !== pageScopeKey()) return;
              const next = ready ? loaded.drawKey : null;
              drawnPage.current = next;
              setDrawn(next);
            }}
            onError={() => {
              if (currentPage.current === loaded && scope === pageScopeKey()) {
                drawnPage.current = null;
                setLoaded({
                  status: "error",
                  error: new Error("Page viewer unavailable"),
                  scope: documentKey,
                });
              }
            }}
            onReply={loaded.chat ? offerReply : undefined}
          />
        </View>
      ) : loaded.status === "error" ? (
        <View style={styles.center}>
          <PageLoadFailure
            error={loaded.error}
            fallback={t("Could not load this page.")}
            gone={t("This page isn't available")}
            onRetry={() => setAttempt((count) => count + 1)}
          />
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      )}
      <View pointerEvents="box-none" style={[styles.controls, { top: insets.top + 6 }]}>
        <NativeActionButton
          accessibilityLabel={t("Close")}
          icon={{ ios: "xmark", android: "close", size: 20 }}
          prominence="secondary"
          style={round}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        {loaded.status === "ready" && drawn === loaded.drawKey ? (
          <NativeActionButton
            accessibilityLabel={t("Share")}
            icon={{ ios: "square.and.arrow.up", android: "share-outline", size: 20 }}
            prominence="secondary"
            style={round}
            onPress={() => {
              if (
                drawnPage.current !== loaded.drawKey ||
                scope !== pageScopeKey() ||
                !navigation.isFocused() ||
                AppState.currentState !== "active"
              )
                return;
              const viewId = uuid.v4();
              offerPageShareView(viewId, loaded.page.id, loaded.page.version);
              router.push({ pathname: "/page-share", params: { pageId: loaded.page.id, viewId } });
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  controls: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  round: {
    width: HEADER_CONTROL_SIZE,
    minHeight: HEADER_CONTROL_SIZE,
    borderRadius: HEADER_CONTROL_SIZE / 2,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
});
