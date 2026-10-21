// @vitest-environment jsdom

import type { ModelCredentialReference } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  list: vi.fn(),
  references: vi.fn<() => Promise<{ references: ModelCredentialReference[] }>>(async () => ({
    references: [],
  })),
  backups: vi.fn(async () => []),
  setBackups: vi.fn(async () => ({ ok: true })),
  credentials: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  setDefault: vi.fn(),
  probeOpenAiCompatible: vi.fn(),
  beginOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
}));

const scope = vi.hoisted(() => ({ generation: 0, spaceId: "space-1" }));

vi.mock("../lib/rpc", () => ({
  currentSpaceSelectionGeneration: () => scope.generation,
  selectedSpaceId: () => scope.spaceId,
  rpc: {
    models,
    me: vi.fn(),
  },
}));
vi.mock("../lib/localized-provider-hint", () => ({
  localizedProviderHint: () => "API key",
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
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
    ModelThinkingOptions: () => null,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const STORED_PLACEHOLDER = "Paste a replacement key";
const deepseekEntry = {
  provider: "deepseek",
  providerName: "DeepSeek",
  id: "deepseek-chat",
  label: "DeepSeek Chat",
  billing: "API key",
  auth: "api-key" as const,
  authHint: "API key",
};
const compatibleEntry = {
  provider: "openai-compatible",
  providerName: "OpenAI-compatible",
  id: "custom",
  label: "Custom model",
  billing: "Your server",
  auth: "api-key" as const,
  authHint: "Custom server",
  placeholder: true,
};

function account(provider: string, modelId: string) {
  return {
    userId: "user-1",
    email: "ada@example.test",
    name: "Ada",
    spaceId: "space-1",
    isDeploymentOwner: false,
    needsModel: false,
    defaultProvider: provider,
    defaultModel: modelId,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot" as const,
    billingEnabled: false,
    ticketBoardEnabled: false,
  };
}

function buttons(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll("button")].filter((entry) =>
    entry.textContent?.includes(text),
  );
  if (found.length === 0) throw new Error(`Missing button: ${text}`);
  return found;
}

function keyField(container: HTMLElement) {
  const input = container.querySelector("#model-api-key");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing API key field");
  return input;
}

function compatibleKeyField(container: HTMLElement) {
  const input = [...container.querySelectorAll("input")].find(
    (entry) => entry.getAttribute("aria-label") === "API key",
  );
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing compatible API key field");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderSettings() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ModelSettingsOverlay embedded onClose={() => undefined} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  scope.generation = 0;
  scope.spaceId = "space-1";
  vi.mocked(rpc.me).mockResolvedValue(account("deepseek", "deepseek-chat"));
  models.references.mockResolvedValue({ references: [] });
  models.probeOpenAiCompatible.mockReset().mockResolvedValue({ models: [] });
  models.setDefault.mockReset().mockResolvedValue(undefined);
  models.list.mockResolvedValue([deepseekEntry]);
  models.credentials.mockResolvedValue([]);
  models.connect.mockReset().mockResolvedValue({ id: "cred-saved", connectionRevision: 1 });
  models.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it("shows a stored BYOK key when provider settings reopen", async () => {
  models.credentials.mockResolvedValue([
    {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      connectionRevision: 1,
      modelId: "deepseek-chat",
    },
  ]);

  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
    expect(input.type).toBe("password");
    expect(view.container.textContent).not.toContain("sk-");

    await typeInto(input, "sk-replacement-key");
    expect(keyField(view.container).value).toBe("sk-replacement-key");

    await typeInto(keyField(view.container), "");
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    await typeInto(keyField(view.container), "sk-replacement-key");
    await act(async () => {
      buttons(view.container, "Replace API key")[0]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", apiKey: "sk-replacement-key" }),
      { context: { spaceId: "space-1" } },
    );
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe(STORED_PLACEHOLDER);

    models.credentials.mockResolvedValue([]);
    await act(async () => {
      buttons(view.container, "Disconnect")[0]?.click();
    });
    const confirm = buttons(view.container, "Disconnect");
    await act(async () => {
      confirm[confirm.length - 1]?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(models.disconnect).toHaveBeenCalledWith(
      { provider: "deepseek", credentialId: "cred-deepseek", expectedRevision: 1 },
      { context: { spaceId: "space-1" } },
    );
    expect(keyField(view.container).value).toBe("");
    expect(keyField(view.container).placeholder).toBe("sk-…");
  } finally {
    await view.unmount();
  }
});

it("leaves the key field empty until a key is saved", async () => {
  const view = await renderSettings();
  try {
    const input = keyField(view.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-…");
    expect(view.container.textContent).not.toContain(STORED_PLACEHOLDER);
  } finally {
    await view.unmount();
  }
});

it("shows Cloudflare account and gateway fields for a new and a saved connection", async () => {
  const entry = {
    provider: "cloudflare-ai-gateway",
    providerName: "Cloudflare AI Gateway",
    id: "workers-ai/@cf/meta/llama-3.1-8b-instruct",
    label: "Llama",
    billing: "API key",
    auth: "api-key" as const,
    authHint: "API key",
  };
  vi.mocked(rpc.me).mockResolvedValue(account(entry.provider, entry.id));
  models.list.mockResolvedValue([entry]);
  models.credentials.mockResolvedValue([]);

  const fresh = await renderSettings();
  try {
    const accountId = fresh.container.querySelector("#cloudflare-account-id");
    const gatewayId = fresh.container.querySelector("#cloudflare-gateway-id");
    expect(accountId).toBeInstanceOf(HTMLInputElement);
    expect(gatewayId).toBeInstanceOf(HTMLInputElement);
    expect((accountId as HTMLInputElement).value).toBe("");
    expect((gatewayId as HTMLInputElement).value).toBe("");
    expect(fresh.container.textContent).toContain("Account ID");
    expect(fresh.container.textContent).toContain("Gateway ID");
  } finally {
    await fresh.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-cf",
      provider: entry.provider,
      label: "Cloudflare AI Gateway",
      hasKey: true,
      isDefault: true,
      accountId: "acct1234",
      gatewayId: "gateway-1",
      modelId: entry.id,
    },
  ]);
  const saved = await renderSettings();
  try {
    expect(
      (saved.container.querySelector("#cloudflare-account-id") as HTMLInputElement).value,
    ).toBe("acct1234");
    expect(
      (saved.container.querySelector("#cloudflare-gateway-id") as HTMLInputElement).value,
    ).toBe("gateway-1");
  } finally {
    await saved.unmount();
  }
});

it("shows a stored OpenAI-compatible key and stays empty when none is saved", async () => {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "deepseek-chat"));
  models.list.mockResolvedValue([compatibleEntry]);
  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "DeepSeek",
      hasKey: true,
      isDefault: true,
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
    },
  ]);

  const stored = await renderSettings();
  try {
    const input = compatibleKeyField(stored.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(STORED_PLACEHOLDER);
  } finally {
    await stored.unmount();
  }

  models.credentials.mockResolvedValue([
    {
      id: "cred-compatible",
      provider: "openai-compatible",
      label: "Local",
      hasKey: false,
      isDefault: true,
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    },
  ]);
  const empty = await renderSettings();
  try {
    const input = compatibleKeyField(empty.container);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Optional");
  } finally {
    await empty.unmount();
  }
});

