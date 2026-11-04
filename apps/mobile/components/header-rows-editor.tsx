import type { ModelHeaderRow } from "@rakazo/contracts";
import { ModelHeaderRowsSchema } from "@rakazo/contracts";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { SettingsGroup, SettingsRow } from "./settings-group";

/** Saved names are placeholders; editing supplies a complete replacement. */
export function HeaderRowsEditor({
  rows,
  savedNames = [],
  onChange,
  disabled,
}: {
  rows: ModelHeaderRow[] | null;
  savedNames?: string[];
  onChange: (rows: ModelHeaderRow[]) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const visible = rows ?? savedNames.map((name) => ({ name, value: "" }));
  return (
    <View style={styles.section}>
      {visible.map((row, index) => (
        <SettingsGroup key={index}>
          <TextInput
            accessibilityLabel={t("Header name")}
            placeholder={t("Header name")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!disabled}
            maxLength={256}
            value={row.name}
            onChangeText={(name) =>
              onChange(visible.map((entry, i) => (i === index ? { ...entry, name } : entry)))
            }
          />
          <TextInput
            accessibilityLabel={t("Header value")}
            placeholder={savedNames.includes(row.name) ? "••••••••" : t("Header value")}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            textContentType="none"
            secureTextEntry
            editable={!disabled}
            maxLength={1024}
            value={row.value}
            onChangeText={(value) =>
              onChange(visible.map((entry, i) => (i === index ? { ...entry, value } : entry)))
            }
          />
          <SettingsRow
            title={t("Remove header")}
            accessibilityLabel={t("Remove header")}
            destructive
            dimmed={disabled}
            disabled={disabled}
            onPress={() => onChange(visible.filter((_, i) => i !== index))}
          />
        </SettingsGroup>
      ))}
      {rows !== null && !ModelHeaderRowsSchema.safeParse(rows).success ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t("Check the custom headers.")}
        </Text>
      ) : null}
      <SettingsGroup>
        <SettingsRow
          title={t("Add header")}
          accessibilityLabel={t("Add header")}
          disabled={disabled || visible.length >= 8}
          dimmed={disabled || visible.length >= 8}
          onPress={() => onChange([...visible, { name: "", value: "" }])}
        />
      </SettingsGroup>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    section: { gap: 12, marginTop: 12 },
    input: {
      minHeight: 48,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 16,
      color: native.label,
    },
    error: { fontSize: 14, color: native.secondaryLabel },
  });
}
