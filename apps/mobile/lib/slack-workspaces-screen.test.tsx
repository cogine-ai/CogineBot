// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SlackWorkspaces from "../app/(settings)/slack-workspaces";

const host = vi.hoisted(() => ({
  rpc: vi.fn(),
  open: vi.fn(),
  alert: vi.fn(),
  capture: vi.fn(),
  epoch: 0,
  scopeChanged: undefined as (() => void) | undefined,
  appChanged: undefined as ((value: string) => void) | undefined,
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: host.open }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]),
}));
vi.mock("./api", () => ({ rpc: host.rpc, captureApiRequestContext: host.capture }));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({ epoch: host.epoch, spaceId: `space-${host.epoch}` }),
  isMobileScopeCurrent: (scope: { epoch: number }) => scope.epoch === host.epoch,
  subscribeMobileScope: (listener: () => void) => {
    host.scopeChanged = listener;
    return () => {
      host.scopeChanged = undefined;
    };
  },
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("react-native", () => ({
  Alert: { alert: host.alert },
  Linking: { openURL: host.open },
  AppState: {
    currentState: "active",
    addEventListener: (_: string, listener: (value: string) => void) => {
      host.appChanged = listener;
      return {
        remove: () => {
          host.appChanged = undefined;
        },
      };
    },
  },
  StyleSheet: { create: (value: unknown) => value },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    choices,
    value,
    onChange,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));

const row = {
  id: "installation-a",
  botId: "bot-a",
  workspaceName: "Synthetic workspace",
  installerName: null,
  status: "active",
  revision: 3,
};
let rows = [row];
let available = true;
let status = "pending";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host.open.mockImplementation(() => new Promise(() => {}));
  host.epoch = 0;
  rows = [row];
  available = true;
  status = "pending";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.capture.mockImplementation(async (spaceId: string) => ({
    headers: { "x-rakazo-space-id": spaceId },
  }));
  host.rpc.mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "bots/list")
      return [
        { id: "bot-a", name: "Synthetic bot" },
        { id: "bot-b", name: "Other bot" },
      ];
    if (proc.endsWith("/list")) return { available, workspaces: rows };
    if (proc.endsWith("/start"))
      return {
        attemptId: "a".repeat(64),
        url: "https://slack.com/oauth/v2/authorize?state=fake",
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    if (proc.endsWith("/attempt")) return { status };
    if (proc.endsWith("/cancel")) status = "expired";
    if (proc.endsWith("/completeMobile")) status = "connected";
    if (proc.endsWith("/pause"))
      rows = [{ ...row, revision: row.revision + 1, status: input.paused ? "paused" : "active" }];
    if (proc.endsWith("/remove")) rows = [];
    return { ok: true };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const render = () => act(async () => root.render(<SlackWorkspaces />));
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function press(label: string) {
  await act(async () => button(label).click());
}
async function choose(id: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows workspace, bot and status and reconciles pause/resume", async () => {
  await render();
  expect(container.textContent).toContain("Synthetic workspaceSynthetic botConnected");
  await press("Pause");
  expect(container.textContent).toContain("Paused");
  expect(host.rpc).toHaveBeenCalledWith(
    "messaging/installations/pause",
    { id: row.id, expectedRevision: 3, paused: true },
    expect.anything(),
  );
  await press("Resume");
  expect(container.textContent).toContain("Connected");
  expect(host.rpc).toHaveBeenCalledWith(
    "messaging/installations/pause",
    { id: row.id, expectedRevision: 4, paused: false },
    expect.anything(),
  );
});
it("requires native confirmation and retains conversation-history explanation", async () => {
  await render();
  await press("Disconnect");
  expect(host.rpc.mock.calls.some(([proc]) => proc.endsWith("/remove"))).toBe(false);
  const [title, description, actions] = host.alert.mock.calls[0]!;
  expect(title).toBe("Disconnect Slack?");
  expect(description).toContain("Conversation history stays in CogineBot.");
  expect(actions[0].style).toBe("cancel");
  await act(async () => actions[1].onPress());
  expect(container.textContent).not.toContain("Synthetic workspace");
});
it("does not apply an old confirmation after Space changes", async () => {
  await render();
  await press("Disconnect");
  const actions = host.alert.mock.calls[0]![2];
  await act(async () => {
    host.epoch++;
    host.scopeChanged?.();
  });
  await act(async () => actions[1].onPress());
  expect(host.rpc.mock.calls.some(([proc]) => proc.endsWith("/remove"))).toBe(false);
});
it("opens OAuth for the selected bot, locks selection, and reads the original Space on return", async () => {
  await render();
  await choose("bot-b");
  await press("Connect Slack");
  expect(host.open).toHaveBeenCalledWith(
    "https://slack.com/oauth/v2/authorize?state=fake",
    "coginebot://slack-workspaces",
  );
  expect(host.rpc).toHaveBeenCalledWith(
    "messaging/installations/start",
    { botId: "bot-b", returnTo: "mobile" },
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-0" } }),
    }),
  );
  expect(container.querySelector("select")).toBeNull();
  expect(container.textContent).toContain("Waiting for Slack authorization");
  status = "connected";
  await act(async () => host.appChanged?.("active"));
  expect(container.textContent).not.toContain("Waiting for Slack authorization");
  expect(container.querySelector("select")?.value).toBe("bot-b");
});
it("cancels authorization and allows retry", async () => {
  await render();
  await choose("bot-a");
  await press("Connect Slack");
  await press("Cancel");
  expect(host.rpc).toHaveBeenCalledWith(
    "messaging/installations/cancel",
    { attemptId: "a".repeat(64) },
    expect.anything(),
  );
  expect(button("Connect Slack").disabled).toBe(false);
});
it.each(["expired", "failed", "cancelled"])(
  "settles %s on foreground and permits retry",
  async (outcome) => {
    await render();
    await choose("bot-a");
    await press("Connect Slack");
    status = outcome;
    await act(async () => host.appChanged?.("active"));
    expect(button("Connect Slack").disabled).toBe(false);
  },
);
it("drops an old authorization on Space switch and clears Bot selection", async () => {
  await render();
  await choose("bot-a");
  await press("Connect Slack");
  await act(async () => {
    host.epoch++;
    host.scopeChanged?.();
  });
  expect(container.textContent).not.toContain("Waiting for Slack authorization");
  expect(container.querySelector("select")?.value).toBe("");
  const before = host.rpc.mock.calls.filter(([proc]) => proc.endsWith("/attempt")).length;
  await act(async () => host.appChanged?.("active"));
  expect(host.rpc.mock.calls.filter(([proc]) => proc.endsWith("/attempt"))).toHaveLength(before);
});
it("retains removal but prevents connecting or pausing when Slack is unavailable", async () => {
  available = false;
  await render();
  expect(container.textContent).toContain("Slack installation is unavailable.");
  expect(button("Reconnect").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
  expect(container.textContent).not.toContain("Connect Slack");
  expect(container.textContent).not.toContain("Pause");
});
it("prevents reconnect and pause when the associated bot is unavailable", async () => {
  rows = [{ ...row, status: "unavailable" }];
  await render();
  expect(button("Reconnect").disabled).toBe(true);
  expect(container.textContent).toContain("Bot unavailable");
  expect(container.textContent).not.toContain("Pause");
});
it("retries request-context capture failure", async () => {
  host.capture.mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(container.textContent).toContain("Couldn't load messaging settings");
  await press("Retry");
  expect(container.textContent).toContain("Synthetic workspace");
});

it("completes the browser callback through the captured authenticated App context", async () => {
  host.open.mockResolvedValue({
    type: "success",
    url: "coginebot://slack-workspaces?state=fake&code=synthetic",
  });
  await render();
  await choose("bot-a");
  await press("Connect Slack");
  expect(host.rpc).toHaveBeenCalledWith(
    "messaging/installations/completeMobile",
    { state: "fake", code: "synthetic" },
    expect.objectContaining({
      requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-0" } }),
    }),
  );
  expect(container.textContent).not.toContain("Waiting for Slack authorization");
});
