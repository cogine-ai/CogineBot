// @vitest-environment jsdom

import type { PageSummary } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Rpc from "./rpc";

const reads = vi.hoisted(() => ({ list: vi.fn(), rename: vi.fn(), pin: vi.fn(), get: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({ PageIcon: () => null }));
vi.mock("@rakazo/ui-web", () => {
  const wrapper = ({ children }: { children?: ReactNode }) => children;
  const button = ({
    children,
    onClick,
    disabled,
    "aria-label": label,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
  return {
    Button: button,
    DropdownMenu: wrapper,
    DropdownMenuContent: wrapper,
    DropdownMenuTrigger: button,
    DropdownMenuItem: button,
  };
});
vi.mock("../pages/shell/dialogs", () => ({ DeleteItemDialog: () => null }));
vi.mock("./relative-time", () => ({ formatRelativeTime: () => "now" }));
vi.mock("./rpc", async (original) => ({
  ...(await original<typeof Rpc>()),
  createSpaceRpc: () => ({ pages: reads }),
}));
const { PagesList } = await import("../components/pages/PagesList");
const { PagesProvider, usePagesForChat } = await import("./pages");
const { usePrivatePageMutation } = await import("./private-page-list");
const { selectSpace, synchronizeRpcSession } = await import("./rpc");

const page = (index: number): PageSummary => ({
  id: `page-${index}`,
  title: `Plan ${index}`,
  botId: "bot-1",
  groupId: null,
  visibility: "private",
  currentVersion: 1,
  pinned: false,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
});
const batch = (start: number, nextCursor: string | null) => ({
  items: Array.from({ length: 20 }, (_, index) => page(start + index)),
  nextCursor,
});
const mounted: { root: ReturnType<typeof createRoot>; container: HTMLDivElement }[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads.list.mockReset();
  reads.rename.mockReset();
  reads.pin.mockReset();
  reads.get.mockReset().mockImplementation(async ({ pageId }: { pageId: string }) => ({
    ...page(1),
    id: pageId,
    version: 1,
    code: "compiled",
    owner: { name: "Owner", image: null },
  }));
  reads.rename.mockResolvedValue({ ok: true });
  reads.pin.mockResolvedValue({ ok: true });
  selectSpace("space-1");
  synchronizeRpcSession("authenticated", "owner-1", "session-1");
});
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});
async function show() {
  function Owner() {
    const pages = usePagesForChat("owner-1:space-1:bot-1", "space-1");
    return (
      <PagesProvider value={pages}>
        <PagesList botId="bot-1" />
      </PagesProvider>
    );
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Owner />
      </MemoryRouter>,
    ),
  );
  return container;
}
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
const titles = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((row) => row.textContent);

it("retries a failed first-batch refresh with existing rows and no next cursor", async () => {
  reads.list
    .mockResolvedValueOnce({ items: [page(1)], nextCursor: null })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [{ ...page(1), title: "Recovered" }], nextCursor: null });
  const container = await show();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).toContain("Plan 1");
  expect(container.textContent).toContain("Couldn't load pages.");
  await act(async () => button(container, "Try again").click());
  expect(reads.list.mock.calls.map(([input]) => input)).toEqual([
    { botId: "bot-1", limit: 20 },
    { botId: "bot-1", limit: 20 },
    { botId: "bot-1", limit: 20 },
  ]);
  expect(container.textContent).toContain("Recovered");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it.each(["focus", "more"] as const)(
  "hides prior private titles when %s loses access",
  async (kind) => {
    reads.list
      .mockResolvedValueOnce(batch(1, "old-cursor"))
      .mockRejectedValueOnce({ code: kind === "focus" ? "UNAUTHORIZED" : "FORBIDDEN" })
      .mockResolvedValueOnce({ items: [{ ...page(1), title: "Reauthorized" }], nextCursor: null });
    const container = await show();
    expect(titles(container)).toHaveLength(20);
    await act(async () => {
      if (kind === "focus") window.dispatchEvent(new Event("focus"));
      else button(container, "Show more").click();
    });
    expect(titles(container)).toEqual([]);
    expect(container.textContent).not.toContain("Plan 1");
    expect(container.textContent).toContain("Couldn't load pages.");
    await act(async () => button(container, "Try again").click());
    expect(reads.list.mock.lastCall?.[0].cursor).toBeUndefined();
    expect(container.textContent).toContain("Reauthorized");
  },
);

