import { parseBotAvatarValue } from "@rakazo/contracts";
import {
  DEFAULT_GROK_BOT_COLOR,
  GAZE_BOT_COLORS,
  GAZE_SHAPE_KEYS,
  resolveGazeAvatar,
  resolvePersonaColorDef,
} from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { captureMobileScope, isMobileScopeCurrent } from "../lib/mobile-scope";
import { useMobileTokens } from "../lib/native";
import { pickBotAvatar } from "../lib/pick-bot-avatar";
import { BotAvatar } from "./bot-avatar";
import { MenuPicker, MenuPickerMenu } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

export function BotAvatarEditor({
  value,
  identity,
  status,
  disabled,
  onChange,
  onBusyChange,
}: {
  value: string;
  identity: string;
  status?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [identity],
  );
  const parsed = parseBotAvatarValue(value);
  const isShape = parsed.kind === "shape" || parsed.kind === "color";
  const color = resolvePersonaColorDef(
    identity,
    isShape ? parsed.color : DEFAULT_GROK_BOT_COLOR,
  ).hex;
  const shape = resolveGazeAvatar(
    identity,
    parsed.kind === "shape" ? parsed.shapeIndex : undefined,
  ).shapeIndex;
  const shapeLabels = [
    t("Circle"),
    t("Square"),
    t("Triangle"),
    t("Pentagon"),
    t("Hexagon"),
    t("Octagon"),
    t("Diamond"),
    t("Pill"),
    t("Column"),
    t("Egg"),
    t("Arch"),
  ];
  const blocked = disabled || busy;
  function change(next: string) {
    if (blocked) return;
    attempt.current += 1;
    setError(null);
    onChange(next);
  }
  async function chooseImage() {
    if (blocked) return;
    const id = ++attempt.current;
    const scope = captureMobileScope();
    const current = () => id === attempt.current && isMobileScopeCurrent(scope);
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const next = await pickBotAvatar(current);
      if (next && current()) {
        onChange(next);
        setOpen(false);
      }
    } catch {
      if (current()) setError(t("Could not open image. Try again."));
    } finally {
      if (current()) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  return (
    <View style={{ marginBottom: 24 }}>
      <View style={{ alignItems: "center" }}>
        <MenuPickerMenu
          label={t("Customize bot avatar")}
          choices={[{ key: "edit", label: t("Customize bot avatar") }]}
          value=""
          disabled={blocked}
          onChange={() => setOpen(!open)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("Customize bot avatar")}
            accessibilityState={{ disabled: blocked, expanded: open }}
          >
            <BotAvatar
              color={value}
              identity={identity}
              size={64}
              status={open ? undefined : status}
            />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                right: -4,
                bottom: -4,
                borderRadius: 12,
                padding: 4,
                backgroundColor: tokens.card,
              }}
            >
              <NativeSymbol ios="pencil" android="pencil" size={14} color={tokens.foreground} />
            </View>
          </View>
        </MenuPickerMenu>
      </View>
      {open ? (
        <>
          <MenuPicker
            label={t("Shape")}
            value={isShape ? String(shape) : ""}
            disabled={blocked}
            choices={[
              ...(!isShape ? [{ key: "", label: t("Image") }] : []),
              ...GAZE_SHAPE_KEYS.map((_, index) => ({
                key: String(index),
                label: shapeLabels[index]!,
              })),
            ]}
            onChange={(key) => {
              if (key) change(`${color}::shape_${key}`);
            }}
          />
          <MenuPicker
            label={t("Color")}
            value={isShape ? color : ""}
            disabled={blocked}
            choices={[
              ...(!isShape ? [{ key: "", label: t("Image") }] : []),
              ...GAZE_BOT_COLORS.map((option, index) => ({
                key: option,
                label: t("Color {number}", { number: index + 1 }),
              })),
            ]}
            onChange={(next) => {
              if (next) change(`${next}::shape_${shape}`);
            }}
          />
          <NativeActionButton
            label={t("Choose image")}
            disabled={blocked}
            prominence="secondary"
            onPress={() => void chooseImage()}
          />
          <NativeActionButton
            label={t("Reset")}
            disabled={blocked}
            prominence="secondary"
            onPress={() => change(isShape ? parsed.color : DEFAULT_GROK_BOT_COLOR)}
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
