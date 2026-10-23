import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";

type AllowedPushRegistration = Readonly<{
  permission: "allowed";
  requestContext: ApiRequestContext;
  isCurrent: () => boolean;
}>;

export async function registerPushToken(allowed?: AllowedPushRegistration) {
  const isCurrent = allowed?.isCurrent ?? (() => true);
  if (!isCurrent()) return;
  const requestContext = allowed
    ? {
        ...allowed.requestContext,
        headers: { ...allowed.requestContext.headers },
      }
    : undefined;
  if (!allowed) {
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;
  }
  try {
    if (!isCurrent()) return;
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!token || !isCurrent()) return;
    if (requestContext) await rpc("notifications/registerPush", { token }, { requestContext });
    else await rpc("notifications/registerPush", { token });
  } catch {
    // Expo Go cannot mint an ExponentPushToken without an EAS project id.
  }
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}
