// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement, forwardRef, useEffect, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ThreadRoute from "../app/thread";
import type * as Api from "./api";
import { resetI18nForTests } from "./i18n";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), setParams: vi.fn() },
  navigation: { isFocused: () => true, setOptions: vi.fn(), goBack: vi.fn() },
  params: { botId: "bot-a", spaceId: "space-a", name: "Writer", readOnly: "1" },
  block: {
    kind: "bot_message_sent",
    toBotId: "bot-b",
    toBotName: "Research",
    text: "Private peer body",
    deliveryStatus: "policy_disabled",
  } as MessageBlock,
}));

vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  visibleNativeTextFromMarkdown: (text: string) => text,
}));

vi.mock("expo-router", () => ({
  useRouter: () => state.router,
  useNavigation: () => state.navigation,
  useLocalSearchParams: () => state.params,
  useIsFocused: () => true,
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    rpc: state.rpc,
    currentApiBase: () => "https://api.example.test",
    currentApiBaseGeneration: () => 0,
    currentSpaceSelectionGeneration: () => 0,
    selectedSpaceId: () => "space-a",
    spaceSelectionSeq: () => 0,
    isSpaceSelectionPending: () => false,
    subscribeApiBase: () => () => {},
    subscribeSelectedSpace: () => () => {},
    subscribeSpaceSelectionPending: () => () => {},
    captureApiRequestContext: async () => ({
      apiBase: "https://api.example.test",
      sessionGeneration: 0,
      headers: { "x-rakazo-space-id": "space-a" },
    }),
    loadSessionToken: async () => "synthetic-session",
  };
});
vi.mock("./session", () => ({
  currentSessionGeneration: () => 0,
  currentReadySessionGeneration: () => 0,
  subscribeSessionGeneration: () => () => {},
  registerSessionDiskCache: () => {},
  saveVerifiedIntegrationsScope: async () => {},
  loadSessionToken: async () => "synthetic-session",
  loadVerifiedIntegrationsScope: async () => ({
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
    sessionGeneration: 0,
  }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-file-system", () => {
  class Entry {
    exists = false;
    uri = "cache://synthetic";
    size = 0;
    create() {}
    write() {}
    delete() {}
    list() {
      return [];
    }
  }
  return {
    Directory: Entry,
    File: Entry,
    Paths: { cache: "cache://synthetic", document: "documents://synthetic" },
  };
});
vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => ({
    setOpenThread: async () => {},
    resume: async () => {},
    dismissThread: async () => {},
  }),
  requireOptionalNativeModule: () => null,
}));
vi.mock("expo-notifications", () => ({
  dismissAllNotificationsAsync: async () => {},
  getPresentedNotificationsAsync: async () => [],
}));
vi.mock("expo-audio", () => ({}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => {} }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-sharing", () => ({}));
vi.mock("react-native-svg", () => ({ default: () => null, G: () => null, Path: () => null }));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "1.0.0" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("./call-sounds", () => ({
  beginWaitSound: () => () => {},
  endWaitSound: () => {},
  playCallCue: async () => {},
  stopCallSounds: () => {},
}));
vi.mock("@react-native-vector-icons/ionicons", () => ({ default: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useKeyboardState: (select: (state: { isVisible: boolean }) => unknown) =>
    select({ isVisible: false }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  useReducedMotion: () => true,
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: number) => value,
  withRepeat: (value: number) => value,
  cancelAnimation: () => {},
  Easing: {
    linear: (value: number) => value,
    inOut: (value: unknown) => value,
    ease: (value: number) => value,
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({ background: "#ffffff", foreground: "#000000" }),
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({
    background: "#ffffff",
    foreground: "#000000",
    mutedForeground: "#777777",
  }),
}));
vi.mock("react-native", () => {
  const host = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const scroll = forwardRef((_props: { children?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({
      scrollTo: () => {},
      scrollToOffset: () => {},
      scrollToIndex: () => {},
    }));
    return <div>{_props.children}</div>;
  });
  return {
    View: host,
    Text: host,
    ScrollView: scroll,
    Image: () => null,
    TextInput: () => null,
    ActivityIndicator: () => <span role="progressbar" />,
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Platform: {
      OS: "android",
      Version: 35,
      select: (values: Record<string, unknown>) => values.android ?? values.default,
    },
    useWindowDimensions: () => ({ width: 393, height: 852, fontScale: 1 }),
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
    Keyboard: { addListener: () => ({ remove: () => {} }), dismiss: () => {} },
    AccessibilityInfo: {
      isScreenReaderEnabled: async () => false,
      isReduceMotionEnabled: async () => true,
      addEventListener: () => ({ remove: () => {} }),
      announceForAccessibility: () => {},
    },
    Alert: { alert: vi.fn() },
    ActionSheetIOS: {},
    Linking: { openURL: vi.fn() },
    I18nManager: { isRTL: false },
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? <div>{children}</div> : null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      disabled?: boolean;
    }) => (
      <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
        {children}
      </button>
    ),
    FlatList: forwardRef(
      (
        {
          data,
          renderItem,
          ListHeaderComponent,
          ListFooterComponent,
        }: {
          data: unknown[];
          renderItem: (info: { item: unknown; index: number }) => ReactNode;
          ListHeaderComponent?: ReactNode;
          ListFooterComponent?: ReactNode;
        },
        ref,
      ) => {
        useImperativeHandle(ref, () => ({ scrollToOffset: () => {}, scrollToIndex: () => {} }));
        return (
          <div>
            {ListHeaderComponent}
            {data.map((item, index) =>
              createElement("div", { key: index }, renderItem({ item, index })),
            )}
            {ListFooterComponent}
          </div>
        );
      },
    ),
  };
});
// These controls need native hosts; their thread-level callbacks are not under test here.
vi.mock("../components/thread-composer", () => ({ ThreadComposer: () => null }));
vi.mock("../components/message-context-menu", () => ({
  MessageContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/select-text-sheet", () => ({ SelectTextSheet: () => null }));
vi.mock("../components/markdown-artifact-preview", () => ({ MarkdownArtifactPreview: () => null }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetI18nForTests("en");
  state.router.push.mockReset();
  state.block = {
    kind: "bot_message_sent",
    toBotId: "bot-b",
    toBotName: "Research",
    text: "Private peer body",
    deliveryStatus: "policy_disabled",
  };
  state.rpc.mockReset().mockImplementation(async (procedure: string) => {
    if (procedure === "threads/get")
      return {
        threadId: "thread-a",
        botId: "bot-a",
        cursor: 3,
        olderCursor: null,
        run: null,
        messages: [
          {
            id: "message-a",
            seq: 3,
            threadId: "thread-a",
            role: "bot",
            botId: "bot-a",
            blocks: [state.block],
          },
        ],
        members: [
          { botId: "bot-a", name: "Writer" },
          { botId: "bot-b", name: "Research" },
        ],
      };
    if (procedure === "me") return { userId: "user-a", spaceId: "space-a" };
    if (procedure === "bots/list" || procedure === "bots/listArchived")
      return [
        { id: "bot-a", spaceId: "space-a", name: "Writer", color: "blue" },
        { id: "bot-b", spaceId: "space-a", name: "Research", color: "green" },
      ];
    if (procedure === "voice/status") return { ready: false, transcribe: false };
    return [];
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows stopped automatic collaboration on the actual sender receipt without revealing its body", async () => {
  await act(async () => root.render(<ThreadRoute />));
  expect(container.textContent).toContain("Messaged Research");
  expect(container.textContent).toContain("Automatic collaboration stopped");
  expect(container.textContent).not.toContain("Private peer body");
});

it.each([
  ["zh-CN", "自动协作已停止"],
  ["ru", "Автоматическое взаимодействие остановлено"],
  ["de", "Automatische Zusammenarbeit gestoppt"],
] as const)("localizes the stopped receipt in %s", async (locale, label) => {
  resetI18nForTests(locale);
  await act(async () => root.render(<ThreadRoute />));
  expect(container.textContent).toContain(label);
  expect(container.textContent).not.toContain("Automatic collaboration stopped");
});

const receipts = [
  {
    block: { kind: "child_bot", botId: "bot-b", name: "Research", status: "created" },
    origin: "Research",
  },
  {
    block: { kind: "handoff", fromBotId: "bot-a", toBotId: "bot-b", text: "Private peer body" },
    origin: "Writer messaged Research",
  },
  {
    block: {
      kind: "bot_message_sent",
      toBotId: "bot-b",
      toBotName: "Research",
      text: "Private peer body",
    },
    origin: "Messaged Research",
  },
] as const;

for (const { block, origin } of receipts) {
  it.each([
    [undefined, undefined],
    ["waiting_peer", "Waiting…"],
    ["completed", "Done"],
    ["policy_disabled", "Automatic collaboration stopped"],
  ] as const)(
    `renders ${block.kind} with delivery %s alongside its existing origin`,
    async (status, label) => {
      state.block = { ...block, ...(status ? { deliveryStatus: status } : {}) };
      await act(async () => root.render(<ThreadRoute />));
      expect(container.textContent).toContain(origin);
      if (label) expect(container.textContent).toContain(`${origin} · ${label}`);
      else {
        expect(container.textContent).not.toContain("Waiting…");
        expect(container.textContent).not.toContain("Done");
        expect(container.textContent).not.toContain("Automatic collaboration stopped");
      }
      expect(container.textContent).not.toContain("Private peer body");
    },
  );
}

it("keeps the stopped sender chip non-expanding and its accessible status explicit", async () => {
  await act(async () => root.render(<ThreadRoute />));
  const chip = container.querySelector<HTMLButtonElement>(
    '[aria-label="Messaged Research · Automatic collaboration stopped"]',
  );
  expect(chip).not.toBeNull();
  await act(async () => chip?.click());
  expect(container.textContent).not.toContain("Private peer body");
  expect(state.router.push).not.toHaveBeenCalled();
});

it("keeps handoff details progressively expandable when collaboration has stopped", async () => {
  state.block = {
    kind: "handoff",
    fromBotId: "bot-a",
    toBotId: "bot-b",
    text: "Private peer body",
    deliveryStatus: "policy_disabled",
  };
  await act(async () => root.render(<ThreadRoute />));
  const chip = container.querySelector<HTMLButtonElement>(
    '[aria-label="Show Writer messaged Research · Automatic collaboration stopped"]',
  );
  expect(chip).not.toBeNull();
  expect(container.textContent).not.toContain("Private peer body");
  await act(async () => chip?.click());
  expect(container.textContent).toContain("Private peer body");
  expect(state.router.push).not.toHaveBeenCalled();
});

it.each(["created", "archived", "deleted"] as const)(
  "preserves %s child card navigation and lifecycle copy",
  async (status) => {
    state.block = {
      kind: "child_bot",
      botId: "bot-b",
      name: "Research",
      title: "Read sources",
      status,
      deliveryStatus: "policy_disabled",
    };
    await act(async () => root.render(<ThreadRoute />));
    const card = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
      node.textContent?.startsWith("Research"),
    );
    expect(card).toBeDefined();
    expect(card?.textContent).toContain("Automatic collaboration stopped");
    await act(async () => card?.click());
    if (status === "created") {
      expect(card?.textContent).toContain("Read sources");
      expect(state.router.push).toHaveBeenCalledWith({
        pathname: "/thread",
        params: { botId: "bot-b", name: "Research" },
      });
    } else {
      expect(card?.textContent).toContain(
        status === "archived"
          ? "Archived. Chat, memory, and files kept."
          : "Removed with chat, computer, and memory.",
      );
      expect(card?.textContent).not.toContain("Read sources");
      expect(state.router.push).not.toHaveBeenCalled();
    }
  },
);
