import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

describe("device voice preference", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(SecureStore.getItemAsync).mockClear();
    vi.mocked(SecureStore.setItemAsync)
      .mockReset()
      .mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
      });
    vi.mocked(SecureStore.deleteItemAsync)
      .mockReset()
      .mockImplementation(async (key: string) => {
        store.delete(key);
      });
  });

  it("defaults to off", async () => {
    const { loadDeviceVoiceEnabled } = await import("./device-voice");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("persists on and off", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    await saveDeviceVoiceEnabled(true);
    expect(await loadDeviceVoiceEnabled()).toBe(true);
    await saveDeviceVoiceEnabled(false);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("rejects when SecureStore cannot write, so callers can roll back", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { saveDeviceVoiceEnabled, loadDeviceVoiceEnabled } = await import("./device-voice");

    await expect(saveDeviceVoiceEnabled(true)).rejects.toThrow("device locked");
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("rejects when SecureStore cannot read, instead of treating the preference as off", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    const { loadDeviceVoiceEnabled } = await import("./device-voice");

    await expect(loadDeviceVoiceEnabled()).rejects.toThrow("device locked");
  });

  it("serializes accepted writes and reads so the newest durable preference wins", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await pending;
      store.set(key, value);
    });
    const older = saveDeviceVoiceEnabled(true);
    await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalled());
    const newer = saveDeviceVoiceEnabled(false);
    let readFinished = false;
    const read = loadDeviceVoiceEnabled().then((value) => {
      readFinished = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await Promise.all([older, newer]);
    await expect(read).resolves.toBe(false);
    await expect(loadDeviceVoiceEnabled()).resolves.toBe(false);
  });

  it("does not persist an old compensation after a newer device intent", async () => {
    const { beginDeviceVoiceIntent, loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import(
      "./device-voice"
    );
    const original = beginDeviceVoiceIntent();
    await saveDeviceVoiceEnabled(false, { intent: original });
    await saveDeviceVoiceEnabled(false);
    vi.mocked(SecureStore.setItemAsync).mockClear();
    await saveDeviceVoiceEnabled(true, { intent: original });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("rechecks a captured owner before a queued compensation reaches storage", async () => {
    const { beginDeviceVoiceIntent, loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import(
      "./device-voice"
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementationOnce(async () => {
      await gate;
    });
    const intent = beginDeviceVoiceIntent();
    const pending = saveDeviceVoiceEnabled(false, { intent });
    await vi.waitFor(() => expect(SecureStore.deleteItemAsync).toHaveBeenCalled());
    let current = true;
    const compensation = saveDeviceVoiceEnabled(true, { intent, isCurrent: () => current });
    current = false;
    release();
    await Promise.all([pending, compensation]);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("keeps the queue usable after one persistence failure", async () => {
    const { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } = await import("./device-voice");
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(saveDeviceVoiceEnabled(true)).rejects.toThrow("device locked");
    await saveDeviceVoiceEnabled(false);
    expect(await loadDeviceVoiceEnabled()).toBe(false);
  });

  it("preserves ordinary callers' writes while serializing their durable order", async () => {
    const { saveDeviceVoiceEnabled } = await import("./device-voice");
    await Promise.all([saveDeviceVoiceEnabled(true), saveDeviceVoiceEnabled(false)]);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });
});
