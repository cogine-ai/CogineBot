import type { ComputerMode, ComputerReleaseReason } from "@rakazo/contracts";
import { createComputerHeartbeat } from "@rakazo/core";
import { useIsFocused, useLocalSearchParams, useNavigation } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { ComputerKeyboardBar } from "../components/computer-keyboard-bar";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { GlassIconButton } from "../components/glass-icon-button";
import { NativeActionButton } from "../components/native-action-button";
import { currentApiBase, rpc } from "../lib/api";
import { useAppActive } from "../lib/app-active";
import type { ComputerStatus } from "../lib/computer";
import {
  COMPUTER_HEARTBEAT_MS,
  COMPUTER_LIFECYCLE_TIMEOUT_MS,
  computerLabel,
  controlLabel,
  embeddableScreenUrl,
  nextLoadedScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  retainScreenSource,
  SCREEN_URL_OPEN_ATTEMPTS,
} from "../lib/computer";
import type { ComputerKeyboardCommand } from "../lib/computer-keyboard";
import {
  computerKeyboardReadyProbe,
  computerKeyboardScript,
  createComputerKeyboardBridge,
  isComputerKeyboardReadyMessage,
  NATIVE_COMPUTER_KEYBOARD_BOOT,
} from "../lib/computer-keyboard";
import { createComputerRefresh } from "../lib/computer-refresh";
import { useI18n } from "../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";

