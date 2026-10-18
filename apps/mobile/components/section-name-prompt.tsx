import {
  AlertDialog,
  Host,
  Text,
  TextButton,
  TextField,
  useNativeState,
} from "@expo/ui/jetpack-compose";
import { useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { sectionNameValidationError } from "../lib/inbox-organization";
import { useResolvedAppearance } from "../lib/native";
import { errorText } from "../lib/user-error";

export type SectionNamePromptProps = {
  title: string;
  initialName?: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
};

/** Android uses the native Compose dialog; iOS supplies its native alert prompt. */
export function SectionNamePrompt({ title, initialName, onSave, onClose }: SectionNamePromptProps) {
  const { t } = useI18n();
  const appearance = useResolvedAppearance();
  const name = useNativeState(initialName ?? "");
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(value: string) {
    if (busy.current) return;
    const validationError = sectionNameValidationError(value, initialName);
    if (validationError) {
      setError(validationError);
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await onSave(value.trim());
      onClose();
    } catch (cause) {
      setError(errorText(cause, t("Could not save section")));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <Host colorScheme={appearance} style={{ position: "absolute" }}>
      <AlertDialog onDismissRequest={saving ? undefined : onClose}>
        <AlertDialog.Title>
          <Text>{title}</Text>
        </AlertDialog.Title>
        <AlertDialog.Text>
          <TextField
            value={name}
            autoFocus
            singleLine
            maxLength={60}
            enabled={!saving}
            isError={!!error}
            keyboardOptions={{ imeAction: "done" }}
            keyboardActions={{ onDone: (value) => void save(value) }}
            onValueChange={() => setError(null)}
          >
            <TextField.Label>
              <Text>{t("Name")}</Text>
            </TextField.Label>
            {error ? (
              <TextField.SupportingText>
                <Text>{error}</Text>
              </TextField.SupportingText>
            ) : null}
          </TextField>
        </AlertDialog.Text>
        <AlertDialog.DismissButton>
          <TextButton enabled={!saving} onClick={onClose}>
            <Text>{t("Cancel")}</Text>
          </TextButton>
        </AlertDialog.DismissButton>
        <AlertDialog.ConfirmButton>
          <TextButton enabled={!saving} onClick={() => void save(name.get())}>
            <Text>{initialName ? t("Save") : t("Create")}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
      </AlertDialog>
    </Host>
  );
}
