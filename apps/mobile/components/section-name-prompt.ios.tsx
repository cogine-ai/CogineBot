import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { t } from "../lib/i18n";
import { sectionNameValidationError } from "../lib/inbox-organization";
import { errorText } from "../lib/user-error";
import type { SectionNamePromptProps } from "./section-name-prompt";

export function SectionNamePrompt(props: SectionNamePromptProps) {
  const latest = useRef(props);
  latest.current = props;
  const { title, initialName = "" } = props;
  useEffect(() => {
    let active = true;
    function prompt(value: string, message?: string) {
      if (!active) return;
      Alert.prompt(
        title,
        message,
        [
          { text: t("Cancel"), style: "cancel", onPress: () => latest.current.onClose() },
          {
            text: initialName ? t("Save") : t("Create"),
            onPress: (name?: string) => {
              if (!active) return;
              const trimmed = name?.trim() ?? "";
              const validationError = sectionNameValidationError(
                trimmed,
                latest.current.initialName,
              );
              if (validationError) {
                prompt(name ?? "", validationError);
                return;
              }
              void latest.current
                .onSave(trimmed)
                .then(() => {
                  if (active) latest.current.onClose();
                })
                .catch((cause: unknown) => {
                  prompt(name ?? "", errorText(cause, t("Could not save section")));
                });
            },
          },
        ],
        "plain-text",
        value,
      );
    }
    prompt(initialName);
    return () => {
      active = false;
    };
  }, [title, initialName]);
  return null;
}
