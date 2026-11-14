import type { Routine } from "@rakazo/contracts";
import {
  cronFromPreset,
  defaultCronPreset,
  isOneShotRoutineCrons,
  presetFromCron,
} from "@rakazo/core";
import type { RoutineTriggerDraft } from "@rakazo/core/routine-trigger-patch";
import { routineTriggerDraft } from "@rakazo/core/routine-trigger-patch";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { RoutineSchedule } from "./routine-schedule";
import type { RoutineTriggerAccess } from "./routine-triggers";
import { RoutineTriggers } from "./routine-triggers";

export function RoutineFields({
  routine,
  seed,
  timezone,
  disabled: saving,
  access,
  onSave,
  onCancel,
}: {
  routine: Routine | null;
  seed?: { name: string; prompt: string };
  timezone: string;
  disabled: boolean;
  access: RoutineTriggerAccess | null;
  onSave: (
    name: string,
    prompt: string,
    crons: string[],
    triggers: RoutineTriggerDraft,
    original: Routine | null,
  ) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [original] = useState(routine);
  const [triggers, setTriggers] = useState<RoutineTriggerDraft>(() =>
    routine
      ? routineTriggerDraft(routine)
      : { webhookEnabled: false, githubEnabled: false, messageProvider: null, nativeTriggers: [] },
  );
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [triggerBusy, setTriggerBusy] = useState(false);
  const disabled = saving || triggerBusy;
  const [name, setName] = useState(routine?.name ?? seed?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? seed?.prompt ?? "");
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
      {triggersOpen && access ? (
        <RoutineTriggers
          value={triggers}
          onChange={setTriggers}
          disabled={disabled}
          access={access}
          onBusy={setTriggerBusy}
        />
      ) : (
        <NativeActionButton
          label={t("External triggers")}
          disabled={disabled || !access}
          prominence="secondary"
          onPress={() => setTriggersOpen(true)}
        />
      )}
      <NativeActionButton
        label={routine ? t("Save") : t("Create")}
        disabled={disabled || !name.trim() || !prompt.trim()}
        onPress={() =>
          onSave(
            name,
            prompt,
            once ? routine.crons : schedules.map((schedule) => schedule.cron),
            triggers,
            original,
          )
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
