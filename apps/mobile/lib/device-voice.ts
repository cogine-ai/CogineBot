import * as SecureStore from "expo-secure-store";

export const DEVICE_VOICE_KEY = "rakazo.device-voice";
let intentVersion = 0;
let pendingWrites: Promise<void> = Promise.resolve();

/** Shared across settings lifetimes because this preference belongs to the device. */
export function beginDeviceVoiceIntent(): number {
  return ++intentVersion;
}

export function currentDeviceVoiceIntent(): number {
  return intentVersion;
}

export async function loadDeviceVoiceEnabled(): Promise<boolean> {
  // Observe writes accepted before this read, including ones from a previous form.
  await pendingWrites;
  return (await SecureStore.getItemAsync(DEVICE_VOICE_KEY)) === "1";
}

export function saveDeviceVoiceEnabled(
  on: boolean,
  options: { intent?: number; isCurrent?: () => boolean } = {},
): Promise<void> {
  const intent = options.intent ?? beginDeviceVoiceIntent();
  const write = pendingWrites.then(async () => {
    if (
      (options.intent !== undefined && intent !== intentVersion) ||
      options.isCurrent?.() === false
    )
      return;
    if (on) await SecureStore.setItemAsync(DEVICE_VOICE_KEY, "1");
    else await SecureStore.deleteItemAsync(DEVICE_VOICE_KEY);
  });
  // A failed write remains visible to its caller without blocking later preferences.
  pendingWrites = write.catch(() => undefined);
  return write;
}
