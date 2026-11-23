import { usePreferenceSettings } from "@rakazo/chat-ui/read-aloud";
import type {
  ThinkingDefaults,
  ThinkingLevel,
  UpdateThinkingDefaultsInput,
  UpdateThinkingDefaultsResult,
} from "@rakazo/contracts";
import {
  sameDefaultModel,
  ThinkingLevelSchema,
  unavailableSpaceThinkingLevel,
} from "@rakazo/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Alert, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "../lib/mobile-scope";
import { thinkingLevelLabel } from "../lib/model-catalog";
import { useMobileTokens } from "../lib/native";
import type { useSpaceSettings } from "../lib/space-settings";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

function nonce() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

export function ThinkingDefaultSettingsRows({
  target: { rpc, isCurrent },
  busy,
  begin,
  finish,
  onRead,
}: {
  target: Pick<ReturnType<typeof useSpaceSettings>, "rpc" | "isCurrent">;
  busy: boolean;
  begin: () => number | null;
  finish: (owner: number) => void;
  onRead: (settings: ThinkingDefaults | null) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scopeKey = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const transport = useMemo(() => {
    const owner = captureMobileScope();
    return {
      read: (signal: AbortSignal) =>
        rpc<ThinkingDefaults>("models/thinkingDefaults", {}, { signal }),
      write: (input: UpdateThinkingDefaultsInput, signal: AbortSignal) =>
        rpc<UpdateThinkingDefaultsResult>("models/updateThinkingDefaults", input, { signal }),
      isCurrent: () => isCurrent() && isMobileScopeCurrent(owner),
    };
  }, [rpc, isCurrent, scopeKey]);
  const { settings, pending, problem, load, save } = usePreferenceSettings(transport);
  useEffect(() => onRead(settings), [settings, onRead]);
  const account = settings?.account.value;
  const effective = settings?.effective;
  const unavailableSpaceLevel = unavailableSpaceThinkingLevel(settings);
  const levels: ThinkingLevel[] = settings?.levels.filter((level) => level !== "off") ?? [];
  const selected =
    account &&
    sameDefaultModel(account.model, settings?.binding?.model ?? null) &&
    levels.includes(account.level);
  const disabled = pending || busy;
  const accountValue = account ? (selected ? account.level : "saved") : "";
  const spaceValue = settings?.followsAccount
    ? "inherit"
    : unavailableSpaceLevel
      ? "saved"
      : effective?.level === "off" || (effective?.level && levels.includes(effective.level))
        ? effective.level
        : "modelDefault";
  const levelLabel = (level: ThinkingLevel | null | undefined) =>
    level ? thinkingLevelLabel(level, t) : t("Model default");
  const describeChoice = (level: ThinkingLevel | null | undefined, modelId?: string) =>
    level && modelId ? `${levelLabel(level)} · ${modelId}` : levelLabel(level);
  const levelChoices = levels.map((level) => ({ key: level, label: levelLabel(level) }));
  const source =
    effective?.source === "space"
      ? t("This Space")
      : effective?.source === "account"
        ? t("My default")
        : t("Model default");

  async function persist(input: UpdateThinkingDefaultsInput) {
    if (!transport.isCurrent()) return;
    const owner = begin();
    if (owner === null) return;
    try {
      await save(input);
    } finally {
      finish(owner);
    }
  }

  if (!problem && !account && !unavailableSpaceLevel && levels.length === 0) return null;
  return (
    <View style={{ gap: 10 }}>
      {problem ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text accessibilityRole="alert" style={{ flex: 1, color: tokens.destructive }}>
            {problem === "conflict"
              ? t("Settings changed elsewhere.")
              : problem === "unavailable"
                ? t("Thinking level is unavailable for this model.")
                : problem === "load"
                  ? t("Could not load thinking defaults")
                  : t("Could not save thinking defaults")}
          </Text>
          <NativeActionButton label={t("Reload")} disabled={disabled} onPress={() => void load()} />
        </View>
      ) : null}
      {settings ? (
        <>
          <MenuPicker
            label={t("My default thinking")}
            value={accountValue}
            choices={[
              { key: "", label: t("Model default") },
              ...(account && !selected
                ? [
                    {
                      key: "saved",
                      label: `${levelLabel(account.level)} · ${account.model.modelId}`,
                    },
                  ]
                : []),
              ...levelChoices,
            ]}
            onChange={(next) => {
              if (disabled || next === accountValue) return;
              const level = ThinkingLevelSchema.safeParse(next);
              if (next && !level.success) return;
              const value = level.data ?? null;
              Alert.alert(
                t("Change my default thinking?"),
                [
                  `${describeChoice(account?.level, account?.model.modelId)} → ${describeChoice(value, settings.binding?.model.modelId)}`,
                  t(
                    "New runs use this level on supported, matching models. These Spaces may be affected.",
                  ),
                  settings.followingSpaces.map(({ name }) => name).join(", "),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                [
                  { text: t("Cancel"), style: "cancel" },
                  {
                    text: t("Confirm"),
                    onPress: () =>
                      void persist({
                        scope: "account",
                        level: value,
                        binding: settings.binding,
                        expectedRevision: settings.account.revision,
                        followingSpaceIds: settings.followingSpaces.map(({ id }) => id),
                        clientNonce: nonce(),
                      }),
                  },
                ],
              );
            }}
          />
          {levels.length || unavailableSpaceLevel ? (
            <MenuPicker
              label={t("Thinking in this Space")}
              value={spaceValue}
              choices={[
                { key: "inherit", label: t("Follow my default") },
                ...(settings.followsAccount
                  ? [{ key: "copy", label: t("Keep the current level in this Space") }]
                  : []),
                ...(unavailableSpaceLevel
                  ? [{ key: "saved", label: levelLabel(unavailableSpaceLevel) }]
                  : []),
                ...(!settings.followsAccount && effective?.level === "off"
                  ? [{ key: "off", label: levelLabel("off") }]
                  : []),
                { key: "modelDefault", label: t("Model default") },
                ...levelChoices,
              ]}
              onChange={(next) => {
                if (disabled || next === spaceValue) return;
                const value =
                  next === "inherit" || next === "copy" || next === "modelDefault"
                    ? next
                    : ThinkingLevelSchema.safeParse(next).data;
                if (!value) return;
                void persist({
                  scope: "space",
                  value,
                  binding: settings.binding,
                  expectedRevision: settings.space.revision,
                  expectedAccountRevision: settings.account.revision,
                  expectedLevel: settings.effective.level,
                  clientNonce: nonce(),
                });
              }}
            />
          ) : null}
          <Text style={{ color: tokens.mutedForeground }}>
            {effective?.unsupported ? t("Thinking level is unavailable for this model.") : source}
          </Text>
        </>
      ) : null}
    </View>
  );
}
