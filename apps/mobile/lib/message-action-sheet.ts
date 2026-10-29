import type { AlertButton } from "react-native";
import { ActionSheetIOS, Alert, Platform } from "react-native";

type MessageAction = { text: string; onPress: () => void };

export function presentMessageActionSheet({
  actions,
  title,
  cancel,
  more,
  colorScheme,
  isCurrent = () => true,
}: {
  actions: MessageAction[];
  title?: string;
  cancel: string;
  more: string;
  colorScheme: "light" | "dark";
  isCurrent?: () => boolean;
}): void {
  if (!isCurrent()) return;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((action) => action.text), cancel],
        cancelButtonIndex: actions.length,
        title,
        userInterfaceStyle: colorScheme,
      },
      (index) => {
        if (isCurrent()) actions[index]?.onPress();
      },
    );
    return;
  }

  function showPage(remaining: MessageAction[]) {
    if (!isCurrent()) return;
    // Android alerts support three buttons. Back/outside tap dismisses every page.
    const buttons: AlertButton[] =
      remaining.length > 3
        ? [...remaining.slice(0, 2), { text: more, onPress: () => showPage(remaining.slice(2)) }]
        : [
            ...remaining,
            ...(remaining.length < 3 ? [{ text: cancel, style: "cancel" as const }] : []),
          ];
    Alert.alert(
      title ?? "",
      undefined,
      buttons.map((button) => ({
        ...button,
        onPress: button.onPress
          ? () => {
              if (isCurrent()) button.onPress?.();
            }
          : undefined,
      })),
      { cancelable: true },
    );
  }
  showPage(actions);
}
