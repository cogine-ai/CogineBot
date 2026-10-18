// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InlineSectionNameProps } from "./inline-section-name";
import { InlineSectionName } from "./inline-section-name";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
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

function render(props: Partial<InlineSectionNameProps> = {}) {
  const onConfirm = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  act(() =>
    root.render(<InlineSectionName onConfirm={onConfirm} onCancel={onCancel} {...props} />),
  );
  return { input: container.querySelector("input")!, onConfirm, onCancel };
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string, isComposing = false) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing, bubbles: true }));
  });
}

it("focuses and selects the name with no visible action buttons", () => {
  const { input } = render({ defaultValue: "Product" });
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(7);
  expect(input.maxLength).toBe(60);
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("trims the name and guards Enter plus blur while the request is pending", async () => {
  let finish!: () => void;
  const onConfirm = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { input } = render({ onConfirm });
  await change(input, "  Product  ");
  await press(input, "Enter");
  expect(input.readOnly).toBe(true);
  await act(async () => input.blur());
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith("Product");
  await act(async () => finish());
  await press(input, "Enter");
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("commits on blur and leaves an unchanged rename without saving", async () => {
  const result = render({ defaultValue: "Product" });
  await act(async () => result.input.blur());
  expect(result.onCancel).toHaveBeenCalledOnce();
  expect(result.onConfirm).not.toHaveBeenCalled();
  act(() => root.unmount());
  root = createRoot(container);
  const next = render();
  await change(next.input, "Engineering");
  await act(async () => next.input.blur());
  expect(next.onConfirm).toHaveBeenCalledExactlyOnceWith("Engineering");
});

it("cancels without committing after Escape, including its ensuing blur", async () => {
  const { input, onConfirm, onCancel } = render();
  await change(input, "Product");
  await press(input, "Escape");
  await act(async () => input.blur());
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("cancels a blank new name on blur but preserves a blank rename for correction", async () => {
  const next = render();
  await act(async () => next.input.blur());
  expect(next.onCancel).toHaveBeenCalledOnce();
  expect(next.onConfirm).not.toHaveBeenCalled();
  act(() => root.unmount());
  root = createRoot(container);
  const rename = render({ defaultValue: "Product" });
  await change(rename.input, "");
  await act(async () => rename.input.blur());
  expect(rename.onCancel).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Section name is required");
  expect(document.activeElement).toBe(rename.input);
  await press(rename.input, "Escape");
  expect(rename.onCancel).toHaveBeenCalledOnce();
});

it("ignores Enter used to complete IME composition", async () => {
  const { input, onConfirm } = render();
  await change(input, "产品");
  await press(input, "Enter", true);
  expect(onConfirm).not.toHaveBeenCalled();
  await press(input, "Enter");
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith("产品");
});

it.each([
  ["   ", "Section name is required"],
  ["Unassigned", "Choose another group name"],
  ["未分组", "Choose another group name"],
  ["product", "A section with this name already exists"],
])("retains invalid names and reports an inline error: %s", async (name, message) => {
  const { input, onConfirm } = render({ existingNames: ["Product"] });
  await change(input, name);
  await press(input, "Enter");
  expect(onConfirm).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.value).toBe(name);
});

it("retains the draft and returns focus after a failed save, then permits retry", async () => {
  const onConfirm = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce(undefined);
  const { input } = render({ onConfirm });
  await change(input, "Product");
  await act(async () => input.blur());
  expect(input.value).toBe("Product");
  expect(document.activeElement).toBe(input);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  expect(input.readOnly).toBe(false);
  await press(input, "Enter");
  expect(onConfirm).toHaveBeenCalledTimes(2);
});
