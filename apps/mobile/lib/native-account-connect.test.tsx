// @vitest-environment jsdom
import type { NativeAppId, NativeConfigStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAccountConnect } from "../components/native-account-connect";

const { rpc, openURL } = vi.hoisted(() => ({ rpc: vi.fn(), openURL: vi.fn() }));
vi.mock("./api", () => ({ rpc, captureApiRequestContext: async () => ({}) }));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: async () => ({}),
  isIntegrationsScopeCurrent: () => true,
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    secureTextEntry,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
    secureTextEntry: boolean;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
      type={secureTextEntry ? "password" : "text"}
    />
  ),
  ActivityIndicator: () => <span>Loading</span>,
  Linking: { openURL },
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    label,
    value,
    choices,
    onChange,
  }: {
    label: string;
    value: string;
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
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
const container = document.createElement("div"),
  root = createRoot(container);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  rpc.mockReset();
  openURL.mockReset();
});
async function render(
  appId: NativeAppId,
  credentialKind: NativeConfigStatus["credentialKind"],
  usesConfiguredCredential = false,
) {
  const submit = vi.fn();
  rpc.mockImplementation(async (path) =>
    path === "nativeConnectors/status"
      ? {
          canConfigure: true,
          callbackUri: "https://instance.example.test/callback",
          configurations: [
            {
              id: "fixture-source",
              appId,
              label: "Fixture source",
              ownership: usesConfiguredCredential ? "official" : "byo",
              credentialKind,
              actor: appId === "hubspot" ? "app" : credentialKind === "bot_token" ? "bot" : "user",
              configured: true,
              enabled: true,
              revision: 1,
              callbackUri: "https://instance.example.test/callback",
              executionLocation: "instance",
              usesConfiguredCredential,
            },
          ],
        }
      : { webUrl: "https://instance.example.test/integrations/setup" },
  );
  await act(async () =>
    root.render(<NativeAccountConnect appId={appId} onSubmit={submit} onCancel={() => {}} />),
  );
  return submit;
}
it.each([
  ["telegram-bot", "Telegram bot token"],
  ["discord", "Discord bot token"],
  ["hubspot", "HubSpot private app token"],
] as const)("mobile %s requires the correct private credential", async (app, label) => {
  await render(app, app === "hubspot" ? "personal_token" : "bot_token");
  expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(label);
  expect(container.querySelector("input")?.type).toBe("password");
  expect(container.textContent).not.toContain("Slack bot token");
});
it.each([
  ["telegram-bot", "bot_token"],
  ["discord", "bot_token"],
  ["feishu-lark", "machine_key"],
  ["dingtalk", "machine_key"],
  ["wecom", "machine_key"],
] as const)(
  "mobile %s connects configured credentials without seeing the secret",
  async (app, kind) => {
    const submit = await render(app, kind, true);
    expect(container.querySelector("input")).toBeNull();
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Connect application",
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(submit).toHaveBeenCalledWith({ configId: "fixture-source" });
  },
);
it("mobile GitHub signing material stays in the existing explicit Web fallback", async () => {
  await render("github", "github_app_installation");
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).toContain("Connect this GitHub App installation in the web app.");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Open web app")!
      .click(),
  );
  expect(openURL).toHaveBeenCalledWith("https://instance.example.test/integrations/setup");
});

it("mobile Figma explains replacement only when connecting OAuth", async () => {
  const message =
    "Authorizing this Figma account replaces its previous authorization for this application.";
  await render("figma", "oauth");
  expect(container.textContent).toContain(message);
  await act(async () => root.render(null));
  await render("figma", "personal_token");
  expect(container.textContent).not.toContain(message);
});
