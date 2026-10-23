import * as Notifications from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationSettingsReturn } from "./notification-settings-return";

const native = vi.hoisted(() => ({
  state: "active",
  listeners: new Set<(state: string) => void>(),
  openSettings: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Linking: { openSettings: native.openSettings },
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  IosAuthorizationStatus: { AUTHORIZED: 2, DENIED: 1, PROVISIONAL: 3, EPHEMERAL: 4 },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function emit(state: string) {
  native.state = state;
  for (const listener of [...native.listeners]) listener(state);
}
async function flush() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}
function fixture() {
  const owner = { current: true, focused: true };
  const onPermission = vi.fn();
  const onAllowed = vi.fn(async (_current: () => boolean): Promise<void> => undefined);
  const handle = createNotificationSettingsReturn({
    isCurrent: () => owner.current,
    isFocused: () => owner.focused,
    onPermission,
    onAllowed,
  });
  return { handle, owner, onPermission, onAllowed };
}
beforeEach(() => {
  native.state = "active";
  native.listeners.clear();
  native.openSettings.mockReset().mockResolvedValue(undefined);
  vi.mocked(Notifications.getPermissionsAsync)
    .mockReset()
    .mockResolvedValue({ granted: true } as never);
  vi.mocked(Notifications.requestPermissionsAsync).mockReset();
});

describe("an explicit notification Settings return", () => {
  it("does not treat open completion as return, then checks and registers exactly once after the real active transition", async () => {
    const f = fixture();
    await f.handle.open();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    emit("inactive");
    emit("background");
    emit("active");
    f.handle.focus();
    emit("active");
    await flush();
    expect(f.onPermission).toHaveBeenCalledExactlyOnceWith("allowed");
    expect(f.onAllowed).toHaveBeenCalledTimes(1);
    expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(native.listeners.size).toBe(0);
  });

  it("waits for a successful launch when active arrives before the open promise resolves", async () => {
    const launched = deferred<void>();
    native.openSettings.mockImplementation(() => launched.promise);
    const f = fixture();
    const opening = f.handle.open();
    emit("background");
    emit("active");
    await flush();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    launched.resolve();
    await opening;
    await flush();
    expect(f.onAllowed).toHaveBeenCalledTimes(1);
  });

  it("cancels a failed launch even when an unrelated background cycle was observed", async () => {
    const launched = deferred<void>();
    native.openSettings.mockImplementation(() => launched.promise);
    const f = fixture();
    const opening = f.handle.open();
    const rejected = expect(opening).rejects.toThrow("Cannot open");
    emit("background");
    emit("active");
    launched.reject(new Error("Cannot open"));
    await rejected;
    await flush();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(f.onAllowed).not.toHaveBeenCalled();
    expect(native.listeners.size).toBe(0);
  });

  it("waits for the same route to regain focus after an OS background transition", async () => {
    const f = fixture();
    await f.handle.open();
    emit("background");
    f.owner.focused = false;
    f.handle.blur();
    emit("active");
    await flush();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    f.owner.focused = true;
    f.handle.focus();
    await flush();
    expect(f.onAllowed).toHaveBeenCalledTimes(1);
  });

  it("does not revive an attempt after a foreground navigation blur", async () => {
    const f = fixture();
    await f.handle.open();
    f.owner.focused = false;
    f.handle.blur();
    emit("background");
    emit("active");
    f.owner.focused = true;
    f.handle.focus();
    await flush();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(f.onAllowed).not.toHaveBeenCalled();
  });

  it.each(["denied", "undetermined"] as const)(
    "publishes %s without registration or another permission prompt",
    async (status) => {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        status,
      } as never);
      const f = fixture();
      await f.handle.open();
      emit("background");
      emit("active");
      await flush();
      expect(f.onPermission).toHaveBeenCalledExactlyOnceWith(
        status === "denied" ? "denied" : "unknown",
      );
      expect(f.onAllowed).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );

  it.each([
    Notifications.IosAuthorizationStatus.PROVISIONAL,
    Notifications.IosAuthorizationStatus.EPHEMERAL,
  ])(
    "registers iOS authorization status %s without requesting permission again",
    async (status) => {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        ios: { status },
      } as never);
      const f = fixture();
      await f.handle.open();
      emit("background");
      emit("active");
      await flush();
      expect(f.onPermission).toHaveBeenCalledExactlyOnceWith("allowed");
      expect(f.onAllowed).toHaveBeenCalledTimes(1);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );

  it("does not revive a pending permission read after another background cycle", async () => {
    const read = deferred<never>();
    vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() => read.promise);
    const f = fixture();
    await f.handle.open();
    emit("background");
    emit("active");
    emit("background");
    emit("active");
    read.resolve({ granted: true } as never);
    await flush();
    expect(f.onPermission).not.toHaveBeenCalled();
    expect(f.onAllowed).not.toHaveBeenCalled();
    expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(native.listeners.size).toBe(0);
  });

  it("invalidates permission results after a new intent or owner cancels the ticket", async () => {
    const read = deferred<never>();
    vi.mocked(Notifications.getPermissionsAsync).mockImplementation(() => read.promise);
    const f = fixture();
    await f.handle.open();
    emit("background");
    emit("active");
    f.handle.cancel();
    read.resolve({ granted: true } as never);
    await flush();
    expect(f.onPermission).not.toHaveBeenCalled();
    expect(f.onAllowed).not.toHaveBeenCalled();
    expect(native.listeners.size).toBe(0);
  });

  it("invalidates an already consumed query's registration predicate on cancellation", async () => {
    const registered = deferred<void>();
    const f = fixture();
    f.onAllowed.mockImplementation(() => registered.promise);
    await f.handle.open();
    emit("background");
    emit("active");
    await flush();
    const current = f.onAllowed.mock.calls[0]?.[0];
    if (!current) throw new Error("Missing return query guard");
    expect(current()).toBe(true);
    f.handle.cancel();
    expect(current()).toBe(false);
    registered.resolve();
    await flush();
    f.handle.focus();
    emit("active");
    expect(f.onAllowed).toHaveBeenCalledTimes(1);
  });
});
