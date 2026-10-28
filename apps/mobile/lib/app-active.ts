import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

function subscribe(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

const currentActive = () => AppState.currentState === "active";

/** System overlays and an unknown launch state pause live computer viewing. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, currentActive, currentActive);
}
