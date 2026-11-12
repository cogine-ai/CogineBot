// @vitest-environment jsdom

import type { HistorySource, MessageBlock } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistorySourcesCard } from "../components/history-sources-card";

const fixture = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  scope: "active",
  focused: true,
  scopeListeners: new Set<() => void>(),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: fixture.push }),
  useIsFocused: () => fixture.focused,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./api", () => ({ rpc: fixture.rpc }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => fixture.scope,
  isMobileScopeCurrent: (scope: string) => scope === fixture.scope,
  mobileScopeKey: () => fixture.scope,
  subscribeMobileScope: (listener: () => void) => {
    fixture.scopeListeners.add(listener);
    return () => fixture.scopeListeners.delete(listener);
  },
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({ locale: "en", t: (text: string) => text }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));

const reference = { threadId: "past-thread", messageId: "past-message" };
const source: HistorySource = {
  ...reference,
  chatName: "Past group",
  groupId: "past-group",
  botId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  text: "The original decision.",
};
const block: Extract<MessageBlock, { kind: "history_sources" }> = {
  kind: "history_sources",
  references: [reference],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.scope = "active";
  fixture.focused = true;
  fixture.rpc.mockReset().mockResolvedValue([source]);
  fixture.push.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("rechecks the source and opens the exact native group message", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  expect(container.textContent).toContain("The original decision.");
  await act(async () => container.querySelector("button")!.click());
  expect(fixture.rpc).toHaveBeenCalledTimes(2);
  expect(fixture.push).toHaveBeenCalledWith({
    pathname: "/group-thread",
    params: { groupId: "past-group", name: "Past group", messageId: "past-message" },
  });
});

it("clears the preview when the original is no longer available", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.rpc.mockResolvedValueOnce([]);
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("This history source is no longer available.");
  expect(fixture.push).not.toHaveBeenCalled();
});

it("offers retry after a temporary initial failure", async () => {
  fixture.rpc.mockRejectedValueOnce(new Error("Connection interrupted"));
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  expect(container.textContent).toContain("Could not load history sources.");
  expect(container.textContent).not.toContain("no longer available");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("The original decision.");
  expect(container.textContent).not.toContain("Could not load history sources.");
});

it("keeps the authorized preview when opening fails temporarily", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.rpc.mockRejectedValueOnce(new Error("Connection interrupted"));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("The original decision.");
  expect(container.textContent).toContain("Could not load history sources.");
  expect(fixture.push).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(fixture.push).toHaveBeenCalledTimes(1);
});

it("lets a refresh commit revocation before cached sources can be opened again", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.rpc.mockRejectedValueOnce(new Error("Connection interrupted"));
  await act(async () => container.querySelector("button")!.click());
  let finishRetry!: (rows: HistorySource[]) => void;
  fixture.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
  );
  await act(async () => {
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    retry!.click();
  });
  const open = container.querySelector("button")!;
  expect(open.disabled).toBe(true);
  await act(async () => open.click());
  expect(fixture.rpc).toHaveBeenCalledTimes(3);
  await act(async () => finishRetry([]));
  expect(container.textContent).toBe("This history source is no longer available.");
});

it("clears the previews when the current Space denies access", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.rpc.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toBe("This history source is no longer available.");
  expect(fixture.push).not.toHaveBeenCalled();
});

it("reloads the reference on return and hides the old preview while blurred", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.focused = false;
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  expect(container.textContent).toBe("");
  fixture.focused = true;
  fixture.rpc.mockResolvedValueOnce([]);
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  expect(container.textContent).toBe("This history source is no longer available.");
});

it("reloads in place when the signed-in scope changes", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  fixture.rpc.mockResolvedValueOnce([{ ...source, text: "Current preview." }]);
  await act(async () => {
    fixture.scope = "renewed";
    for (const listener of fixture.scopeListeners) listener();
  });
  expect(container.textContent).toContain("Current preview.");
  expect(container.textContent).not.toContain("The original decision.");
  expect(fixture.rpc).toHaveBeenCalledTimes(2);
});

it("does not navigate when a source check returns after switching identity", async () => {
  await act(async () => root.render(<HistorySourcesCard block={block} />));
  let resolve!: (rows: HistorySource[]) => void;
  fixture.rpc.mockImplementationOnce(
    () =>
      new Promise((complete) => {
        resolve = complete;
      }),
  );
  await act(async () => container.querySelector("button")!.click());
  await act(async () => {
    fixture.scope = "changed";
    resolve([source]);
  });
  expect(fixture.push).not.toHaveBeenCalled();
});
