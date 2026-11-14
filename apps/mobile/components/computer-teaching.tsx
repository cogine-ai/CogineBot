import type { SkillPlaybook, TaughtSkill } from "@rakazo/contracts";
import { createTaughtSkillEditor } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { captureMobileScope, isMobileScopeCurrent } from "../lib/mobile-scope";
import { native, useMobileTokens } from "../lib/native";
import { spaceRequestContext } from "../lib/space-request-context";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

/** Key by Bot + mobile scope. The computer's existing WebView remains the input surface. */
export function ComputerTeaching({
  botId,
  active,
  supported,
  onChanged,
  onState,
  beforeStop,
}: {
  botId: string;
  active: boolean;
  supported: boolean;
  onChanged: () => Promise<void>;
  onState: (state: { verified: boolean; recordingId: string | null; busy: boolean }) => void;
  beforeStop: () => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [expanded, setExpanded] = useState(false);
  const [goal, setGoal] = useState("");
  const live = useRef(active);
  live.current = active;
  const editor = useMemo(() => {
    const scope = captureMobileScope();
    const lifecycle = { active: false, generation: 0 };
    const eligible = () => lifecycle.active && isMobileScopeCurrent(scope);
    async function request<T>(procedure: string, input: object): Promise<T> {
      const generation = lifecycle.generation;
      const current = () => eligible() && generation === lifecycle.generation;
      const context = await spaceRequestContext(scope, current);
      return rpc<T>(procedure, input, { requestContext: { ...context, isCurrent: current } });
    }
    const controller = createTaughtSkillEditor(
      botId,
      {
        list: () => request<TaughtSkill[]>("skills/list", { botId }),
        start: (goal) => request<TaughtSkill>("skills/start", { botId, goal }),
        stop: async (skillId) => {
          const generation = lifecycle.generation;
          await beforeStop();
          if (!eligible() || generation !== lifecycle.generation)
            throw new Error("Teaching target changed");
          return request<TaughtSkill>("skills/stop", { skillId });
        },
        update: (skillId, name, playbook) =>
          request<TaughtSkill>("skills/updateDraft", { skillId, name, playbook }),
        save: (skillId, name) => request<TaughtSkill>("skills/save", { skillId, name }),
        get: (skillId) => request<TaughtSkill>("skills/get", { skillId }),
        test: (skillId) => request<{ runId: string }>("skills/testRun", { skillId }),
      },
      eligible,
      render,
    );
    return {
      ...controller,
      setActive(value: boolean) {
        lifecycle.generation += 1;
        lifecycle.active = value;
        controller.setActive(value);
      },
    };
  }, [botId]);
  useEffect(() => {
    editor.setActive(active);
    return () => editor.setActive(false);
  }, [editor, active]);
  const state = editor.snapshot();
  const recording = state.skills.find((s) => s.status === "recording" || s.status === "drafting");
  useEffect(() => {
    onState({
      verified: active && state.verified,
      recordingId: recording?.id ?? null,
      busy: state.busy || recording?.status === "drafting",
    });
  }, [active, state.verified, recording?.id, recording?.status, state.busy, onState]);
  const disabled = !active || state.busy || !state.verified;
  async function recordingAction(action: () => Promise<void>) {
    await action();
    if (live.current && editor.isCurrent()) {
      setExpanded(true);
      await onChanged().catch(() => undefined);
    }
  }
  return (
    <View style={{ gap: 12, marginTop: 16 }}>
      <NativeActionButton
        label={recording ? t("Recording") : supported ? t("Teach a task") : t("Skills")}
        prominence="secondary"
        disabled={!active}
        onPress={() => setExpanded(!expanded)}
      />
      {active && recording ? (
        <NativeActionButton
          label={t("Stop teaching")}
          disabled={disabled}
          onPress={() => void recordingAction(() => editor.stop(recording.id))}
        />
      ) : null}
      {active && state.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {errorText(state.error, t("Could not load teaching status"))}
        </Text>
      ) : null}
      {active && (!state.verified || expanded) ? (
        <NativeActionButton
          label={t("Refresh")}
          disabled={state.busy}
          prominence="quiet"
          onPress={() => void editor.refresh()}
        />
      ) : null}
      <View style={{ display: expanded && active ? "flex" : "none", gap: 12 }}>
        {!recording && supported ? (
          <>
            <TextInput
              accessibilityLabel={t("What result will you demonstrate?")}
              placeholder={t("What result will you demonstrate?")}
              multiline
              maxLength={4000}
              value={goal}
              onChangeText={setGoal}
              editable={!disabled}
              style={{
                color: native.label,
                backgroundColor: native.fill,
                padding: 14,
                borderRadius: 12,
              }}
            />
            <NativeActionButton
              label={t("Start recording")}
              disabled={disabled || !goal.trim()}
              onPress={() => void recordingAction(() => editor.start(goal))}
            />
          </>
        ) : null}
        {state.skills
          .filter((s) => s.status === "draft" || s.status === "saved")
          .map((skill) => (
            <TaughtSkillCard
              key={skill.id}
              skill={skill}
              disabled={disabled}
              onSubmit={(name, playbook, mode) => editor.submit(skill.id, name, playbook, mode)}
              onRoutine={() =>
                editor.isCurrent() &&
                router.push({ pathname: "/routine", params: { botId, skillId: skill.id } })
              }
            />
          ))}
        {state.skills.some((skill) => skill.status === "draft" || skill.status === "saved") ? (
          <NativeActionButton
            label={t("View result")}
            disabled={disabled}
            onPress={() =>
              editor.isCurrent() && router.push({ pathname: "/thread", params: { botId } })
            }
          />
        ) : null}
      </View>
    </View>
  );
}

