import DateTimePicker from "@expo/ui/community/datetime-picker";
import type { Routine } from "@rakazo/contracts";
import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  formatRoutineTime,
  isOneShotRoutineCrons,
  parseRoutineDateTime,
  routineCronPresets,
  routineDateTimeLocal,
} from "@rakazo/core";
import { useState } from "react";
import { Platform, Text, TextInput, View } from "react-native";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

export type RoutineTimingPatch = {
  active?: boolean;
  crons?: string[];
  startAt?: string | null;
  runAt?: string;
  intervalBased?: boolean;
};

const INTERVAL_UNITS: CronUnit[] = ["minutes", "hours", "days"];
const pad = (n: number) => String(n).padStart(2, "0");

function RepeatControl({
  value,
  onChange,
}: {
  value: CronPreset;
  onChange: (value: CronPreset) => void;
}) {
  const { t } = useI18n();
  const change = (patch: Partial<CronPreset>) => onChange({ ...value, ...patch });
  const freqText: Record<CronFreq, string> = {
    "Every hour": t("Every hour"),
    "Every day": t("Every day"),
    Weekdays: t("Weekdays"),
    "Every week": t("Every Monday"),
    "Every month": t("Monthly on the 1st"),
    Interval: t("Interval"),
    Advanced: t("Advanced"),
  };
  return (
    <View style={{ backgroundColor: native.fill, borderRadius: 16 }}>
      <MenuPicker
        label={t("How often")}
        choices={CRON_FREQS.map((freq) => ({ key: freq, label: freqText[freq] }))}
        value={value.freq}
        onChange={(key) => {
          const freq = key as CronFreq;
          change(freq === "Advanced" ? { freq, cron: cronFromPreset(value) } : { freq });
        }}
      />
      {value.freq === "Interval" ? (
        <>
          <MenuPicker
            label={t("Every")}
            choices={cronIntervalAmounts(value.unit, value.n).map((n) => ({
              key: String(n),
              label: String(n),
            }))}
            value={String(value.n)}
            onChange={(key) => change({ n: Number(key) })}
            divider
          />
          <MenuPicker
            label={t("Unit")}
            choices={INTERVAL_UNITS.map((unit) => ({ key: unit, label: t(unit) }))}
            value={value.unit}
            onChange={(key) => {
              const unit = key as CronUnit;
              change({ unit, n: clampIntervalAmount(value.n, unit) });
            }}
            divider
          />
        </>
      ) : value.freq === "Advanced" ? (
        <TextInput
          accessibilityLabel={t("Cron expression")}
          autoCapitalize="none"
          autoCorrect={false}
          value={value.cron}
          onChangeText={(cron) => change({ cron })}
          style={{ color: native.label, minHeight: 44, paddingHorizontal: 16 }}
        />
      ) : value.freq !== "Every hour" ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 4 }}>
          <Text style={{ color: native.secondaryLabel }}>{t("Time of day")}</Text>
          <LocalDateTimePicker
            value={clockToLocalInput(value.time)}
            zone="UTC"
            timeOnly
            onChange={(time) => change({ time: clockFromLocalInput(time) })}
          />
        </View>
      ) : null}
    </View>
  );
}

function clockToLocalInput(clock: string): string {
  const [time, period] = clock.split(" ");
  const [hour = 0, minute = 0] = (time ?? "").split(":").map(Number);
  return `2000-01-01T${pad((hour % 12) + (period === "PM" ? 12 : 0))}:${pad(minute)}`;
}

