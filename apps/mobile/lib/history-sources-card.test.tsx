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

function pendingSourceCheck() {
  let resolve!: (rows: HistorySource[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<HistorySource[]>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

it.each([undefined, 401, 403])(
  "settles the first source check before another source can be opened (status %s)",
  async (status) => {
    const other: HistorySource = {
      ...source,
      threadId: "other-thread",
      messageId: "other-message",
      groupId: "other-group",
      chatName: "Other group",
      text: "Another decision.",
    };
    fixture.rpc.mockResolvedValueOnce([source, other]);
    await act(async () =>
      root.render(
        <HistorySourcesCard block={{ kind: "history_sources", references: [source, other] }} />,
      ),
    );

    const check = pendingSourceCheck();
    fixture.rpc.mockReturnValueOnce(check.promise);
    const [first, second] = container.querySelectorAll("button");
    await act(async () => {
      first!.click();
      second!.click();
    });
    const secondWasDisabled = second!.disabled;
    await act(async () => {
      if (status) check.reject(Object.assign(new Error("Access denied"), { status }));
      else check.resolve([]);
    });
    expect(container.textContent).not.toContain(source.chatName);
    expect(container.textContent).not.toContain(source.text);
    expect(container.textContent).toContain("This history source is no longer available.");
    expect(fixture.push).not.toHaveBeenCalled();
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
    expect(secondWasDisabled).toBe(true);

    if (status) {
      expect(container.textContent).not.toContain(other.chatName);
      return;
    }
    expect(second!.disabled).toBe(false);
    fixture.rpc.mockResolvedValueOnce([other]);
    await act(async () => second!.click());
    expect(fixture.push).toHaveBeenCalledWith({
      pathname: "/group-thread",
      params: { groupId: "other-group", name: "Other group", messageId: "other-message" },
    });
  },
);

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

it.each(["available", "denied"])(
  "ignores a late %s source check after switching scope",
  async (result) => {
    await act(async () => root.render(<HistorySourcesCard block={block} />));
    const check = pendingSourceCheck();
    fixture.rpc.mockReturnValueOnce(check.promise);
    await act(async () => container.querySelector("button")!.click());
    const signal = fixture.rpc.mock.lastCall?.[2].signal as AbortSignal;
    fixture.rpc.mockResolvedValueOnce([{ ...source, text: "Current scope preview." }]);
    await act(async () => {
      fixture.scope = "changed";
      for (const listener of fixture.scopeListeners) listener();
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (result === "denied")
        check.reject(Object.assign(new Error("Access denied"), { status: 403 }));
      else check.resolve([source]);
    });
    expect(container.textContent).toContain("Current scope preview.");
    expect(container.textContent).not.toContain("This history source is no longer available.");
    expect(container.querySelector("button")!.disabled).toBe(false);
    expect(fixture.push).not.toHaveBeenCalled();
  },
);
