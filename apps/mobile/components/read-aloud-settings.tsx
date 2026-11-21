import { useReadAloudSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  ReadAloudSettings,
  UpdateReadAloudInput,
  UpdateReadAloudResult,
} from "@rakazo/contracts";
import { useMemo, useSyncExternalStore } from "react";
import { Alert, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import type { useSpaceSettings } from "../lib/space-settings";
import type { MenuPickerChoice } from "./menu-picker";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

function nonce() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

export function ReadAloudSettingsRows({
  settings: { rpc, isCurrent },
}: {
  settings: Pick<ReturnType<typeof useSpaceSettings>, "rpc" | "isCurrent">;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey);
  const transport = useMemo(() => {
    const owner = captureMobileScope();
    return {
      read: (signal: AbortSignal) =>
        rpc<ReadAloudSettings>("preferences/readAloud", {}, { signal }),
      write: (input: UpdateReadAloudInput, signal: AbortSignal) =>
        rpc<UpdateReadAloudResult>("preferences/updateReadAloud", input, { signal }),
      isCurrent: () => isCurrent() && isMobileScopeCurrent(owner),
    };
  }, [rpc, isCurrent, scopeKey]);
  const { settings, pending, problem, load, save } = useReadAloudSettings(transport);
  const spaceSource =
    settings?.effective.source === "space"
      ? t("This Space")
      : settings?.effective.source === "account"
        ? t("My default")
        : t("System default");

  function saveSpace(value: boolean | "copy" | null) {
    if (!settings) return;
    void save({
      scope: "space",
      value,
      expectedRevision: settings.space.revision,
      expectedAccountRevision: settings.account.revision,
      clientNonce: nonce(),
    });
  }

  const labelValue = (value: boolean | null) =>
    value === null ? t("System default") : value ? t("On") : t("Off");
  const choices: MenuPickerChoice[] = [
    { key: "default", label: t("System default") },
    { key: "true", label: t("On") },
    { key: "false", label: t("Off") },
  ];
  const row = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 12,
  };
  return (
    <View style={{ gap: 12, marginBottom: 20 }}>
      <Text accessibilityRole="header" style={{ color: tokens.foreground, fontSize: 16 }}>
        {t("Read replies aloud")}
      </Text>
      {problem ? (
        <View style={row}>
          <Text accessibilityRole="alert" style={{ flex: 1, color: tokens.destructive }}>
            {problem === "conflict"
              ? t("Settings changed elsewhere.")
              : problem === "load"
                ? t("Could not load read-aloud settings.")
                : t("Could not save read-aloud settings.")}
          </Text>
          <NativeActionButton label={t("Reload")} disabled={pending} onPress={() => void load()} />
        </View>
      ) : null}
      {settings ? (
        <>
          <MenuPicker
            label={t("My default")}
            value={settings.account.value === null ? "default" : String(settings.account.value)}
            choices={choices}
            onChange={(choice) => {
              if (pending) return;
              const value = choice === "default" ? null : choice === "true";
              if (value === settings.account.value) return;
              const spaces = settings.followingSpaces.map(({ name }) => name).join(", ");
              Alert.alert(
                t("Change my read-aloud default?"),
                [
                  `${labelValue(settings.account.value)} → ${labelValue(value)}`,
                  t("This applies to new replies in Spaces that follow your default."),
                  spaces,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                [
                  { text: t("Cancel"), style: "cancel" },
                  {
                    text: t("Confirm"),
                    onPress: () =>
                      void save({
                        scope: "account",
                        value,
                        expectedRevision: settings.account.revision,
                        followingSpaceIds: settings.followingSpaces.map(({ id }) => id),
                        clientNonce: nonce(),
                      }),
                  },
                ],
              );
            }}
          />
          <View style={row}>
            <Text style={{ color: tokens.foreground }}>{t("Override in this Space")}</Text>
            <NativeSwitch
              accessibilityLabel={t("Override in this Space")}
              disabled={pending}
              value={settings.space.value !== null}
              onValueChange={(checked) => saveSpace(checked ? "copy" : null)}
            />
          </View>
          <View style={row}>
            <Text style={{ color: tokens.mutedForeground }}>{spaceSource}</Text>
            {settings.space.value === null ? (
              <Text style={{ color: tokens.foreground }}>
                {settings.effective.enabled ? t("On") : t("Off")}
              </Text>
            ) : (
              <NativeSwitch
                accessibilityLabel={t("Read replies aloud in this Space")}
                disabled={pending}
                value={settings.space.value}
                onValueChange={saveSpace}
              />
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}
