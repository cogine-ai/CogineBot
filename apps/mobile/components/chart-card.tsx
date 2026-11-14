import type { MessageBlock } from "@rakazo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { currentApiBase, subscribeApiBase } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import {
  CHART_TIMEOUT_MS,
  chartBootScript,
  chartDocument,
  parseChartMessage,
} from "../lib/chart-webview";
import { useI18n } from "../lib/i18n";
import { isDiagramDocument } from "../lib/mermaid-webview";
import { useResolvedAppearance } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

type ChartBlock = Extract<MessageBlock, { kind: "chart" }>;
let nextRequestId = 0;

export function ChartCard({ block }: { block: ChartBlock }) {
  const { t } = useI18n();
  useResolvedAppearance();
  const tokens = mobileTokens();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.card, { backgroundColor: tokens.muted, borderColor: tokens.border }]}>
      <ChartCanvas block={block} />
      <NativeActionButton
        label={t("Expand chart")}
        onPress={() => setExpanded(true)}
        prominence="quiet"
        size="compact"
      />
      {expanded ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setExpanded(false)}
        >
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                backgroundColor: tokens.background,
                paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
                paddingBottom: insets.bottom,
              },
            ]}
          >
            <View style={styles.header}>
              <Text style={[styles.name, { color: tokens.foreground }]}>{block.name}</Text>
              <NativeActionButton
                label={t("Close chart")}
                onPress={() => setExpanded(false)}
                fill={false}
                prominence="quiet"
              />
            </View>
            <ScrollView contentContainerStyle={styles.content}>
              <ChartCanvas
                block={block}
                height={Math.max(200, viewport.height - insets.top - insets.bottom - 160)}
              />
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function ChartCanvas({ block, height }: { block: ChartBlock; height?: number }) {
  const endpoint = useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase);
  const appearance = useResolvedAppearance();
  const html = useMemo(() => {
    try {
      return chartDocument(endpoint);
    } catch {
      return null;
    }
  }, [endpoint]);
  const key = JSON.stringify([endpoint, appearance, block.spec, block.data, height]);
  return html ? (
    <ChartDocument key={key} block={block} html={html} height={height} />
  ) : (
    <ChartFailure />
  );
}

function ChartFailure() {
  const { t } = useI18n();
  return (
    <Text accessibilityRole="alert" style={{ color: mobileTokens().mutedForeground }}>
      {t("Chart unavailable")}
    </Text>
  );
}

function ChartDocument({
  block,
  html,
  height,
}: {
  block: ChartBlock;
  html: string;
  height?: number;
}) {
  const tokens = mobileTokens();
  const [requestId] = useState(() => `chart-${++nextRequestId}`);
  const [state, setState] = useState<{ type: "loading" | "failed" | "drawn"; height: number }>({
    type: "loading",
    height: 300,
  });
  const lifecycle = useRef({ active: true, failed: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fail = useCallback(() => {
    if (!lifecycle.current.active || lifecycle.current.failed) return;
    lifecycle.current.failed = true;
    clearTimeout(timer.current);
    setState({ type: "failed", height: 0 });
  }, []);
  useEffect(() => {
    lifecycle.current.active = true;
    timer.current = setTimeout(fail, CHART_TIMEOUT_MS);
    return () => {
      lifecycle.current.active = false;
      clearTimeout(timer.current);
    };
  }, [fail]);
  const source = useMemo(() => ({ html, baseUrl: "about:blank" }), [html]);
  const boot = useMemo(
    () =>
      chartBootScript({
        requestId,
        spec: block.spec,
        data: block.data,
        foreground: tokens.foreground,
        background: tokens.background,
        height,
      }),
    [requestId, block.spec, block.data, tokens.foreground, tokens.background, height],
  );
  if (state.type === "failed") return <ChartFailure />;
  return (
    <View>
      {state.type === "loading" ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      <WebView
        source={source}
        injectedJavaScript={boot}
        style={{
          height: state.height,
          backgroundColor: tokens.background,
          opacity: state.type === "drawn" ? 1 : 0,
        }}
        onMessage={(event) => {
          if (!lifecycle.current.active || lifecycle.current.failed) return;
          const message = parseChartMessage(event.nativeEvent.data, requestId);
          if (!message) return;
          if (message.type === "failed") return fail();
          clearTimeout(timer.current);
          setState(message);
        }}
        onError={fail}
        onHttpError={fail}
        onContentProcessDidTerminate={fail}
        onRenderProcessGone={fail}
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
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={({ url }) => isDiagramDocument(url)}
        onOpenWindow={fail}
        scrollEnabled
        nestedScrollEnabled
        bounces={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 12,
    gap: 8,
  },
  sheet: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    gap: 12,
  },
  name: { flex: 1, fontSize: 14 },
  content: { padding: 16 },
});
