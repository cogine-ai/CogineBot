// @vitest-environment jsdom
import type { PageSummary } from "@rakazo/contracts";
import { act, Suspense, startTransition, useEffect, useLayoutEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePagedPages } from "./use-paged-pages";

const host = vi.hoisted(() => ({
  scope: "scope-a",
  focused: true,
  watchers: new Set<() => void>(),
  request: vi.fn(),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) =>
    useEffect(() => (host.focused ? callback() : undefined), [callback, host.focused]),
}));
vi.mock("./pages", () => ({
  pageScopeKey: () => host.scope,
  subscribePageScope: (watcher: () => void) => {
    host.watchers.add(watcher);
    return () => host.watchers.delete(watcher);
  },
  privatePageRpc: host.request,
}));

const item = (id: string): PageSummary => ({
  id,
  title: id,
  botId: "bot-a",
  groupId: null,
  visibility: "private",
  currentVersion: 1,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
let root: Root;
let container: HTMLDivElement;
let pages: ReturnType<typeof usePagedPages>;
type Owner = { botId?: string; groupId?: string };
const commits: Array<{ scope: string; owner: Owner; title: string }> = [];
const renders: Owner[] = [];
const suspended = new Promise<void>(() => {});
function Probe({ owner, suspend = false }: { owner: Owner; suspend?: boolean }) {
  const current = usePagedPages(owner);
  renders.push(owner);
  const text =
    current.listed.status === "ready"
      ? current.listed.items.map((page) => page.title).join(",")
      : current.listed.status;
  useLayoutEffect(() => {
    pages = current;
    commits.push({ scope: host.scope, owner, title: text });
  });
  if (suspend) throw suspended;
  return <p>{text}</p>;
}
function screen(owner: Owner, suspend = false) {
  return (
    <Suspense fallback={<p>suspended</p>}>
      <Probe owner={owner} suspend={suspend} />
    </Suspense>
  );
}
async function render(owner: string | Owner, focused = host.focused) {
  host.focused = focused;
  await act(async () => root.render(screen(typeof owner === "string" ? { botId: owner } : owner)));
}
function pending() {
  let resolve!: (value: { items: PageSummary[]; nextCursor: string | null }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ items: PageSummary[]; nextCursor: string | null }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.scope = "scope-a";
  host.focused = true;
  host.request.mockReset();
  commits.length = 0;
  renders.length = 0;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("hides the previous bot's pages when its owner changes while the screen is unfocused", async () => {
  host.request.mockResolvedValueOnce({ items: [item("Private A")], nextCursor: null });
  await render("bot-a");
  expect(container.textContent).toBe("Private A");
  await render("bot-a", false);
  await render("bot-b", false);
  expect(container.textContent).toBe("loading");
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(
    commits
      .filter((commit) => commit.owner.botId === "bot-b")
      .every((commit) => commit.title === "loading"),
  ).toBe(true);
});

it("gates old scope data before an unfocused identity switch commits", async () => {
  host.request.mockResolvedValueOnce({ items: [item("Private A")], nextCursor: null });
  await render("bot-a");
  await render("bot-a", false);
  host.scope = "scope-b";
  await render("bot-a", false);
  expect(container.textContent).toBe("loading");
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(
    commits
      .filter((commit) => commit.scope === "scope-b")
      .every((commit) => commit.title === "loading"),
  ).toBe(true);
  host.request.mockResolvedValueOnce({ items: [item("Private B")], nextCursor: null });
  await render("bot-a", true);
  expect(container.textContent).toBe("Private B");
});

it.each(["success", "error"] as const)(
  "drops an old owner's late %s and rejects its retained callbacks",
  async (result) => {
    const old = pending();
    host.request.mockReturnValueOnce(old.promise);
    await render("bot-a");
    const stale = pages;
    host.request.mockResolvedValueOnce({ items: [item("Group B")], nextCursor: "group-cursor" });
    await render({ groupId: "bot-a" });
    expect(container.textContent).toBe("Group B");
    await act(async () => {
      if (result === "success") old.resolve({ items: [item("Private A")], nextCursor: null });
      else old.reject(new Error("Old owner's failure"));
      stale.refresh();
      await stale.showMore();
    });
    expect(container.textContent).toBe("Group B");
    expect(host.request).toHaveBeenCalledTimes(2);
    expect(host.request).toHaveBeenLastCalledWith("pages/list", { groupId: "bot-a", limit: 5 });
  },
);

it("drops a result as soon as its scope changes, before the next commit", async () => {
  const old = pending();
  host.request.mockReturnValueOnce(old.promise);
  await render("bot-a");
  host.scope = "scope-b";
  await act(async () => old.resolve({ items: [item("Private A")], nextCursor: null }));
  expect(container.textContent).toBe("loading");
  expect(commits.some((commit) => commit.title === "Private A")).toBe(false);
  host.request.mockResolvedValueOnce({ items: [item("Private B")], nextCursor: null });
  await act(async () => {
    for (const watcher of host.watchers) watcher();
  });
  expect(container.textContent).toBe("Private B");
});

it.each(["success", "error"] as const)(
  "invalidates an unfocused screen's pending %s",
  async (result) => {
    const old = pending();
    host.request.mockReturnValueOnce(old.promise);
    await render("bot-a");
    await render("bot-a", false);
    await act(async () => {
      if (result === "success") old.resolve({ items: [item("Private A")], nextCursor: null });
      else old.reject(new Error("Unfocused failure"));
    });
    expect(container.textContent).toBe("loading");
    host.request.mockResolvedValueOnce({ items: [item("Fresh A")], nextCursor: null });
    await render("bot-a", true);
    expect(container.textContent).toBe("Fresh A");
  },
);

it.each(["success", "error"] as const)(
  "drops stale show-more %s after refresh and admits another page",
  async (result) => {
    const more = pending();
    host.request.mockResolvedValueOnce({ items: [item("A")], nextCursor: "cursor-a" });
    await render("bot-a");
    host.request.mockReturnValueOnce(more.promise);
    let showing!: Promise<void>;
    act(() => {
      showing = pages.showMore();
    });
    host.request.mockResolvedValueOnce({ items: [item("Fresh A")], nextCursor: "fresh-cursor" });
    await act(async () => pages.refresh());
    await act(async () => {
      if (result === "success") more.resolve({ items: [item("Stale")], nextCursor: null });
      else more.reject(new Error("Stale pagination failure"));
      await showing;
    });
    expect(container.textContent).toBe("Fresh A");
    host.request.mockResolvedValueOnce({ items: [item("B")], nextCursor: null });
    await act(async () => pages.showMore());
    expect(container.textContent).toBe("Fresh A,B");
    expect(host.request).toHaveBeenLastCalledWith("pages/list", {
      botId: "bot-a",
      limit: 5,
      cursor: "fresh-cursor",
    });
  },
);

it("does not invalidate a committed owner's request when another owner's render is discarded", async () => {
  const old = pending();
  host.request.mockReturnValueOnce(old.promise);
  await render("bot-a");
  await act(async () => {
    startTransition(() => root.render(screen({ botId: "bot-b" }, true)));
  });
  expect(renders.some((owner) => owner.botId === "bot-b")).toBe(true);
  expect(commits.some((commit) => commit.owner.botId === "bot-b")).toBe(false);
  await act(async () => old.resolve({ items: [item("Committed A")], nextCursor: null }));
  expect(container.textContent).toBe("Committed A");
  expect(host.request).toHaveBeenCalledTimes(1);
  // Abandon the suspended transition and keep the committed identity.
  await render("bot-a");
  expect(container.textContent).toBe("Committed A");
});

it.each(["success", "error"] as const)(
  "drops old-owner pagination %s and rejects its ready callbacks",
  async (result) => {
    const more = pending();
    host.request.mockResolvedValueOnce({ items: [item("Private A")], nextCursor: "cursor-a" });
    await render("bot-a");
    const stale = pages;
    host.request.mockReturnValueOnce(more.promise);
    let showing!: Promise<void>;
    act(() => {
      showing = pages.showMore();
    });
    host.request.mockResolvedValueOnce({ items: [item("Private B")], nextCursor: "cursor-b" });
    await render("bot-b");
    await act(async () => {
      if (result === "success")
        more.resolve({ items: [item("Extra private A")], nextCursor: null });
      else more.reject(new Error("Old owner's pagination failure"));
      await showing;
      await stale.showMore();
      stale.refresh();
    });
    expect(container.textContent).toBe("Private B");
    expect(host.request).toHaveBeenCalledTimes(3);
    host.request.mockResolvedValueOnce({ items: [item("Extra B")], nextCursor: null });
    await act(async () => pages.showMore());
    expect(container.textContent).toBe("Private B,Extra B");
  },
);

it("refreshes the shown count but starts the next owner at five", async () => {
  host.request.mockResolvedValueOnce({
    items: Array.from({ length: 5 }, (_, i) => item(`A${i}`)),
    nextCursor: "cursor-a",
  });
  await render("bot-a");
  host.request.mockResolvedValueOnce({ items: [item("A5")], nextCursor: null });
  await act(async () => pages.showMore());
  host.request.mockResolvedValueOnce({ items: [item("Fresh A")], nextCursor: null });
  await act(async () => pages.refresh());
  expect(host.request).toHaveBeenLastCalledWith("pages/list", { botId: "bot-a", limit: 6 });
  host.request.mockResolvedValueOnce({ items: [item("B")], nextCursor: null });
  await render("bot-b");
  expect(host.request).toHaveBeenLastCalledWith("pages/list", { botId: "bot-b", limit: 5 });
});
