// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageView } from "./PageView";

const frame = vi.hoisted(() => ({
  drawn: undefined as (() => void) | undefined,
  committed: undefined as ((drawn: boolean) => void) | undefined,
  key: undefined as string | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PageFrame", () => ({
  PageFrame: ({
    onHeight,
    onPageDrawn,
    documentKey,
  }: {
    onHeight: () => void;
    onPageDrawn: (drawn: boolean) => void;
    documentKey?: string;
  }) => {
    frame.drawn = onHeight;
    frame.committed = onPageDrawn;
    frame.key = documentKey;
    return <iframe title="page" />;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mount(props: {
  document: string;
  documentKey?: string;
  notice?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  share?: (drawn: boolean) => ReactNode;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = (next: typeof props) =>
    act(async () =>
      root.render(
        <PageView
          open
          onOpenChange={next.onOpenChange ?? (() => {})}
          title="Plan"
          document={next.document}
          documentKey={next.documentKey}
          notice={next.notice}
          share={next.share}
        />,
      ),
    );
  return { render, unmount: () => act(() => root.unmount()) };
}

it("waits for an updated page to draw, and offers a retry when it never does", async () => {
  vi.useFakeTimers();
  const view = mount({ document: "<p>v1</p>" });
  await view.render({ document: "<p>v1</p>" });
  await act(async () => frame.drawn?.());
  expect(document.body.textContent).not.toContain("This page couldn't load");

  await view.render({ document: "<p>v2</p>" });
  await act(async () => vi.advanceTimersByTime(16_000));
  expect(document.body.textContent).toContain("This page couldn't load");
  await view.unmount();
});

it("waits for a distinct version and retry even when the compiled bytes match", async () => {
  vi.useFakeTimers();
  const first = { document: "<p>same bytes</p>", documentKey: "page:1" };
  const view = mount(first);
  await view.render(first);
  const originalKey = frame.key;
  await act(async () => frame.drawn?.());
  expect(document.querySelector('button[title^="Opens your browser"]')).not.toBeNull();

  await view.render({ ...first, documentKey: "page:2" });
  const nextKey = frame.key;
  expect(nextKey).not.toBe(originalKey);
  expect(document.querySelector('button[title^="Opens your browser"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(16_000));
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(frame.key).not.toBe(nextKey);
  await act(async () => frame.drawn?.());
  expect(document.querySelector('button[title^="Opens your browser"]')).not.toBeNull();
  await view.unmount();
});

it("allows sharing only after the current visible frame reports a successful commit", async () => {
  const share = vi.fn();
  const page = { document: "<p>same bytes</p>", documentKey: "page:1", share };
  const view = mount(page);
  try {
    await view.render(page);
    const firstCommit = frame.committed!;
    await act(async () => frame.drawn?.());
    expect(share).toHaveBeenLastCalledWith(false);
    await act(async () => firstCommit(true));
    expect(share).toHaveBeenLastCalledWith(true);
    await act(async () => firstCommit(false));
    expect(share).toHaveBeenLastCalledWith(false);

    await view.render({ ...page, documentKey: "page:2" });
    await act(async () => {
      frame.drawn?.();
      firstCommit(true);
    });
    expect(share).toHaveBeenLastCalledWith(false);
    await act(async () => frame.committed?.(true));
    expect(share).toHaveBeenLastCalledWith(true);
    await act(async () => firstCommit(false));
    expect(share).toHaveBeenLastCalledWith(true);
  } finally {
    await view.unmount();
  }
});

it("waits for a fresh frame after a refresh notice clears without changing the document", async () => {
  vi.useFakeTimers();
  const page = { document: "<p>cached plan</p>", documentKey: "plan:1" };
  const view = mount(page);
  const pdf = () => document.querySelector('button[title^="Opens your browser"]');
  const loading = () => document.querySelector('[data-testid="page-loading"]');
  const frameWrapper = () => document.querySelector('iframe[title="page"]')!.parentElement!;
  try {
    await view.render(page);
    const originalDrawn = frame.drawn!;
    const originalKey = frame.key;
    await act(async () => originalDrawn());
    expect(pdf()).not.toBeNull();

    await view.render({ ...page, notice: <p>Refresh failed</p> });
    expect(document.body.textContent).toContain("Refresh failed");
    expect(document.querySelector('iframe[title="page"]')).toBeNull();
    expect(pdf()).toBeNull();
    await act(async () => vi.advanceTimersByTime(16_000));

    await view.render(page);
    expect(loading()).not.toBeNull();
    expect(pdf()).toBeNull();
    expect(frameWrapper().hasAttribute("inert")).toBe(true);
    expect(frame.key).not.toBe(originalKey);
    const remountedDrawn = frame.drawn!;
    await act(async () => originalDrawn());
    expect(loading()).not.toBeNull();
    expect(pdf()).toBeNull();

    await act(async () => vi.advanceTimersByTime(15_000));
    expect(document.body.textContent).toContain("This page couldn't load");
    expect(pdf()).toBeNull();
    await act(async () => remountedDrawn());
    expect(document.body.textContent).toContain("This page couldn't load");

    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await act(async () => remountedDrawn());
    expect(loading()).not.toBeNull();
    expect(pdf()).toBeNull();
    expect(frameWrapper().hasAttribute("inert")).toBe(true);
    await act(async () => frame.drawn?.());
    expect(loading()).toBeNull();
    expect(pdf()).not.toBeNull();
    expect(frameWrapper().hasAttribute("inert")).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("closes on Escape unless the key landed in a popup", async () => {
  const onOpenChange = vi.fn();
  const view = mount({ document: "<p>v1</p>", onOpenChange });
  await view.render({ document: "<p>v1</p>", onOpenChange });
  // A menu elsewhere in the app, open but not where the key went.
  const menu = document.body.appendChild(document.createElement("div"));
  menu.dataset.slot = "dropdown-menu-content";
  const press = (target: Element) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  await press(document.querySelector('[data-testid="page-view"]')!);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  onOpenChange.mockClear();
  const item = menu.appendChild(document.createElement("button"));
  await press(item);
  expect(onOpenChange).not.toHaveBeenCalled();
  await view.unmount();
});
