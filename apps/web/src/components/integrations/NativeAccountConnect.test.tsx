// @vitest-environment jsdom
import type { NativeAppId, NativeConfigStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAccountConnect } from "./NativeAccountConnect";

const { status } = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { nativeConnectors: { status } } }));
vi.mock("../../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
const container = document.createElement("div"),
  root = createRoot(container);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  status.mockReset();
});
async function render(
  appId: NativeAppId,
  kind: NativeConfigStatus["credentialKind"],
  actor: NativeConfigStatus["actor"],
  options: Partial<ComponentProps<typeof NativeAccountConnect>> & {
    pickerAvailable?: boolean;
    usesConfiguredCredential?: boolean;
  } = {},
) {
  status.mockResolvedValue({
    canConfigure: true,
    callbackUri: "https://instance.example.test/callback",
    configurations: [
      {
        id: "fixture-config",
        appId,
        label: "Fixture source",
        credentialKind: kind,
        actor,
        ownership: "byo",
        configured: true,
        enabled: true,
        revision: 1,
        callbackUri: "https://instance.example.test/callback",
        executionLocation: "instance",
        usesConfiguredCredential: options.usesConfiguredCredential,
        ...(options.pickerAvailable === undefined
          ? {}
          : { driveFilePickerAvailable: options.pickerAvailable }),
      },
    ],
  });
  await act(async () =>
    root.render(
      <NativeAccountConnect
        appId={appId}
        onSubmit={options.onSubmit ?? (async () => {})}
        onCancel={() => {}}
        {...(options.previousConnectionId
          ? { previousConnectionId: options.previousConnectionId }
          : {})}
      />,
    ),
  );
}
it.each([
  ["github", "github_app_installation", "installation", "GitHub App private key JSON"],
  ["github", "personal_token", "user", "Personal access token"],
  ["linear", "personal_token", "user", "Linear API key"],
  ["slack", "bot_token", "bot", "Slack bot token"],
  ["slack", "personal_token", "user", "Slack user token"],
  ["telegram-bot", "bot_token", "bot", "Telegram bot token"],
  ["discord", "bot_token", "bot", "Discord bot token"],
  ["hubspot", "personal_token", "app", "HubSpot private app token"],
] as const)(
  "%s %s displays the actual protected credential field",
  async (appId, kind, actor, label) => {
    await render(appId, kind, actor);
    expect([...container.querySelectorAll("label")].map((node) => node.textContent)).toContain(
      label,
    );
    expect(container.querySelector("input")?.type).toBe("password");
    if (kind === "github_app_installation")
      expect(container.textContent).toContain("appId, installationId and privateKeyPem");
  },
);
it("Slack OAuth identifies the selected actor and never asks for a pasted token", async () => {
  await render("slack", "oauth", "bot");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("option")?.textContent).toContain("Bot");
  expect(container.textContent).toContain("Authorize account");
});
it("Drive file selection begins a separate connection without a previous account or credential", async () => {
  const submit = vi.fn();
  await render("google-drive", "oauth", "user", { pickerAvailable: true, onSubmit: submit });
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Choose accessible files",
  )!;
  await act(async () => button.click());
  expect(submit).toHaveBeenCalledWith({
    configId: "fixture-config",
    authorizationFlow: "drive_picker",
  });
  expect(container.querySelector("input")).toBeNull();
});
it("ordinary Drive authorization preserves the ordinary input shape", async () => {
  const submit = vi.fn();
  await render("google-drive", "oauth", "user", { pickerAvailable: true, onSubmit: submit });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(submit).toHaveBeenCalledWith({ configId: "fixture-config" });
});
it("reauthorization never offers Picker or changes the existing account flow", async () => {
  const submit = vi.fn();
  await render("google-drive", "oauth", "user", {
    pickerAvailable: true,
    previousConnectionId: "old-drive",
    onSubmit: submit,
  });
  expect(container.textContent).not.toContain("Choose accessible files");
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(submit).toHaveBeenCalledWith({
    configId: "fixture-config",
    previousConnectionId: "old-drive",
  });
});
it.each([false, undefined])(
  "does not offer Picker when its config capability is %s",
  async (pickerAvailable) => {
    await render("google-drive", "oauth", "user", { pickerAvailable });
    expect(container.textContent).not.toContain("Choose accessible files");
    if (pickerAvailable === false) expect(container.textContent).toContain("Ask an administrator");
  },
);

it.each([
  ["telegram-bot", "bot_token", "bot"],
  ["discord", "bot_token", "bot"],
  ["feishu-lark", "machine_key", "app"],
  ["dingtalk", "machine_key", "app"],
  ["wecom", "machine_key", "app"],
] as const)(
  "%s reuses the configured credential without asking a member to paste it",
  async (appId, kind, actor) => {
    const submit = vi.fn();
    await render(appId, kind, actor, { usesConfiguredCredential: true, onSubmit: submit });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Connect application",
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submit).toHaveBeenCalledWith({ configId: "fixture-config" });
  },
);

it("Figma warns about the platform token replacement only for OAuth", async () => {
  const message =
    "Authorizing this Figma account replaces its previous authorization for this application.";
  await render("figma", "oauth", "user");
  expect(container.textContent).toContain(message);
  await act(async () => root.render(null));
  await render("figma", "personal_token", "user");
  expect(container.textContent).not.toContain(message);
});
