import { beforeEach, expect, it, vi } from "vitest";
import type { InboxSpace } from "./inbox-spaces";
import { captureMobileScope } from "./mobile-scope";
import { getSearchInbox, setSearchInbox, subscribeSearchInbox } from "./search-inbox";

const state = vi.hoisted(() => ({
  apiBase: "https://example.test",
  apiGeneration: 1,
  sessionGeneration: 1,
  spaceId: "space-a" as string | null,
  spaceGeneration: 1,
  selectionSeq: 1,
  listeners: new Set<() => void>(),
  unsubscribe: vi.fn(),
}));
const subscribe = (listener: () => void) => {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    state.unsubscribe();
  };
};
vi.mock("./api", () => ({
  currentApiBase: () => state.apiBase,
  currentApiBaseGeneration: () => state.apiGeneration,
  selectedSpaceId: () => state.spaceId,
  currentSpaceSelectionGeneration: () => state.spaceGeneration,
  spaceSelectionSeq: () => state.selectionSeq,
  subscribeApiBase: (listener: () => void) => subscribe(listener),
  subscribeSelectedSpace: (listener: () => void) => subscribe(listener),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.sessionGeneration,
  subscribeSessionGeneration: (listener: () => void) => subscribe(listener),
}));
const spaces = [{ id: "space-a", bots: [], groups: [] }] as unknown as InboxSpace[];
beforeEach(() => {
  Object.assign(state, {
    apiBase: "https://example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-a",
    spaceGeneration: 1,
    selectionSeq: 1,
  });
  state.listeners.clear();
  vi.clearAllMocks();
});
it("publishes the verified roster and supports a loaded empty inbox", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  setSearchInbox(captureMobileScope(), spaces);
  expect(getSearchInbox()).toBe(spaces);
  expect(listener).toHaveBeenCalledOnce();
  const empty: InboxSpace[] = [];
  setSearchInbox(captureMobileScope(), empty);
  expect(getSearchInbox()).toBe(empty);
  unsubscribe();
  setSearchInbox(captureMobileScope(), spaces);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(state.unsubscribe).toHaveBeenCalled();
});
it.each([
  "apiBase",
  "apiGeneration",
  "sessionGeneration",
  "spaceId",
  "spaceGeneration",
  "selectionSeq",
] as const)("hides old rows immediately when %s changes", (field) => {
  setSearchInbox(captureMobileScope(), spaces);
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  if (field === "apiBase") state.apiBase = "https://other.example.test";
  else if (field === "spaceId") state.spaceId = "space-b";
  else state[field]++;
  for (const notify of state.listeners) notify();
  expect(listener).toHaveBeenCalled();
  expect(getSearchInbox()).toEqual([]);
  expect(getSearchInbox()).toBe(getSearchInbox());
  unsubscribe();
});
it("rejects late old publication instead of relabeling it with current scope", () => {
  const old = captureMobileScope();
  state.spaceGeneration += 2;
  const current = captureMobileScope();
  const updated = [
    { id: "space-a", bots: [{ id: "new-bot" }], groups: [] },
  ] as unknown as InboxSpace[];
  setSearchInbox(current, updated);
  setSearchInbox(old, spaces);
  expect(getSearchInbox()).toBe(updated);
});
