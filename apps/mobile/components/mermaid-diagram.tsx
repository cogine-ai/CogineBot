import { chatMermaidConfig } from "@rakazo/chat-ui/mermaid";
import type { MermaidDiagramProps } from "@rakazo/chat-ui/native";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { currentApiBase, subscribeApiBase } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  DIAGRAM_TIMEOUT_MS,
  diagramBootScript,
  diagramDocument,
  diagramScriptUrl,
  isDiagramDocument,
  parseDiagramMessage,
} from "../lib/mermaid-webview";
import { NativeActionButton } from "./native-action-button";

type DiagramState =
  | { status: "drawing" }
  | { status: "drawn"; height: number; alt: string }
  | { status: "failed" };

let nextDocumentId = 0;

export function MermaidDiagram(props: MermaidDiagramProps) {
  const endpoint = useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase);
  const document = useMemo(() => {
    try {
      const html = diagramDocument(diagramScriptUrl(endpoint));
      const config = chatMermaidConfig(props.palette, props.colorScheme, {
        surface: props.palette.background,
      });
      return { html, config, key: JSON.stringify([html, config, props.source]) };
    } catch {
      return null;
    }
  }, [endpoint, props.palette, props.colorScheme, props.source]);
  if (!document) return props.fallback;
  return <DiagramDocument key={document.key} {...props} document={document} />;
}

// Each source, theme and server gets its own page, timer and terminal failure state.
function DiagramDocument({
  source,
  palette,
  fallback,
  document,
}: MermaidDiagramProps & {
  document: {
    html: string;
    config: ReturnType<typeof chatMermaidConfig>;
  };
}) {
  const { t } = useI18n();
  const [requestId] = useState(() => `diagram-${++nextDocumentId}`);
  const [diagram, setDiagram] = useState<DiagramState>({ status: "drawing" });
  const [showSource, setShowSource] = useState(false);
  const lifecycle = useRef({ active: true, status: "drawing" as DiagramState["status"] });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const fail = useCallback(() => {
    if (!lifecycle.current.active || lifecycle.current.status === "failed") return;
    lifecycle.current.status = "failed";
    clearTimer();
    setDiagram({ status: "failed" });
  }, [clearTimer]);
  useEffect(() => {
    lifecycle.current.active = true;
    timer.current = setTimeout(() => {
      if (lifecycle.current.status === "drawing") fail();
    }, DIAGRAM_TIMEOUT_MS);
    return () => {
      lifecycle.current.active = false;
      clearTimer();
    };
  }, [clearTimer, fail]);
  const boot = useMemo(
    () => diagramBootScript(source, document.config, requestId),
    [source, document.config, requestId],
  );
  const pageSource = useMemo(
    () => ({ html: document.html, baseUrl: "about:blank" }),
    [document.html],
  );

  if (diagram.status === "failed") return fallback;
  const drawn = diagram.status === "drawn";
  const visible = drawn && !showSource;
  return (
    <View style={styles.wrap}>
      {drawn ? (
        <NativeActionButton
          label={t(showSource ? "Show diagram" : "Show source")}
          onPress={() => setShowSource((current) => !current)}
          prominence="quiet"
          size="compact"
        />
      ) : null}
      {visible ? null : fallback}
      <View
        style={
          visible
            ? [styles.card, { backgroundColor: palette.background, borderColor: palette.border }]
            : styles.measuring
        }
        pointerEvents={visible ? "auto" : "none"}
        accessible={visible}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
        accessibilityRole="image"
        accessibilityLabel={drawn && diagram.alt ? diagram.alt : t("Diagram")}
      >
        <WebView
          source={pageSource}
          injectedJavaScript={boot}
          onMessage={(event) => {
            if (!lifecycle.current.active || lifecycle.current.status === "failed") return;
            const message = parseDiagramMessage(event.nativeEvent.data, requestId);
            if (!message) return;
            if (message.type === "failed") return fail();
            lifecycle.current.status = "drawn";
            clearTimer();
            setDiagram({ status: "drawn", height: message.height, alt: message.alt });
          }}
          onError={fail}
          onHttpError={fail}
          onContentProcessDidTerminate={fail}
          onRenderProcessGone={fail}
          style={[styles.webview, { height: drawn ? diagram.height : 1 }]}
          javaScriptEnabled
          // Android incognito clears cookies for every WebView, including the computer screen.
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
          // Route all URLs through our rejecting handler; WebView otherwise opens nonlisted URLs.
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={({ url }) => isDiagramDocument(url)}
          onOpenWindow={fail}
          scrollEnabled
          nestedScrollEnabled
          bounces={false}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", minWidth: 0 },
  card: {
    width: "100%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 8,
    overflow: "hidden",
  },
  measuring: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
  webview: { width: "100%", backgroundColor: "transparent" },
});