it("retries the failed next batch through the real Show more consumer", async () => {
  reads.list
    .mockResolvedValueOnce(batch(1, "cursor-20"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [page(21)], nextCursor: null });
  const container = await show();
  await act(async () => button(container, "Show more").click());
  await act(async () => button(container, "Try again").click());
  expect(reads.list.mock.calls.map(([input]) => input.cursor)).toEqual([
    undefined,
    "cursor-20",
    "cursor-20",
  ]);
  expect(titles(container)).toHaveLength(21);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps expanded batches on focus, pin and rename using newly read cursors", async () => {
  let refresh = 0;
  reads.list.mockImplementation(async ({ cursor }: { cursor?: string }) => {
    if (!cursor) {
      refresh += 1;
      return batch(1, `cursor-${refresh}`);
    }
    return batch(21, null);
  });
  const container = await show();
  await act(async () => button(container, "Show more").click());
  expect(titles(container)).toHaveLength(40);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(titles(container)).toHaveLength(40);
  await act(async () => button(container, "Pin").click());
  expect(reads.pin).toHaveBeenCalledWith({ pageId: "page-1", pinned: true });
  expect(titles(container)).toHaveLength(40);
  await act(async () => button(container, "Rename").click());
  const title = container.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(title, "Renamed plan");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(reads.rename).toHaveBeenCalledWith({ pageId: "page-1", title: "Renamed plan" });
  expect(titles(container)).toHaveLength(40);
  expect(reads.list.mock.calls.map(([input]) => input.cursor)).toEqual([
    undefined,
    "cursor-1",
    undefined,
    "cursor-2",
    undefined,
    "cursor-3",
    undefined,
    "cursor-4",
  ]);
  expect(reads.list.mock.calls.every(([input]) => input.limit === 20)).toBe(true);
});

it("retains expanded rows on a later refresh error and retries the whole cursor chain", async () => {
  reads.list
    .mockResolvedValueOnce(batch(1, "old-cursor"))
    .mockResolvedValueOnce(batch(21, null))
    .mockResolvedValueOnce(batch(1, "changed-cursor"))
    .mockRejectedValueOnce(new Error("second batch offline"))
    .mockResolvedValueOnce(batch(1, "retry-cursor"))
    .mockResolvedValueOnce(batch(21, null));
  const container = await show();
  await act(async () => button(container, "Show more").click());
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(titles(container)).toHaveLength(40);
  await act(async () => button(container, "Try again").click());
  expect(titles(container)).toHaveLength(40);
  expect(reads.list.mock.calls.map(([input]) => input.cursor)).toEqual([
    undefined,
    "old-cursor",
    undefined,
    "changed-cursor",
    undefined,
    "retry-cursor",
  ]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("drops an old next-batch reply when a new search takes over, then starts its own first batch", async () => {
  let finishMore!: (data: ReturnType<typeof batch>) => void;
  let finishSearch!: (data: ReturnType<typeof batch>) => void;
  reads.list
    .mockResolvedValueOnce(batch(1, "old-cursor"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMore = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSearch = resolve;
        }),
    );
  const container = await show();
  await act(async () => button(container, "Show more").click());
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "Different");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(reads.list).toHaveBeenLastCalledWith({ botId: "bot-1", limit: 20, query: "Different" });
  await act(async () => finishMore(batch(21, null)));
  expect(titles(container)).toHaveLength(20);
  expect(button(container, "Show more")).toBeUndefined();
  await act(async () => finishSearch(batch(101, null)));
  expect(titles(container)).toHaveLength(20);
  expect(container.textContent).toContain("Plan 101");
  expect(container.textContent).not.toContain("Plan 1now");
});

async function mutationView(pageId?: string) {
  let visible = true;
  let scopeKey = "owner-1:space-1:bot-1";
  let spaceId = "space-1";
  let instance = 0;
  let mounts = 0;
  let binding!: ReturnType<typeof usePagesForChat>;
  let mutation!: ReturnType<typeof usePrivatePageMutation<{ pageId: string; title: string }>>;
  function Probe() {
    useEffect(() => {
      mounts += 1;
    }, []);
    mutation = usePrivatePageMutation(
      (input: { pageId: string; title: string }) => reads.rename(input),
      pageId,
    );
    return null;
  }
  function Owner() {
    binding = usePagesForChat(scopeKey, spaceId);
    return (
      <PagesProvider value={binding}>{visible ? <Probe key={instance} /> : null}</PagesProvider>
    );
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Owner />
      </MemoryRouter>,
    ),
  );
  return {
    binding: () => binding,
    mutation: () => mutation,
    mounts: () => mounts,
    switchScope: (key: string, space: string, replace = false) => {
      scopeKey = key;
      spaceId = space;
      if (replace) instance += 1;
      root.render(
        <MemoryRouter>
          <Owner />
        </MemoryRouter>,
      );
    },
    hide: () => {
      visible = false;
      root.render(
        <MemoryRouter>
          <Owner />
        </MemoryRouter>,
      );
    },
  };
}

