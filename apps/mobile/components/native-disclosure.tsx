import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { native } from "../lib/native";
import { Chevron } from "./row-accessories";

export type NativeDisclosureProps = {
  label: string;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  children?: ReactNode;
};

export function NativeDisclosure({
  label,
  expanded,
  onExpandedChange,
  children,
}: NativeDisclosureProps) {
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => onExpandedChange(!expanded)}
        style={styles.button}
      >
        <Chevron expanded={expanded} />
        <Text style={styles.label}>{label}</Text>
      </Pressable>
      {expanded ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  button: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  label: { flexShrink: 1, color: native.label },
});
