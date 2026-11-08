// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedPagePage } from "./SharedPage";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/pages", () => ({
  usePageDocument: (
    code: string,
    _surface: string,
    reply: boolean,
    _inset: number,
    key: string,
  ) => ({
    document: `${code}:${reply}`,
    documentKey: key,
    failed: false,
  }),
}));
vi.mock("../components/pages/PageFrame", () => ({
  PageFrame: ({ document, title }: { document: string; title: string }) => (
    <div data-testid="public-viewer" data-title={title}>
      {document}
    </div>
  ),
}));

const first = "a".repeat(43);
const second = "b".repeat(43);
const fetchPage = vi.fn<typeof fetch>();
let container: HTMLDivElement;
let root: Root;

function response(title: string, extra = {}) {
  return Response.json({
    title,
    code: "compiled page",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

async function render(pathname: string) {
  await act(async () => root.render(<SharedPagePage pathname={pathname} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchPage);
  fetchPage.mockReset();
  document.title = "CogineBot";
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("rejects malformed links locally and reads a valid link without credentials or referrer", async () => {
  for (const path of ["/p", `/p/plan%2F${first}`, `/p/plan-${first}/extra`]) {
    await render(path);
    expect(container.querySelector("h1")?.textContent).toBe("This page isn't available");
  }
  expect(fetchPage).not.toHaveBeenCalled();

  fetchPage.mockResolvedValueOnce(response("First plan"));
  await render(`/p/plan-${first}`);
  expect(fetchPage).toHaveBeenCalledExactlyOnceWith(`/api/v1/pages/shared/${first}`, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: expect.any(AbortSignal),
  });
  expect(container.querySelector('[data-testid="public-viewer"]')?.textContent).toBe(
    "compiled page:false",
  );
  expect(document.title).toBe("First plan");
});

it("aborts a replaced link and ignores its delayed response even when the documents match", async () => {
  let finish!: (value: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  fetchPage.mockReturnValueOnce(delayed).mockResolvedValueOnce(response("Second plan"));
  await render(`/p/first-${first}`);
  const signal = fetchPage.mock.calls[0]?.[1]?.signal;
  await render(`/p/second-${second}`);
  expect(signal?.aborted).toBe(true);
  expect(document.title).toBe("Second plan");
  await act(async () => finish(response("First plan")));
  expect(container.textContent).not.toContain("First plan");
  expect(
    container.querySelector('div[data-testid="public-viewer"]')?.getAttribute("data-title"),
  ).toBe("Second plan");
});

it("clears the viewer for a back-forward cache restoration and rereads before rendering", async () => {
  fetchPage
    .mockResolvedValueOnce(response("First plan"))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  await render(`/p/plan-${first}`);
  expect(document.title).toBe("First plan");

  await act(async () =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  expect(container.querySelector('[data-testid="public-viewer"]')).toBeNull();
  expect(document.title).toBe("CogineBot");
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await act(async () =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(container.querySelector("h1")?.textContent).toBe("This page isn't available");
});

it("rejects extra response fields and retries without exposing them", async () => {
  fetchPage
    .mockResolvedValueOnce(response("First plan", { ownerId: "private-owner" }))
    .mockResolvedValueOnce(response("Fresh plan"));
  await render(`/p/plan-${first}`);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't load this page. Try again.",
  );
  expect(container.querySelector('[data-testid="public-viewer"]')).toBeNull();
  await act(async () => container.querySelector("button")?.click());
  expect(document.title).toBe("Fresh plan");
});
