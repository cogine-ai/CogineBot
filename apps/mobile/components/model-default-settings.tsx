import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  DefaultModelChoice,
  ModelDefaults,
  UpdateModelDefaultsInput,
  UpdateModelDefaultsResult,
} from "@rakazo/contracts";
import { defaultModelChoiceKey } from "@rakazo/contracts";
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

export function ModelDefaultSettingsRows({
  target: { rpc, isCurrent },
  label,
  busy,
  begin,
  finish,
  onChange,
}: {
  target: Pick<ReturnType<typeof useSpaceSettings>, "rpc" | "isCurrent">;
  label: (choice: DefaultModelChoice) => string;
  busy: boolean;
  begin: () => number | null;
  finish: (owner: number) => void;
  onChange: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const transport = useMemo(() => {
    const owner = captureMobileScope();
    return {
      read: (signal: AbortSignal) => rpc<ModelDefaults>("models/defaults", {}, { signal }),
      write: (input: UpdateModelDefaultsInput, signal: AbortSignal) =>
        rpc<UpdateModelDefaultsResult>("models/updateDefaults", input, { signal }),
      isCurrent: () => isCurrent() && isMobileScopeCurrent(owner),
    };
  }, [rpc, isCurrent, scopeKey]);
  const { settings, pending, problem, load, save } = usePreferenceSettings(transport);
  const account = settings?.account.value;
  const key = defaultModelChoiceKey;
  const selected = account ? key(account) : "";
  const listed = settings?.choices.some((choice) => key(choice) === selected);
  const effective = settings?.effective;
  const source =
    effective?.source === "account"
      ? t("My default")
      : effective?.source === "space"
        ? t("This Space")
        : t("System default");
  const choiceLabel = (value: DefaultModelChoice | null) =>
    value ? label(value) : t("No account default");
  async function sync(input?: UpdateModelDefaultsInput) {
    if (!transport.isCurrent()) return;
    const owner = begin();
    if (owner === null) return;
    try {
      if (input) {
        if (!(await save(input))) return;
      } else {
        await load();
      }
      if (transport.isCurrent()) await onChange();
    } finally {
      finish(owner);
    }
  }
  const row = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 12,
  };
  return (
    <View style={{ gap: 10 }}>
      {problem ? (
        <View style={row}>
          <Text accessibilityRole="alert" style={{ flex: 1, color: tokens.destructive }}>
            {problem === "conflict"
              ? t("Settings changed elsewhere.")
              : problem === "unavailable"
                ? t("Choose a model connection in this Space.")
                : problem === "load"
                  ? t("Could not load model defaults")
                  : t("Could not save model defaults")}
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
          {account || settings.choices.length ? (
            <MenuPicker
              label={t("My default model")}
              value={account && !listed ? "saved" : selected}
              choices={[
                { key: "", label: t("No account default") },
                ...(account && !listed ? [{ key: "saved", label: label(account) }] : []),
                ...settings.choices.map((choice) => ({ key: key(choice), label: label(choice) })),
              ]}
              onChange={(next) => {
                if (busy || pending || next === selected) return;
                const value = settings.choices.find((choice) => key(choice) === next) ?? null;
                if (next !== "" && !value) return;
                Alert.alert(
                  t("Change my default model?"),
                  [
                    `${choiceLabel(account ?? null)} → ${choiceLabel(value)}`,
                    t("Following Spaces use their own connection for new runs."),
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
              {t("Override model in this Space")}
            </Text>
            <NativeSwitch
              accessibilityLabel={t("Override model in this Space")}
              value={settings.space.value}
              disabled={
                pending ||
                busy ||
                (!settings.space.value && (!effective?.choice || Boolean(effective.unavailable)))
              }
              onValueChange={(enabled) =>
                void sync({
                  scope: "space",
                  enabled,
                  expectedRevision: settings.space.revision,
                  expectedAccountRevision: settings.account.revision,
                  expectedChoice: settings.effective.choice,
                  clientNonce: nonce(),
                })
              }
            />
          </View>
          <Text style={{ color: tokens.mutedForeground }}>
            {effective?.unavailable ? t("Choose a model connection in this Space.") : source}
          </Text>
        </>
      ) : null}
    </View>
  );
}
