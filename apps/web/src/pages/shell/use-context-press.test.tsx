// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useContextPress } from "./use-context-press";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render() {
  const onOpen = vi.fn();
  const onClick = vi.fn();
  function Row() {
    const press = useContextPress<HTMLButtonElement>(onOpen);
    return (
      <button type="button" {...press} onClick={onClick}>
        Companion
      </button>
    );
  }
  act(() => root.render(<Row />));
  return { button: container.querySelector("button")!, onOpen, onClick };
}

function pointer(button: HTMLButtonElement, type: string, x = 20, y = 30, pointerType = "touch") {
  act(() => {
    const event = new Event(type === "pointerleave" ? "pointerout" : type, { bubbles: true });
    Object.assign(event, { pointerId: 1, clientX: x, clientY: y, isPrimary: true, pointerType });
    button.dispatchEvent(event);
  });
}

it("opens after a stationary half-second touch and suppresses its following click", () => {
  const { button, onOpen, onClick } = render();
  pointer(button, "pointerdown");
  act(() => vi.advanceTimersByTime(499));
  expect(onOpen).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(button, { x: 20, y: 30 });
  pointer(button, "pointerup");
  act(() => button.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true })));
  expect(onClick).not.toHaveBeenCalled();
  act(() => button.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it.each(["pointerup", "pointercancel", "pointerleave"])("cancels a pending press on %s", (type) => {
  const { button, onOpen, onClick } = render();
  pointer(button, "pointerdown");
  pointer(button, type);
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).not.toHaveBeenCalled();
  act(() => button.click());
  expect(onClick).toHaveBeenCalledOnce();
});

it("allows scrolling and dragging to cancel a pending touch", () => {
  const { button, onOpen } = render();
  pointer(button, "pointerdown");
  pointer(button, "pointermove", 25, 36);
  act(() => vi.advanceTimersByTime(100));
  pointer(button, "pointermove", 31, 30);
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).not.toHaveBeenCalled();
});

it("leaves mouse input alone and clears its timer on unmount", () => {
  const { button, onOpen } = render();
  pointer(button, "pointerdown", 20, 30, "mouse");
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).not.toHaveBeenCalled();
  pointer(button, "pointerdown");
  act(() => root.unmount());
  root = createRoot(container);
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).not.toHaveBeenCalled();
});
