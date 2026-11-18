import type { ModelCatalogEntry, ModelCredential, ModelSettings } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { ModelSettingsFields } from "@rakazo/core";
import {
  credentialModelSettings,
  modelCapabilitiesConfigurable,
  modelHasOwnSettings,
  modelSettingsDefaults,
  modelSettingsFields,
  modelSettingsRequest,
} from "@rakazo/core";
import { useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

/** One selected model on the current connection, using the shared form contract. */
export function ModelSettingsPanel({
  credential,
  modelId,
  entry,
  saveSettings,
  onSaved,
}: {
  credential: ModelCredential;
  modelId: string;
  entry?: ModelCatalogEntry;
  saveSettings: (settings: ModelSettings) => Promise<void>;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(false);
  const [edited, setEdited] = useState<ModelSettingsFields | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = modelSettingsFields(credentialModelSettings(credential, modelId), entry);
  const fields = edited ?? saved;
  const customized = modelHasOwnSettings(credential, modelId);
  const resettable =
    customized || Object.keys(credentialModelSettings(credential, modelId)).length > 0;
  const dirty = (Object.keys(fields) as (keyof ModelSettingsFields)[]).some(
    (key) => fields[key] !== saved[key],
  );
  const defaults = modelSettingsDefaults(credential.provider, entry);
  const capabilities = modelCapabilitiesConfigurable(credential.provider, entry);
  function update(patch: Partial<ModelSettingsFields>) {
    setEdited({ ...fields, ...patch });
    setError(null);
    setNotice(null);
  }
  function announce(message: string, failed = false) {
    setError(failed ? message : null);
    setNotice(failed ? null : message);
    AccessibilityInfo.announceForAccessibility(message);
  }
  async function persist(settings: ModelSettings) {
    Keyboard.dismiss();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await saveSettings(settings);
    } catch (err) {
      announce(errorText(err, t("Could not save model settings")), true);
      setPending(false);
      return;
    }
    try {
      await onSaved();
      setEdited(null);
      announce(t("Saved."));
    } catch (err) {
      announce(errorText(err, t("Could not load model settings")), true);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    const request = modelSettingsRequest({ fields, provider: credential.provider, entry });
    if (request.status === "invalid") {
      announce(
        request.field === "contextWindow"
          ? t("Enter a whole number from 1 to {max} for the context limit.", {
              max: MAX_MODEL_CONTEXT_WINDOW,
            })
          : request.field === "maxTokens"
            ? t("Enter a whole number from 1 to {max} for maximum output tokens.", {
                max: MAX_MODEL_MAX_TOKENS,
              })
            : request.field === "outputRoom"
              ? t("Maximum output tokens must be below the context limit.")
              : t("Enter a whole number from 1 to 1000 for the image limit."),
        true,
      );
      return;
    }
    await persist(request.settings);
  }
  function limit(
    label: string,
    value: string,
    change: (value: string) => void,
    placeholder?: number,
  ) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          keyboardType="number-pad"
          value={value}
          onChangeText={change}
          editable={!pending}
          placeholder={placeholder?.toString()}
          placeholderTextColor={native.tertiaryLabel}
          style={styles.input}
        />
      </View>
    );
  }
  function toggle(label: string, value: boolean, change: (value: boolean) => void) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <NativeSwitch
          accessibilityLabel={label}
          value={value}
          onValueChange={change}
          disabled={pending}
        />
      </View>
    );
  }
  return (
    <View testID="model-settings-panel" style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Advanced")}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.row}
      >
        <Text style={styles.label}>{t("Advanced")}</Text>
        <Text style={styles.secondary}>{customized ? t("Adjusted") : t("Default")}</Text>
      </Pressable>
      {expanded ? (
        <>
          {limit(
            t("Context limit"),
            fields.contextWindow,
            (contextWindow) => update({ contextWindow }),
            defaults.contextWindow,
          )}
          {limit(
            t("Maximum output tokens"),
            fields.maxTokens,
            (maxTokens) => update({ maxTokens }),
            defaults.maxTokens,
          )}
          {capabilities
            ? toggle(t("Supports images"), fields.images, (images) => update({ images }))
            : null}
          {fields.images
            ? limit(
                t("Maximum images per request"),
                fields.maxImagesPerPrompt,
                (maxImagesPerPrompt) => update({ maxImagesPerPrompt }),
              )
            : null}
          {capabilities
            ? toggle(t("Supports thinking"), fields.reasoning, (reasoning) => update({ reasoning }))
            : null}
          {dirty ? (
            <NativeActionButton
              disabled={pending}
              label={pending ? t("Saving…") : t("Save")}
              onPress={() => void save()}
            />
          ) : null}
          {resettable ? (
            <NativeActionButton
              disabled={pending}
              fill={false}
              label={t("Reset to defaults")}
              onPress={() => void persist({})}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : notice ? (
            <Text accessibilityRole="alert" style={styles.secondary}>
              {notice}
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
function createStyles() {
  return StyleSheet.create({
    panel: {
      marginTop: 16,
      borderRadius: 12,
      backgroundColor: native.groupedCell,
      overflow: "hidden",
    },
    row: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    label: { color: native.label, flex: 1, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    input: { color: native.label, textAlign: "right", width: 110, fontSize: 15 },
    error: { color: mobileTokens().destructive, padding: 12, fontSize: 13 },
  });
}
