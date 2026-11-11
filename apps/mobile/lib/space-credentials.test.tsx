// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Screen from "../app/(settings)/space-credentials";
import { fetchAccountSecurity } from "./api";

const host = vi.hoisted(() => ({
  rpc: vi.fn(),
  current: true,
  isCurrent: () => host.current,
  listeners: new Set<(state: string) => void>(),
  captureApiRequestContext: vi.fn(),
  signal: () => undefined,
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ spaceId: "space-a" }),
  useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]),
}));
vi.mock("./space-settings", () => ({
  useSpaceSettings: () => host,
  useSpaceSettingsKey: () => "space-a:account-a",
}));
vi.mock("./api", () => ({
  fetchAccountSecurity: vi.fn(),
  requestIdentityCode: vi.fn(),
  confirmIdentity: vi.fn(),
}));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { useI18n: () => ({ t }) };
});
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      host.listeners.add(callback);
      return { remove: () => host.listeners.delete(callback) };
    },
  },
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  Platform: { OS: "ios" },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    editable,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    editable?: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={editable === false}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title, detail }: { title: string; detail: string }) => (
    <span>
      {title} {detail}
    </span>
  ),
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: () => null,
  MenuPickerMenu: ({
    children,
    onChange,
  }: {
    children: ReactNode;
    onChange: (action: string) => void;
  }) => (
    <div data-credential>
      {children}
      <button type="button" onClick={() => onChange("show")}>
        Show value
      </button>
      <button type="button" onClick={() => onChange("edit")}>
        Replace value
      </button>
    </div>
  ),
}));

const credential = {
  name: "portal",
  origin: "https://site.example.test",
  auth: { type: "bearer" },
  revision: "revision-1",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host.current = true;
  host.rpc.mockReset().mockImplementation(async (procedure) =>
    procedure === "botSecrets/listForSpace"
      ? [
          { botId: "bot-a", botName: "First Bot", credentials: [credential] },
          {
            botId: "bot-b",
            botName: "Second Bot",
            credentials: [{ ...credential, revision: "revision-2" }],
          },
        ]
      : { value: "synthetic-value" },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("opens the exact Bot's saved revision and clears a revealed value in the background", async () => {
  await act(async () => root.render(<Screen />));
  expect(container.textContent).not.toContain("synthetic-value");
  const second = [...container.querySelectorAll("[data-credential]")].find((row) =>
    row.textContent?.includes("Second Bot"),
  );
  await act(async () => second?.querySelector("button")?.click());
  expect(host.rpc).toHaveBeenLastCalledWith("botSecrets/reveal", {
    botId: "bot-b",
    name: "portal",
    expectedRevision: "revision-2",
  });
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("synthetic-value");
  await act(async () => {
    for (const listener of host.listeners) listener("background");
  });
  expect(container.textContent).not.toContain("synthetic-value");
});

it("drops a reveal that returns after the app went to the background", async () => {
  await act(async () => root.render(<Screen />));
  let complete!: (result: { value: string }) => void;
  host.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-credential] button")?.click(),
  );
  await act(async () => {
    for (const listener of host.listeners) listener("background");
    complete({ value: "late-synthetic-value" });
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("late-synthetic-value");
});

it("keeps a mobile replacement draft when saving fails and clears it on dismissal", async () => {
  await act(async () => root.render(<Screen />));
  const replace = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Replace value",
  );
  await act(async () => replace?.click());
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Value"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "replacement-fixture-value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  host.rpc.mockRejectedValueOnce(new Error("Fixture store outage"));
  const save = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  await act(async () => save?.click());
  expect(container.textContent).toContain("Could not save the credential");
  expect(input.value).toBe("replacement-fixture-value");
  await act(async () => {
    for (const listener of host.listeners) listener("background");
  });
  expect(container.querySelector('input[aria-label="Value"]')).toBeNull();
});

it("offers a password confirmation when the optional account flag is omitted", async () => {
  await act(async () => root.render(<Screen />));
  host.rpc.mockRejectedValueOnce({ code: "IDENTITY_CONFIRMATION_REQUIRED" });
  host.captureApiRequestContext.mockResolvedValue({
    apiBase: "https://api.example.test",
    headers: {},
  });
  vi.mocked(fetchAccountSecurity).mockResolvedValue({
    hasPassword: true,
    emailDeletion: false,
    freshOidcAuth: false,
    ssoLinked: false,
    sso: null,
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-credential] button")?.click(),
  );
  expect(container.querySelector('input[aria-label="Password"]')).not.toBeNull();
});