function compatibleConnection(id = "connection-a", baseUrl = "https://models.example.test/v1") {
  return {
    id,
    provider: "openai-compatible",
    label: "Model server",
    hasKey: true,
    isDefault: id === "connection-a",
    connectionRevision: 7,
    baseUrl,
    modelId: "model-a",
    enabledModelIds: ["model-a", "model-b"],
  };
}

function useCompatibleConnections(connections = [compatibleConnection()]) {
  vi.mocked(rpc.me).mockResolvedValue(account("openai-compatible", "model-a"));
  models.list.mockResolvedValue([compatibleEntry, deepseekEntry]);
  models.credentials.mockResolvedValue(connections);
  models.connect.mockResolvedValue(connections[0]);
}

function field(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
  return input;
}

function select(container: HTMLElement, label: string): HTMLSelectElement {
  const input = container.querySelector(`select[aria-label="${label}"]`);
  if (!(input instanceof HTMLSelectElement)) throw new Error(`Missing select: ${label}`);
  return input;
}

async function choose(input: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("discovers without enabling models and saves explicit enabled choices with connection identity", async () => {
  useCompatibleConnections();
  models.probeOpenAiCompatible.mockResolvedValue({ models: ["model-a", "model-b", "model-c"] });
  const view = await renderSettings();
  try {
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    const checks = [...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks.map((entry) => entry.checked)).toEqual([true, true, false]);
    expect(checks[0]?.disabled).toBe(true);
    await act(async () => {
      checks[2]?.click();
    });
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        credentialId: "connection-a",
        expectedRevision: 7,
        modelId: "model-a",
        enabledModelIds: ["model-b", "model-c"],
      }),
      { context: { spaceId: "space-1" } },
    );
  } finally {
    await view.unmount();
  }
});

