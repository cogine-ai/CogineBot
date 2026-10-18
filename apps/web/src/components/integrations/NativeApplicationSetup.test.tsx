// @vitest-environment jsdom
import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeApplicationSetup } from "./NativeApplicationSetup";

const { status, save } = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { nativeConnectors: { status, save } } }));
vi.mock("../../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("./NativeNotionWebhookSetup", () => ({
  NativeNotionWebhookSetup: () => <div>Notion events</div>,
}));
vi.mock("./NativeSlackEventSetup", () => ({
  NativeSlackEventSetup: () => <div>Slack events</div>,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: ({ onChange, ...props }: ComponentProps<"input">) => (
    <input
      {...props}
      onInput={(event) => onChange?.(event as unknown as ChangeEvent<HTMLInputElement>)}
    />
  ),
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    onCheckedChange,
    checked,
    disabled,
    id,
  }: {
    onCheckedChange: (value: boolean) => void;
    checked: boolean;
    disabled: boolean;
    id: string;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
const container = document.createElement("div"),
  root = createRoot(container);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  status.mockReset();
  save.mockReset();
});
function control(label: string): HTMLInputElement | HTMLSelectElement {
  const node = [...container.querySelectorAll("label")].find((node) => node.textContent === label);
  expect(node, label).toBeTruthy();
  return container.querySelector(`[id="${node!.htmlFor}"]`)!;
}
async function choose(label: string, value: string) {
  await act(async () => {
    const node = control(label);
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function enter(label: string, value: string) {
  await act(async () => {
    const node = control(label);
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(app: string) {
  status.mockResolvedValue({
    canConfigure: true,
    callbackUri: "https://instance.example.test/callback",
    configurations: [],
  });
  await act(async () => root.render(<NativeApplicationSetup />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Add application")!
      .click(),
  );
  await choose("Application", app);
}
it("setup offers all 37 native apps through the existing application form", async () => {
  await render("outlook-mail");
  const application = control("Application") as HTMLSelectElement;
  expect(application.options).toHaveLength(37);
  expect([...application.options].map((x) => x.textContent)).toContain("飞书 / Lark");
  expect(control("Client ID")).toBeTruthy();
  expect(container.textContent).toContain("Mail.Read");
  expect(container.textContent).not.toContain("Corp ID");
});
it("HubSpot OAuth defaults to account access; its private token cannot claim user permissions", async () => {
  await render("hubspot");
  expect(control("Acts as").value).toBe("app");
  expect(container.textContent).toContain("HubSpot account");
  await choose("Authorization", "personal_token");
  expect(container.textContent).not.toContain("User permissions");
  expect(container.textContent).toContain(
    "Members enter their credentials when connecting from Apps.",
  );
  expect(container.querySelector('input[type="password"]')).toBeNull();
});
it("Atlassian cloud-site selection and GitLab origin only appear for the relevant app", async () => {
  await render("jira");
  expect(control("Cloud site ID").required).toBe(true);
  expect(container.textContent).not.toContain("GitLab origin");
  await choose("Application", "gitlab");
  expect(control("GitLab origin").required).toBe(false);
  expect((control("GitLab origin") as HTMLInputElement).placeholder).toBe("https://gitlab.com");
  expect(container.textContent).not.toContain("Cloud site ID");
});
it("official Discord stores the owner token and concrete server/channel bindings; BYO asks the member", async () => {
  await render("discord");
  await choose("Application owner", "official");
  expect(control("Discord bot token").type).toBe("password");
  expect(control("Server ID").required).toBe(true);
  expect(control("Allowed channel IDs").required).toBe(true);
  expect(container.textContent).toContain("This server is bound to the current space.");
  await choose("Application owner", "byo");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain(
    "Members enter their credentials when connecting from Apps.",
  );
});
it("Feishu/Lark region and WeCom corporate application fields are explicit", async () => {
  await render("feishu-lark");
  expect(control("Platform").value).toBe("feishu");
  await choose("Platform", "lark");
  expect(control("Platform").value).toBe("lark");
  await choose("Application", "wecom");
  expect(control("Corp ID").required).toBe(true);
  expect(control("Agent ID").required).toBe(true);
  expect(control("App secret").type).toBe("password");
  expect(container.textContent).not.toContain("Platform");
});
it("Telegram owner form saves exact typed targets and write-only token on the existing RPC", async () => {
  await render("telegram-bot");
  await choose("Application owner", "official");
  await enter("Connection method name", "Company bot");
  await enter("Telegram bot token", "fixture-token");
  await enter("Allowed chat IDs", "-100123456, 123456");
  save.mockResolvedValue({
    id: "fixture",
    appId: "telegram-bot",
    label: "Company bot",
    ownership: "official",
    credentialKind: "bot_token",
    actor: "bot",
    configured: true,
    enabled: true,
    revision: 1,
    callbackUri: "https://instance.example.test/callback",
    executionLocation: "instance",
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: "telegram-bot",
      actor: "bot",
      credentialKind: "bot_token",
      ownership: "official",
      targetIds: ["-100123456", "123456"],
      clientSecret: "fixture-token",
    }),
  );
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("enterprise callback credentials only appear in the supported OAuth owner setup and stay write-only", async () => {
  await render("feishu-lark");
  expect(container.textContent).toContain("This application is bound to the current space.");
  expect(container.textContent).not.toContain("Authorization callbacks");
  await choose("Authorization", "oauth");
  expect(container.textContent).not.toContain("This application is bound to the current space.");
  expect(control("Verification token").type).toBe("password");
  expect(control("Encryption key").type).toBe("password");
  await enter("Connection method name", "Lark authorization");
  await enter("App ID", "fixture-app");
  await enter("Client secret", "fixture-secret");
  await enter("Verification token", "fixture-verification");
  await enter("Encryption key", "fixture-encryption");
  save.mockResolvedValue({
    id: "fixture",
    appId: "feishu-lark",
    label: "Lark authorization",
    ownership: "byo",
    credentialKind: "oauth",
    actor: "user",
    configured: true,
    enabled: true,
    revision: 1,
    callbackUri: "https://instance.example.test/callback",
    executionLocation: "instance",
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: "user",
      verificationToken: "fixture-verification",
      encryptionKey: "fixture-encryption",
    }),
  );
});

it("WeCom distinguishes local Corp/Agent credentials from a suite installation and DingTalk needs its corporation", async () => {
  await render("wecom");
  expect(control("Corp ID").required).toBe(true);
  expect(control("Agent ID").required).toBe(true);
  expect(container.textContent).not.toContain("Client ID");
  expect(container.textContent).not.toContain("Suite ID");
  await choose("Authorization", "oauth");
  expect(control("Suite ID").required).toBe(true);
  expect(control("Corp ID (optional)").required).toBe(false);
  expect(control("Agent ID").required).toBe(true);
  await choose("Application", "dingtalk");
  expect(control("AppKey").required).toBe(true);
  expect(control("Corp ID").required).toBe(true);
  await choose("Authorization", "oauth");
  expect(control("Client ID").required).toBe(true);
  expect(control("Corp ID (optional)").required).toBe(false);
});
