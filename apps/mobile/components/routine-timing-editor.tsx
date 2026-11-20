import DateTimePicker from "@expo/ui/community/datetime-picker";
import type { Routine } from "@rakazo/contracts";
import type { CronFreq, CronPreset, CronUnit } from "@rakazo/core";
import {
  CRON_FREQS,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  defaultRoutineDateTimeLocal,
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
            value={clockToDate(value.time)}
            zone="UTC"
            timeOnly
            onChange={(date) => change({ time: clockFromDate(date) })}
          />
        </View>
      ) : null}
    </View>
  );
}

function clockToDate(clock: string): Date {
  const [time, period] = clock.split(" ");
  const [hour = 0, minute = 0] = (time ?? "").split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, (hour % 12) + (period === "PM" ? 12 : 0), minute));
}

function clockFromDate(value: Date): string {
  const hour = value.getUTCHours();
  const minute = value.getUTCMinutes();
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

function LocalDateTimePicker({
  value,
  zone,
  timeOnly = false,
  onChange,
}: {
  value: Date;
  zone: string;
  timeOnly?: boolean;
  onChange: (value: Date) => void;
}) {
  const { t } = useI18n();
  const [pick, setPick] = useState<"date" | "time" | null>(null);
  if (Platform.OS === "ios") {
    return (
      <DateTimePicker
        mode={timeOnly ? "time" : "datetime"}
        display="compact"
        value={value}
        timeZoneName={zone}
        onValueChange={(_, date) => onChange(date)}
      />
    );
  }
  const [day = "", time = ""] = routineDateTimeLocal(value, zone).split("T");
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
            const selected = parseRoutineDateTime(
              pick === "date" ? `${nextDay}T${time}` : `${day}T${nextTime}`,
              zone,
            );
            if (selected) onChange(selected);
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
  const localNow = () => defaultRoutineDateTimeLocal(new Date(), routine.timezone);
  const savedStart = routine.startAt ? new Date(routine.startAt) : null;
  const currentStart = savedStart && savedStart.getTime() > Date.now() ? savedStart : null;
  const shownStart = startAt === undefined ? currentStart : startAt && new Date(startAt);
  const crons = schedules.map(cronFromPreset);
  const intervalBased = crons.length === 1 && schedules[0]?.freq === "Interval";
  const initial = routineCronPresets(routine.crons, routine.intervalBased);
  const changedCrons =
    crons.length !== initial.length ||
    initial.some((preset, i) => cronFromPreset(preset) !== crons[i]);
  const changedMode =
    routine.intervalBased !== undefined && intervalBased !== routine.intervalBased;
  const changed = startAt !== undefined || changedCrons || changedMode;

  function chooseLocalStart(value: string) {
    const date = parseRoutineDateTime(value, routine.timezone);
    if (date) setStartAt(date.toISOString());
  }

  async function save() {
    const saved = await onSave(
      canArm
        ? { active: true, runAt: startAt ?? undefined }
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
          <View
            pointerEvents={saving ? "none" : "auto"}
            accessibilityElementsHidden={saving}
            importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
            style={{ gap: 8 }}
          >
            {repeating
              ? schedules.map((preset, index) => (
                  <RepeatControl
                    key={index}
                    value={preset}
                    onChange={(next) => {
                      if (!saving)
                        setSchedules((items) =>
                          items.map((item, i) => (i === index ? next : item)),
                        );
                    }}
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
                  onChange={(date) => {
                    if (!saving) setStartAt(date.toISOString());
                  }}
                />
                {repeating ? (
                  <NativeActionButton
                    label={t("Use next occurrence")}
                    disabled={saving}
                    onPress={() => setStartAt(null)}
                  />
                ) : null}
              </>
            ) : (
              <NativeActionButton
                label={t("Set first run")}
                disabled={saving}
                onPress={() => chooseLocalStart(localNow())}
              />
            )}
          </View>
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
                if (canArm) chooseLocalStart(localNow());
                else setStartAt(undefined);
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