it("keeps canonical endpoint aliases and discards keys for actual endpoint changes", async () => {
  useCompatibleConnections();
  const view = await renderSettings();
  try {
    await typeInto(compatibleKeyField(view.container), "replacement-secret");
    await typeInto(
      field(view.container, "OpenAI-compatible server URL"),
      "https://models.example.test/",
    );
    expect(compatibleKeyField(view.container).value).toBe("replacement-secret");
    await typeInto(compatibleKeyField(view.container), "");
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    expect(models.probeOpenAiCompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseUrl: "https://models.example.test/",
        credentialId: "connection-a",
        expectedBaseUrl: "https://models.example.test/v1",
      }),
      { context: { spaceId: "space-1" } },
    );
    await typeInto(compatibleKeyField(view.container), "replacement-secret");
    await typeInto(
      field(view.container, "OpenAI-compatible server URL"),
      "https://other.example.test/custom/v2",
    );
    expect(compatibleKeyField(view.container).value).toBe("");
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    expect(models.probeOpenAiCompatible.mock.calls.at(-1)?.[0]).not.toHaveProperty("credentialId");
    expect(models.probeOpenAiCompatible.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "expectedBaseUrl",
    );
  } finally {
    await view.unmount();
  }
});

it("edits the selected connection and creates a distinct new connection without reusing its ID", async () => {
  useCompatibleConnections([
    compatibleConnection(),
    compatibleConnection("connection-b", "https://other.example.test/v1"),
  ]);
  const view = await renderSettings();
  try {
    await choose(select(view.container, "Connection"), "connection-b");
    expect(field(view.container, "OpenAI-compatible server URL").value).toBe(
      "https://other.example.test/v1",
    );
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect.mock.calls.at(-1)?.[0]).toMatchObject({
      credentialId: "connection-b",
      expectedRevision: 7,
    });
    await choose(select(view.container, "Connection"), "");
    await typeInto(
      field(view.container, "OpenAI-compatible server URL"),
      "https://new.example.test",
    );
    await typeInto(field(view.container, "Model id"), "manual-model");
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect.mock.calls.at(-1)?.[0]).toMatchObject({
      baseUrl: "https://new.example.test",
      modelId: "manual-model",
    });
    expect(models.connect.mock.calls.at(-1)?.[0]).not.toHaveProperty("credentialId");
    expect(models.connect.mock.calls.at(-1)?.[0]).not.toHaveProperty("expectedRevision");
  } finally {
    await view.unmount();
  }
});

it("retains a rejected draft and its captured revision for retry", async () => {
  useCompatibleConnections();
  models.connect.mockRejectedValue(new Error("Connection changed. Reopen settings."));
  const view = await renderSettings();
  try {
    await typeInto(compatibleKeyField(view.container), "replacement-secret");
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(view.container.textContent).toContain("Connection changed. Reopen settings.");
    expect(compatibleKeyField(view.container).value).toBe("replacement-secret");
    expect(select(view.container, "Connection").value).toBe("connection-a");
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect.mock.calls.map(([input]) => input.expectedRevision)).toEqual([7, 7]);
  } finally {
    await view.unmount();
  }
});

