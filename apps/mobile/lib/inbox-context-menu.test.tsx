// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { act, useEffect, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ OS: "android", show: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: native,
  View: ({
    children,
    onLayout,
  }: {
    children: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) => {
    useEffect(() => onLayout?.({ nativeEvent: { layout: { width: 320 } } }), [onLayout]);
    return <div>{children}</div>;
  },
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children, ref }: { children: ReactNode; ref: Ref<{ show: () => void }> }) => {
    useImperativeHandle(ref, () => ({ show: native.show }), []);
    return <div>{children}</div>;
  },
}));
vi.mock("./native", () => ({ useResolvedAppearance: () => "light" }));

import { InboxContextMenu } from "../components/inbox-context-menu";

beforeEach(() => {
  native.OS = "android";
  native.show.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "forwards the Android child gesture only when its menu is enabled (%s)",
  (enabled) => {
    const open = vi.fn();
    function Row({ onLongPress }: { onLongPress?: () => void }) {
      return (
        <button
          type="button"
          onClick={open}
          onContextMenu={(event) => {
            event.preventDefault();
            onLongPress?.();
          }}
        >
          Chat
        </button>
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <InboxContextMenu
            enabled={enabled}
            actions={[{ id: "group", title: "Group" }]}
            onAction={vi.fn()}
          >
            <Row />
          </InboxContextMenu>,
        ),
      );
      act(() =>
        container
          .querySelector("button")!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
      );
      expect(native.show).toHaveBeenCalledTimes(enabled ? 1 : 0);
      act(() => container.querySelector("button")!.click());
      expect(open).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  },
);
