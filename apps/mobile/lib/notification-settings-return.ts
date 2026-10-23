import type { AppStateStatus } from "react-native";
import { AppState } from "react-native";
import type { ChatNotifyPermissionStatus } from "./live-notifications";
import { openLiveNotificationSettings, readChatNotificationPermission } from "./live-notifications";

export type NotificationSettingsReturn = {
  open(): Promise<void>;
  focus(): void;
  blur(): void;
  cancel(): void;
};

/** One explicit Settings visit, owned by its route and saved notification intent. */
export function createNotificationSettingsReturn(options: {
  isCurrent: () => boolean;
  isFocused: () => boolean;
  onPermission: (status: ChatNotifyPermissionStatus) => void;
  onAllowed: (isCurrent: () => boolean) => Promise<void>;
}): NotificationSettingsReturn {
  let state: "armed" | "checking" | "done" | "cancelled" = "armed";
  let opened = false;
  let launchConfirmed = false;
  let leftApp = false;
  let returned = false;
  let generation = 0;
  let subscription: ReturnType<typeof AppState.addEventListener> | undefined;

  function removeListener() {
    subscription?.remove();
    subscription = undefined;
  }
  function cancel() {
    state = "cancelled";
    generation += 1;
    removeListener();
  }
  function checkReturn() {
    if (state !== "armed" || !launchConfirmed || !leftApp || !returned) return;
    if (!options.isCurrent()) {
      cancel();
      return;
    }
    if (!options.isFocused() || AppState.currentState !== "active") return;
    // Consume before the first await so duplicate active/focus events cannot replay it.
    state = "checking";
    const request = ++generation;
    const isCurrent = () =>
      state === "checking" &&
      request === generation &&
      options.isCurrent() &&
      options.isFocused() &&
      AppState.currentState === "active";
    void (async () => {
      const status = await readChatNotificationPermission(isCurrent);
      if (!isCurrent() || status === null) return;
      options.onPermission(status);
      if (status === "allowed" && isCurrent()) await options.onAllowed(isCurrent);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (state === "checking" && request === generation) {
          state = "done";
          removeListener();
        }
      });
  }
  function onAppState(next: AppStateStatus) {
    if (!options.isCurrent()) {
      cancel();
      return;
    }
    if (state === "checking") {
      if (next !== "active") cancel();
      return;
    }
    if (state !== "armed") return;
    if (next !== "active") {
      leftApp = true;
      returned = false;
    } else if (leftApp) {
      returned = true;
      checkReturn();
    }
  }
  return {
    async open() {
      if (opened || state !== "armed") return;
      if (!options.isCurrent() || !options.isFocused()) {
        cancel();
        return;
      }
      opened = true;
      subscription = AppState.addEventListener("change", onAppState);
      try {
        await openLiveNotificationSettings(
          () => state === "armed" && options.isCurrent() && options.isFocused(),
        );
        if (state !== "armed") return;
        launchConfirmed = true;
        checkReturn();
      } catch (error) {
        cancel();
        throw error;
      }
    },
    focus: checkReturn,
    blur() {
      if (state === "checking" || AppState.currentState === "active") cancel();
    },
    cancel,
  };
}
