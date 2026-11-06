import type { PageDetail } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  rpc: vi.fn(),
  generation: 1,
  space: "space-a",
  clear: new Set<() => void>(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example",
  currentApiBaseGeneration: () => 1,
  currentSpaceSelectionGeneration: () => host.generation,
  selectedSpaceId: () => host.space,
  subscribeApiBase: () => () => {},
  subscribeSelectedSpace: (clear: () => void) => {
    host.clear.add(clear);
    return () => host.clear.delete(clear);
  },
  captureApiRequestContext: async () => ({ apiBase: "https://app.example", headers: {} }),
  rpc: host.rpc,
}));
vi.mock("./session", () => ({
  registerSessionDiskCache: (clear: () => void) => host.clear.add(clear),
  currentSessionGeneration: () => 1,
  subscribeSessionGeneration: () => () => {},
}));
vi.mock("./i18n", () => ({ getActiveUiLocale: () => "en" }));

const { getLatestPage, getPageVersion, renamePage, removePage, pinPage } = await import("./pages");
const page = (id: string, version: number): PageDetail => ({
  id,
  title: `Title ${id}`,
  botId: "bot-1",
  groupId: null,
  visibility: "private",
  currentVersion: 3,
  version,
  code: `${id}-v${version}`,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  owner: { name: "Owner", image: null },
  shareUrl: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  for (const clear of host.clear) clear();
  host.generation += 1;
  host.space = "space-a";
  host.rpc
    .mockReset()
    .mockImplementation(async (proc, input: { pageId: string; version?: number }) =>
      proc === "pages/get" ? page(input.pageId, input.version ?? 3) : { ok: true },
    );
});

it("shares reads for one saved version without letting different versions replace the latest Page", async () => {
  const first = getPageVersion("page-1", 1);
  expect(getPageVersion("page-1", 1)).toBe(first);
  const [saved, other, current] = await Promise.all([
    first,
    getPageVersion("page-1", 2),
    getLatestPage("page-1"),
  ]);
  expect([saved.code, other.code, current.code]).toEqual(["page-1-v1", "page-1-v2", "page-1-v3"]);
  await expect(getLatestPage("page-1")).resolves.toEqual(current);
  expect(host.rpc.mock.calls.map(([proc, input]) => [proc, input])).toEqual([
    ["pages/get", { pageId: "page-1", version: 1 }],
    ["pages/get", { pageId: "page-1", version: 2 }],
    ["pages/get", { pageId: "page-1" }],
  ]);
});

it("retries a failed historical read while retaining the separate successful latest read", async () => {
  await getLatestPage("page-1");
  host.rpc.mockRejectedValueOnce(
    Object.assign(new Error("Missing version"), { code: "NOT_FOUND" }),
  );
  await expect(getPageVersion("page-1", 1)).rejects.toThrow("Missing version");
  await expect(getPageVersion("page-1", 1)).resolves.toMatchObject({ version: 1 });
  await expect(getLatestPage("page-1")).resolves.toMatchObject({ version: 3 });
  expect(host.rpc).toHaveBeenCalledTimes(3);
});

it.each(["rename", "remove", "pin"] as const)(
  "%s clears this Page's live and saved reads, preserving another Page's cache",
  async (mutation) => {
    await Promise.all([
      getLatestPage("page-1"),
      getPageVersion("page-1", 1),
      getLatestPage("page-other"),
      getPageVersion("page-other", 1),
    ]);
    if (mutation === "rename") await renamePage("page-1", "New title");
    if (mutation === "remove") await removePage("page-1");
    if (mutation === "pin") await pinPage("page-1", true);
    await Promise.all([
      getLatestPage("page-1"),
      getPageVersion("page-1", 1),
      getLatestPage("page-other"),
      getPageVersion("page-other", 1),
    ]);
    const reads = host.rpc.mock.calls.filter(([proc]) => proc === "pages/get");
    expect(reads.filter(([, input]) => input.pageId === "page-1")).toHaveLength(4);
    expect(reads.filter(([, input]) => input.pageId === "page-other")).toHaveLength(2);
  },
);

it("an invalidated historical request's late rejection cannot evict its replacement", async () => {
  const old = deferred<PageDetail>();
  const replacement = deferred<PageDetail>();
  host.rpc.mockReturnValueOnce(old.promise);
  const stale = getPageVersion("page-1", 1);
  await Promise.resolve();
  await renamePage("page-1", "Renamed");
  host.rpc.mockReturnValueOnce(replacement.promise);
  const current = getPageVersion("page-1", 1);
  old.reject(new Error("Old failed read"));
  await expect(stale).rejects.toThrow("Old failed read");
  expect(getPageVersion("page-1", 1)).toBe(current);
  replacement.resolve(page("page-1", 1));
  await expect(current).resolves.toMatchObject({ version: 1 });
  expect(host.rpc).toHaveBeenCalledTimes(3);
});