it.each(["page-1", undefined])(
  "reconciles a lost mutation reply with %s detail invalidation and resets the next attempt",
  async (pageId) => {
    let reject!: (reason: Error) => void;
    reads.rename.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const view = await mutationView(pageId);
    const store = view.binding().store;
    const first = store.get("page-1");
    const second = store.get("page-2");
    await Promise.all([first, second]);
    await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Rename" }));
    expect(view.mutation().isPending).toBe(true);
    expect(view.mutation().isError).toBe(false);
    await act(async () => reject(new Error("reply lost")));
    expect(view.mutation().isPending).toBe(false);
    expect(view.mutation().isError).toBe(true);
    const refreshed = store.get("page-1");
    expect(refreshed).not.toBe(first);
    const retained = store.get("page-2");
    if (pageId) expect(retained).toBe(second);
    else expect(retained).not.toBe(second);
    await retained;
    expect(reads.get).toHaveBeenCalledTimes(pageId ? 3 : 4);
    let finish!: () => void;
    reads.rename.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Retry" }));
    expect(view.mutation().isPending).toBe(true);
    expect(view.mutation().isError).toBe(false);
    await act(async () => finish());
    expect(view.mutation().isPending).toBe(false);
    expect(view.mutation().isError).toBe(false);
    expect(store.get("page-1")).not.toBe(refreshed);
    if (pageId) expect(store.get("page-2")).toBe(retained);
    else expect(store.get("page-2")).not.toBe(retained);
  },
);

it("does not reconcile a lost reply or issue another mutation after its account scope dies", async () => {
  let reject!: (reason: Error) => void;
  reads.rename.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const view = await mutationView("page-1");
  const store = view.binding().store;
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Rename" }));
  const revision = store.revision();
  synchronizeRpcSession("authenticated", "owner-2", "session-2");
  await act(async () => reject(new Error("reply lost")));
  expect(store.revision()).toBe(revision);
  expect(view.mutation().isPending).toBe(false);
  expect(view.mutation().isError).toBe(false);
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Stale" }));
  expect(reads.rename).toHaveBeenCalledTimes(1);
});