function clockFromLocalInput(value: string): string {
  const [hour = 0, minute = 0] = value.slice(11).split(":").map(Number);
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

function LocalDateTimePicker({
  value,
  zone,
  timeOnly = false,
  onChange,
}: {
  value: string;
  zone: string;
  timeOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [pick, setPick] = useState<"date" | "time" | null>(null);
  const [day = "", time = ""] = value.split("T");
  const actual = parseRoutineDateTime(value, zone);
  if (!actual) return null;
  if (Platform.OS === "ios") {
    return (
      <DateTimePicker
        mode={timeOnly ? "time" : "datetime"}
        display="compact"
        value={actual}
        timeZoneName={zone}
        onValueChange={(_, date) => onChange(routineDateTimeLocal(date, zone))}
      />
    );
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {timeOnly ? null : (
        <NativeActionButton
          label={day}
          accessibilityLabel={t("Date: {value}", { value: day })}
          onPress={() => setPick("date")}
        />
      )}
      <NativeActionButton
        label={time}
        accessibilityLabel={t("Time: {value}", { value: time })}
        onPress={() => setPick("time")}
      />
      {pick ? (
        <DateTimePicker
          mode={pick}
          value={new Date(pick === "date" ? `${day}T12:00` : `2000-01-01T${time}`)}
          positiveButton={{ label: t("Done") }}
          onDismiss={() => setPick(null)}
          onValueChange={(_, date) => {
            const nextDay = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
            const nextTime = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
            onChange(pick === "date" ? `${nextDay}T${time}` : `${day}T${nextTime}`);
            setPick(null);
          }}
        />
      ) : null}
    </View>
  );
}

export function RoutineTimingEditor({
  routine,
  readOnly,
  saving,
  onSave,
}: {
  routine: Routine;
  readOnly: boolean;
  saving: boolean;
  onSave: (patch: RoutineTimingPatch) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [editing, setEditing] = useState(false);
  const [schedules, setSchedules] = useState(() =>
    routineCronPresets(routine.crons, routine.intervalBased),
  );
  const [startAt, setStartAt] = useState<string | null | undefined>(undefined);
  const oneShot = isOneShotRoutineCrons(routine.crons);
  const repeating = routine.crons.length > 0 && !oneShot;
  const next = routine.nextRunAt
    ? formatRoutineTime(routine.nextRunAt, routine.timezone, dateLocaleForUi(locale))
    : null;
  const canArm = oneShot && !routine.lastRunAt && !routine.nextRunAt;
  const localNow = () => routineDateTimeLocal(new Date(Date.now() + 3_600_000), routine.timezone);
  const currentStart =
    routine.startAt && new Date(routine.startAt).getTime() > Date.now()
      ? routineDateTimeLocal(new Date(routine.startAt), routine.timezone)
      : null;
  const shownStart = startAt === undefined ? currentStart : startAt;
  const crons = schedules.map(cronFromPreset);
  const intervalBased = crons.length === 1 && schedules[0]?.freq === "Interval";
  const initial = routineCronPresets(routine.crons, routine.intervalBased);
  const changedCrons =
    crons.length !== initial.length ||
    initial.some((preset, i) => cronFromPreset(preset) !== crons[i]);
  const changedMode =
    routine.intervalBased !== undefined && intervalBased !== routine.intervalBased;
  const changed = startAt !== undefined || changedCrons || changedMode;

  async function save() {
    const runAt = canArm && startAt ? parseRoutineDateTime(startAt, routine.timezone) : null;
    const saved = await onSave(
      canArm
        ? { active: true, runAt: runAt?.toISOString() }
        : {
            ...(changedCrons ? { crons } : {}),
            ...(changedCrons || changedMode ? { intervalBased } : {}),
            ...(startAt === undefined ? {} : { startAt }),
          },
    );
    if (saved) setEditing(false);
  }

  return (
    <View style={{ gap: 8 }}>
      {next ? (
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
          {t("Next run: {time}", { time: next })}
        </Text>
      ) : null}
      {readOnly ? null : editing ? (
        <>
          {repeating
            ? schedules.map((preset, index) => (
                <RepeatControl
                  key={index}
                  value={preset}
                  onChange={(next) =>
                    setSchedules((items) => items.map((item, i) => (i === index ? next : item)))
                  }
                />
              ))
            : null}
          {shownStart ? (
            <>
              <Text style={{ color: tokens.mutedForeground }}>
                {canArm ? t("Run at") : t("First run")}
              </Text>
              <LocalDateTimePicker
                value={shownStart}
                zone={routine.timezone}
                onChange={setStartAt}
              />
              {repeating ? (
                <NativeActionButton
                  label={t("Use next occurrence")}
                  onPress={() => setStartAt(null)}
                />
              ) : null}
            </>
          ) : (
            <NativeActionButton label={t("Set first run")} onPress={() => setStartAt(localNow())} />
          )}
          <NativeActionButton
            label={saving ? t("Saving…") : t("Save")}
            disabled={saving || !changed}
            onPress={() => void save()}
          />
          <NativeActionButton
            label={t("Cancel")}
            disabled={saving}
            onPress={() => setEditing(false)}
          />
        </>
      ) : (
        <>
          {repeating || canArm ? (
            <NativeActionButton
              label={canArm ? t("Set run time") : t("Edit schedule")}
              disabled={saving}
              onPress={() => {
                setSchedules(routineCronPresets(routine.crons, routine.intervalBased));
                setStartAt(canArm ? localNow() : undefined);
                setEditing(true);
              }}
            />
          ) : null}
          {routine.active || !oneShot ? (
            <NativeActionButton
              label={routine.active ? t("Pause") : t("Resume")}
              disabled={saving}
              onPress={() => void onSave({ active: !routine.active })}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
