import { Image, StyleSheet, View } from "react-native";
import appMark from "../assets/notification-icon.png";
import { native, useThemedStyles } from "../lib/native";

const MARK = 56;

export function AppMark() {
  const styles = useThemedStyles(createAppMarkStyles);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.mark}
    >
      <Image source={appMark} style={styles.image} />
    </View>
  );
}

function createAppMarkStyles() {
  return StyleSheet.create({
    mark: {
      width: MARK,
      height: MARK,
      alignSelf: "center",
    },
    image: {
      width: MARK,
      height: MARK,
      tintColor: native.label,
    },
  });
}