export default function Computer() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const { botId, name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const appActive = useAppActive();
  const focused = useIsFocused();
  const visible = appActive && focused;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const targetKey = `${botId ?? ""}:${scopeKey}`;
  const viewEpoch = useMemo(() => ({ visible, targetKey }), [visible, targetKey]);
  const viewEpochRef = useRef(viewEpoch);
  viewEpochRef.current = viewEpoch;
  const [verifiedView, setVerifiedView] = useState<typeof viewEpoch | null>(null);
  const viewVisible = visible && verifiedView === viewEpoch;
  const name = nameParam || t("Bot");
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyTarget, setReadyTarget] = useState<string | null>(null);
  const [bootingCount, setBootingCount] = useState(0);
  const [switchingCount, setSwitchingCount] = useState(0);
  const booting = bootingCount > 0;
  const switching = switchingCount > 0;
  const [computerOpen, setComputerOpen] = useState(false);
  const autoBooted = useRef<string | null>(null);
  const screenWebViewRef = useRef<WebView>(null);
  const keyboardGate = useRef({
    key: "",
    session: 0,
    bridge: createComputerKeyboardBridge(),
  });
  const heldScreenUrl = useRef<string | null>(null);
  const [screenRecovery, setScreenRecovery] = useState({ generation: 0, watchOnly: false });
  const screenRecoveryRef = useRef(screenRecovery);
  screenRecoveryRef.current = screenRecovery;

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  useEffect(() => setScreenError(null), [embeddedScreenUrl]);

  const hasControl =
    !screenRecovery.watchOnly &&
    computer?.controlHolder === "user" &&
    computer.controlBotId === botId;
  const screenVisible =
    viewVisible &&
    computerOpen &&
    computer?.state === "running" &&
    Boolean(embeddedScreenUrl) &&
    !screenError;
  const loadedScreenUrl = nextLoadedScreenUrl(
    heldScreenUrl.current,
    embeddedScreenUrl,
    screenVisible,
  );
  heldScreenUrl.current = loadedScreenUrl;
  // The gate follows the page the WebView actually loaded. A capability refresh that
  // does not reload that page must not open a session the bridge will never acknowledge.
  const keyboardSurfaceKey = `${viewVisible}:${computerOpen}:${hasControl}:${screenRecovery.generation}:${loadedScreenUrl ?? ""}`;
  if (keyboardGate.current.key !== keyboardSurfaceKey) {
    keyboardGate.current = {
      key: keyboardSurfaceKey,
      session: keyboardGate.current.session + 1,
      bridge: createComputerKeyboardBridge(),
    };
  }
  const keyboardSession = String(keyboardGate.current.session);

  useEffect(() => {
    if (!viewVisible || !computerOpen || !hasControl || !loadedScreenUrl) return;
    const gate = keyboardGate.current;
    if (gate.bridge.isReady()) return;
    const webView = screenWebViewRef.current;
    if (!webView) return;
    webView.injectJavaScript(computerKeyboardReadyProbe(String(gate.session)));
  }, [viewVisible, computerOpen, hasControl, loadedScreenUrl, embeddedScreenUrl, keyboardSession]);

  function injectKeyboardCommands(commands: ComputerKeyboardCommand[]) {
    const webView = screenWebViewRef.current;
    if (!webView) return;
    for (const command of commands) webView.injectJavaScript(computerKeyboardScript(command));
  }

  const label = computerLabel(computer?.mode, name);

  useLayoutEffect(() => {
    navigation.setOptions({ title: label });
  }, [label, navigation]);

  const refreshController = useMemo(() => {
    const scope = captureMobileScope();
    const current = () =>
      visibleRef.current &&
      viewEpochRef.current.targetKey === targetKey &&
      isMobileScopeCurrent(scope);
    let heartbeat: ReturnType<typeof createComputerHeartbeat> | undefined;
    const controller = createComputerRefresh({
      readStatus: (signal) => {
        if (!current()) throw new Error("Computer target changed");
        return rpc<ComputerStatus>("computer/status", { botId }, { signal });
      },
      readScreen: (attempts, signal) =>
        readScreenUrl(
          () =>
            current()
              ? rpc<{ url: string | null }>("computer/screenUrl", { botId }, { signal })
              : Promise.resolve({ url: null }),
          { attempts, signal },
        ),
      onStatus: (status) => {
        if (!current()) return;
        setComputer(status);
        setVerifiedView(viewEpochRef.current);
        heartbeat?.setEnabled(status.state === "running");
      },
      onScreen: (url) => {
        if (current()) setScreenUrl(url);
      },
      onReady: () => {
        if (current()) setReadyTarget(`${botId ?? ""}:${scopeKey}`);
      },
      onInitialError: (err) => {
        if (current()) setError(errorText(err));
      },
    });
    return {
      ...controller,
      start(input?: { paused?: boolean }) {
        heartbeat?.dispose();
        heartbeat = createComputerHeartbeat({
          intervalMs: COMPUTER_HEARTBEAT_MS,
          ping: (signal) =>
            current()
              ? rpc("computer/heartbeat", { botId }, { signal })
              : Promise.resolve(undefined),
        });
        controller.start(input);
      },
      pause() {
        heartbeat?.setEnabled(false);
        controller.pause();
      },
      dispose() {
        heartbeat?.dispose();
        heartbeat = undefined;
        controller.dispose();
      },
    };
  }, [botId, scopeKey]);
  const refresh = refreshController.refresh;
  function resetScreen() {
    const next = { generation: screenRecoveryRef.current.generation + 1, watchOnly: true };
    screenRecoveryRef.current = next;
    // A new renderer must not accept queued commands or acknowledgements from its predecessor.
    keyboardGate.current = {
      key: "",
      session: keyboardGate.current.session + 1,
      bridge: createComputerKeyboardBridge(),
    };
    heldScreenUrl.current = null;
    setScreenUrl(null);
    setScreenError(null);
    setScreenRecovery(next);
    refreshController.invalidateScreen();
  }
  function rendererLost() {
    if (
      !visibleRef.current ||
      viewEpochRef.current !== viewEpoch ||
      screenRecoveryRef.current.generation !== screenRecovery.generation ||
      !refreshController.isActive()
    )
      return;
    resetScreen();
    void refresh().catch(() => undefined);
  }
  const refreshAfterMaintenance = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => {
    setComputer(null);
    setScreenUrl(null);
    setScreenError(null);
    setError(null);
    setReadyTarget(null);
    setBootingCount(0);
    setSwitchingCount(0);
    setComputerOpen(false);
    if (botId) refreshController.start({ paused: !visibleRef.current });
    return () => refreshController.dispose();
  }, [botId, refreshController]);

  useLayoutEffect(() => {
    if (!visible) resetScreen();
  }, [visible, refreshController]);

  useEffect(() => {
    if (!botId) return;
    if (visible) refreshController.resume();
    else refreshController.pause();
  }, [botId, visible, refreshController]);

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    if (!botId || !visibleRef.current || !refreshController.isActive()) return false;
    const action = refreshController.beginAction();
    const actionView = viewEpochRef.current;
    const actionGeneration = screenRecoveryRef.current.generation;
    const currentInteraction = () =>
      action.isActive() &&
      visibleRef.current &&
      viewEpochRef.current === actionView &&
      screenRecoveryRef.current.generation === actionGeneration;
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    const showBooting = overlay && needsBoot;
    if (showBooting) setBootingCount((count) => count + 1);
    try {
      if (needsBoot)
        await rpc("computer/boot", { botId }, { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS });
      if (!action.isActive()) return false;
      if (takeControl) {
        if (!currentInteraction()) return false;
        await rpc("computer/takeover", { botId });
      }
      if (!action.isActive()) return false;
      await action.refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS });
      if (!action.isActive()) return false;
      if (takeControl) {
        if (!currentInteraction()) return false;
        const next = { ...screenRecoveryRef.current, watchOnly: false };
        screenRecoveryRef.current = next;
        setScreenRecovery(next);
      }
      setError(null);
      return true;
    } catch (err) {
      if (!action.isActive()) return false;
      setError(errorText(err, t("Could not open computer")));
      throw err;
    } finally {
      if (action.isActive() && showBooting) setBootingCount((count) => count - 1);
      action.finish();
    }
  }

  useEffect(() => {
    if (!viewVisible || !botId || !computer || readyTarget !== targetKey || switching) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === botId) return;
    autoBooted.current = botId;
    void bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: true,
    }).catch(() => undefined);
  }, [readyTarget, targetKey, botId, computer?.state, switching, viewVisible]);

  useEffect(() => {
    // Let the full-screen desktop rotate to landscape; the rest of the app stays portrait.
    const lock =
      visible && computerOpen
        ? ScreenOrientation.OrientationLock.DEFAULT
        : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    void ScreenOrientation.lockAsync(lock).catch(() => undefined);
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
        () => undefined,
      );
    };
  }, [computerOpen, visible]);

  /** Open the full window. Only an explicit Take control asks for the lease. */
  async function openComputer({ takeControl }: { takeControl: boolean }) {
    if (!botId) return;
    const needsTakeover = takeControl && !hasControl;
    try {
      const opened = await bootComputer({
        takeControl: needsTakeover,
        overlay: needsTakeover || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      if (!opened || !refreshController.isActive()) return;
      setComputerOpen(true);
      setScreenError(null);
    } catch {
      // error already set
    }
  }

  async function releaseComputer(reason?: ComputerReleaseReason) {
    if (!botId || !refreshController.isActive()) return;
    const action = refreshController.beginAction();
    try {
      await rpc("computer/release", { botId, reason });
      if (!action.isActive()) return;
      setComputerOpen(false);
      await action.refresh().catch(() => undefined);
    } catch {
      if (action.isActive()) setScreenError(t("Could not continue"));
    } finally {
      action.finish();
    }
  }

  async function setComputerMode(mode: ComputerMode) {
    if (!botId || !refreshController.isActive() || mode === computer?.mode) return;
    const action = refreshController.beginAction();
    setSwitchingCount((count) => count + 1);
    setError(null);
    try {
      if (hasControl) {
        await rpc("computer/release", {
          botId,
          reason: computer?.takeoverRequested ? "skipped" : undefined,
        });
      }
      if (!action.isActive()) return;
      await rpc("bots/setComputer", { botId, mode }, { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS });
      if (!action.isActive()) return;
      setComputer(null);
      setScreenUrl(null);
      autoBooted.current = null;
      await action.refresh();
    } catch (err) {
      if (!action.isActive()) return;
      setError(errorText(err, t("Could not switch computer")));
    } finally {
      if (action.isActive()) setSwitchingCount((count) => count - 1);
      action.finish();
    }
  }

  const placeholder =
    screenError ?? previewPlaceholder(computer?.state, booting, name, computer?.mode);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 24 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {error ? (
        <Text style={{ color: tokens.mutedForeground, marginBottom: 12 }}>{error}</Text>
      ) : null}
      <View
        style={{
          height: 360,
          minHeight: 220,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor: tokens.card,
        }}
      >
        {computerOpen ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Open in full window")}</Text>
          </View>
        ) : viewVisible && computer?.state === "running" && embeddedScreenUrl && !screenError ? (
          <ScreenWebView
            key={screenRecovery.generation}
            url={embeddedScreenUrl}
            interactive={false}
            onRendererLost={rendererLost}
            onError={() => {
              refreshController.invalidateScreen();
              setScreenError(
                t("Could not load the desktop. This device cannot reach the screen URL."),
              );
            }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
            <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
              {placeholder}
            </Text>
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open computer")}
          onPress={() => void openComputer({ takeControl: false })}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
      </View>
      <View
        style={{
          marginTop: 16,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, flex: 1 }}>
          {controlLabel(computer, name, botId)}
        </Text>
        {hasControl ? (
          <ComputerReleaseActions
            takeoverRequested={computer?.takeoverRequested ?? false}
            onRelease={releaseComputer}
          />
        ) : (
          <NativeActionButton
            label={t("Take control")}
            prominence="secondary"
            style={{ alignSelf: "center" }}
            onPress={() => void openComputer({ takeControl: true })}
          />
        )}
      </View>
      {computer ? (
        <ComputerMaintenanceActions
          botId={botId ?? ""}
          computer={computer}
          onChanged={refreshAfterMaintenance}
        />
      ) : null}
      <ComputerModePicker
        value={computer?.mode}
        disabled={switching}
        onChange={(mode) => void setComputerMode(mode)}
      />

      <Modal
        visible={visible && (booting || computerOpen)}
        animationType="fade"
        presentationStyle="fullScreen"
        supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
        onRequestClose={() => {
          if (!booting) setComputerOpen(false);
        }}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          {booting ? (
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={{
                flex: 1,
                backgroundColor: tokens.background,
                alignItems: "center",
                justifyContent: "center",
                gap: 22,
                padding: 24,
              }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: 19,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {t("Booting {label}", { label })}
              </Text>
              <View
                style={{
                  height: 5,
                  width: "70%",
                  maxWidth: 420,
                  overflow: "hidden",
                  borderRadius: 999,
                  backgroundColor: tokens.muted,
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: "66%",
                    borderRadius: 999,
                    backgroundColor: tokens.primary,
                  }}
                />
              </View>
            </SafeAreaView>
          ) : (
            <KeyboardAvoidingView
              behavior="height"
              style={{ flex: 1, backgroundColor: tokens.background }}
            >
              <SafeAreaView
                edges={["top", "left", "right"]}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  borderBottomWidth: iosAtLeast(26) ? 0 : 1,
                  borderBottomColor: tokens.border,
                  paddingHorizontal: 14,
                  paddingVertical: 4,
                }}
              >
                <View
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      color: tokens.foreground,
                      fontSize: 15.5,
                      fontWeight: "500",
                    }}
                  >
                    {label}
                  </Text>
                  {hasControl ? (
                    <View
                      style={{
                        borderRadius: 999,
                        backgroundColor: tokens.muted,
                        paddingHorizontal: 9,
                        paddingVertical: 3,
                      }}
                    >
                      <Text numberOfLines={1} style={{ color: tokens.success, fontSize: 12 }}>
                        {t("You have control")}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {hasControl ? (
                    <ComputerReleaseActions
                      takeoverRequested={computer?.takeoverRequested ?? false}
                      onRelease={releaseComputer}
                    />
                  ) : (
                    <NativeActionButton
                      label={t("Take control")}
                      prominence="secondary"
                      fill={false}
                      style={{ alignSelf: "center" }}
                      onPress={() =>
                        void bootComputer({ takeControl: true, overlay: false }).catch(
                          () => undefined,
                        )
                      }
                    />
                  )}
                  <GlassIconButton
                    accessibilityLabel={t("Close computer")}
                    onPress={() => setComputerOpen(false)}
                    ios="xmark"
                    android="close"
                    size={36}
                    iconSize={16}
                  />
                </View>
              </SafeAreaView>
              <View style={{ flex: 1, backgroundColor: tokens.card }}>
                {viewVisible && loadedScreenUrl ? (
                  <ScreenWebView
                    key={screenRecovery.generation}
                    url={loadedScreenUrl}
                    interactive={hasControl}
                    nativeKeyboard={hasControl}
                    keyboardSession={keyboardSession}
                    webViewRef={screenWebViewRef}
                    onRendererLost={rendererLost}
                    onKeyboardMessage={(data) => {
                      if (
                        !viewVisible ||
                        !hasControl ||
                        viewEpochRef.current !== viewEpoch ||
                        screenRecoveryRef.current.generation !== screenRecovery.generation
                      )
                        return;
                      const gate = keyboardGate.current;
                      if (!isComputerKeyboardReadyMessage(data, String(gate.session))) return;
                      injectKeyboardCommands(gate.bridge.ready());
                    }}
                    onError={() => {
                      refreshController.invalidateScreen();
                      setScreenError(
                        t("Could not load the desktop. This device cannot reach the screen URL."),
                      );
                    }}
                  />
                ) : (
                  <View
                    style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}
                  >
                    <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                      {placeholder}
                    </Text>
                  </View>
                )}
              </View>
              {hasControl ? (
                <ComputerKeyboardBar
                  onCommand={(command) => {
                    if (
                      !viewVisible ||
                      !hasControl ||
                      viewEpochRef.current !== viewEpoch ||
                      screenRecoveryRef.current.generation !== screenRecovery.generation
                    )
                      return;
                    injectKeyboardCommands(keyboardGate.current.bridge.push(command));
                  }}
                />
              ) : null}
            </KeyboardAvoidingView>
          )}
        </SafeAreaProvider>
      </Modal>
    </ScrollView>
  );
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  const { t } = useI18n();
  const actions: Array<{ label: string; reason?: ComputerReleaseReason; primary?: boolean }> =
    takeoverRequested
      ? [
          { label: t("Skip"), reason: "skipped" },
          { label: t("I’m done"), reason: "done", primary: true },
        ]
      : [{ label: t("Release") }];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {actions.map((action) => (
        <NativeActionButton
          key={action.label}
          label={action.label}
          prominence={action.primary ? "primary" : "secondary"}
          fill={false}
          style={{ alignSelf: "center" }}
          onPress={() => void onRelease(action.reason)}
        />
      ))}
    </View>
  );
}

