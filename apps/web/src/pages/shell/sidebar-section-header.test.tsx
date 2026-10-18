// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarSectionHeader } from "./sidebar-section-header";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("uses one trailing slot for the collapsed count and disclosure arrow", () => {
  act(() =>
    root.render(<SidebarSectionHeader title="Product" count={2} collapsed onToggle={vi.fn()} />),
  );
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.getAttribute("aria-label")).toBe("Product, 2");
  const indicator = container.querySelector("[data-sidebar-section-indicator]")!;
  expect(indicator.querySelector("[data-sidebar-section-count]")?.textContent).toBe("2");
  expect(indicator.querySelector("[data-sidebar-section-chevron]")).not.toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(1);
});

it("omits the count when expanded and preserves context and keyboard actions", () => {
  const onToggle = vi.fn();
  const onContextMenu = vi.fn();
  const onKeyDown = vi.fn();
  act(() =>
    root.render(
      <SidebarSectionHeader
        title="Unassigned"
        count={5}
        collapsed={false}
        onToggle={onToggle}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />,
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("[data-sidebar-section-count]")).toBeNull();
  act(() => {
    button.click();
    button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
  });
  expect(onToggle).toHaveBeenCalledOnce();
  expect(onContextMenu).toHaveBeenCalledOnce();
  expect(onKeyDown).toHaveBeenCalledOnce();
});

it("renders a plain actionable space heading when it is not collapsible", () => {
  const onToggle = vi.fn();
  act(() =>
    root.render(
      <SidebarSectionHeader
        title="Personal"
        count={0}
        collapsed={false}
        collapsible={false}
        onToggle={onToggle}
        aria-label="Open Personal"
      />,
    ),
  );
  const button = container.querySelector("button")!;
  expect(button.hasAttribute("aria-expanded")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Open Personal");
  expect(container.querySelector("[data-sidebar-section-indicator]")).toBeNull();
  act(() => button.click());
  expect(onToggle).toHaveBeenCalledOnce();
});
