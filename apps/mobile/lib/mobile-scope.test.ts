import { readFileSync } from "node:fs";
import * as SecureStore from "expo-secure-store";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadApiBase, selectedSpaceId, selectInitialSpace, selectSpace } from "./api";
import { resumeLiveNotifications } from "./live-notifications";
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

it.each(["refresh", "unmount", "preclaim"] as const)(
  "keeps default Space maintenance owned after %s",
  async (phase) => {
    const storage = new Map<string, string>([["rakazo.session_token", "fake-home-owner"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let heldOnce = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (phase === "preclaim" && key === "rakazo.space_rollback" && !heldOnce) {
        heldOnce = true;
        started();
        await held;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (phase !== "preclaim" && key === "rakazo.space_id" && !heldOnce) {
        heldOnce = true;
        started();
        await held;
      }
      storage.set(key, value);
    });
    await loadApiBase();
    await restoreSessionToken("fake-home-owner");
    vi.mocked(resumeLiveNotifications).mockClear();
    const me = { userId: "user-home", spaceId: "space-current", name: "Owner" };
    const navigation = {
      current: { id: me.spaceId, bots: [], groups: [], botSections: [] },
      spaces: [],
    };
    const setBots = vi.fn();
    const setSearchInbox = vi.fn();
    const dependencies = {
      useCallback: (fn: unknown) => fn,
      spaceActionRef: { current: { busy: false, recoveryId: null } },
      organizationBusyRef: { current: false },
      inboxRequestId: { current: 0 },
      mounted: { current: true },
      bootstrap: { current: null },
      captureMobileScope,
      isMobileScopeCurrent,
      isMobileSessionCurrent,
      selectInitialSpace,
      setError: vi.fn(),
      rpc: vi.fn(async (p: string) => (p === "me" ? me : navigation)),
      verifiedInbox: { current: null },
      publicationRevision: { current: 0 },
      setSearchInbox,
      inboxState: { current: {} },
      setBots,
      setBotSections: vi.fn(),
      setGroups: vi.fn(),
      setSpaces: vi.fn(),
      setMe: vi.fn(),
      retainInboxValue: (_before: unknown, next: unknown) => next,
      saveInbox: vi.fn(),
      adoptDeviceTimezone: vi.fn(async () => undefined),
      errorText: (error: Error) => error.message,
      t: (value: string) => value,
    };
    const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
    const body = source.slice(
      source.indexOf("  const loadBots = useCallback("),
      source.indexOf("  const refreshBots = useCallback("),
    );
    const load = new Function(
      ...Object.keys(dependencies),
      ts.transpileModule(`${body}\nreturn loadBots;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
    )(...Object.values(dependencies)) as () => Promise<void>;
    const first = load();
    await ready;
    if (phase === "refresh") {
      expect(selectedSpaceId()).toBe(me.spaceId);
      await load();
      expect(setBots).toHaveBeenCalledOnce();
      expect(setSearchInbox).toHaveBeenCalledOnce();
    } else if (phase === "unmount") {
      dependencies.mounted.current = false;
    } else {
      expect(selectedSpaceId()).toBeNull();
      dependencies.rpc.mockRejectedValueOnce(new Error("Offline"));
      await load();
    }
    release();
    await first;
    if (phase === "refresh") {
      expect(setBots).toHaveBeenCalledOnce();
      expect(resumeLiveNotifications).toHaveBeenCalledExactlyOnceWith(
        captureMobileScope().apiBase,
        "fake-home-owner",
        me.spaceId,
      );
    } else {
      expect(setBots).not.toHaveBeenCalled();
      expect(setSearchInbox).not.toHaveBeenCalled();
      expect(resumeLiveNotifications).not.toHaveBeenCalled();
      if (phase === "preclaim") expect(selectedSpaceId()).toBeNull();
    }
  },
);
