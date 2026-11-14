import { mapTeachPointer } from "@rakazo/core";
import { useRef } from "react";
import type { GestureResponderEvent } from "react-native";
import { StyleSheet, View } from "react-native";
import type { TeachingInput } from "../lib/teaching-input";

/** Reuses the displayed framebuffer; input goes through the recording-aware server route. */
export function TeachingTouchSurface({
  width,
  height,
  onInput,
}: {
  width: number;
  height: number;
  onInput: (input: TeachingInput) => void;
}) {
  const bounds = useRef({ left: 0, top: 0, width: 1, height: 1 });
  const pointer = (event: GestureResponderEvent, type: string) => {
    const { locationX, locationY } = event.nativeEvent;
    const point = mapTeachPointer(locationX, locationY, bounds.current, { width, height });
    onInput({ kind: "pointer", payload: { ...point, button: "left", type } });
  };
  return (
    <View
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        bounds.current = { left: 0, top: 0, ...event.nativeEvent.layout };
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(event) => pointer(event, "down")}
      onResponderRelease={(event) => {
        pointer(event, "move");
        pointer(event, "up");
      }}
      onResponderTerminate={(event) => pointer(event, "up")}
    />
  );
}