function renameReply() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("keeps the latest rename feedback when the list starts another rename before the first reply", async () => {
  const first = renameReply();
  const second = renameReply();
  reads.list.mockResolvedValue({ items: [page(1)], nextCursor: null });
  reads.rename.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const container = await show();
  const rename = async (next: string) => {
    await act(async () => button(container, "Rename").click());
    const title = container.querySelector<HTMLInputElement>('input[aria-label="Page title"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(title, next);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
  };
  await rename("First name");
  await rename("Second name");
  expect(reads.rename.mock.calls.map(([input]) => input.title)).toEqual([
    "First name",
    "Second name",
  ]);
  await act(async () => first.reject(new Error("first reply lost")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => second.resolve({ ok: true }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(reads.list).toHaveBeenCalledTimes(3);
});

it.each([
  { firstFails: false, firstSettlesFirst: true },
  { firstFails: false, firstSettlesFirst: false },
  { firstFails: true, firstSettlesFirst: true },
  { firstFails: true, firstSettlesFirst: false },
])(
  "keeps overlapping calls pending and latest feedback: %j",
  async ({ firstFails, firstSettlesFirst }) => {
    const replies = [renameReply(), renameReply()];
    reads.rename.mockReturnValueOnce(replies[0]!.promise).mockReturnValueOnce(replies[1]!.promise);
    const view = await mutationView("page-1");
    const store = view.binding().store;
    const results: Promise<unknown>[] = [];
    await act(async () => {
      for (const title of ["First", "Second"])
        results.push(
          view
            .mutation()
            .mutateAsync({ pageId: "page-1", title })
            .catch((error: unknown) => error),
        );
    });
    const revision = store.revision();
    let previousRead = store.get("page-1");
    await previousRead;
    const failures = [firstFails, !firstFails];
    const order = firstSettlesFirst ? [0, 1] : [1, 0];
    for (const [settled, index] of order.entries()) {
      const error = new Error(`call ${index + 1} reply lost`);
      await act(async () => {
        if (failures[index]) replies[index]!.reject(error);
        else replies[index]!.resolve({ ok: true });
      });
      if (failures[index]) expect(await results[index]).toBe(error);
      else expect(await results[index]).toEqual({ ok: true });
      expect(view.mutation().isPending).toBe(settled === 0);
      expect(view.mutation().isError).toBe(order.slice(0, settled + 1).includes(1) && !firstFails);
      expect(store.revision()).toBe(revision + settled + 1);
      const refreshed = store.get("page-1");
      expect(refreshed).not.toBe(previousRead);
      await refreshed;
      previousRead = refreshed;
    }
    expect(reads.rename).toHaveBeenCalledTimes(2);
  },
);

it("reset clears feedback while active calls still reconcile and remain pending", async () => {
  const reply = renameReply();
  reads.rename.mockReturnValueOnce(reply.promise);
  const view = await mutationView("page-1");
  const store = view.binding().store;
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Rename" }));
  const revision = store.revision();
  await act(async () => view.mutation().reset());
  expect(view.mutation().isPending).toBe(true);
  expect(view.mutation().isError).toBe(false);
  await act(async () => reply.reject(new Error("reset attempt reply lost")));
  expect(view.mutation().isPending).toBe(false);
  expect(view.mutation().isError).toBe(false);
  expect(store.revision()).toBe(revision + 1);
});

it("reconciles each settled call after its reader unmounts while the owning scope remains live", async () => {
  const first = renameReply();
  const second = renameReply();
  reads.rename.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = await mutationView("page-1");
  const store = view.binding().store;
  let rejected!: Promise<unknown>;
  await act(async () => {
    view.mutation().mutate({ pageId: "page-1", title: "First" });
    rejected = view
      .mutation()
      .mutateAsync({ pageId: "page-1", title: "Second" })
      .catch((e: unknown) => e);
  });
  const revision = store.revision();
  await act(async () => view.hide());
  expect(store.isCurrent()).toBe(true);
  await act(async () => first.resolve({ ok: true }));
  const error = new Error("second reply lost");
  await act(async () => second.reject(error));
  expect(await rejected).toBe(error);
  expect(store.revision()).toBe(revision + 2);
});

it("does not revive old mutation callbacks after the same account and session return", async () => {
  const reply = renameReply();
  reads.rename.mockReturnValueOnce(reply.promise);
  const view = await mutationView("page-1");
  const store = view.binding().store;
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Rename" }));
  const revision = store.revision();
  synchronizeRpcSession("authenticated", "owner-2", "session-2");
  synchronizeRpcSession("authenticated", "owner-1", "session-1");
  await act(async () => reply.reject(new Error("old reply lost")));
  expect(store.isCurrent()).toBe(false);
  expect(store.revision()).toBe(revision);
  expect(view.mutation().isPending).toBe(false);
  expect(view.mutation().isError).toBe(false);
  await expect(
    view.mutation().mutateAsync({ pageId: "page-1", title: "Stale" }),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(reads.rename).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "settles local pending when selection scope dies without remount (failed=%s)",
  async (failed) => {
    const reply = renameReply();
    reads.rename.mockReturnValueOnce(reply.promise);
    const view = await mutationView("page-1");
    const store = view.binding().store;
    await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Rename" }));
    const revision = store.revision();
    selectSpace("space-2");
    expect(store.isCurrent()).toBe(false);
    await act(async () => {
      if (failed) reply.reject(new Error("old selection reply lost"));
      else reply.resolve({ ok: true });
    });
    expect(view.mounts()).toBe(1);
    expect(view.mutation().isPending).toBe(false);
    expect(view.mutation().isError).toBe(false);
    expect(store.revision()).toBe(revision);
  },
);

it.each([false, true])(
  "keeps the reused hook's active count and new-scope error owner (old settles first=%s)",
  async (oldFirst) => {
    const oldReply = renameReply();
    const newReply = renameReply();
    reads.rename.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
    const view = await mutationView("page-1");
    const oldStore = view.binding().store;
    await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Old scope" }));
    const oldRevision = oldStore.revision();
    selectSpace("space-2");
    // Stress reuse of the hook itself; production reader keys normally remount on a Space change.
    await act(async () => view.switchScope("owner-1:space-1:bot-1", "space-2"));
    const currentStore = view.binding().store;
    expect(view.mounts()).toBe(1);
    expect(oldStore.isCurrent()).toBe(false);
    expect(currentStore.isCurrent()).toBe(true);
    await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Current scope" }));
    const currentRevision = currentStore.revision();
    const finishOld = () => oldReply.reject(new Error("stale failure"));
    const finishCurrent = () => newReply.reject(new Error("current failure"));
    await act(async () => (oldFirst ? finishOld() : finishCurrent()));
    expect(view.mutation().isPending).toBe(true);
    expect(view.mutation().isError).toBe(!oldFirst);
    expect(oldStore.revision()).toBe(oldRevision);
    await act(async () => (oldFirst ? finishCurrent() : finishOld()));
    expect(view.mutation().isPending).toBe(false);
    expect(view.mutation().isError).toBe(true);
    expect(oldStore.revision()).toBe(oldRevision);
    expect(currentStore.revision()).toBe(currentRevision + 1);
  },
);

it("keeps a replacement reader's pending state independent of an old owner's completion", async () => {
  const oldReply = renameReply();
  const newReply = renameReply();
  reads.rename.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
  const view = await mutationView("page-1");
  const oldStore = view.binding().store;
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Previous owner" }));
  const revision = oldStore.revision();
  synchronizeRpcSession("authenticated", "owner-2", "session-2");
  await act(async () => view.switchScope("owner-2:space-1:bot-1", "space-1", true));
  expect(view.mounts()).toBe(2);
  expect(view.mutation().isPending).toBe(false);
  await act(async () => view.mutation().mutate({ pageId: "page-1", title: "Current owner" }));
  await act(async () => oldReply.reject(new Error("previous owner reply lost")));
  expect(view.mutation().isPending).toBe(true);
  expect(view.mutation().isError).toBe(false);
  expect(oldStore.revision()).toBe(revision);
  await act(async () => newReply.resolve({ ok: true }));
  expect(view.mutation().isPending).toBe(false);
  expect(view.mutation().isError).toBe(false);
});
