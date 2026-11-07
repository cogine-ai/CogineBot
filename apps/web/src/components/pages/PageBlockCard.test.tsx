// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageBlockCard } from "./PageBlockCard";

const hooks = vi.hoisted(() => ({
  read: vi.fn(),
  viewer: vi.fn(),
  open: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("../../lib/pages", () => ({
  usePageDetail: hooks.read,
  usePageDocument: hooks.viewer,
  useOpenPage: () => hooks.open,
  usePages: () => ({ store: { invalidate: hooks.invalidate } }),
}));
vi.mock("./PageCard", () => ({
  PageCard: ({ document, onOpen }: { document: string | null; onOpen?: () => void }) => (
    <button type="button" onClick={onOpen} disabled={!onOpen}>
      {document}
    </button>
  ),
}));

const block = { kind: "page" as const, pageId: "plan", version: 1, title: "Plan" };
const snapshot = (version: number) => ({
  data: { title: "Plan", currentVersion: 2, version, code: `Compiled version ${version}` },
});
const mounted: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mounted.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hooks.viewer.mockImplementation((code: string) => ({ document: code, failed: false }));
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted.push(root);
  return { root, button: () => container.querySelector("button")! };
}

it("renders a superseded card's saved version but opens the current Page", async () => {
  hooks.read.mockImplementation((_id: string, version?: number) => snapshot(version ?? 2));
  const { root, button } = mount();
  await act(() => root.render(<PageBlockCard block={block} updated />));
  expect(hooks.read.mock.calls).toEqual([["plan"], ["plan", 1]]);
  expect(hooks.viewer).toHaveBeenLastCalledWith(
    "Compiled version 1",
    "card",
    false,
    0,
    '["plan",1]',
  );
  expect(button().textContent).toBe("Compiled version 1");
  await act(() => button().click());
  expect(hooks.open).toHaveBeenCalledWith("plan");
});

it("hides an older cached preview if the current Page is no longer accessible", async () => {
  hooks.read.mockImplementation((_id: string, version?: number) =>
    version === undefined ? { error: { code: "FORBIDDEN" } } : snapshot(version),
  );
  const { root, button } = mount();
  await act(() => root.render(<PageBlockCard block={block} updated />));
  expect(button().textContent).toBe("");
});

it("refreshes a newly selected Page even when its card has the same version number", async () => {
  hooks.read.mockReturnValue({ data: { ...snapshot(1).data, currentVersion: 1 } });
  const { root } = mount();
  await act(() => root.render(<PageBlockCard block={{ ...block, version: 2 }} />));
  await act(() =>
    root.render(<PageBlockCard block={{ ...block, pageId: "other-plan", version: 2 }} />),
  );
  expect(hooks.invalidate.mock.calls).toEqual([["plan"], ["other-plan"]]);
});
