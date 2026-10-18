// @vitest-environment jsdom
import type { BotSection } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotContextMenu } from "./BotContextMenu";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings ? strings.message : String.raw(strings, ...values),
  }),
}));

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

async function render(sections: BotSection[] = []) {
  const onCreateSection = vi.fn();
  const onMoveToSection = vi.fn();
  await act(async () =>
    root.render(
      <BotContextMenu
        bot={{ name: "Companion", pinned: false, unread: false, sectionId: null }}
        position={{ x: 80, y: 80 }}
        onClose={vi.fn()}
        onTogglePinned={vi.fn()}
        sections={sections}
        onMoveToSection={onMoveToSection}
        onCreateSection={onCreateSection}
        onToggleUnread={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onClear={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    ),
  );
  return { onCreateSection, onMoveToSection };
}

function item(text: string) {
  const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === text,
  );
  if (!match) throw new Error(`Missing menu item: ${text}`);
  return match;
}

it("offers one direct grouping action before a section exists", async () => {
  const { onCreateSection } = await render();
  expect(document.body.textContent).not.toContain("Move to");
  expect(document.body.textContent).not.toContain("Unassigned");
  expect(document.body.textContent).not.toContain("Rename section");
  await act(async () => item("Group").click());
  expect(onCreateSection).toHaveBeenCalledOnce();
});

it("offers destination names, Unassigned and creation in a real submenu", async () => {
  const { onMoveToSection } = await render([
    {
      id: "product",
      name: "Product",
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const move = item("Move to");
  expect(move.getAttribute("aria-haspopup")).toBe("menu");
  await act(async () => {
    move.focus();
    move.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(item("Unassigned")).toBeDefined();
  expect(item("New section")).toBeDefined();
  expect(document.body.textContent).not.toContain("Rename section");
  await act(async () => item("Product").click());
  expect(onMoveToSection).toHaveBeenCalledExactlyOnceWith("product");
});

it("returns keyboard focus to Move to when its submenu closes", async () => {
  await render([
    {
      id: "product",
      name: "Product",
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const move = item("Move to");
  await act(async () => {
    move.focus();
    move.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  const destination = item("Product");
  await act(async () => {
    destination.focus();
    destination.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(move));
});
