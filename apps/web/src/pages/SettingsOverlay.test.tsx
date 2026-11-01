// @vitest-environment jsdom

import type * as UiWeb from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  calls: [] as string[],
  pending: null as Promise<unknown> | null,
  fail: false,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((s, p, i) => s + (i ? String(values[i - 1]) : "") + p, ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const actual = await importOriginal<typeof UiWeb>();
  return {
    Switch: actual.Switch,
    Label: actual.Label,
    Select: actual.Select,
    SelectContent: actual.SelectContent,
    SelectItem: actual.SelectItem,
    SelectTrigger: actual.SelectTrigger,
    SelectValue: actual.SelectValue,
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    Dialog: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DialogClose: ({
      children,
      render: _render,
      ...props
    }: ComponentProps<"button"> & { render?: unknown }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    DialogContent: ({
      children,
      showCloseButton: _s,
      initialFocus: _i,
      ...props
    }: ComponentProps<"div"> & { showCloseButton?: boolean; initialFocus?: unknown }) => (
      <div {...props}>{children}</div>
    ),
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  };
});
vi.mock("./AccountSettingsOverlay", () => ({
  GeneralSettingsPanels: () => <p>Account details</p>,
  ComputerSettingsPanel: () => null,
  UsageSettingsPanel: () => null,
  UpdatesSettingsPanel: () => null,
}));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => <p>Models pane</p> }));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: () => <p>Voice pane</p> }));
vi.mock("../components/ApprovalRulesSettings", () => ({
  ApprovalRulesSettings: () => <p>Approval rules pane</p>,
}));
vi.mock("./MemorySettingsOverlay", () => ({
  MemorySettingsOverlay: ({
    config: value,
    onConfigChange,
  }: {
    config: unknown;
    onConfigChange: (value: unknown) => void;
  }) => (
    <div>
      <p data-testid="memory-value">{JSON.stringify(value) ?? "Loading memory"}</p>
      <button type="button" onClick={() => onConfigChange(value)}>
        Save memory
      </button>
    </div>
  ),
}));
vi.mock("../components/ComputersUnavailableHint", () => ({ computersAreUnavailable: () => false }));

import { SettingsOverlay } from "./SettingsOverlay";

