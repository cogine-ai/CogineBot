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
      },
    ],
  });
  await act(async () =>
    root.render(
      <NativeAccountConnect appId={appId} onSubmit={async () => {}} onCancel={() => {}} />,
    ),
  );
}
it.each([
  ["github", "github_app_installation", "installation", "GitHub App private key JSON"],
  ["github", "personal_token", "user", "Personal access token"],
  ["linear", "personal_token", "user", "Linear API key"],
  ["slack", "bot_token", "bot", "Slack bot token"],
  ["slack", "personal_token", "user", "Slack user token"],
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
