// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Screen from "../app/(settings)/approval-rules";

const host = vi.hoisted(() => ({
  rpc: vi.fn(),
  current: true,
  focused: true,
  active: true,
  space: "a",
  isCurrent: () => host.current,
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ spaceId: host.space }),
  useFocusEffect: (cb: () => () => void) =>
    useEffect(() => (host.focused ? cb() : undefined), [cb, host.focused]),
}));
vi.mock("./space-settings", () => ({
  useSpaceSettings: () => host,
  useSpaceSettingsKey: () => host.space,
}));
vi.mock("./app-active", () => ({ useAppActive: () => host.active }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: () => ({}) }));
vi.mock("./i18n", () => {
  const t = (s: string) => s;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  StyleSheet: { create: (s: unknown) => s },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    detail,
    trailing,
    disabled,
    onPress,
  }: {
    title: string;
    detail?: string;
    trailing?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <div>
      {onPress ? (
        <button type="button" disabled={disabled} onClick={onPress}>
          {title}
        </button>
      ) : (
        title
      )}
      {detail}
      {trailing}
    </div>
  ),
  SettingsSwitch: ({
    label,
    detail,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    detail?: string;
    value: boolean;
    disabled: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <label>
      {label}
      {detail}
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={() => onChange(!value)}
      />
    </label>
  ),
}));
let root: Root;
let container: HTMLDivElement;
let rules: { id: string; effect: string; matchKind: string; matchValue: string }[];
let enabled: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host.current = true;
  host.focused = true;
  host.active = true;
  host.space = "a";
  enabled = true;
  rules = [
    { id: "one", effect: "always_allow", matchKind: "tool", matchValue: "synthetic_write" },
    { id: "two", effect: "deny", matchKind: "site", matchValue: "example.test" },
    { id: "three", effect: "require_approval", matchKind: "connector", matchValue: "synthetic" },
  ];
  host.rpc.mockReset().mockImplementation(async (route, input) => {
    if (route === "approvalRules/list") return [...rules];
    if (route === "autoReview/get") return { enabled, checkerAvailable: false };
    if (route === "approvalRules/remove") rules = rules.filter((r) => r.id !== input.id);
    if (route === "approvalRules/set") rules.push({ id: input.matchValue, ...input });
    if (route === "autoReview/set") enabled = input.enabled;
    return { ok: true };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () => root.render(<Screen />));
}
async function click(label: string) {
  await act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
  );
}
it("renders all effects and scopes, preserves enabled review without a checker, and removes only the selected rule", async () => {
  await render();
  for (const label of [
    "Allowed",
    "Blocked",
    "Requires confirmation",
    "Action",
    "Site",
    "Connector",
    "Add a model in Settings to use this.",
  ])
    expect(container.textContent).toContain(label);
  expect(container.querySelector("input")?.checked).toBe(true);
  await click("Remove");
  expect(host.rpc).toHaveBeenCalledWith("approvalRules/remove", { id: "one" });
  expect(container.textContent).not.toContain("synthetic_write");
  expect(container.textContent).toContain("example.test");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).not.toContain("synthetic_write");
});
it("sets only the two existing category presets and reloads review state", async () => {
  await render();
  await click("Ask before sending external email");
  await click("Ask before purchases");
  for (const matchValue of ["email", "purchase"])
    expect(host.rpc).toHaveBeenCalledWith("approvalRules/set", {
      effect: "require_approval",
      matchKind: "category",
      matchValue,
    });
  await act(async () => container.querySelector("input")?.click());
  expect(host.rpc).toHaveBeenCalledWith("autoReview/set", { enabled: false });
  expect(container.querySelector("input")?.checked).toBe(false);
});
it.each(["approvalRules/remove", "approvalRules/set", "autoReview/set"])(
  "retains confirmed state after %s fails and allows refresh",
  async (route) => {
    await render();
    const original = host.rpc.getMockImplementation()!;
    host.rpc.mockImplementation(async (r, i) => {
      if (r === route) throw new Error("Permission denied");
      return original(r, i);
    });
    if (route === "autoReview/set")
      await act(async () => container.querySelector("input")?.click());
    else await click(route === "approvalRules/remove" ? "Remove" : "Ask before purchases");
    expect(container.textContent).toContain("synthetic_write");
    expect(container.querySelector("input")?.checked).toBe(true);
    expect(container.textContent).toContain("Permission denied");
    host.rpc.mockImplementation(original);
    await click("Refresh");
    expect(container.textContent).not.toContain("Permission denied");
  },
);
it("does not present a failed load as an empty rule list", async () => {
  host.rpc.mockRejectedValue(new Error("Permission denied"));
  await render();
  expect(container.textContent).toContain("Permission denied");
  expect(container.textContent).not.toContain("No saved rules");
  expect(container.querySelector("input")?.disabled).toBe(true);
});
it("clears old Space state and rejects stale mutation results", async () => {
  await render();
  let complete!: () => void;
  host.rpc.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await click("Remove");
  host.space = "b";
  rules = [{ id: "new", effect: "always_allow", matchKind: "category", matchValue: "new-space" }];
  await render();
  expect(container.textContent).not.toContain("synthetic_write");
  await act(async () => complete());
  expect(container.textContent).not.toContain("synthetic_write");
});
it("ignores a late list response after Space changes", async () => {
  let complete!: (value: unknown) => void;
  host.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  host.space = "b";
  rules = [{ id: "new", effect: "always_allow", matchKind: "category", matchValue: "new-space" }];
  await render();
  await act(async () =>
    complete([
      { id: "stale", effect: "always_allow", matchKind: "tool", matchValue: "synthetic_write" },
    ]),
  );
  expect(container.textContent).not.toContain("synthetic_write");
});

it("serializes rapid writes and blocks mutations until failed readback is refreshed", async () => {
  await render();
  let complete!: () => void;
  host.rpc.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const remove = [...container.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
  await act(async () => {
    remove.click();
    remove.click();
  });
  expect(host.rpc.mock.calls.filter(([route]) => route === "approvalRules/remove")).toHaveLength(1);
  host.rpc.mockRejectedValueOnce(new Error("Readback unavailable"));
  await act(async () => complete());
  expect(container.textContent).toContain("synthetic_write");
  expect(container.textContent).toContain("Readback unavailable");
  expect(container.querySelector("input")?.disabled).toBe(true);
  await click("Refresh");
  expect(container.querySelector("input")?.disabled).toBe(false);
});
it("refuses unscoped entry", async () => {
  host.space = "";
  await render();
  expect(host.rpc).not.toHaveBeenCalled();
  expect(container.querySelector("input")?.disabled).toBe(true);
});

it("refocus waits for an in-flight mutation before reading back", async () => {
  await render();
  let complete!: () => void;
  host.rpc.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  await click("Remove");
  host.focused = false;
  await render();
  host.focused = true;
  await render();
  expect(host.rpc.mock.calls.filter(([route]) => route === "approvalRules/list")).toHaveLength(1);
  expect(container.querySelector("input")?.disabled).toBe(true);
  rules = rules.filter((rule) => rule.id !== "one");
  await act(async () => complete());
  expect(container.textContent).not.toContain("synthetic_write");
  expect(container.querySelector("input")?.disabled).toBe(false);
});

it("reloads confirmed settings when the App returns to the foreground", async () => {
  await render();
  host.active = false;
  await render();
  rules = [];
  enabled = false;
  host.active = true;
  await render();
  expect(container.textContent).toContain("No saved rules");
  expect(container.querySelector("input")?.checked).toBe(false);
});