const spaces = [
  { id: "space-a", name: "Alpha" },
  { id: "space-b", name: "Beta" },
  { id: "space-c", name: "Gamma" },
];
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  config.calls.length = 0;
  config.pending = null;
  config.fail = false;
});
async function setup(initialSection: "models" | "memory" | "general" = "models") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("rakazo:space-id", "space-a");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_request: Request, init?: RequestInit) => {
      const id = new Headers(init?.headers).get("x-rakazo-space-id")!;
      config.calls.push(id);
      if (config.fail) throw new Error("Read unavailable");
      const value = config.pending
        ? await config.pending
        : { provider: id, defaultMemoryScope: "shared" };
      return Response.json({ json: value });
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSpaceChange = vi.fn();
  const onMemoryConfigChange = vi.fn();
  const render = async (target: (typeof spaces)[number] | null = spaces[1]!) => {
    await act(async () =>
      root.render(
        <SettingsOverlay
          space={target}
          spaces={spaces}
          currentSpaceId="space-a"
          ownerKey="account-a/session-a"
          onSpaceChange={onSpaceChange}
          name="Example"
          onUsageOpen={() => undefined}
          memoryConfig={{
            provider: "space-a",
            defaultMemoryScope: "shared",
            settings: {},
            updatedAt: "2026-10-23T00:00:00Z",
          }}
          onMemoryConfigChange={onMemoryConfigChange}
          onClose={() => undefined}
          initialSection={initialSection}
        />,
      ),
    );
  };
  await render();
  return {
    container,
    render,
    onSpaceChange,
    onMemoryConfigChange,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it("names and changes only the edited Space while the conversation stays selected", async () => {
  const h = await setup();
  try {
    const picker = h.container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]');
    expect(picker?.querySelector('[data-slot="select-value"]')?.textContent).toBe("Beta");
    await act(async () => picker!.click());
    const alpha = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (b) => b.textContent === "Alpha",
    )!;
    await act(async () => alpha.click());
    expect(h.onSpaceChange).toHaveBeenCalledExactlyOnceWith("space-a");
    expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
  } finally {
    await h.close();
  }
});
it("keeps account controls outside the per-Space picker and exposes confirmations separately", async () => {
  const h = await setup("general");
  try {
    expect(h.container.querySelector('[data-testid="settings-space"]')).toBeNull();
    const button = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-nav-confirmations"]',
    );
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(h.container.textContent).toContain("Approval rules pane");
    expect(
      h.container.querySelector('[data-testid="settings-space"] [data-slot="select-value"]')
        ?.textContent,
    ).toBe("Beta");
  } finally {
    await h.close();
  }
});
it("loads the edited memory independently and withholds a previous Space after target change", async () => {
  const h = await setup("memory");
  try {
    expect(config.calls).toEqual(["space-b"]);
    expect(h.container.querySelector('[data-testid="memory-value"]')?.textContent).toContain(
      "space-b",
    );
    let release!: (value: unknown) => void;
    config.pending = new Promise((resolve) => {
      release = resolve;
    });
    await h.render(spaces[2]);
    expect(
      h.container.querySelector('[data-testid="memory-value"]')?.textContent ?? "",
    ).not.toContain("space-b");
    await act(async () => release({ provider: "space-c", defaultMemoryScope: "shared" }));
    expect(config.calls).toEqual(["space-b", "space-c"]);
    expect(h.container.querySelector('[data-testid="memory-value"]')?.textContent).toContain(
      "space-c",
    );
    expect(h.onMemoryConfigChange).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("does not use the conversation as a fallback when the edited Space is unavailable", async () => {
  const h = await setup("memory");
  try {
    await h.render(null);
    expect(h.container.querySelector('[data-testid="memory-value"]')).toBeNull();
    expect(config.calls).toEqual(["space-b"]);
  } finally {
    await h.close();
  }
});
it("retries a failed target memory read without showing disconnected controls or updating another Space", async () => {
  config.fail = true;
  const h = await setup("memory");
  try {
    expect(h.container.querySelector('[data-testid="memory-value"]')).toBeNull();
    const retry = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    config.fail = false;
    await act(async () => retry.click());
    expect(config.calls).toEqual(["space-b", "space-b"]);
    expect(h.container.querySelector('[data-testid="memory-value"]')?.textContent).toContain(
      "space-b",
    );
    await act(async () =>
      [...h.container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save memory")!
        .click(),
    );
    expect(h.onMemoryConfigChange).not.toHaveBeenCalled();
    await h.render(spaces[0]!);
    await act(async () =>
      [...h.container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save memory")!
        .click(),
    );
    expect(h.onMemoryConfigChange).toHaveBeenCalledTimes(1);
  } finally {
    await h.close();
  }
});
it("ignores a previous target read that finishes after a replacement target", async () => {
  let release!: (value: unknown) => void;
  config.pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup("memory");
  try {
    config.pending = null;
    await h.render(spaces[2]!);
    await act(async () => release({ provider: "space-b", defaultMemoryScope: "shared" }));
    expect(h.container.querySelector('[data-testid="memory-value"]')?.textContent).toContain(
      "space-c",
    );
    expect(h.container.querySelector('[data-testid="memory-value"]')?.textContent).not.toContain(
      "space-b",
    );
  } finally {
    await h.close();
  }
});

it("lets the target Space owner save fresh collaboration policy without moving the chat", async () => {
  const h = await setup();
  let written: unknown;
  let writeSpace: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request | string | URL, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.endsWith("/spaces/list"))
        return Response.json({
          json: {
            spaces: [
              {
                id: "space-b",
                name: "Beta",
                allowBotCollaboration: true,
                collaborationRevision: 7,
                canManageCollaboration: true,
              },
            ],
          },
        });
      if (url.endsWith("/spaces/update")) {
        written = JSON.parse(
          request instanceof Request ? await request.text() : String(init?.body),
        );
        writeSpace = new Headers(init?.headers).get("x-rakazo-space-id");
        return Response.json({
          json: {
            spaceId: "space-b",
            allowBotCollaboration: false,
            collaborationRevision: 8,
            canManageCollaboration: true,
          },
        });
      }
      throw new Error(`Unexpected UI RPC ${url}`);
    }),
  );
  try {
    const tab = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-nav-collaboration"]',
    );
    expect(tab).not.toBeNull();
    await act(async () => tab!.click());
    const toggle = h.container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle!.click());
    expect(h.container.textContent).toContain("Work already running may finish.");
    const save = Array.from(h.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    expect(save?.disabled).toBe(false);
    await act(async () => save!.click());
    expect(written).toEqual({
      json: { spaceId: "space-b", allowBotCollaboration: false, expectedCollaborationRevision: 7 },
    });
    expect(writeSpace).toBe("space-b");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(h.container.textContent).toContain("Saved.");
    expect(h.onSpaceChange).not.toHaveBeenCalled();
    expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
  } finally {
    await h.close();
  }
});

it("keeps the settings target and navigation locked until a collaboration write settles", async () => {
  const h = await setup();
  let release!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    release = done;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      if (request.url.endsWith("/spaces/list"))
        return Response.json({
          json: {
            spaces: [
              {
                id: "space-b",
                allowBotCollaboration: true,
                collaborationRevision: 7,
                canManageCollaboration: true,
              },
            ],
          },
        });
      if (request.url.endsWith("/spaces/update")) return pending;
      throw new Error("Unexpected UI RPC");
    }),
  );
  try {
    await act(async () =>
      h.container
        .querySelector<HTMLButtonElement>('[data-testid="settings-nav-collaboration"]')!
        .click(),
    );
    await act(async () => h.container.querySelector<HTMLElement>('[role="switch"]')!.click());
    await act(async () =>
      [...h.container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]')?.disabled,
    ).toBe(true);
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-models"]')?.disabled,
    ).toBe(true);
    expect(
      h.container.querySelector<HTMLButtonElement>('[aria-label="Close user settings"]')?.disabled,
    ).toBe(true);
    expect(h.onSpaceChange).not.toHaveBeenCalled();
    await act(async () =>
      release(
        Response.json({
          json: {
            spaceId: "space-b",
            allowBotCollaboration: false,
            collaborationRevision: 8,
            canManageCollaboration: true,
          },
        }),
      ),
    );
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="settings-space"]')?.disabled,
    ).toBe(false);
    expect(localStorage.getItem("rakazo:space-id")).toBe("space-a");
  } finally {
    await h.close();
  }
});
