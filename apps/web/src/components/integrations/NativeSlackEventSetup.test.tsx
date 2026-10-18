// @vitest-environment jsdom
import type { NativeConfigStatus, NativeSlackHook } from "@rakazo/contracts";
import type { ChangeEvent, ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeSlackEventSetup } from "./NativeSlackEventSetup";

const { status, save, disable } = vi.hoisted(() => ({
  status: vi.fn(),
  save: vi.fn(),
  disable: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    nativeConnectors: {
      slackWebhookStatus: status,
      saveSlackWebhook: save,
      disableSlackWebhook: disable,
    },
  },
}));
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
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    Input: ({ onChange, ...props }: ComponentProps<"input">) => (
      <input
        {...props}
        onInput={(event) => onChange?.(event as unknown as ChangeEvent<HTMLInputElement>)}
      />
    ),
    Field: Box,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Switch: ({
      onCheckedChange,
      ...props
    }: ComponentProps<"input"> & { onCheckedChange: (value: boolean) => void }) => (
      <input
        {...props}
        type="checkbox"
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
    ),
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? children : null,
    AlertDialogContent: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: Box,
    AlertDialogDescription: Box,
    AlertDialogFooter: Box,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button {...props} />,
    AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
  };
});
const config: NativeConfigStatus = {
  id: "fixture-config",
  appId: "slack",
  label: "Fixture Slack",
  ownership: "byo",
  credentialKind: "bot_token",
  actor: "bot",
  enabled: true,
  configured: true,
  revision: 1,
  callbackUri: "https://instance.example.test/callback",
  executionLocation: "instance",
};
const hook: NativeSlackHook = {
  id: "fixture-hook",
  configId: config.id,
  configRevision: 1,
  revision: 1,
  appId: "AFIXTURE",
  teamId: null,
  botEvents: ["app_mention"],
  enabled: true,
  configured: true,
  verified: false,
  phase: "waiting_for_verification",
  webhookUrl: "https://instance.example.test/api/connectors/events/slack/fixture-hook",
  lastVerifiedAt: null,
};
const container = document.createElement("div"),
  root = createRoot(container);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  status.mockReset();
  save.mockReset();
  disable.mockReset();
});
async function render(value = config) {
  await act(async () => root.render(<NativeSlackEventSetup config={value} onBack={() => {}} />));
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("saving writes the secret once, clears it before response and shows a verification step instead of delivery proof", async () => {
  status.mockResolvedValue({ configId: config.id, publicHttpsAvailable: true, hooks: [] });
  let complete!: (value: NativeSlackHook) => void;
  save.mockImplementation(
    () =>
      new Promise<NativeSlackHook>((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  const text = [...container.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.type === "text",
  )!;
  const secret = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await enter(text, "AFIXTURE");
  await enter(secret, "fixture-signing-secret");
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => {
    boxes[0]!.click();
  });
  await act(async () => {
    boxes[boxes.length - 1]!.click();
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(save).toHaveBeenCalledWith({
    configId: config.id,
    appId: "AFIXTURE",
    signingSecret: "fixture-signing-secret",
    botEvents: ["app_mention"],
    botSubscriptionsConfirmed: true,
  });
  expect(secret.value).toBe("");
  status.mockResolvedValue({ configId: config.id, publicHttpsAvailable: true, hooks: [hook] });
  await act(async () => complete(hook));
  expect(container.textContent).toContain("Verify the Request URL in Slack");
  expect(container.textContent).toContain("Grant the matching bot scopes separately");
  expect(container.textContent).toContain(
    "app_uninstalled and tokens_revoked update account status",
  );
  expect(container.textContent).not.toContain("fixture-signing-secret");
});
it("a stale response from another application configuration cannot replace the current setup", async () => {
  let complete!: (value: unknown) => void;
  status
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue({ configId: "other-config", publicHttpsAvailable: false, hooks: [] });
  await render();
  await render({ ...config, id: "other-config" });
  await act(async () =>
    complete({ configId: config.id, publicHttpsAvailable: true, hooks: [hook] }),
  );
  expect(container.textContent).toContain("A public HTTPS API URL is required");
  expect(container.textContent).not.toContain("AFIXTURE");
  expect(container.querySelector('input[type="password"]')).toBeNull();
});
