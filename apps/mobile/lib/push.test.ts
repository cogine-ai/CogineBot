import * as Notifications from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { registerPushToken } from "./push";

vi.mock("expo-constants", () => ({ default: { easConfig: { projectId: "synthetic-project" } } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: vi.fn(async () => undefined) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const context = () => ({
  apiBase: "https://saved.example.test",
  sessionGeneration: 7,
  headers: { authorization: "Bearer saved-account", "x-rakazo-space-id": "saved-space" },
});

beforeEach(() => {
  vi.mocked(Notifications.getPermissionsAsync)
    .mockReset()
    .mockResolvedValue({ granted: true } as never);
  vi.mocked(Notifications.requestPermissionsAsync)
    .mockReset()
    .mockResolvedValue({ granted: true } as never);
  vi.mocked(Notifications.getExpoPushTokenAsync)
    .mockReset()
    .mockResolvedValue({ data: "ExponentPushToken[synthetic-device]" } as never);
  vi.mocked(rpc).mockClear();
});

describe("saved notification push registration", () => {
  it("uses the saved request context without rechecking or prompting for already allowed permission", async () => {
    const requestContext = context();
    await registerPushToken({ permission: "allowed", requestContext, isCurrent: () => true });
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "notifications/registerPush",
      { token: "ExponentPushToken[synthetic-device]" },
      { requestContext },
    );
  });

  it("drops token minting that finishes after its account or Space owner changes", async () => {
    let current = true;
    const minted = deferred<{ data: string }>();
    vi.mocked(Notifications.getExpoPushTokenAsync).mockImplementation(
      () => minted.promise as never,
    );
    const pending = registerPushToken({
      permission: "allowed",
      requestContext: context(),
      isCurrent: () => current,
    });
    await Promise.resolve();
    current = false;
    minted.resolve({ data: "ExponentPushToken[old-device]" });
    await pending;
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not read permissions or mint a token for an already stale save", async () => {
    await registerPushToken({
      permission: "allowed",
      requestContext: context(),
      isCurrent: () => false,
    });
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("retains the exact saved authentication headers during token minting", async () => {
    const requestContext = context();
    const minted = deferred<{ data: string }>();
    vi.mocked(Notifications.getExpoPushTokenAsync).mockImplementation(
      () => minted.promise as never,
    );
    const pending = registerPushToken({
      permission: "allowed",
      requestContext,
      isCurrent: () => true,
    });
    requestContext.headers.authorization = "Bearer replacement-account";
    requestContext.headers["x-rakazo-space-id"] = "replacement-space";
    minted.resolve({ data: "ExponentPushToken[synthetic-device]" });
    await pending;
    expect(vi.mocked(rpc).mock.calls[0]?.[2]?.requestContext).toEqual(context());
  });

  it("preserves the ordinary startup permission request and registration path", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);
    await registerPushToken();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rpc).mock.calls[0]?.slice(0, 2)).toEqual([
      "notifications/registerPush",
      { token: "ExponentPushToken[synthetic-device]" },
    ]);
  });
});
