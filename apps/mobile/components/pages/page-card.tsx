import { PageIcon } from "@rakazo/chat-ui/native";
import type { MessageBlock, PageDetail } from "@rakazo/contracts";
import { pageCardSuperseded } from "@rakazo/core";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { currentApiBase } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../../lib/native";
import { usePageCardDetail } from "../../lib/page-card-detail";
import { pageDocument } from "../../lib/page-runtime";
import {
  pageCardState,
  pagePreviewLayout,
  pageScopeKey,
  subscribePageScope,
} from "../../lib/pages";
import { useOpenPrivatePage } from "../../lib/use-open-page";
import { PageFrame } from "./page-frame";

type PageBlock = Extract<MessageBlock, { kind: "page" }>;

/** The thread's newest card for each page, from `newestPageCards`, as web reads it. */
export const NewestPageCards = createContext<ReadonlyMap<string, string>>(new Map());

type PageRowBounds = { top: number; height: number };

/** The jump window already owns these content coordinates; do not rerender its history on scroll. */
export function createPagePreviewViewport() {
  let offset = 0;
  let height = 0;
  const listeners = new Set<() => void>();
  return {
    update(next: { offset?: number; viewport?: number }) {
      const measuredOffset = next.offset ?? offset;
      const measuredHeight = next.viewport ?? height;
      if (offset === measuredOffset && height === measuredHeight) return;
      offset = measuredOffset;
      height = measuredHeight;
      for (const listener of listeners) listener();
    },
    near(row: PageRowBounds | null) {
      return (
        row !== null &&
        row.height > 0 &&
        height > 0 &&
        row.top + row.height >= offset - 400 &&
        row.top <= offset + height + 400
      );
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function usePagePreviewViewport(scopeKey: string, windowKey: string | undefined) {
  return useMemo(createPagePreviewViewport, [scopeKey, windowKey]);
}

export const PagePreviewViewport = createContext<ReturnType<
  typeof createPagePreviewViewport
> | null>(null);
export const PagePreviewRowBounds = createContext<PageRowBounds | null>(null);
const noViewportSubscription = () => () => {};

/**
 * The page's top, drawn live at desktop width and scaled into the card. A page or viewer that
 * could not load says so in its place; the card still opens the page, which can try again.
 */
function PagePreview({
  detail,
  failed,
  width,
}: {
  detail: PageDetail | null;
  failed: boolean;
  width: number;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const theme = useResolvedAppearance();
  const scope = useSyncExternalStore(subscribePageScope, pageScopeKey, pageScopeKey);
  const surface = JSON.stringify([scope, detail?.id, theme, locale]);
  const key = JSON.stringify([surface, detail?.version]);
  const [preview, setPreview] = useState<{ surface: string; key: string; html: string | null }>();
  useEffect(() => {
    if (!detail) return;
    let active = true;
    void pageDocument(currentApiBase(), detail.code, theme, t("This page couldn't be shown."), {
      lang: locale,
    })
      .then((html) => {
        if (active && scope === pageScopeKey()) setPreview({ surface, key, html });
      })
      .catch(() => {
        if (active && scope === pageScopeKey()) setPreview({ surface, key, html: null });
      });
    return () => {
      active = false;
    };
  }, [detail, theme, locale, t, surface, key, scope]);
  const layout = pagePreviewLayout(width);
  const current = detail && preview?.surface === surface ? preview : undefined;
  const unavailable = failed || current?.html === null;
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ height: layout.height, overflow: "hidden", backgroundColor: tokens.card }}
    >
      {unavailable ? (
        <Text style={[styles.unavailable, { color: tokens.mutedForeground }]}>
          {t("This page couldn't load")}
        </Text>
      ) : null}
      {current?.html && !unavailable && width > 0 ? (
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: layout.frameWidth,
            height: layout.frameHeight,
            transformOrigin: "0 0",
            transform: [{ scale: layout.scale }],
          }}
        >
          <PageFrame
            document={current.html}
            documentKey={current.key}
            background={tokens.card}
            scrollEnabled={false}
            isCurrent={() => scope === pageScopeKey()}
            onError={() => {
              if (scope === pageScopeKey())
                setPreview((shown) =>
                  shown?.key === current.key ? { ...shown, html: null } : shown,
                );
            }}
          />
        </View>
      ) : null}
      <Svg style={styles.fade} width="100%" height={100}>
        <Defs>
          <LinearGradient id="page-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tokens.card} stopOpacity={0} />
            <Stop offset="1" stopColor={tokens.card} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={100} fill="url(#page-fade)" />
      </Svg>
    </View>
  );
}

/** An older card retains its saved preview; every card opens the latest Page. */
export function PageCard({ block, messageId }: { block: PageBlock; messageId: string }) {
  const openPage = useOpenPrivatePage();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [width, setWidth] = useState(0);
  const newest = useContext(NewestPageCards);
  const viewport = useContext(PagePreviewViewport);
  const rowBounds = useContext(PagePreviewRowBounds);
  const near = () => !viewport || viewport.near(rowBounds);
  const previewNear = useSyncExternalStore(
    viewport?.subscribe ?? noViewportSubscription,
    near,
    near,
  );
  const updated = pageCardSuperseded(newest, messageId, block);
  const detail = usePageCardDetail(block, updated);
  const state = pageCardState(block, detail.current);
  const updatedBelow = state.status === "ready" && updated;
  const deleted = state.status === "deleted";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {title}", { title: state.title })}
      testID="page-card"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      disabled={deleted}
      onPress={() => openPage(block.pageId)}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: tokens.card,
          borderColor: `${tokens.foreground}1F`,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      {deleted ? null : !previewNear ? (
        <View style={{ height: pagePreviewLayout(width).height, backgroundColor: tokens.card }} />
      ) : (
        <PagePreview
          key={JSON.stringify([pageScopeKey(), block.pageId, updated ? block.version : null])}
          detail={
            state.status === "ready" && typeof detail.preview === "object" ? detail.preview : null
          }
          failed={state.status === "failed" || detail.preview === "failed"}
          width={width}
        />
      )}
      <View style={[styles.footer, { borderTopColor: `${tokens.foreground}0A` }]}>
        <PageIcon colors={tokens} style={styles.icon} />
        <View style={styles.footerText}>
          <Text numberOfLines={1} style={[styles.title, { color: tokens.foreground }]}>
            {state.title}
          </Text>
          <Text numberOfLines={1} style={[styles.kind, { color: tokens.mutedForeground }]}>
            {deleted ? t("Deleted") : updatedBelow ? t("Updated below") : t("Page")}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
  },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
  unavailable: { fontSize: 15, textAlign: "center", marginTop: 40, paddingHorizontal: 20 },
  footer: {
    height: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 14.5,
    paddingLeft: 15.5,
    paddingRight: 20,
    borderTopWidth: 1,
  },
  icon: { transform: [{ translateY: -3 }] },
  footerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, lineHeight: 22 },
  kind: { fontSize: 15, lineHeight: 20, marginTop: 4 },
});
