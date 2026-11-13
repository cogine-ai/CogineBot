import type { KnowledgeClient, KnowledgeSection, KnowledgeState } from "@rakazo/core";
import { createKnowledgeEditor, initialKnowledgeState } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { shareMemoryMarkdown } from "../lib/bot-package-file";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { captureMobileScope, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { mobileScopedClient } from "../lib/mobile-scoped-client";
import { native } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

export function KnowledgeEditor({
  botId,
  section,
  client,
}: {
  botId: string;
  section: KnowledgeSection;
  client: KnowledgeClient;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<KnowledgeState>(initialKnowledgeState);
  const manager = useRef<ReturnType<typeof createKnowledgeEditor> | null>(null);
  useLayoutEffect(() => {
    setState(initialKnowledgeState);
    const editor = createKnowledgeEditor({
      client,
      botId,
      section,
      changed: setState,
      deliver: shareMemoryMarkdown,
    });
    manager.current = editor;
    void editor.refresh();
    return () => {
      editor.dispose();
      manager.current = null;
    };
  }, [client, botId, section]);
  const readOnly = state.editor?.kind === "skill" && state.editor.skill?.readOnly;
  const savedContent =
    state.editor?.kind === "memory" ? state.editor.document.content : state.editor?.skill?.content;
  const selectedEditor = useRef(state.editor);
  selectedEditor.current = state.editor;
  function confirmDelete() {
    const selection = state.editor;
    const editor = manager.current;
    const skillId = state.editor?.kind === "skill" ? state.editor.skill?.id : undefined;
    Alert.alert(t("Delete skill?"), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          if (manager.current === editor && selectedEditor.current === selection)
            void editor?.remove(skillId);
        },
      },
    ]);
  }
  return (
    <View style={styles.section} testID="knowledge-editor">
      {state.busy ? <Text style={styles.secondary}>{t("Loading…")}</Text> : null}
      {state.error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.secondary}>
            {state.error === "load"
              ? t("Could not load")
              : state.error === "save"
                ? t("Could not save")
                : state.error === "delete"
                  ? t("Could not delete skill")
                  : t("Could not export memory")}
          </Text>
          {state.error === "load" ? (
            <NativeActionButton
              label={t("Retry")}
              disabled={state.busy}
              onPress={() => void manager.current?.refresh()}
            />
          ) : null}
        </View>
      ) : null}
      {!state.editor ? (
        <>
          {section === "skills"
            ? state.skills.map((skill) => (
                <View key={skill.id}>
                  <NativeActionButton
                    label={skill.name}
                    disabled={state.busy}
                    prominence="plain"
                    onPress={() => void manager.current?.openSkill(skill.id)}
                  />
                  <Text style={styles.secondary}>{skill.description}</Text>
                  {skill.readOnly ? <Text style={styles.secondary}>{t("Read only")}</Text> : null}
                </View>
              ))
            : state.documents.map((doc) => (
                <NativeActionButton
                  key={doc.id}
                  label={doc.path}
                  disabled={state.busy}
                  prominence="plain"
                  onPress={() => manager.current?.openDocument(doc)}
                />
              ))}
          {state.loaded &&
          !state.error &&
          !(section === "skills" ? state.skills.length : state.documents.length) ? (
            <Text style={styles.secondary}>
              {section === "skills" ? t("No skills yet") : t("Nothing remembered yet")}
            </Text>
          ) : null}
          {section === "skills" ? (
            <NativeActionButton
              label={t("New skill")}
              disabled={state.busy}
              prominence="secondary"
              onPress={() =>
                manager.current?.createSkill(
                  `---\nname: my-skill\ndescription: ${t("What this skill does and when to use it.")}\n---\n\n${t("Steps the agent should follow.")}\n`,
                )
              }
            />
          ) : null}
        </>
      ) : (
        <>
          <Text style={styles.heading}>
            {state.editor.kind === "memory"
              ? state.editor.document.path
              : (state.editor.skill?.name ?? t("New skill"))}
          </Text>
          {readOnly ? <Text style={styles.secondary}>{t("Read only")}</Text> : null}
          <TextInput
            accessibilityLabel={
              state.editor.kind === "memory" ? state.editor.document.path : "SKILL.md"
            }
            multiline
            value={state.draft}
            onChangeText={(text) => manager.current?.edit(text)}
            editable={!state.busy && !readOnly}
            autoCorrect={false}
            autoCapitalize="none"
            style={styles.input}
          />
          {!readOnly ? (
            <NativeActionButton
              label={t("Save")}
              disabled={
                state.busy ||
                state.draft === savedContent ||
                (section === "skills" && !state.draft.trim())
              }
              onPress={() => void manager.current?.save()}
            />
          ) : null}
          <NativeActionButton
            label={readOnly ? t("Close") : t("Cancel")}
            disabled={state.busy}
            prominence="quiet"
            onPress={() => manager.current?.cancel()}
          />
          {state.editor.kind === "skill" && state.editor.skill && !readOnly ? (
            <NativeActionButton
              label={t("Delete")}
              disabled={state.busy}
              prominence="destructive"
              onPress={confirmDelete}
            />
          ) : null}
        </>
      )}
      {section !== "skills" && state.loaded && state.documents.length ? (
        <NativeActionButton
          label={t("Export Markdown")}
          disabled={state.busy}
          prominence="secondary"
          onPress={() => void manager.current?.exportMarkdown()}
        />
      ) : null}
    </View>
  );
}

function KnowledgeTools({ botId, scope }: { botId: string; scope: MobileScope }) {
  const { t } = useI18n();
  const [client, setClient] = useState<KnowledgeClient | null>(null);
  const [section, setSection] = useState<KnowledgeSection | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setClient(null);
      setSection(null);
      setFailed(false);
      void mobileScopedClient(scope, () => active)
        .then((next) => {
          if (next.isCurrent()) setClient(next);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
      return () => {
        active = false;
        setClient(null);
        setSection(null);
      };
    }, [scope, retry]),
  );
  return (
    <View style={styles.section}>
      {failed ? (
        <NativeActionButton label={t("Retry")} onPress={() => setRetry((value) => value + 1)} />
      ) : null}
      {client ? (
        <>
          {(["bot", "user", "skills"] as const).map((value) => (
            <NativeActionButton
              key={value}
              label={
                value === "bot"
                  ? t("Bot memory")
                  : value === "user"
                    ? t("Shared documents")
                    : t("Shared skills")
              }
              selected={section === value}
              prominence="secondary"
              onPress={() => setSection(section === value ? null : value)}
            />
          ))}
          {section ? (
            <KnowledgeEditor key={section} botId={botId} section={section} client={client} />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function NativeKnowledgeTools({ botId }: { botId: string }) {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [key]);
  return <KnowledgeTools key={`${key}:${botId}`} botId={botId} scope={scope} />;
}
const styles = StyleSheet.create({
  section: { gap: 12, marginTop: 12 },
  heading: { fontSize: 16, fontWeight: "600", color: native.label },
  secondary: { fontSize: 14, color: native.secondaryLabel },
  input: {
    minHeight: 180,
    textAlignVertical: "top",
    fontSize: 14,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
});
