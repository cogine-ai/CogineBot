import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ApprovalDetails({ detail }: { detail: string }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        style={styles.button}
      >
        <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("Details")}</Text>
      </Pressable>
      {expanded ? (
        <Text selectable style={[styles.detail, { color: tokens.foreground }]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 8 },
  button: { alignSelf: "flex-start", paddingVertical: 6 },
  label: { fontSize: 13.5 },
  detail: { fontSize: 12.5, fontFamily: "monospace", lineHeight: 20 },
});