it.each(["space ABA", "logout"])("ignores late discovery after %s", async (change) => {
  useCompatibleConnections();
  const pending = deferred<{ models: string[] }>();
  models.probeOpenAiCompatible.mockReturnValue(pending.promise);
  const view = await renderSettings();
  try {
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    scope.generation += 2;
    if (change === "logout") scope.spaceId = "";
    await act(async () => {
      pending.resolve({ models: ["stale-result"] });
      await pending.promise;
    });
    expect(view.container.textContent).not.toContain("stale-result");
    expect(view.container.textContent).not.toContain("Found 1 model.");
    expect(select(view.container, "Models from server").value).toBe("model-a");
    expect(buttons(view.container, "Find models")[0]?.disabled).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("ignores a late save result after an endpoint edit and preserves the new draft", async () => {
  useCompatibleConnections();
  const pending = deferred<ReturnType<typeof compatibleConnection>>();
  models.connect.mockReturnValue(pending.promise);
  const view = await renderSettings();
  try {
    await typeInto(compatibleKeyField(view.container), "first-secret");
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    await typeInto(
      field(view.container, "OpenAI-compatible server URL"),
      "https://new.example.test/v1",
    );
    await typeInto(compatibleKeyField(view.container), "new-secret");
    await act(async () => {
      pending.resolve(compatibleConnection());
      await pending.promise;
    });
    expect(field(view.container, "OpenAI-compatible server URL").value).toBe(
      "https://new.example.test/v1",
    );
    expect(compatibleKeyField(view.container).value).toBe("new-secret");
    expect(view.container.textContent).not.toContain("Saved.");
    expect(models.credentials).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});

it("lists connection impacts and prevents disconnect while a bot is pinned", async () => {
  useCompatibleConnections();
  models.references.mockResolvedValue({
    references: [
      {
        kind: "space-default",
        id: "space-1",
        name: "Workspace",
        spaceId: "space-1",
        provider: "openai-compatible",
        modelId: "model-a",
        modelCredentialId: "connection-a",
        unresolved: false,
      },
      {
        kind: "bot",
        id: "bot-1",
        name: "Research bot",
        spaceId: "space-1",
        provider: "openai-compatible",
        modelId: "model-b",
        modelCredentialId: "connection-a",
        unresolved: false,
      },
    ],
  });
  const view = await renderSettings();
  try {
    expect(view.container.textContent).toContain("Research bot");
    await act(async () => {
      buttons(view.container, "Disconnect")[0]?.click();
    });
    const confirm = buttons(view.container, "Disconnect").at(-1);
    expect(confirm?.disabled).toBe(true);
    expect(view.container.textContent).toContain(
      "Choose another model for these items before disconnecting.",
    );
    expect(models.disconnect).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("switches the default only through the selected saved connection and captured revision", async () => {
  useCompatibleConnections();
  const view = await renderSettings();
  try {
    await choose(select(view.container, "Models from server"), "model-b");
    await act(async () => {
      buttons(view.container, "Use this model")[0]?.click();
    });
    expect(models.setDefault).toHaveBeenCalledWith(
      {
        provider: "openai-compatible",
        modelId: "model-b",
        modelCredentialId: "connection-a",
        expectedRevision: 7,
      },
      { context: { spaceId: "space-1" } },
    );
  } finally {
    await view.unmount();
  }
});

it("resets discovery on a connection change and ignores the previous connection's response", async () => {
  useCompatibleConnections([
    compatibleConnection(),
    compatibleConnection("connection-b", "https://other.example.test/v1"),
  ]);
  const pending = deferred<{ models: string[] }>();
  models.probeOpenAiCompatible.mockReturnValue(pending.promise);
  const view = await renderSettings();
  try {
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    await choose(select(view.container, "Connection"), "connection-b");
    expect(buttons(view.container, "Find models")[0]?.disabled).toBe(false);
    await act(async () => {
      pending.resolve({ models: ["old-connection-model"] });
      await pending.promise;
    });
    expect(select(view.container, "Connection").value).toBe("connection-b");
    expect(view.container.textContent).not.toContain("old-connection-model");
    expect(view.container.textContent).not.toContain("Found 1 model.");
  } finally {
    await view.unmount();
  }
});

it("keeps a found-model draft chosen after Save starts when the old receipt arrives", async () => {
  useCompatibleConnections();
  models.probeOpenAiCompatible.mockResolvedValue({ models: ["model-c"] });
  const pending = deferred<ReturnType<typeof compatibleConnection>>();
  models.connect.mockReturnValue(pending.promise);
  const view = await renderSettings();
  try {
    await typeInto(compatibleKeyField(view.container), "draft-secret");
    await act(async () => {
      buttons(view.container, "Find models")[0]?.click();
    });
    await choose(select(view.container, "Models from server"), "");
    await typeInto(field(view.container, "Model id"), "manual-model");
    await act(async () => {
      buttons(view.container, "Save")[0]?.click();
    });
    expect(models.connect.mock.calls[0]?.[0]).toMatchObject({ modelId: "manual-model" });
    const found = buttons(view.container, "Use a found model")[0];
    expect(found?.disabled).toBe(false);
    await act(async () => {
      found?.click();
    });
    expect(select(view.container, "Models from server").value).toBe("model-c");
    await act(async () => {
      pending.resolve(compatibleConnection());
      await pending.promise;
    });
    expect(select(view.container, "Models from server").value).toBe("model-c");
    expect(compatibleKeyField(view.container).value).toBe("draft-secret");
    expect(models.credentials).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).not.toContain("Saved.");
  } finally {
    await view.unmount();
  }
});

it.each(["https://models.example.test/", "https://models.example.test/v1/"])(
  "keeps unsaved enabled and disabled models when the endpoint changes to alias %s",
  async (alias) => {
    useCompatibleConnections();
    models.probeOpenAiCompatible.mockResolvedValue({ models: ["model-a", "model-b", "model-c"] });
    const view = await renderSettings();
    try {
      await typeInto(compatibleKeyField(view.container), "draft-secret");
      await act(async () => {
        buttons(view.container, "Find models")[0]?.click();
      });
      const checks = [
        ...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ];
      await act(async () => {
        checks[1]?.click();
        checks[2]?.click();
      });
      expect(checks.map((entry) => entry.checked)).toEqual([true, false, true]);
      await typeInto(field(view.container, "OpenAI-compatible server URL"), alias);
      expect(compatibleKeyField(view.container).value).toBe("draft-secret");
      await act(async () => {
        buttons(view.container, "Save")[0]?.click();
      });
      expect(models.connect.mock.calls[0]?.[0]).toMatchObject({
        baseUrl: alias,
        modelId: "model-a",
        enabledModelIds: ["model-c"],
        apiKey: "draft-secret",
      });
    } finally {
      await view.unmount();
    }
  },
);
