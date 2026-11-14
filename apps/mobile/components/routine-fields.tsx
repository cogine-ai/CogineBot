import type { Routine } from "@rakazo/contracts";
import {
  cronFromPreset,
  defaultCronPreset,
  isOneShotRoutineCrons,
  presetFromCron,
} from "@rakazo/core";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { RoutineSchedule } from "./routine-schedule";

export function RoutineFields({
  routine,
  timezone,
  disabled,
  onSave,
  onCancel,
}: {
  routine: Routine | null;
  timezone: string;
  disabled: boolean;
  onSave: (name: string, prompt: string, crons: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedules, setSchedules] = useState(() =>
    (routine ? routine.crons : [cronFromPreset(defaultCronPreset())]).map((cron, id) => ({
      id,
      cron,
      preset: presetFromCron(cron),
    })),
  );
  const nextScheduleId = useRef(schedules.length);
  const once = routine && isOneShotRoutineCrons(routine.crons);
  const inputStyle = {
    color: native.label,
    backgroundColor: native.fill,
    padding: 14,
    borderRadius: 12,
  };
  return (
    <View style={{ gap: 12 }}>
      <TextInput
        accessibilityLabel={t("Name")}
        placeholder={t("Name")}
        value={name}
        onChangeText={setName}
        editable={!disabled}
        maxLength={80}
        style={inputStyle}
      />
      <TextInput
        accessibilityLabel={t("Prompt")}
        placeholder={t("Prompt")}
        value={prompt}
        onChangeText={setPrompt}
        editable={!disabled}
        multiline
        style={inputStyle}
      />
      {!routine ? <Text style={{ color: tokens.mutedForeground }}>{timezone}</Text> : null}
      {!once ? (
        <>
          {schedules.map((schedule, index) => (
            <View key={schedule.id} style={{ gap: 8 }}>
              <RoutineSchedule
                value={schedule.preset}
                disabled={disabled}
                onChange={(next) =>
                  setSchedules((values) =>
                    values.map((value, i) =>
                      i === index ? { ...value, preset: next, cron: cronFromPreset(next) } : value,
                    ),
                  )
                }
              />
              <NativeActionButton
                label={t("Remove schedule")}
                prominence="quiet"
                disabled={disabled}
                onPress={() => setSchedules((values) => values.filter((_, i) => i !== index))}
              />
            </View>
          ))}
          <NativeActionButton
            label={t("Add schedule")}
            prominence="secondary"
            disabled={disabled}
            onPress={() => {
              const preset = defaultCronPreset();
              const id = nextScheduleId.current++;
              setSchedules((values) => [...values, { id, preset, cron: cronFromPreset(preset) }]);
            }}
          />
        </>
      ) : null}
      <NativeActionButton
        label={routine ? t("Save") : t("Create")}
        disabled={disabled || !name.trim() || !prompt.trim()}
        onPress={() =>
          onSave(name, prompt, once ? routine.crons : schedules.map((schedule) => schedule.cron))
        }
      />
      <NativeActionButton
        label={t("Cancel")}
        prominence="quiet"
        disabled={disabled}
        onPress={onCancel}
      />
    </View>
  );
}
