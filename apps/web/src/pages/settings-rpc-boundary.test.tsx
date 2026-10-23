// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + (index ? String(values[index - 1]) : "") + part, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + (index ? String(values[index - 1]) : "") + part, ""),
}));
vi.mock("../lib/localized-provider-hint", () => ({ localizedProviderHint: () => "API key" }));
vi.mock("./AccountSettingsOverlay", () => ({
  GeneralSettingsPanels: () => null,
  ComputerSettingsPanel: () => null,
  UsageSettingsPanel: () => null,
  UpdatesSettingsPanel: () => null,
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./KnowledgeSection", () => ({ SpaceMemorySection: () => null }));
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof UiWeb>();
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: actual.Select,
    SelectContent: actual.SelectContent,
    SelectItem: actual.SelectItem,
    SelectTrigger: actual.SelectTrigger,
    SelectValue: actual.SelectValue,
    AlertDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Button: ({
      children,
      onClick,
      disabled,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Checkbox: ({
      checked,
      disabled,
      onCheckedChange,
    }: {
      checked: boolean;
      disabled?: boolean;
      onCheckedChange: (value: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
    Label: Pass,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Toggle: ({
      pressed,
      onPressedChange,
      children,
      ...props
    }: ComponentProps<"button"> & { pressed?: boolean; onPressedChange?: () => void }) => (
      <button type="button" {...props} aria-pressed={pressed} onClick={onPressedChange}>
        {children}
      </button>
    ),
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: ComponentProps<"input"> & {
      checked?: boolean;
      onCheckedChange?: (value: boolean) => void;
    }) => (
      <input
        type="checkbox"
        {...props}
        checked={checked}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
    ),
    Field: Pass,
    FieldLabel: Pass,
    ModelThinkingOptions: () => null,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { SpaceRpcProvider } from "../lib/space-rpc";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { SettingsOverlay } from "./SettingsOverlay";

const entry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key",
  authHint: "API key",
};
const credential = {
  id: "cred-b",
  provider: "deepseek",
  label: "Target key",
  hasKey: true,
  isDefault: true,
  connectionRevision: 7,
  modelId: "deepseek-chat",
};
const memory = {
  provider: "supermemory",
  settings: { mode: "cloud" },
  defaultMemoryScope: "isolated" as const,
  updatedAt: "2026-10-23T00:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.body.replaceChildren();
});
async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  localStorage.setItem("rakazo:space-id", "space-a");
  const calls: Array<{ path: string; space: string | null; input: unknown }> = [];
  const held = new Map<string, Promise<unknown>>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request, init?: RequestInit) => {
      const path = new URL(request.url).pathname.split("/rpc/")[1]!;
      const space = new Headers(init?.headers).get("x-rakazo-space-id");
      const body = await request.text();
      const input = body ? JSON.parse(body).json : undefined;
      calls.push({ path, space, input });
      let value: unknown;
      if (held.has(path)) value = await held.get(path);
      else if (path === "me")
        value = {
          userId: "user-a",
          spaceId: space,
          defaultProvider: "deepseek",
          defaultModel: "deepseek-chat",
        };
      else if (path === "models/list") value = [entry];
      else if (path === "models/credentials") value = [{ ...credential, label: `Key ${space}` }];
      else if (path === "models/references") value = { references: [] };
      else if (path === "models/connect") value = { ...credential, connectionRevision: 8 };
      else if (path === "models/backups" || path === "approvalRules/list") value = [];
      else if (path === "approvalRules/set")
        value = {
          id: "rule-b",
          effect: "require_approval",
          matchKind: "category",
          matchValue: "email",
        };
      else if (path === "autoReview/get" || path === "autoReview/set")
        value = { enabled: false, checkerAvailable: false };
      else if (path === "memory/providerConfig") value = memory;
      else if (path === "memory/setDefaultScope")
        value = { ...memory, defaultMemoryScope: "shared" };
      else throw new Error(`Unexpected ${path}`);
      return Response.json({ json: value });
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (children: ReactNode, space = "space-b", owner = "account-a/session-1") => {
    await act(async () =>
      root.render(
        <SpaceRpcProvider key={`${owner}/${space}`} spaceId={space} ownerKey={owner}>
          {children}
        </SpaceRpcProvider>,
      ),
    );
  };
  const click = async (name: string) => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Missing ${name}`);
    await act(async () => button.click());
  };
  return {
    calls,
    held,
    container,
    render,
    click,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it("saves a stored key in the edited Space without switching the conversation", async () => {
  const h = await setup();
  try {
    await h.render(<ModelSettingsOverlay embedded onClose={() => undefined} />);
    const input = h.container.querySelector<HTMLInputElement>("#model-api-key")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "synthetic-replacement",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await h.click("Replace API key");
    expect(h.calls.find((call) => call.path === "models/connect")).toMatchObject({
      space: "space-b",
      input: { provider: "deepseek", apiKey: "synthetic-replacement" },
    });
    expect(h.calls.every((call) => call.space === "space-b")).toBe(true);
    expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
  } finally {
    await h.close();
  }
});
it("discards a late model response after target and account lifetimes change", async () => {
  const h = await setup();
  const pending = deferred<unknown>();
  h.held.set("models/credentials", pending.promise);
  try {
    await h.render(<ModelSettingsOverlay embedded onClose={() => undefined} />);
    h.held.delete("models/credentials");
    await h.render(
      <ModelSettingsOverlay embedded onClose={() => undefined} />,
      "space-c",
      "account-b/session-2",
    );
    await act(async () => pending.resolve([{ ...credential, label: "Old private key" }]));
    expect(h.container.textContent).toContain("Key space-c");
    expect(h.container.textContent).not.toContain("Old private key");
  } finally {
    await h.close();
  }
});
it("writes confirmations to the edited Space and rejects an old saved callback after replacement", async () => {
  const h = await setup();
  try {
    await h.render(<ApprovalRulesSettings />);
    await h.click("Ask before sending external email");
    expect(h.calls.find((call) => call.path === "approvalRules/set")?.space).toBe("space-b");
    const pending = deferred<unknown>();
    h.held.set("approvalRules/set", pending.promise);
    await h.click("Ask before purchases");
    h.held.delete("approvalRules/set");
    await h.render(<ApprovalRulesSettings />, "space-c");
    await act(async () =>
      pending.resolve({
        id: "old",
        effect: "require_approval",
        matchKind: "category",
        matchValue: "purchase",
      }),
    );
    expect(h.container.textContent).not.toContain("Ask before purchase actions");
  } finally {
    await h.close();
  }
});
it("uses the edited memory and never publishes a previous target's late save", async () => {
  const h = await setup();
  const saved = vi.fn();
  const pending = deferred<unknown>();
  h.held.set("memory/setDefaultScope", pending.promise);
  try {
    await h.render(
      <MemorySettingsOverlay
        embedded
        config={memory}
        onConfigChange={saved}
        onClose={() => undefined}
      />,
    );
    await h.click("Shared");
    expect(h.calls.find((call) => call.path === "memory/setDefaultScope")?.space).toBe("space-b");
    await h.render(
      <MemorySettingsOverlay
        embedded
        config={memory}
        onConfigChange={saved}
        onClose={() => undefined}
      />,
      "space-c",
    );
    await act(async () => pending.resolve({ ...memory, defaultMemoryScope: "shared" }));
    expect(saved).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("keeps navigation and the target locked while the edited memory save is pending", async () => {
  const h = await setup();
  const pending = deferred<unknown>();
  h.held.set("memory/setDefaultScope", pending.promise);
  try {
    await h.render(
      <SettingsOverlay
        name="Example"
        space={{ id: "space-b", name: "Beta" }}
        spaces={[
          { id: "space-a", name: "Alpha" },
          { id: "space-b", name: "Beta" },
        ]}
        currentSpaceId="space-a"
        ownerKey="account-a/session-1"
        onSpaceChange={() => undefined}
        onUsageOpen={() => undefined}
        memoryConfig={null}
        onMemoryConfigChange={() => undefined}
        onClose={() => undefined}
        initialSection="memory"
      />,
    );
    await h.click("Shared");
    expect(h.calls.find((call) => call.path === "memory/setDefaultScope")?.space).toBe("space-b");
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]')?.disabled,
    ).toBe(true);
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-models"]')?.disabled,
    ).toBe(true);
    await act(async () => pending.resolve({ ...memory, defaultMemoryScope: "shared" }));
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]')?.disabled,
    ).toBe(false);
  } finally {
    await h.close();
  }
});
