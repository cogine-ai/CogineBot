import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  dismissNotificationAsync: vi.fn(async () => undefined),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  IosAuthorizationStatus: {
    NOT_DETERMINED: 0,
    DENIED: 1,
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Linking: { openSettings: vi.fn(async () => undefined) },
}));

import * as Notifications from "expo-notifications";
import { Linking } from "react-native";
import {
  afterChatNotifyChange,
  configureForegroundNotifications,
  notificationTargetsThread,
  openLiveNotificationSettings,
  readChatNotificationPermission,
  setOpenNotificationThread,
} from "./live-notifications";

beforeEach(() => vi.clearAllMocks());

describe("notification thread targeting", () => {
  it("matches Expo and native notification keys for the open agent", () => {
    expect(notificationTargetsThread({ botId: "bot-1" }, { botId: "bot-1" })).toBe(true);
    expect(
      notificationTargetsThread(
        { "rakazo.threadId": "thread-1" },
        { botId: "bot-1", threadId: "thread-1" },
      ),
    ).toBe(true);
  });

  it("keeps other agents visible", () => {
    expect(notificationTargetsThread({ botId: "bot-2" }, { botId: "bot-1" })).toBe(false);
    expect(notificationTargetsThread({ botId: "bot-1" }, null)).toBe(false);
  });

  it("does not confuse an open DM with a group notification from the same agent", () => {
    expect(
      notificationTargetsThread(
        { botId: "bot-1", threadId: "group-thread" },
        { botId: "bot-1", threadId: "dm-thread" },
      ),
    ).toBe(false);
  });

  it("hides only foreground notifications for the open agent", async () => {
    configureForegroundNotifications();
    await setOpenNotificationThread({ botId: "bot-1" });
    const handler = vi.mocked(Notifications.setNotificationHandler).mock.calls[0]?.[0];
    expect(handler).toBeTruthy();

    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-1" } } } } as never),
    ).resolves.toMatchObject({ shouldShowBanner: false, shouldShowList: false });
    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-2" } } } } as never),
    ).resolves.toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });
});

describe("chat notification preference follow-up", () => {
  const change = (partial = {}) => ({
    botId: "bot-1",
    threadId: "dm",
    notifyOnFinish: true,
    apiBase: "https://api.example.test",
    token: "saved-token",
    spaceId: "space-1",
    isCurrent: () => true,
    ...partial,
  });
  it("reports system denial without rejecting a saved preference or opening Settings", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      status: "denied",
      canAskAgain: false,
    } as never);
    await expect(
      afterChatNotifyChange({
        botId: "bot-1",
        threadId: "dm",
        notifyOnFinish: true,
        apiBase: "https://api.example.test",
        token: "saved-token",
        spaceId: "space-1",
        isCurrent: () => true,
      }),
    ).resolves.toBe("denied");
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Linking.openSettings).not.toHaveBeenCalled();
  });

  it.each([2, 3, 4])("accepts iOS status %s without another permission prompt", async (status) => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: true,
      ios: { status },
    } as never);
    expect(await afterChatNotifyChange(change())).toBe("allowed");
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it.each(["granted", "denied"])(
    "requests a requestable permission once and reports %s",
    async (status) => {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
        granted: false,
        status: "undetermined",
        canAskAgain: true,
      } as never);
      vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
        granted: status === "granted",
        status,
        canAskAgain: false,
      } as never);
      expect(await afterChatNotifyChange(change())).toBe(
        status === "granted" ? "allowed" : "denied",
      );
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a failed permission query as unknown; Retry never prompts", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockRejectedValueOnce(new Error("OS unavailable"));
    expect(await afterChatNotifyChange(change())).toBe("unknown");
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      status: "undetermined",
      canAskAgain: true,
    } as never);
    expect(await readChatNotificationPermission(() => true)).toBe("unknown");
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Linking.openSettings).not.toHaveBeenCalled();
  });

  it.each(["read", "prompt"])(
    "drops a permission result when ownership changes during %s",
    async (boundary) => {
      let current = true;
      let finish!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      vi.mocked(Notifications.getPermissionsAsync).mockImplementation(async () =>
        boundary === "read"
          ? (gate as never)
          : ({ granted: false, status: "undetermined", canAskAgain: true } as never),
      );
      vi.mocked(Notifications.requestPermissionsAsync).mockImplementation(() => gate as never);
      const pending = afterChatNotifyChange(change({ token: "", isCurrent: () => current }));
      await Promise.resolve();
      current = false;
      finish({ granted: true, status: "granted" });
      expect(await pending).toBeNull();
      if (boundary === "read") expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    },
  );

  it("ignores stale entry and opens iOS Settings only from a current explicit action", async () => {
    expect(await afterChatNotifyChange(change({ isCurrent: () => false }))).toBeNull();
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    await openLiveNotificationSettings(() => false);
    expect(Linking.openSettings).not.toHaveBeenCalled();
    await openLiveNotificationSettings(() => true);
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it("muting dismisses the DM while preserving group notifications and never requests permission", async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "dm", content: { data: { botId: "bot-1", threadId: "dm" } } } },
      {
        request: { identifier: "group", content: { data: { botId: "bot-1", threadId: "group" } } },
      },
    ] as never);
    expect(await afterChatNotifyChange(change({ notifyOnFinish: false }))).toBeNull();
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith("dm");
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it("does not dismiss a delivered list returned after ownership changes", async () => {
    let current = true;
    let finish!: (value: unknown) => void;
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const pending = afterChatNotifyChange(
      change({ token: "", notifyOnFinish: false, isCurrent: () => current }),
    );
    current = false;
    finish([{ request: { identifier: "dm", content: { data: { threadId: "dm" } } } }]);
    await pending;
    expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });

  it("rechecks ownership before every notification dismissal", async () => {
    let current = true;
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "first", content: { data: { threadId: "dm" } } } },
      { request: { identifier: "second", content: { data: { threadId: "dm" } } } },
    ] as never);
    vi.mocked(Notifications.dismissNotificationAsync).mockImplementationOnce(async () => {
      current = false;
    });
    await afterChatNotifyChange(change({ notifyOnFinish: false, isCurrent: () => current }));
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("keeps clearing other matching deliveries when one dismissal fails", async () => {
    vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
      { request: { identifier: "first", content: { data: { threadId: "dm" } } } },
      { request: { identifier: "second", content: { data: { threadId: "dm" } } } },
    ] as never);
    vi.mocked(Notifications.dismissNotificationAsync).mockRejectedValueOnce(
      new Error("One dismissal failed"),
    );
    await afterChatNotifyChange(change({ notifyOnFinish: false }));
    expect(vi.mocked(Notifications.dismissNotificationAsync).mock.calls).toEqual([
      ["first"],
      ["second"],
    ]);
  });
});
