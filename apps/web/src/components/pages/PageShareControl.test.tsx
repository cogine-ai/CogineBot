// @vitest-environment jsdom

import type { PageDetail, PageShareInput, PageShareState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageShareControl } from "./PageShareControl";

const owner = vi.hoisted(() => ({
  store: {
    client: { pages: { getShare: vi.fn(), setShare: vi.fn() } },
    isCurrent: () => true,
    invalidate: vi.fn(),
  },
}));
vi.mock("../../lib/pages", () => ({ usePages: () => owner }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const page: PageDetail = {
  id: "page-1",
  title: "Reviewed plan",
  visibility: "private",
  sharedByLink: true,
  botId: null,
  groupId: null,
  currentVersion: 1,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  code: "compiled page",
  owner: { name: "Owner", image: null },
};
const activeLink = (generation: string, token: string) =>
  ({
    visibility: "link",
    publishingEnabled: true,
    shareUrl: `https://app.example.test/p/plan-${token.repeat(43)}`,
    generation,
  }) satisfies PageShareState;
const original = activeLink("first-generation", "a");
const replacement = activeLink("next-generation", "b");
const privatePage = {
  visibility: "private",
  publishingEnabled: true,
  shareUrl: null,
  generation: null,
} satisfies PageShareState;
const writeText = vi.fn<(text: string) => Promise<void>>();
const execCommand = vi.fn<(command: string) => boolean>();
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
let root: Root;
let state: PageShareState;

async function render(detail: PageDetail, open = true) {
  await act(async () => {
    root.render(
      <PageShareControl page={detail} open={open} onOpenChange={() => {}} compact drawn />,
    );
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  writeText.mockReset();
  execCommand.mockReset().mockReturnValue(true);
  state = original;
  const { getShare, setShare } = owner.store.client.pages;
  getShare.mockReset().mockImplementation(async () => state);
  setShare.mockReset().mockImplementation(async (input: PageShareInput) => {
    state = input.visibility === "private" ? privatePage : replacement;
    return state;
  });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await render(page);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (exec) Object.defineProperty(document, "execCommand", exec);
  else Reflect.deleteProperty(document, "execCommand");
  vi.unstubAllGlobals();
});

const button = (name: string, where: ParentNode = document) =>
  [...where.querySelectorAll("button")].find((item) => item.textContent === name);
const radio = (value: "private" | "link") =>
  document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[value === "private" ? 0 : 1]!;

async function copyThenRevoke() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  writeText.mockReturnValueOnce(
    new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
  );
  await act(async () => button("Copy link")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(original.shareUrl);
  await act(async () => radio("private").click());
  expect(owner.store.client.pages.setShare).toHaveBeenCalledExactlyOnceWith(
    { pageId: page.id, visibility: "private" },
    { signal: expect.any(AbortSignal) },
  );
  expect(radio("private").checked).toBe(true);
  return { resolve, reject };
}

it("does not fall back to writing a revoked link after a delayed clipboard rejection", async () => {
  const native = await copyThenRevoke();
  await act(async () => native.reject(new Error("Clipboard permission denied")));
  expect(execCommand).not.toHaveBeenCalled();
  expect(document.querySelector('input[aria-label="Page link"]')).toBeNull();
});

it("ignores late copied feedback after reissue and copies the newly verified link", async () => {
  const native = await copyThenRevoke();
  await act(async () => radio("link").click());
  const confirm = document.querySelector('[role="alertdialog"]')!;
  await act(async () => button("Share", confirm)!.click());
  expect(radio("link").checked).toBe(true);
  await act(async () => native.resolve());
  expect(button("Copied")).toBeUndefined();
  writeText.mockResolvedValueOnce();
  await act(async () => button("Copy link")!.click());
  expect(writeText).toHaveBeenLastCalledWith(replacement.shareUrl);
  expect(button("Copied")).toBeDefined();
});

it("copies a same-generation link after a same-origin title change", async () => {
  state = { ...original, shareUrl: original.shareUrl.replace("/plan-", "/renamed-plan-") };
  writeText.mockResolvedValueOnce();
  await act(async () => button("Copy link")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(state.shareUrl);
});

it("requires a new action after the link origin changes without a new generation", async () => {
  state = {
    ...original,
    shareUrl: original.shareUrl.replace("app.example.test", "new.example.test"),
  };
  writeText.mockResolvedValueOnce();
  await act(async () => button("Copy link")!.click());
  expect(writeText).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "The page link changed. Try again.",
  );
  await act(async () => button("Copy link")!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(state.shareUrl);
});

it("requires fresh consent for a renamed page even when the version did not change", async () => {
  await render(page, false);
  state = privatePage;
  const unshared = { ...page, sharedByLink: undefined };
  await render(unshared);
  await act(async () => radio("link").click());
  const dialog = () => document.querySelector('[role="alertdialog"]')!;
  const renamed = { ...unshared, title: "Renamed plan" };
  await render(renamed);
  const stale = button("Share", dialog())!;
  expect(stale.disabled).toBe(true);
  expect(dialog().textContent).toContain(unshared.title);
  await act(async () => stale.click());
  expect(owner.store.client.pages.setShare).not.toHaveBeenCalled();

  await act(async () => button("Cancel", dialog())!.click());
  await act(async () => radio("link").click());
  expect(dialog().textContent).toContain(renamed.title);
  await act(async () => button("Share", dialog())!.click());
  expect(owner.store.client.pages.setShare).toHaveBeenCalledExactlyOnceWith(
    {
      pageId: renamed.id,
      visibility: "link",
      expectedVersion: renamed.version,
      expectedTitle: renamed.title,
    },
    { signal: expect.any(AbortSignal) },
  );
});

it.each([
  { result: "the committed link", readback: replacement, published: true },
  { result: "the unchanged private state", readback: privatePage, published: false },
])("shows $result after losing the publication response", async ({ readback, published }) => {
  await render(page, false);
  state = privatePage;
  await render({ ...page, sharedByLink: undefined });
  const { getShare, setShare } = owner.store.client.pages;
  getShare.mockClear();
  setShare.mockImplementationOnce(async () => {
    state = readback;
    throw new Error("Publication response was lost");
  });

  await act(async () => radio("link").click());
  const confirm = document.querySelector('[role="alertdialog"]')!;
  await act(async () => button("Share", confirm)!.click());
  expect(getShare).toHaveBeenCalledExactlyOnceWith(
    { pageId: page.id },
    { signal: expect.any(AbortSignal) },
  );
  expect(radio("link").checked).toBe(published);
  expect(radio("private").checked).toBe(!published);
  expect(Boolean(button("Copy link"))).toBe(published);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    published ? undefined : "Couldn't change who can view this page. Try again.",
  );
});

it("shows private without a failure alert when the lost revocation response is confirmed", async () => {
  const { getShare, setShare } = owner.store.client.pages;
  getShare.mockClear();
  setShare.mockImplementationOnce(async () => {
    state = privatePage;
    throw new Error("Revocation response was lost");
  });

  await act(async () => radio("private").click());
  expect(getShare).toHaveBeenCalledExactlyOnceWith(
    { pageId: page.id },
    { signal: expect.any(AbortSignal) },
  );
  expect(radio("private").checked).toBe(true);
  expect(button("Copy link")).toBeUndefined();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
