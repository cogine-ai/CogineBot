// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApprovalDetails } from "../components/approval-details";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children, selectable }: { children: ReactNode; selectable?: boolean }) =>
    createElement("span", { "data-selectable": selectable }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityState: { expanded: boolean };
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-expanded": accessibilityState.expanded },
      children,
    ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

it("expands the complete approval details as selectable text and collapses them again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const detail = `Action: "demo_send"\n${"x".repeat(8_500)}\n<final>`;
  try {
    await act(async () => root.render(<ApprovalDetails detail={detail} />));
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Details");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("<final>");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-selectable='true']")?.textContent).toBe(detail);
    expect(container.querySelector("final")).toBeNull();
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("<final>");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
