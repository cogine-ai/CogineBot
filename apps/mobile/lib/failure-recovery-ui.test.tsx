// @vitest-environment jsdom

import type { RoutineHistory } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HomeErrorState } from "../components/home-error-state";
import { RoutineRunHistory } from "../components/routine-run-history";
import { RunErrorNotice } from "../components/run-error-notice";
import type { MobileScope } from "./mobile-scope";

const state = vi.hoisted(() => ({ rpc: vi.fn(), push: vi.fn(), openURL: vi.fn(), current: true }));
vi.mock("react-native", () => ({
  Linking: { openURL: state.openURL },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("span", { role: accessibilityRole }, children),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("./api", () => ({ rpc: state.rpc }));
vi.mock("./mobile-scope", () => ({ isMobileScopeCurrent: () => state.current }));
vi.mock("./space-request-context", () => ({
  spaceRequestContext: async () => ({ spaceId: "space-a" }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  useI18n: () => ({ locale: "en", t: (text: string) => text }),
  t: (text: string) => text,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, label),
}));
vi.mock("../components/select-text-sheet", () => ({
  SelectTextSheet: ({ text, onClose }: { text: string | null; onClose: () => void }) =>
    text === null
      ? null
      : createElement(
          "section",
          { "aria-label": "Selectable diagnostics" },
          text,
          createElement("button", { type: "button", onClick: onClose }, "Close details"),
        ),
}));

const owner: MobileScope = {
  apiBase: "https://api.example.test",
  apiGeneration: 1,
  sessionGeneration: 1,
  spaceId: "space-a",
  spaceGeneration: 1,
  selectionSeq: 1,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.current = true;
  state.rpc.mockReset();
  state.push.mockReset();
  state.openURL.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}
async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
function row(
  id: string,
  changes: Partial<RoutineHistory["runs"][number]> = {},
): RoutineHistory["runs"][number] {
  return {
    id,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    botId: "bot-a",
    groupId: null,
    messageId: null,
    error: null,
    ...changes,
  };
}

it.each([
  ["offline", "Could not reach the server"],
  ["auth", "Sign in again"],
  ["space", "This Space is unavailable"],
  ["server", "The server could not complete the request"],
  ["unknown", "Could not load chats"],
] as const)(
  "shows the %s recovery action without replacing cached chats",
  async (kind, message) => {
    const retry = vi.fn();
    const signIn = vi.fn();
    await render(
      <HomeErrorState kind={kind} cached busy={false} onRetry={retry} onSignIn={signIn} />,
    );
    expect(container.textContent).toContain(message);
    expect(container.textContent).toContain("Showing saved chats.");
    await press(kind === "auth" ? "Sign in" : "Retry");
    expect(signIn).toHaveBeenCalledTimes(kind === "auth" ? 1 : 0);
    expect(retry).toHaveBeenCalledTimes(kind === "auth" ? 0 : 1);
  },
);

it("disables duplicate read retries while loading", async () => {
  const retry = vi.fn();
  await render(
    <HomeErrorState kind="server" cached={false} busy onRetry={retry} onSignIn={vi.fn()} />,
  );
  await press("Retry");
  expect(retry).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Showing saved chats.");
});

it("reveals only cleaned selectable diagnostics and closes them when the error changes", async () => {
  const raw =
    '503: {"error":{"message":"provider failed Authorization: Bearer sample-secret-value"}}';
  await render(<RunErrorNotice error={raw} />);
  expect(container.textContent).toContain("The model provider returned an error.");
  expect(container.textContent).not.toContain("provider failed");
  await press("Details");
  expect(container.querySelector("section")?.textContent).toContain("provider failed");
  expect(container.textContent).not.toContain("sample-secret-value");
  await render(<RunErrorNotice error="429: too many requests" />);
  expect(container.querySelector("section")).toBeNull();
});

it("shows computer retry advice without model usage actions", async () => {
  await render(<RunErrorNotice error="Too many computer requests. Try again later." />);
  expect(container.textContent).toContain("Too many computer requests. Try again later.");
  expect(container.textContent).not.toContain("model provider");
  expect(container.textContent).not.toContain("Manage usage");
  expect(state.openURL).not.toHaveBeenCalled();
});

it("offers the fixed ChatGPT usage action only for a ChatGPT plan usage failure", async () => {
  await render(
    <RunErrorNotice error='{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}' />,
  );
  await press("Manage usage");
  expect(state.openURL).toHaveBeenCalledExactlyOnceWith("https://chatgpt.com/settings/usage");
  await render(<RunErrorNotice error="429: too many requests" />);
  expect(container.textContent).not.toContain("Manage usage");
});

it("pages history without duplicating rows or inventing links for silent runs", async () => {
  state.rpc
    .mockResolvedValueOnce({
      runs: [row("run-a")],
      nextCursor: { createdAt: "2026-01-01T00:00:00.000Z", id: "run-a" },
    })
    .mockResolvedValueOnce({
      runs: [row("run-a"), row("run-b", { messageId: "message-b", groupId: "group-b" })],
      nextCursor: null,
    });
  await render(
    <RoutineRunHistory
      routineId="routine-a"
      owner={owner}
      spaceId="space-a"
      isCurrent={() => true}
    />,
  );
  expect(container.textContent).not.toContain("View chat");
  await press("Run history");
  await press("Load more");
  expect(state.rpc.mock.calls[1]?.[1]).toEqual({
    routineId: "routine-a",
    before: { createdAt: "2026-01-01T00:00:00.000Z", id: "run-a" },
  });
  expect(container.textContent?.match(/Done/g)).toHaveLength(2);
  await press("View chat");
  expect(state.push).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { groupId: "group-b", messageId: "message-b" },
  });
});

it("aborts a closed history read and ignores its late response", async () => {
  let resolve!: (history: RoutineHistory) => void;
  state.rpc.mockImplementationOnce(
    () =>
      new Promise<RoutineHistory>((done) => {
        resolve = done;
      }),
  );
  await render(
    <RoutineRunHistory
      routineId="routine-a"
      owner={owner}
      spaceId="space-a"
      isCurrent={() => true}
    />,
  );
  const signal = state.rpc.mock.calls[0]?.[2].signal as AbortSignal;
  await render(null);
  expect(signal.aborted).toBe(true);
  await act(async () =>
    resolve({ runs: [row("late", { messageId: "late-message" })], nextCursor: null }),
  );
  expect(container.textContent).toBe("");
  expect(state.push).not.toHaveBeenCalled();
});

it("retries a failed history read and fences an obsolete chat link", async () => {
  state.rpc
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ runs: [row("run-a", { messageId: "message-a" })], nextCursor: null });
  await render(
    <RoutineRunHistory
      routineId="routine-a"
      owner={owner}
      spaceId="space-a"
      isCurrent={() => state.current}
    />,
  );
  expect(container.textContent).toContain("Could not load run history");
  await press("Refresh");
  expect(container.textContent).not.toContain("Could not load run history");
  state.current = false;
  await press("View chat");
  expect(state.push).not.toHaveBeenCalled();
  expect(state.rpc).toHaveBeenCalledTimes(2);
});
