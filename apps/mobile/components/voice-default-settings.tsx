import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  UpdateVoiceDefaultsInput,
  UpdateVoiceDefaultsResult,
  VoiceChoice,
  VoiceDefaults,
  VoiceInfo,
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
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

function nonce() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

export function VoiceDefaultSettingsRows({
  target: { rpc, isCurrent },
  catalog,
  busy,
  onChange,
  beginWrite,
  endWrite,
}: {
  target: Pick<ReturnType<typeof useSpaceSettings>, "rpc" | "isCurrent">;
  catalog: { provider: string; voices: VoiceInfo[] } | null;
  busy: boolean;
  onChange: () => Promise<unknown>;
  beginWrite: () => boolean;
  endWrite: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey);
  const transport = useMemo(() => {
    const owner = captureMobileScope();
    return {
      read: (signal: AbortSignal) => rpc<VoiceDefaults>("voice/defaults", {}, { signal }),
      write: (input: UpdateVoiceDefaultsInput, signal: AbortSignal) =>
        rpc<UpdateVoiceDefaultsResult>("voice/updateDefaults", input, { signal }),
      isCurrent: () => isCurrent() && isMobileScopeCurrent(owner),
    };
  }, [rpc, isCurrent, scopeKey]);
  const { settings, pending, problem, save, load } = usePreferenceSettings(transport);
  const choices = settings?.provider === catalog?.provider ? (catalog?.voices ?? []) : [];
  const account = settings?.account.value;
  const selected =
    account?.provider === catalog?.provider
      ? choices.find(({ id }) => id === account?.voiceId)
      : undefined;
  const effective = settings?.effective;
  const unavailable =
    effective?.source === "account" &&
    (!effective.choice ||
      (catalog?.provider === effective.choice.provider &&
        !choices.some(({ id }) => id === effective.choice?.voiceId)));
  const source =
    effective?.source === "space"
      ? t("This Space")
      : effective?.source === "account"
        ? t("My default")
        : t("System default");
  function label(choice: VoiceChoice | null) {
    if (!choice) return t("System default");
    return choice.provider === catalog?.provider
      ? (choices.find(({ id }) => id === choice.voiceId)?.label ?? choice.voiceId)
      : choice.voiceId;
  }
  async function sync(input?: UpdateVoiceDefaultsInput) {
    if (!transport.isCurrent() || !beginWrite()) return;
    try {
      if (input) {
        if (!(await save(input))) return;
      } else {
        await load();
      }
      if (transport.isCurrent()) await onChange();
    } finally {
      if (transport.isCurrent()) endWrite();
    }
  }
  const row = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 12,
  };
  return (
    <View style={{ gap: 12, marginBottom: 20 }}>
      {problem ? (
        <View style={row}>
          <Text accessibilityRole="alert" style={{ flex: 1, color: tokens.destructive }}>
            {problem === "conflict"
              ? t("Settings changed elsewhere.")
              : problem === "unavailable"
                ? t("Choose a voice available in this Space.")
                : problem === "load"
                  ? t("Could not load voice settings")
                  : t("Could not save that voice")}
          </Text>
          <NativeActionButton
            label={t("Reload")}
            disabled={pending || busy}
            onPress={() => void sync()}
          />
        </View>
      ) : null}
      {settings ? (
        <>
          {account || choices.length ? (
            <MenuPicker
              label={t("My default voice")}
              value={selected ? `voice:${selected.id}` : account ? "saved" : ""}
              choices={[
                { key: "", label: t("System default") },
                ...(account && !selected ? [{ key: "saved", label: label(account) }] : []),
                ...choices.map(({ id, label }) => ({ key: `voice:${id}`, label })),
              ]}
              onChange={(key) => {
                if (busy || pending || key === "saved" || (key === "" && !account)) return;
                const option = choices.find(({ id }) => `voice:${id}` === key);
                if (key !== "" && (!option || option.id === selected?.id)) return;
                const value =
                  option && catalog ? { provider: catalog.provider, voiceId: option.id } : null;
                Alert.alert(
                  t("Change my default voice?"),
                  [
                    `${label(account ?? null)} → ${label(value)}`,
                    t("Applies to new playback in following Spaces where the voice is available."),
                    settings.followingSpaces.map(({ name }) => name).join(", "),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Confirm"),
                      onPress: () =>
                        void sync({
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
          ) : null}
          <View style={row}>
            <Text style={{ flex: 1, color: tokens.foreground }}>
              {t("Override voice in this Space")}
            </Text>
            <NativeSwitch
              accessibilityLabel={t("Override voice in this Space")}
              value={settings.space.value}
              disabled={
                pending || busy || (!settings.space.value && (!effective?.choice || unavailable))
              }
              onValueChange={(enabled) =>
                void sync({
                  scope: "space",
                  enabled,
                  expectedRevision: settings.space.revision,
                  expectedAccountRevision: settings.account.revision,
                  expectedProvider: settings.provider,
                  clientNonce: nonce(),
                })
              }
            />
          </View>
          <View style={row}>
            <Text style={{ color: tokens.mutedForeground }}>{source}</Text>
            <Text style={{ flex: 1, textAlign: "right", color: tokens.foreground }}>
              {unavailable
                ? t("Choose a voice available in this Space.")
                : effective?.choice
                  ? label(effective.choice)
                  : t("Unavailable")}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}
