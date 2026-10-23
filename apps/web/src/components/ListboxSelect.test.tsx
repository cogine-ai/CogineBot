// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ListboxSelect } from "./ListboxSelect";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList,
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changed = vi.fn();
  const render = async (disabled = false, value = "a") => {
    await act(async () =>
      root.render(
        <>
          <ListboxSelect
            options={[
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ]}
            value={value}
            label="Space"
            testId="target-space"
            disabled={disabled}
            onChange={changed}
          />
          <button type="button" data-next>
            Next settings control
          </button>
        </>,
      ),
    );
  };
  await render();
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  return {
    container,
    trigger,
    changed,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it.each([false, true])(
  "closes on trigger Tab before the queued popup focus, shift=%s",
  async (shiftKey) => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    const h = await setup();
    try {
      await act(async () => {
        h.trigger.focus();
        h.trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      });
      expect(h.trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      expect(document.activeElement).toBe(h.trigger);
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => h.trigger.dispatchEvent(tab));
      expect(tab.defaultPrevented).toBe(false);
      expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
      expect(h.changed).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);
it("closes the Space chooser when Tab moves to the next settings control", async () => {
  const h = await setup();
  try {
    await act(async () => h.trigger.click());
    const option = document.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => option.focus());
    expect(document.activeElement).toBe(option);
    const popup = document.querySelector<HTMLElement>('[role="listbox"]')!;
    // jsdom has no native Tab traversal; move focus to the next DOM tab stop,
    // including the shared primitive's portal focus guard.
    const nextStop = [...document.querySelectorAll<HTMLElement>('[tabindex="0"]')].find(
      (node) =>
        !popup.contains(node) &&
        Boolean(popup.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
    )!;
    await act(async () => {
      option.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      nextStop.focus();
    });
    expect(document.activeElement?.textContent).toBe("Next settings control");
    await vi.waitFor(() => expect(h.trigger.getAttribute("aria-expanded")).toBe("false"));
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
    expect(h.changed).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
it("selects with keyboard and restores focus on Escape", async () => {
  const h = await setup();
  try {
    await act(async () => {
      h.trigger.focus();
      h.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const target =
      document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      document.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(h.trigger);
    await act(async () => h.trigger.click());
    const beta = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent?.trim() === "Beta",
    )!;
    await act(async () => {
      beta.focus();
      beta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.changed).toHaveBeenCalledExactlyOnceWith("b");
  } finally {
    await h.close();
  }
});
it("keeps a chooser that was already open from changing a busy target", async () => {
  const h = await setup();
  try {
    await act(async () => h.trigger.click());
    await h.render(true);
    const beta = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent?.trim() === "Beta",
    );
    if (beta)
      await act(async () => {
        beta.click();
        beta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
    expect(h.trigger.disabled).toBe(true);
    expect(h.changed).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("renders a controlled value change without committing another option", async () => {
  const h = await setup();
  try {
    await act(async () => h.trigger.click());
    await h.render(false, "b");
    expect(h.trigger.textContent).toContain("Beta");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe(
      "Beta",
    );
    expect(h.changed).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
