import type {
  IntegrationSetupState,
  NativeAppId,
  NativeBeginInput,
  NativeSetupState,
} from "@rakazo/contracts";
import { NativeBeginInputSchema, NativeSetupStateSchema } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, TextInput, View } from "react-native";
import { captureApiRequestContext, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import type { IntegrationsCacheScope } from "../lib/integrations-cache";
import { integrationsCacheScope, isIntegrationsScopeCurrent } from "../lib/integrations-cache";
import { native, useThemedStyles } from "../lib/native";
import {
  nativeApplicationName,
  nativeConnectionMethodLabel,
  nativeCredentialLabel,
} from "../lib/native-connection-method";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

/** Account credentials stay in this mounted form; the existing screen owns the attempt. */
export function NativeAccountConnect({
  appId,
  previousConnectionId,
  onSubmit,
  onCancel,
}: {
  appId: NativeAppId;
  previousConnectionId?: string;
  onSubmit: (input: NativeBeginInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [state, setState] = useState<NativeSetupState | null>(null);
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const scope = useRef<IntegrationsCacheScope | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    let cancelled = false;
    scope.current = null;
    setState(null);
    setWebUrl(null);
    setSelectedId("");
    setCredential("");
    setError(null);
    setLoading(true);
    void (async () => {
      const current = await integrationsCacheScope();
      const requestContext = await captureApiRequestContext();
      if (cancelled || !isIntegrationsScopeCurrent(current)) return;
      const [result, setup] = await Promise.all([
        rpc<NativeSetupState>("nativeConnectors/status", {}, { requestContext }),
        rpc<IntegrationSetupState>("integrationSetup/get", {}, { requestContext }).catch(
          () => null,
        ),
      ]);
      if (cancelled || !isIntegrationsScopeCurrent(current)) return;
      const next = NativeSetupStateSchema.parse(result);
      scope.current = current;
      setState(next);
      setWebUrl(setup?.webUrl ?? null);
      const ready = next.configurations.filter(
        (entry) => entry.appId === appId && entry.enabled && entry.configured,
      );
      setSelectedId(ready.length === 1 ? ready[0]!.id : "");
    })()
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorText(reason, t("Could not load connection methods")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      scope.current = null;
    };
  }, [appId, previousConnectionId, reload]);
  const configurations =
    state?.configurations.filter(
      (entry) => entry.appId === appId && entry.enabled && entry.configured,
    ) ?? [];
  const selected = configurations.find((entry) => entry.id === selectedId);
  const usesConfiguredCredential = selected?.usesConfiguredCredential === true;
  const oauth = selected?.credentialKind === "oauth" || selected?.credentialKind === "mcp_oauth";
  const canChooseDriveFiles =
    appId === "google-drive" &&
    selected?.credentialKind === "oauth" &&
    !previousConnectionId &&
    selected.driveFilePickerAvailable === true;
  const webCredential = selected?.credentialKind === "github_app_installation";
  const credentialLabel = nativeCredentialLabel(appId, selected?.credentialKind, t);
  async function openWebSettings() {
    if (!webUrl || !scope.current || !isIntegrationsScopeCurrent(scope.current)) return;
    try {
      await Linking.openURL(webUrl);
    } catch (reason) {
      setError(errorText(reason, t("Could not open the web app")));
    }
  }
  async function submit(authorizationFlow?: "drive_picker") {
    if (!selected || submitting.current) return;
    if (authorizationFlow && !canChooseDriveFiles) return;
    if (webCredential) return;
    if (!scope.current || !isIntegrationsScopeCurrent(scope.current)) {
      setCredential("");
      setError(t("The server or space changed. Return and open this application again."));
      return;
    }
    const parsed = NativeBeginInputSchema.safeParse({
      configId: selected.id,
      ...(authorizationFlow ? { authorizationFlow } : {}),
      ...(previousConnectionId ? { previousConnectionId } : {}),
      ...(!oauth && !usesConfiguredCredential ? { credential: credential.trim() } : {}),
    });
    if (!parsed.success) {
      setError(t("Enter a valid credential"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data);
      setCredential("");
    } catch (reason) {
      setError(errorText(reason, t("Could not connect")));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <View style={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        {previousConnectionId ? t("Reconnect account") : t("Connect account")}
      </Text>
      <Text style={styles.secondary}>{nativeApplicationName(appId)}</Text>
      {loading ? <ActivityIndicator /> : null}
      {!loading && state && !configurations.length ? (
        <Text style={styles.secondary}>
          {state.canConfigure
            ? t("Set up a connection method in the web app first.")
            : t("Ask your administrator to enable a connection method.")}
        </Text>
      ) : null}
      {configurations.length ? (
        busy ? (
          <Text style={styles.secondary}>{selected?.label}</Text>
        ) : (
          <MenuPicker
            label={t("Connection method")}
            value={selectedId}
            choices={[
              ...(configurations.length > 1
                ? [{ key: "", label: t("Choose a connection method") }]
                : []),
              ...configurations.map((entry) => ({
                key: entry.id,
                label: nativeConnectionMethodLabel(entry, appId, t),
              })),
            ]}
            onChange={(value) => {
              setSelectedId(value);
              setCredential("");
              setError(null);
            }}
          />
        )
      ) : null}
      {selected && !oauth && !webCredential && !usesConfiguredCredential ? (
        <View style={styles.content}>
          <Text style={styles.label}>{credentialLabel}</Text>
          <TextInput
            accessibilityLabel={credentialLabel}
            value={credential}
            onChangeText={setCredential}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            editable={!busy}
            maxLength={16384}
            style={styles.input}
          />
          {selected.credentialKind === "machine_key" ? (
            <Text style={styles.secondary}>
              {t("Uses a machine identity restricted to the configured knowledge bases.")}
            </Text>
          ) : null}
          {selected.credentialKind === "internal_token" ? (
            <Text style={styles.secondary}>
              {t("Only pages shared with this integration are available.")}
            </Text>
          ) : null}
        </View>
      ) : null}
      {appId === "figma" && selected?.credentialKind === "oauth" ? (
        <Text style={styles.secondary}>
          {t(
            "Authorizing this Figma account replaces its previous authorization for this application.",
          )}
        </Text>
      ) : null}
      {webCredential ? (
        <View style={styles.content}>
          <Text style={styles.secondary}>
            {t("Connect this GitHub App installation in the web app.")}
          </Text>
          {webUrl ? (
            <NativeActionButton
              label={t("Open web app")}
              prominence="secondary"
              onPress={() => void openWebSettings()}
            />
          ) : null}
        </View>
      ) : null}
      {oauth ? (
        <Text style={styles.secondary}>
          {t(
            "Authorization opens in your system browser. If asked, sign in to this CogineBot instance to continue. Then return here to check the result.",
          )}
        </Text>
      ) : null}
      {canChooseDriveFiles ? (
        <View style={styles.content}>
          <Text style={styles.secondary}>
            {t("Connect with access to the files and folders you choose in Google.")}
          </Text>
          <NativeActionButton
            label={t("Choose accessible files")}
            prominence="secondary"
            disabled={busy}
            onPress={() => void submit("drive_picker")}
          />
        </View>
      ) : null}
      {appId === "google-drive" &&
      selected?.credentialKind === "oauth" &&
      !previousConnectionId &&
      selected.driveFilePickerAvailable === false ? (
        <Text style={styles.secondary}>
          {t("Ask an administrator to enable access to selected files.")}
        </Text>
      ) : null}
      {!loading && state?.canConfigure && !configurations.length && webUrl ? (
        <NativeActionButton
          label={t("Open web settings")}
          prominence="secondary"
          onPress={() => void openWebSettings()}
        />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Back to application")}
        prominence="quiet"
        onPress={() => {
          setCredential("");
          onCancel();
        }}
      />
      {!loading && !state ? (
        <NativeActionButton
          label={t("Try again")}
          prominence="secondary"
          onPress={() => setReload((value) => value + 1)}
        />
      ) : null}
      {configurations.length && !webCredential ? (
        <NativeActionButton
          label={
            usesConfiguredCredential
              ? t("Connect application")
              : oauth
                ? t("Authorize account")
                : selected?.credentialKind === "machine_key"
                  ? t("Connect machine")
                  : selected?.credentialKind === "internal_token"
                    ? t("Connect integration")
                    : t("Connect account")
          }
          busy={busy}
          disabled={!selected || (!oauth && !usesConfiguredCredential && !credential.trim())}
          onPress={() => void submit()}
        />
      ) : null}
    </View>
  );
}
function createStyles() {
  return StyleSheet.create({
    content: { gap: 12 },
    title: { color: native.label, fontSize: 20, fontWeight: "600" },
    label: { color: native.label, fontSize: 16 },
    secondary: { color: native.secondaryLabel, fontSize: 14, lineHeight: 20 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      paddingHorizontal: 14,
      color: native.label,
      backgroundColor: native.fill,
    },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
