import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadApiBase, selectedSpaceId, selectSpace } from "./api";
import {
  captureMobileScope,
  isMobileScopeCurrent,
  isMobileSessionCurrent,
  mobileScopeKey,
  subscribeMobileScope,
} from "./mobile-scope";
import { restoreSessionToken } from "./session";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));

beforeEach(async () => {
  vi.restoreAllMocks();
  const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    storage.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    storage.delete(key);
  });
  await restoreSessionToken("fake-scope-owner");
  await loadApiBase();
});

afterEach(() => vi.restoreAllMocks());

it("invalidates captured ownership when a same-Space selection starts before claiming memory", async () => {
  const before = captureMobileScope();
  const observed: boolean[] = [];
  const unsubscribe = subscribeMobileScope(() => observed.push(isMobileScopeCurrent(before)));
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    if (key === "rakazo.space_rollback") {
      started();
      await held;
    }
  });
  try {
    const selecting = selectSpace("space-current");
    await ready;
    expect(selectedSpaceId()).toBe("space-current");
    expect(isMobileScopeCurrent(before)).toBe(false);
    expect(observed).toEqual([false]);
    release();
    await expect(selecting).resolves.toBe(true);
    expect(isMobileScopeCurrent(before)).toBe(false);
  } finally {
    release();
    unsubscribe();
  }
});

it("keeps session ownership across Space changes but rejects same-ID Space and session ABA", async () => {
  const before = captureMobileScope();
  const key = mobileScopeKey();
  await selectSpace("space-other");
  await selectSpace("space-current");
  expect(isMobileSessionCurrent(before)).toBe(true);
  expect(isMobileScopeCurrent(before)).toBe(false);
  expect(mobileScopeKey()).not.toBe(key);
  const next = captureMobileScope();
  await restoreSessionToken("fake-second-owner");
  await restoreSessionToken("fake-scope-owner");
  expect(isMobileSessionCurrent(next)).toBe(false);
});

it("rejects an endpoint A-B-A round trip and stops delivering after unsubscribe", async () => {
  const owner = captureMobileScope();
  const listener = vi.fn();
  const stop = subscribeMobileScope(listener);
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
    key === "rakazo.api_base"
      ? "https://other.example.test"
      : key === "rakazo.space_id"
        ? "space-current"
        : null,
  );
  await loadApiBase();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
    key === "rakazo.space_id" ? "space-current" : null,
  );
  await loadApiBase();
  expect(isMobileSessionCurrent(owner)).toBe(false);
  expect(listener).toHaveBeenCalled();
  stop();
  listener.mockClear();
  await selectSpace("space-after-unsubscribe");
  await restoreSessionToken("fake-after-unsubscribe");
  expect(listener).not.toHaveBeenCalled();
});