it("rejects reads from before a Space A to B to A change without poisoning the new generation", async () => {
  const oldVersion = deferred<PageDetail>();
  const oldLatest = deferred<PageDetail>();
  host.rpc.mockReturnValueOnce(oldVersion.promise).mockReturnValueOnce(oldLatest.promise);
  const staleVersion = getPageVersion("page-1", 1);
  const staleLatest = getLatestPage("page-1");
  await Promise.resolve();
  host.space = "space-b";
  host.generation += 1;
  for (const clear of host.clear) clear();
  await expect(getPageVersion("page-1", 1)).resolves.toMatchObject({ version: 1 });
  host.space = "space-a";
  host.generation += 1;
  for (const clear of host.clear) clear();
  const current = getPageVersion("page-1", 1);
  const currentLatest = getLatestPage("page-1");
  oldVersion.resolve({ ...page("page-1", 1), code: "old owner's version" });
  oldLatest.resolve({ ...page("page-1", 3), code: "old owner's latest" });
  await expect(staleVersion).rejects.toThrow("Page scope changed");
  await expect(staleLatest).rejects.toThrow("Page scope changed");
  await expect(current).resolves.toMatchObject({ code: "page-1-v1" });
  await expect(currentLatest).resolves.toMatchObject({ code: "page-1-v3" });
  expect(getPageVersion("page-1", 1)).toBe(current);
  expect(host.rpc).toHaveBeenCalledTimes(5);
});

it("shares concurrent focus refreshes of the latest Page while retaining saved version reads", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    await Promise.all([getLatestPage("page-1"), getPageVersion("page-1", 1)]);
    now.mockReturnValue(11_000);
    const [first, second] = await Promise.all([
      getLatestPage("page-1", { since: 11_000 }),
      getLatestPage("page-1", { since: 11_000 }),
    ]);
    expect(first).toBe(second);
    await getPageVersion("page-1", 1);
    expect(host.rpc).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
  }
});

it("shares the refresh when two cards discover the cached latest Page is older than their version", async () => {
  host.rpc.mockResolvedValueOnce({ ...page("page-1", 1), currentVersion: 1 });
  await getLatestPage("page-1");
  const refresh = deferred<PageDetail>();
  host.rpc.mockReturnValue(refresh.promise);
  const first = getLatestPage("page-1", { atLeastVersion: 2 });
  const second = getLatestPage("page-1", { atLeastVersion: 2 });
  await Promise.resolve();
  await Promise.resolve();
  expect(host.rpc).toHaveBeenCalledTimes(2);
  refresh.resolve(page("page-1", 3));
  await expect(first).resolves.toMatchObject({ currentVersion: 3 });
  await expect(second).resolves.toMatchObject({ currentVersion: 3 });
});

it("a previous generation's late mutation cannot invalidate the current owner's read cache", async () => {
  const mutation = deferred<{ ok: true }>();
  host.rpc.mockReturnValueOnce(mutation.promise);
  const staleRename = renamePage("page-1", "Old title");
  await Promise.resolve();
  host.space = "space-b";
  host.generation += 1;
  for (const clear of host.clear) clear();
  host.space = "space-a";
  host.generation += 1;
  for (const clear of host.clear) clear();
  const saved = getPageVersion("page-1", 1);
  const current = getLatestPage("page-1");
  await Promise.all([saved, current]);
  mutation.resolve({ ok: true });
  await expect(staleRename).rejects.toThrow("Page scope changed");
  expect(getPageVersion("page-1", 1)).toBe(saved);
  await getLatestPage("page-1");
  expect(host.rpc).toHaveBeenCalledTimes(3);
});

it("checks each caller's minimum after sharing a lower-version refresh, and shares the needed next read", async () => {
  host.rpc.mockResolvedValueOnce({ ...page("page-1", 1), currentVersion: 1 });
  await getLatestPage("page-1");
  const secondVersion = deferred<PageDetail>();
  const thirdVersion = deferred<PageDetail>();
  host.rpc.mockReturnValueOnce(secondVersion.promise).mockReturnValueOnce(thirdVersion.promise);
  const wantsTwo = getLatestPage("page-1", { atLeastVersion: 2 });
  const wantsThree = getLatestPage("page-1", { atLeastVersion: 3 });
  const alsoWantsThree = getLatestPage("page-1", { atLeastVersion: 3 });
  await Promise.resolve();
  await Promise.resolve();
  expect(host.rpc).toHaveBeenCalledTimes(2);
  secondVersion.resolve({ ...page("page-1", 2), currentVersion: 2 });
  await expect(wantsTwo).resolves.toMatchObject({ currentVersion: 2 });
  expect(host.rpc).toHaveBeenCalledTimes(3);
  thirdVersion.resolve(page("page-1", 3));
  await expect(wantsThree).resolves.toMatchObject({ currentVersion: 3 });
  await expect(alsoWantsThree).resolves.toMatchObject({ currentVersion: 3 });
  expect(host.rpc).toHaveBeenCalledTimes(3);
});

it("makes only one fresh attempt when the server still returns less than the requested version", async () => {
  host.rpc.mockResolvedValue({ ...page("page-1", 1), currentVersion: 1 });
  await getLatestPage("page-1");
  await expect(getLatestPage("page-1", { atLeastVersion: 99 })).resolves.toMatchObject({
    currentVersion: 1,
  });
  expect(host.rpc).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "does not refresh a resolved old-scope cache in the new Space before its continuation (ABA=%s)",
  async (backToFirstSpace) => {
    host.rpc.mockResolvedValueOnce({ ...page("page-1", 1), currentVersion: 1 });
    await getLatestPage("page-1");
    const stale = getLatestPage("page-1", { atLeastVersion: 2 });
    host.space = "space-b";
    host.generation += 1;
    for (const clear of host.clear) clear();
    if (backToFirstSpace) {
      host.space = "space-a";
      host.generation += 1;
      for (const clear of host.clear) clear();
    }
    await expect(stale).rejects.toThrow("Page scope changed");
    expect(host.rpc).toHaveBeenCalledTimes(1);
  },
);
