// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Account from "../app/(settings)/account";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), capture: vi.fn() }));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  captureApiRequestContext: mocks.capture,
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "revoked-space",
  fetchAccountSecurity: async () => ({ hasPassword: false }),
  loadSessionToken: async () => "fake-account-session",
  signOut: vi.fn(),
  deleteAccount: vi.fn(),
  requestAccountDeletionCode: vi.fn(),
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({}),
  isMobileScopeCurrent: () => true,
  mobileScopeKey: () => "api-session-with-revoked-space",
  subscribeMobileScope: () => () => {},
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: (value: unknown) => value },
    Text: view,
    View: view,
    ScrollView: view,
    Modal: () => null,
    KeyboardAvoidingView: view,
    Pressable: view,
    TextInput: () => null,
    ActivityIndicator: () => null,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("../components/settings-group", () => ({
  useStackedSettings: () => false,
  SettingsGroup: ({ children }: { children?: ReactNode }) =>
    createElement("section", null, children),
  SettingsRow: ({ title }: { title: string }) => createElement("span", null, title),
  SettingsLabel: () => null,
  SettingsSwitch: () => null,
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({ label }: { label: string }) => createElement("select", { "aria-label": label }),
}));
vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../components/native-segmented-control", () => ({ NativeSegmentedControl: () => null }));
vi.mock("../components/app-mark", () => ({ AppMark: () => null }));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({}),
  useThemedStyles: () => ({}),
}));
vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => "system",
  mobileTokens: {},
  setAppearancePreference: vi.fn(),
}));
vi.mock("./i18n", () => {
  const t = (value: string) => value;
  return { t, useI18n: () => ({ t, locale: "en" }), setUiLocale: vi.fn() };
});
vi.mock("./app-version", () => ({
  getAppVersionInfo: () => ({ nativeLabel: "test" }),
  formatUpdateLabel: () => "test",
}));
vi.mock("./auth-routing", () => ({ replaceWithSignIn: vi.fn() }));
vi.mock("./delete-account-prompt", () => ({ promptAccountDeletion: vi.fn() }));
vi.mock("./live-notifications", () => ({
  DEFAULT_LIVE_NOTIFICATION_SETTINGS: {},
  canPostPromotedNotifications: vi.fn(),
  getLiveNotificationSettings: vi.fn(),
  openLiveNotificationSettings: vi.fn(),
  openPromotedNotificationSettings: vi.fn(),
  setLiveNotificationSettings: vi.fn(),
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./push", () => ({ registerPushToken: vi.fn() }));
vi.mock("./remote-images-preference", () => ({
  getCachedRemoteImagesEnabled: () => false,
  setRemoteImagesPreference: vi.fn(),
  subscribeRemoteImages: () => () => {},
}));
vi.mock("./response-streaming", () => ({
  getCachedResponseStreamingEnabled: () => false,
  setResponseStreamingPreference: vi.fn(),
  subscribeResponseStreaming: () => () => {},
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads the real account editor without authorizing its obsolete selected Space", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.capture.mockImplementation(async (spaceId: string | null | undefined) => ({
    apiBase: "https://api.example.test",
    sessionGeneration: 1,
    headers: {
      authorization: "Bearer fake-account-session",
      ...(spaceId === null ? {} : { "x-rakazo-space-id": "revoked-space" }),
    },
  }));
  mocks.rpc.mockImplementation(
    async (
      procedure: string,
      _input: unknown,
      options?: { requestContext?: { headers: Record<string, string> } },
    ) => {
      if (procedure === "me") {
        if (options?.requestContext?.headers["x-rakazo-space-id"])
          throw new Error("Space access revoked");
        return {
          userId: "user-a",
          spaceId: "default-space",
          name: "Account",
          email: "test@example.com",
          timezone: "UTC",
        };
      }
      return [];
    },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  await act(async () => root.render(<Account />));
  expect(container.querySelector('select[aria-label="Timezone"]')).not.toBeNull();
  expect(mocks.capture).toHaveBeenCalledWith(null);
});
