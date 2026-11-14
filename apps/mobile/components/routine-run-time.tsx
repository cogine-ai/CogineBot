import DateTimePicker from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { deviceTimeZone } from "../lib/routine";
import { NativeActionButton } from "./native-action-button";

/** One-shot instants use the device zone, like web's datetime-local input. */
export function RoutineRunTime({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [mode, setMode] = useState<"date" | "time" | "datetime" | null>(null);
  const [draft, setDraft] = useState(() => new Date(Date.now() + 60 * 60 * 1000));
  return (
    <View style={{ gap: 8 }}>
      <NativeActionButton
        label={value ? new Date(value).toLocaleString(locale) : t("Run time")}
        accessibilityLabel={t("Run time")}
        disabled={disabled}
        prominence="secondary"
        onPress={() => {
          setDraft(value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000));
          setMode(Platform.OS === "ios" ? "datetime" : "date");
        }}
      />
      <Text style={{ color: tokens.mutedForeground }}>{deviceTimeZone()}</Text>
      {mode && !disabled ? (
        <DateTimePicker
          key={mode}
          mode={mode}
          locale={Platform.OS === "ios" ? locale : undefined}
          value={draft}
          minimumDate={mode === "time" ? undefined : new Date()}
          onDismiss={() => setMode(null)}
          onValueChange={(_, date) => {
            setDraft(date);
            if (mode === "date") setMode("time");
            else if (mode === "time") {
              onChange(date.toISOString());
              setMode(null);
            }
          }}
        />
      ) : null}
      {mode === "datetime" && !disabled ? (
        <NativeActionButton
          label={t("Done")}
          onPress={() => {
            onChange(draft.toISOString());
            setMode(null);
          }}
        />
      ) : null}
    </View>
  );
}
