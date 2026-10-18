import type { MenuAction, MenuComponentRef } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { ReactElement } from "react";
import { cloneElement, useCallback, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useResolvedAppearance } from "../lib/native";

export function InboxContextMenu({
  actions,
  onAction,
  children,
  enabled = true,
}: {
  actions: MenuAction[];
  onAction: (id: string) => void;
  children: ReactElement<{ onLongPress?: () => void }>;
  enabled?: boolean;
}) {
  const appearance = useResolvedAppearance();
  const menu = useRef<MenuComponentRef>(null);
  const open = useCallback(() => menu.current?.show(), []);
  const [width, setWidth] = useState(0);
  // Android's inner Pressable owns the gesture; forward it to the native menu.
  const trigger =
    enabled && Platform.OS === "android" ? cloneElement(children, { onLongPress: open }) : children;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {enabled && width > 0 ? (
        <MenuView
          ref={menu}
          actions={actions}
          colorScheme={appearance}
          shouldOpenOnLongPress
          onPressAction={(event) => onAction(event.nativeEvent.event)}
        >
          {/* The native menu bridge measures its RN trigger without a width constraint. */}
          <View style={{ width }}>{trigger}</View>
        </MenuView>
      ) : (
        trigger
      )}
    </View>
  );
}
