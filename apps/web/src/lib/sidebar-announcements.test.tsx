// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarAnnouncements } from "./use-sidebar-announcements";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
let controls: ReturnType<typeof useSidebarAnnouncements>;
function Sidebar({ scope }: { scope: string }) {
  controls = useSidebarAnnouncements(scope);
  return <div role="status">{controls.text}</div>;
}
let cleanup = async () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});
async function setup() {
  const view = document.createElement("div");
  document.body.appendChild(view);
  const root = createRoot(view);
  const render = async (scope: string) => {
    await act(async () => root.render(<Sidebar scope={scope} />));
  };
  cleanup = async () => {
    await act(async () => root.unmount());
    view.remove();
  };
  await render("scope");
  const flush = async () => {
    await act(async () => vi.runOnlyPendingTimers());
  };
  return { view, render, flush };
}

describe("sidebar drag announcements", () => {
  it("announces the item and destination, then waits for actual persistence before success", async () => {
    const { view, flush } = await setup();
    let settle = (_success: boolean) => {};
    await act(async () => {
      controls.start("Research");
      controls.target("Product");
      settle = controls.accept();
      controls.end();
    });
    await flush();
    expect(view.textContent).toContain("Moving Research");
    expect(view.textContent).toContain("Move Research to Product");
    expect(view.textContent).not.toContain("Moved Research");
    await act(async () => settle(true));
    await flush();
    expect(view.textContent).toBe("Moved Research");
  });
  it.each(["cancel", "failed"])("does not announce success for a %s move", async (reason) => {
    const { view, flush } = await setup();
    await act(async () => {
      controls.start("Research");
      if (reason === "cancel") controls.end();
      else controls.accept()(false);
    });
    await flush();
    expect(view.textContent).not.toContain("Moved Research");
    expect(view.textContent).toContain(
      reason === "cancel" ? "Move cancelled" : "Could not move Research",
    );
  });
  it("ignores a prior account's result and a superseded drag", async () => {
    const { view, render, flush } = await setup();
    let old = (_success: boolean) => {};
    await act(async () => {
      controls.start("Old");
      old = controls.accept();
    });
    await render("new-scope");
    await act(async () => old(true));
    await flush();
    expect(view.textContent).toBe("");
    await act(async () => {
      controls.start("First");
      old = controls.accept();
      controls.start("Second");
      old(true);
    });
    await flush();
    expect(view.textContent).not.toContain("Moved First");
  });
});