function TaughtSkillCard({
  skill,
  disabled,
  onSubmit,
  onRoutine,
}: {
  skill: TaughtSkill;
  disabled: boolean;
  onSubmit: (name: string, playbook: SkillPlaybook, mode: "save" | "test") => Promise<void>;
  onRoutine: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name);
  const [playbook, setPlaybook] = useState(skill.playbook);
  const [dirty, setDirty] = useState(false);
  // Refresh untouched fields, but keep edits through reconnects and failed saves.
  useEffect(() => {
    if (
      skill.status === "saved" &&
      skill.name === name &&
      JSON.stringify(skill.playbook) === JSON.stringify(playbook)
    )
      setDirty(false);
    else if (!dirty) {
      setName(skill.name);
      setPlaybook(skill.playbook);
    }
  }, [skill, dirty, name, playbook]);
  const fields: [keyof SkillPlaybook, string][] = [
    ["whenToUse", t("When to use")],
    ["inputs", t("Inputs")],
    ["steps", t("Steps")],
    ["howToCheck", t("How to check")],
    ["whatToReturn", t("What to return")],
    ["approvalBoundaries", t("Approval boundaries")],
    ["failureHandling", t("Failure handling")],
  ];
  const style = {
    color: native.label,
    backgroundColor: native.fill,
    padding: 14,
    borderRadius: 12,
  };
  return (
    <View style={{ backgroundColor: tokens.card, borderRadius: 12, padding: 14, gap: 12 }}>
      <Text style={{ color: tokens.foreground }}>{skill.name || skill.goal}</Text>
      <NativeActionButton
        label={t("Edit")}
        disabled={disabled}
        prominence="quiet"
        onPress={() => setEditing(!editing)}
      />
      {editing ? (
        <>
          <TextInput
            accessibilityLabel={t("Name")}
            placeholder={t("Name")}
            value={name}
            editable={!disabled}
            onChangeText={(value) => {
              setName(value);
              setDirty(true);
            }}
            style={style}
          />
          {fields.map(([field, label]) => (
            <View key={field} style={{ gap: 4 }}>
              <Text style={{ color: tokens.mutedForeground }}>{label}</Text>
              <TextInput
                accessibilityLabel={label}
                multiline
                editable={!disabled}
                value={
                  Array.isArray(playbook[field]) ? playbook[field].join("\n") : playbook[field]
                }
                onChangeText={(value) => {
                  setDirty(true);
                  setPlaybook({
                    ...playbook,
                    [field]: field === "inputs" || field === "steps" ? value.split("\n") : value,
                  });
                }}
                style={style}
              />
            </View>
          ))}
        </>
      ) : null}
      <NativeActionButton
        label={skill.status === "saved" && !dirty ? t("Saved") : t("Save")}
        disabled={disabled}
        onPress={() => {
          void onSubmit(name, playbook, "save");
        }}
      />
      <NativeActionButton
        label={t("Test")}
        disabled={disabled}
        prominence="secondary"
        onPress={() => void onSubmit(name, playbook, "test")}
      />
      {skill.status === "saved" ? (
        <NativeActionButton
          label={t("Add to routine")}
          disabled={disabled || dirty}
          prominence="secondary"
          onPress={onRoutine}
        />
      ) : null}
    </View>
  );
}
