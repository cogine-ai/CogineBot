import { normalizePageTitle } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Modal, Platform, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

type Edit = { id: symbol; draft: string; onCommit: (next: string) => void; error?: string };

/**
 * Edits one line of text: the system prompt on iOS (Alert.prompt is iOS-only), a small dialog
 * elsewhere. `ask` opens it on a value; Save hands back a valid normalized title.
 */
export function useTextEditDialog(
  label: string,
  maxLength: number,
  isCurrent: () => boolean,
): {
  ask: (value: string, onCommit: (next: string) => void) => void;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [asked, setAsked] = useState<Edit | null>(null);
  const active = useRef<symbol | null>(null);
  useLayoutEffect(
    () => () => {
      active.current = null;
    },
    [],
  );
  function discard(id: symbol) {
    if (active.current !== id) return;
    active.current = null;
    setAsked(null);
  }
  function commit({ id, draft, onCommit }: Edit, onError: (error: string) => void) {
    if (active.current !== id) return;
    if (!isCurrent()) return discard(id);
    const title = normalizePageTitle(draft);
    if (!title) return onError(t("Enter a name"));
    if (/[\uD800-\uDFFF]/u.test(title)) return onError(t("Use a valid name"));
    if (title.length > maxLength)
      return onError(t("Use {count} characters or fewer", { count: maxLength }));
    discard(id);
    onCommit(title);
  }
  function ask(value: string, onCommit: (next: string) => void) {
    if (Platform.OS !== "ios") {
      if (!isCurrent()) return;
      const id = Symbol();
      active.current = id;
      setAsked({ id, draft: value, onCommit });
      return;
    }
    function prompt(draft: string, message?: string) {
      if (!isCurrent()) return;
      const id = Symbol();
      active.current = id;
      Alert.prompt(
        label,
        message,
        [
          { text: t("Cancel"), style: "cancel", onPress: () => discard(id) },
          {
            text: t("Save"),
            onPress: (next?: string) => {
              if (next === undefined) discard(id);
              else commit({ id, draft: next, onCommit }, (error) => prompt(next, error));
            },
          },
        ],
        "plain-text",
        draft,
      );
    }
    prompt(value);
  }
  function saveDialog(draft: string) {
    if (!asked) return;
    commit({ ...asked, draft }, (error) =>
      setAsked((current) => (current?.id === asked.id ? { ...current, draft, error } : current)),
    );
  }
  const dialog =
    Platform.OS !== "ios" && asked ? (
      <Modal transparent animationType="fade" onRequestClose={() => discard(asked.id)}>
        <View
          style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: native.fill }}
        >
          <View
            accessibilityViewIsModal
            style={{ padding: 24, gap: 16, borderRadius: 16, backgroundColor: tokens.card }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 18 }}>{label}</Text>
            <TextInput
              autoFocus
              accessibilityLabel={label}
              value={asked.draft}
              onChangeText={(draft) =>
                setAsked((current) =>
                  current?.id === asked.id ? { ...current, draft, error: undefined } : current,
                )
              }
              maxLength={maxLength}
              onSubmitEditing={({ nativeEvent }) => saveDialog(nativeEvent.text)}
              style={{ minHeight: 44, color: tokens.foreground }}
            />
            {asked.error ? (
              <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
                {asked.error}
              </Text>
            ) : null}
            <NativeActionButton label={t("Save")} onPress={() => saveDialog(asked.draft)} />
            <NativeActionButton
              label={t("Cancel")}
              prominence="plain"
              onPress={() => discard(asked.id)}
            />
          </View>
        </View>
      </Modal>
    ) : null;
  return { ask, dialog };
}
