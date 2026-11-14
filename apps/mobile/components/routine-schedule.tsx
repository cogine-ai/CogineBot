import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import { CRON_FREQS, clampIntervalAmount, cronFromPreset, cronIntervalAmounts } from "@rakazo/core";
import { TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { MenuPicker } from "./menu-picker";

/** The same presets and cron conversion used by the web editor. */
export function RoutineSchedule({
  value,
  onChange,
  disabled,
}: {
  value: CronPreset;
  onChange: (value: CronPreset) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const patch = (change: Partial<CronPreset>) => {
    if (!disabled) onChange({ ...value, ...change });
  };
  const times = [
    ...new Set([
      "6:00 AM",
      "7:00 AM",
      "8:00 AM",
      "9:00 AM",
      "12:00 PM",
      "3:00 PM",
      "6:00 PM",
      "9:00 PM",
      value.time,
    ]),
  ];
  return (
    <View style={{ gap: 8 }}>
      <MenuPicker
        label={t("How often")}
        value={value.freq}
        choices={CRON_FREQS.map((freq) => ({ key: freq, label: t(freq) }))}
        onChange={(freq) =>
          patch({
            freq: freq as CronFreq,
            ...(freq === "Advanced" ? { cron: cronFromPreset(value) } : {}),
          })
        }
      />
      {value.freq === "Interval" ? (
        <>
          <MenuPicker
            label={t("Interval amount")}
            value={String(value.n)}
            choices={cronIntervalAmounts(value.unit, value.n).map((n) => ({
              key: String(n),
              label: String(n),
            }))}
            onChange={(n) => patch({ n: Number(n) })}
          />
          <MenuPicker
            label={t("Interval unit")}
            value={value.unit}
            choices={["minutes", "hours", "days"].map((unit) => ({ key: unit, label: t(unit) }))}
            onChange={(unit) =>
              patch({ unit: unit as CronUnit, n: clampIntervalAmount(value.n, unit as CronUnit) })
            }
          />
        </>
      ) : null}
      {["Every day", "Weekdays", "Every week", "Every month"].includes(value.freq) ? (
        <MenuPicker
          label={t("Time of day")}
          value={value.time}
          choices={times.map((time) => ({ key: time, label: time }))}
          onChange={(time) => patch({ time })}
        />
      ) : null}
      {value.freq === "Advanced" ? (
        <TextInput
          accessibilityLabel={t("Cron expression")}
          value={value.cron}
          onChangeText={(cron) => patch({ cron })}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            color: native.label,
            backgroundColor: native.fill,
            padding: 12,
            borderRadius: 12,
          }}
        />
      ) : null}
    </View>
  );
}
