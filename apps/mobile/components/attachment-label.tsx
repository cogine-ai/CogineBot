import { StyleSheet, Text, View } from "react-native";

/** Keep duplicate-file identity outside the filename's truncation boundary. */
export function AttachmentLabel({
  name,
  description,
  color,
}: {
  name: string;
  description?: string;
  color: string;
}) {
  return (
    <View style={styles.container}>
      <Text style={[styles.text, { color }]} numberOfLines={1} ellipsizeMode="middle">
        {name}
      </Text>
      {description ? <Text style={[styles.text, { color }]}>{description}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { minWidth: 0, flexShrink: 1 },
  text: { fontSize: 15, flexShrink: 1 },
});
