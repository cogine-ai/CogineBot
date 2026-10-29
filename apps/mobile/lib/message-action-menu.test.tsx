// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageMenuSpec } from "../components/message-action-menu";
import { MessageMenuHost, presentMessageMenu } from "../components/message-action-menu";

const events = vi.hoisted(() => ({
  app: (_state: string) => {},
  scope: () => {},
  close: () => {},
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_name: string, handler: typeof events.app) => {
      events.app = handler;
      return { remove: vi.fn() };
    },
  },
  Modal: ({ children, onRequestClose }: { children: ReactNode; onRequestClose: () => void }) => {
    events.close = onRequestClose;
    return <div role="dialog">{children}</div>;
  },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => (
    <button
      type="button"
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 320, height: 640, fontScale: 2.643 }),
}));
vi.mock("@react-native-vector-icons/ionicons", () => ({ default: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./mobile-scope", () => ({
  subscribeMobileScope: (listener: () => void) => {
    events.scope = listener;
    return vi.fn();
  },
}));

let dispose: () => Promise<void> = async () => {};
afterEach(async () => {
  await dispose();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MessageMenuHost />));
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
function menu(isCurrent = () => true): MessageMenuSpec {
  return {
    anchor: { x: 319, y: 630 },
    isCurrent,
    reactions: [{ emoji: "👍", onPress: vi.fn() }],
    groups: [
      ["Reply", "Copy", "Quote", "Speak message", "Select text"].map((text) => ({
        name: text,
        text,
        icon: "copy-outline",
        onPress: vi.fn(),
      })),
    ],
  };
}

describe("complete mobile action menu", () => {
  it("exposes every action and reaction together, closes and invokes only the selected action", async () => {
    const view = await setup();
    const spec = menu();
    await act(async () => {
      presentMessageMenu(spec);
    });
    expect([...view.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)).toEqual(
      ["Reply", "Copy", "Quote", "Speak message", "Select text"],
    );
    await act(async () => {
      (view.querySelectorAll('[role="menuitem"]')[1] as HTMLButtonElement).click();
    });
    expect(spec.groups[0]![1]!.onPress).toHaveBeenCalledOnce();
    expect(view.querySelector('[role="dialog"]')).toBeNull();
  });
  it("rejects a stale scope even before its listener closes the native overlay", async () => {
    const view = await setup();
    let current = true;
    const spec = menu(() => current);
    await act(async () => {
      presentMessageMenu(spec);
    });
    current = false;
    await act(async () => {
      (view.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    });
    expect(spec.groups[0]![0]!.onPress).not.toHaveBeenCalled();
  });
  it.each(["background", "scope", "cancel"])(
    "closes on %s without performing an action",
    async (reason) => {
      const view = await setup();
      const spec = menu();
      await act(async () => {
        presentMessageMenu(spec);
      });
      await act(async () => {
        if (reason === "background") events.app("background");
        else if (reason === "scope") events.scope();
        else events.close();
      });
      expect(view.querySelector('[role="dialog"]')).toBeNull();
      expect(spec.groups[0]!.every((item) => vi.mocked(item.onPress).mock.calls.length === 0)).toBe(
        true,
      );
    },
  );
  it("does not let an old route's cleanup close a newer menu", async () => {
    const view = await setup();
    let closeOld = () => {};
    await act(async () => {
      closeOld = presentMessageMenu(menu());
      presentMessageMenu({
        ...menu(),
        groups: [[{ name: "New", text: "New", icon: "copy-outline", onPress: vi.fn() }]],
      });
      closeOld();
    });
    expect(view.textContent).toContain("New");
  });
});
