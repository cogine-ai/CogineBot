import type { WebsiteLoginAnswer } from "@rakazo/contracts";
import { LOGIN_VALUE_TOO_LONG, loginCardFields, NamedLoginSecretValue } from "@rakazo/contracts";
import { WebsiteLoginAnswerUnconfirmed } from "@rakazo/core";
import { useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function WebsiteLoginSheet({
  botName,
  purpose,
  origin,
  labels,
  onClose,
  onProvide,
  onUnconfirmed,
}: {
  botName?: string;
  purpose: string;
  origin: string;
  labels: readonly string[];
  onClose: () => void;
  onProvide: (login: WebsiteLoginAnswer) => Promise<void>;
  onUnconfirmed: (receipt: WebsiteLoginAnswerUnconfirmed) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [fields, setFields] = useState(() => loginCardFields(labels));
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const login = NamedLoginSecretValue.safeParse({ fields });
  const tooLong =
    !login.success && login.error.issues.some((issue) => issue.message === LOGIN_VALUE_TOO_LONG);

  async function provide() {
    if (submitting || !login.success) return;
    setSubmitting(true);
    setFailed(false);
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
    try {
      await onProvide({ fields: login.data.fields, remember });
      onClose();
    } catch (error) {
      if (error instanceof WebsiteLoginAnswerUnconfirmed) {
        onUnconfirmed(error);
        onClose();
      } else {
        setFailed(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    if (!submitting) onClose();
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={styles.header}>
          <NativeActionButton
            label={t("Close")}
            onPress={close}
            prominence="plain"
            disabled={submitting}
          />
          <NativeActionButton
            label={t("Provide information")}
            onPress={() => void provide()}
            disabled={!login.success}
            busy={submitting}
            fill={false}
          />
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {botName ? (
            <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{botName}</Text>
          ) : null}
          <Text style={{ color: tokens.foreground, fontSize: 18 }}>{purpose}</Text>
          <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>{origin}</Text>
          {fields.map((field, index) => {
            const change = (update: Partial<WebsiteLoginAnswer["fields"][number]>) => {
              setFailed(false);
              setFields((current) =>
                current.map((entry, at) => (at === index ? { ...entry, ...update } : entry)),
              );
            };
            const label = field.label.toLowerCase();
            const autoFill =
              field.hidden && label === "password"
                ? "password"
                : !field.hidden && label === "username"
                  ? "username"
                  : undefined;
            return (
              <View key={field.label} style={styles.fieldGroup}>
                <View style={styles.row}>
                  <Text style={{ flex: 1, color: tokens.foreground }}>{field.label}</Text>
                  <Text style={{ color: tokens.mutedForeground }}>
                    {field.hidden ? t("Hidden") : t("Visible")}
                  </Text>
                  <NativeSwitch
                    accessibilityLabel={t("Hide {label}", { label: field.label })}
                    disabled={submitting}
                    value={field.hidden}
                    onValueChange={(hidden) => change({ hidden })}
                  />
                </View>
                <TextInput
                  accessibilityLabel={field.label}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete={autoFill === "password" ? "current-password" : (autoFill ?? "off")}
                  textContentType={autoFill ?? "none"}
                  editable={!submitting}
                  secureTextEntry={field.hidden}
                  maxLength={4096}
                  value={field.value}
                  onChangeText={(value) => change({ value })}
                  style={[styles.field, { borderColor: tokens.border, color: tokens.foreground }]}
                />
              </View>
            );
          })}
          <View style={styles.row}>
            <Text style={{ flex: 1, color: tokens.foreground }}>{t("Save for this Bot")}</Text>
            <NativeSwitch
              accessibilityLabel={t("Save for this Bot")}
              disabled={submitting}
              value={remember}
              onValueChange={(value) => {
                setFailed(false);
                setRemember(value);
              }}
            />
          </View>
          {!remember ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("For this task only")}</Text>
          ) : null}
          {failed ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("Could not send answer")}
            </Text>
          ) : null}
          {tooLong ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
              {t("These login values are too long together. Shorten one or more fields.")}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  content: { paddingHorizontal: 20, paddingVertical: 16, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  fieldGroup: { gap: 6 },
  field: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