function ScreenWebView({
  url,
  interactive,
  nativeKeyboard = false,
  keyboardSession,
  webViewRef,
  onKeyboardMessage,
  onRendererLost,
  onError,
}: {
  url: string;
  interactive: boolean;
  nativeKeyboard?: boolean;
  keyboardSession?: string;
  webViewRef?: RefObject<WebView | null>;
  onKeyboardMessage?: (data: string) => void;
  onRendererLost: () => void;
  onError: () => void;
}) {
  const tokens = useMobileTokens();
  const sourceUrl = useRef(url);
  sourceUrl.current = retainScreenSource(sourceUrl.current, url);
  return (
    <WebView
      ref={webViewRef}
      // Reload when control enables the native keyboard. The boot script only
      // runs on load, and a view-only page never attaches the key bridge.
      key={`${nativeKeyboard ? "keys" : "view"}:${sourceUrl.current}`}
      source={{ uri: sourceUrl.current }}
      injectedJavaScriptBeforeContentLoaded={
        nativeKeyboard ? NATIVE_COMPUTER_KEYBOARD_BOOT : undefined
      }
      injectedJavaScript={
        nativeKeyboard && keyboardSession ? computerKeyboardReadyProbe(keyboardSession) : undefined
      }
      onMessage={
        nativeKeyboard
          ? (event) => {
              onKeyboardMessage?.(event.nativeEvent.data);
            }
          : undefined
      }
      style={{ flex: 1, backgroundColor: tokens.background }}
      pointerEvents={interactive ? "auto" : "none"}
      // A view-only screen is a picture: keep its page, including the hidden keyboard field,
      // out of VoiceOver and TalkBack.
      accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? "auto" : "no-hide-descendants"}
      javaScriptEnabled
      domStorageEnabled
      keyboardDisplayRequiresUserAction={false}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      originWhitelist={["*"]}
      mixedContentMode="always"
      setSupportMultipleWindows={false}
      scrollEnabled={false}
      overScrollMode="never"
      onError={onError}
      onHttpError={onError}
      onRenderProcessGone={onRendererLost}
      onContentProcessDidTerminate={onRendererLost}
    />
  );
}
