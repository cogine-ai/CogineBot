// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backupApi = vi.hoisted(() => ({
  me: vi.fn(),
  backups: vi.fn(),
  setBackups: vi.fn(),
  selectedSpaceId: vi.fn(() => "space-a"),
  spaceGeneration: 0,
  translate: (parts: TemplateStringsArray, ...values: string[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));

vi.mock("../lib/rpc", () => ({
  rpc: {
    me: backupApi.me,
    models: { backups: backupApi.backups, setBackups: backupApi.setBackups },
  },
  selectedSpaceId: backupApi.selectedSpaceId,
  currentSpaceSelectionGeneration: () => backupApi.spaceGeneration,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: backupApi.translate }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />;
  return {
    Button,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  };
});

import { ModelBackupsSettings } from "./ModelBackupsSettings";

const scope = { userId: "user-a", spaceId: "space-a" };
const catalog = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet",
    label: "Claude Sonnet",
    billing: "",
  },
  {
    provider: "openai",
    providerName: "OpenAI",
    id: "gpt-test",
    label: "GPT test",
    billing: "",
  },
];
const credentials = [
  {
    id: "anthropic-credential",
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
    connectionRevision: 1,
  },
  {
    id: "openai-credential",
    provider: "openai",
    label: "OpenAI",
    hasKey: true,
    isDefault: false,
    connectionRevision: 2,
  },
];

let container: HTMLDivElement;
let root: Root;

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

function backupRows(): string[] {
  return [...container.querySelectorAll('[data-testid^="model-backup-"]')].map(
    (row) => row.children[1]?.firstElementChild?.textContent ?? "",
  );
}

async function clickButton(name: string): Promise<void> {
  await act(async () => button(name).click());
}

async function pickConnectedModel(label: string): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Add connected model"]',
  );
  if (!select) throw new Error("Missing connected model picker");
  const option = [...select.options].find((item) => item.textContent?.trim() === label);
  if (!option) throw new Error(`Missing model option: ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  backupApi.me.mockReset().mockResolvedValue({ userId: scope.userId, spaceId: scope.spaceId });
  backupApi.backups.mockReset().mockResolvedValue([]);
  backupApi.setBackups.mockReset().mockResolvedValue({ ok: true });
  backupApi.selectedSpaceId.mockReturnValue(scope.spaceId);
  backupApi.spaceGeneration = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ModelBackupsSettings", () => {
  it("retries a failed initial load without replacing unseen backups", async () => {
    backupApi.backups
      .mockRejectedValueOnce(new Error("Temporary load failure"))
      .mockResolvedValueOnce([{ provider: "openai", modelId: "gpt-test" }]);
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();
    expect(button("Save backups").disabled).toBe(true);
    await clickButton("Retry");
    await flush();
    expect(backupRows()).toEqual(["OpenAI · GPT test"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(backupApi.backups).toHaveBeenCalledTimes(2);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });

  it("keeps editing disabled after a failed load so an unseen saved list cannot be replaced", async () => {
    backupApi.backups.mockRejectedValueOnce(new Error("Load failed"));
    backupApi.backups.mockResolvedValueOnce([]);
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Load failed");
    expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    expect(button("Add").disabled).toBe(true);
    expect(button("Save backups").disabled).toBe(true);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
    await clickButton("Retry");
    await flush();
    expect(backupApi.backups).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>("select")?.disabled).toBe(false);
    await pickConnectedModel("Anthropic · Claude Sonnet");
    expect(button("Add").disabled).toBe(false);
  });

  it("starts empty and disabled when no backup models are configured", async () => {
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();

    expect(container.textContent).toContain("Add connected models to use them as backups.");
    expect(button("Save backups").disabled).toBe(true);
    expect(backupApi.backups).toHaveBeenCalledTimes(1);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });

  it("adds, removes, and explicitly reorders choices before saving in that order", async () => {
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();

    await pickConnectedModel("Anthropic · Claude Sonnet");
    await clickButton("Add");
    await pickConnectedModel("OpenAI · GPT test");
    await clickButton("Add");
    expect(backupRows()).toEqual(["Anthropic · Claude Sonnet", "OpenAI · GPT test"]);

    await clickButton("Move OpenAI · GPT test up");
    expect(backupRows()).toEqual(["OpenAI · GPT test", "Anthropic · Claude Sonnet"]);
    await clickButton("Remove Anthropic · Claude Sonnet");
    expect(backupRows()).toEqual(["OpenAI · GPT test"]);

    await clickButton("Save backups");
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledWith(
      [
        {
          provider: "openai",
          modelId: "gpt-test",
          modelCredentialId: "openai-credential",
          expectedRevision: 2,
        },
      ],
      { context: { spaceId: scope.spaceId } },
    );
    expect(container.textContent).toContain("Backup models saved.");
    expect(button("Save backups").disabled).toBe(true);
  });

  it("reloads the saved order and leaves disconnected entries removable without substitution", async () => {
    backupApi.backups.mockResolvedValue([
      { provider: "openai", modelId: "gpt-test" },
      { provider: "disconnected-provider", modelId: "old-model" },
    ]);
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();

    expect(backupRows()).toEqual(["OpenAI · GPT test", "disconnected-provider · old-model"]);
    expect(container.textContent).toContain("Not connected");
    await clickButton("Remove disconnected-provider · old-model");
    await clickButton("Save backups");
    await flush();
    expect(backupApi.setBackups).toHaveBeenCalledWith(
      [{ provider: "openai", modelId: "gpt-test" }],
      { context: { spaceId: scope.spaceId } },
    );
  });

  it("keeps the edited order and surfaces a backend duplicate or limit error", async () => {
    backupApi.backups.mockResolvedValue([{ provider: "anthropic", modelId: "claude-sonnet" }]);
    backupApi.setBackups.mockRejectedValue(
      new Error("Backup model choices must be unique (maximum 10)."),
    );
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();
    await pickConnectedModel("OpenAI · GPT test");
    await clickButton("Add");
    await clickButton("Move OpenAI · GPT test up");
    const expected = ["OpenAI · GPT test", "Anthropic · Claude Sonnet"];

    await clickButton("Save backups");
    await flush();

    expect(backupRows()).toEqual(expected);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Backup model choices must be unique (maximum 10).",
    );
    expect(button("Save backups").disabled).toBe(false);
  });

  it("does not let an old-space save overwrite the newly selected space", async () => {
    let resolveOldSpaceMe: ((value: { userId: string; spaceId: string }) => void) | undefined;
    backupApi.me.mockImplementation((options: { context: { spaceId: string } }) => {
      const requestedSpaceId = options.context.spaceId;
      if (requestedSpaceId === "space-a" && backupApi.me.mock.calls.length === 2) {
        return new Promise((resolve) => {
          resolveOldSpaceMe = resolve;
        });
      }
      return Promise.resolve({
        userId: requestedSpaceId === "space-a" ? "user-a" : "user-b",
        spaceId: requestedSpaceId,
      });
    });
    backupApi.backups.mockImplementation(
      (_input: unknown, options: { context: { spaceId: string } }) =>
        Promise.resolve(
          options.context.spaceId === "space-a"
            ? []
            : [{ provider: "openai", modelId: "gpt-test" }],
        ),
    );
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();
    await pickConnectedModel("Anthropic · Claude Sonnet");
    await clickButton("Add");
    await clickButton("Save backups");

    backupApi.selectedSpaceId.mockReturnValue("space-b");
    await act(async () => {
      root.render(
        <ModelBackupsSettings
          userId="user-b"
          spaceId="space-b"
          catalog={catalog}
          credentials={credentials}
        />,
      );
    });
    await flush();
    resolveOldSpaceMe?.({ userId: "user-a", spaceId: "space-a" });
    await flush();

    expect(backupRows()).toEqual(["OpenAI · GPT test"]);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });

  it("keeps add, reorder, and save disabled when the backup list fails to load", async () => {
    backupApi.backups.mockRejectedValue(new Error("Could not load backup models"));
    await act(async () => {
      root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not load backup models",
    );
    expect(container.querySelector('[data-testid="model-backup-1"]')).toBeNull();
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Add connected model"]',
    );
    expect(select?.disabled).toBe(true);
    expect(button("Add").disabled).toBe(true);
    expect(button("Save backups").disabled).toBe(true);

    await pickConnectedModel("Anthropic · Claude Sonnet");
    await clickButton("Add");
    await clickButton("Save backups");
    await flush();

    expect(backupRows()).toEqual([]);
    expect(backupApi.setBackups).not.toHaveBeenCalled();
  });
});

it("keeps the revision captured by a selected backup when credentials refresh", async () => {
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await flush();
  await pickConnectedModel("OpenAI · GPT test");
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
      />,
    );
  });
  await clickButton("Add");
  await clickButton("Save backups");
  await flush();
  expect(backupApi.setBackups).toHaveBeenCalledWith(
    [
      {
        provider: "openai",
        modelId: "gpt-test",
        modelCredentialId: "openai-credential",
        expectedRevision: 2,
      },
    ],
    { context: { spaceId: scope.spaceId } },
  );
});

it("snapshots exact-ID revisions for loaded backups before a reorder or removal", async () => {
  backupApi.backups.mockResolvedValue([
    { provider: "anthropic", modelId: "claude-sonnet", modelCredentialId: "anthropic-credential" },
    { provider: "openai", modelId: "gpt-test", modelCredentialId: "openai-credential" },
  ]);
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await flush();
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
      />,
    );
  });
  await clickButton("Remove Anthropic · Claude Sonnet");
  await clickButton("Save backups");
  await flush();
  expect(backupApi.setBackups).toHaveBeenCalledWith(
    [
      {
        provider: "openai",
        modelId: "gpt-test",
        modelCredentialId: "openai-credential",
        expectedRevision: 2,
      },
    ],
    { context: { spaceId: scope.spaceId } },
  );
});

it("acknowledges this screen's connection save for a pending picker choice", async () => {
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await flush();
  await pickConnectedModel("OpenAI · GPT test");
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
        connectionSave={{
          ...scope,
          spaceGeneration: 0,
          credential: { ...credentials[1]!, connectionRevision: 9 },
        }}
      />,
    );
  });
  await clickButton("Add");
  await clickButton("Save backups");
  expect(backupApi.setBackups).toHaveBeenCalledWith(
    [
      {
        provider: "openai",
        modelId: "gpt-test",
        modelCredentialId: "openai-credential",
        expectedRevision: 9,
      },
    ],
    { context: { spaceId: scope.spaceId } },
  );
  expect(backupApi.backups).toHaveBeenCalledOnce();
});

it("applies an acknowledged save after the initial backup list arrives late", async () => {
  let resolveBackups!: (choices: unknown[]) => void;
  backupApi.backups.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveBackups = resolve;
    }),
  );
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
        connectionSave={{
          ...scope,
          spaceGeneration: 0,
          credential: { ...credentials[1]!, connectionRevision: 9 },
        }}
      />,
    );
    resolveBackups([
      {
        provider: "anthropic",
        modelId: "claude-sonnet",
        modelCredentialId: "anthropic-credential",
      },
      { provider: "openai", modelId: "gpt-test", modelCredentialId: "openai-credential" },
    ]);
  });
  await clickButton("Remove Anthropic · Claude Sonnet");
  await clickButton("Save backups");
  expect(backupApi.setBackups).toHaveBeenCalledWith(
    [
      {
        provider: "openai",
        modelId: "gpt-test",
        modelCredentialId: "openai-credential",
        expectedRevision: 9,
      },
    ],
    { context: { spaceId: scope.spaceId } },
  );
  expect(backupApi.backups).toHaveBeenCalledOnce();
});

it("keeps a dispatched backup write locked while acknowledging a connection save", async () => {
  let rejectSave!: (error: Error) => void;
  backupApi.setBackups.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectSave = reject;
    }),
  );
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await pickConnectedModel("OpenAI · GPT test");
  await clickButton("Add");
  await clickButton("Save backups");
  expect(backupApi.setBackups).toHaveBeenCalledOnce();
  expect(backupApi.setBackups.mock.calls[0]?.[0]).toEqual([
    {
      provider: "openai",
      modelId: "gpt-test",
      modelCredentialId: "openai-credential",
      expectedRevision: 2,
    },
  ]);
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
        connectionSave={{
          ...scope,
          spaceGeneration: 0,
          credential: { ...credentials[1]!, connectionRevision: 9 },
        }}
      />,
    );
  });
  expect(button("Saving…").disabled).toBe(true);
  expect(button("Add").disabled).toBe(true);
  await clickButton("Saving…");
  expect(backupApi.setBackups).toHaveBeenCalledOnce();
  await act(async () => rejectSave(new Error("Model connection changed. Reload and try again.")));
  expect(backupRows()).toEqual(["OpenAI · GPT test"]);
  await clickButton("Save backups");
  expect(backupApi.setBackups.mock.calls[1]?.[0]).toEqual([
    {
      provider: "openai",
      modelId: "gpt-test",
      modelCredentialId: "openai-credential",
      expectedRevision: 9,
    },
  ]);
});

it("retains an unavailable draft tuple without replacing it with another connection", async () => {
  const connection = {
    id: "compatible-a",
    provider: "openai-compatible",
    label: "Server A",
    baseUrl: "https://models-a.example.test/v1",
    hasKey: true,
    isDefault: true,
    modelId: "model-a",
    enabledModelIds: ["model-a", "model-b"],
    connectionRevision: 7,
  };
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={[connection]} />);
  });
  const picker = container.querySelector<HTMLSelectElement>("select")!;
  const pending = [...picker.options].find((option) => option.textContent?.includes("model-b"))!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
      picker,
      pending.value,
    );
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await clickButton("Add");
  const savedConnection = { ...connection, connectionRevision: 9, enabledModelIds: ["model-a"] };
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={[
          savedConnection,
          { ...connection, id: "compatible-b", connectionRevision: 11 },
        ]}
        connectionSave={{ ...scope, spaceGeneration: 0, credential: savedConnection }}
      />,
    );
  });
  expect(container.textContent).toContain("Not connected");
  backupApi.setBackups.mockRejectedValueOnce(
    new Error("Model connection changed. Reload and try again."),
  );
  await clickButton("Save backups");
  expect(backupApi.setBackups.mock.calls[0]?.[0]).toEqual([
    {
      provider: "openai-compatible",
      modelId: "model-b",
      modelCredentialId: "compatible-a",
      expectedRevision: 7,
    },
  ]);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Model connection changed. Reload and try again.",
  );
  expect(container.querySelector('[data-testid="model-backup-1"]')).not.toBeNull();
});

it("does not replay an earlier own-save receipt after the settings owner changes", async () => {
  backupApi.me.mockImplementation((options: { context: { spaceId: string } }) =>
    Promise.resolve({
      userId: options.context.spaceId === "space-a" ? "user-a" : "user-b",
      spaceId: options.context.spaceId,
    }),
  );
  backupApi.backups.mockResolvedValue([
    { provider: "anthropic", modelId: "claude-sonnet", modelCredentialId: "anthropic-credential" },
    { provider: "openai", modelId: "gpt-test", modelCredentialId: "openai-credential" },
  ]);
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  const connectionSave = {
    ...scope,
    spaceGeneration: 0,
    credential: { ...credentials[1]!, connectionRevision: 9 },
  };
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials}
        connectionSave={connectionSave}
      />,
    );
  });
  backupApi.selectedSpaceId.mockReturnValue("space-b");
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        userId="user-b"
        spaceId="space-b"
        catalog={catalog}
        credentials={credentials}
        connectionSave={connectionSave}
      />,
    );
  });
  backupApi.selectedSpaceId.mockReturnValue("space-a");
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials}
        connectionSave={connectionSave}
      />,
    );
  });
  await clickButton("Remove Anthropic · Claude Sonnet");
  await clickButton("Save backups");
  expect(backupApi.setBackups).toHaveBeenCalledWith(
    [
      {
        provider: "openai",
        modelId: "gpt-test",
        modelCredentialId: "openai-credential",
        expectedRevision: 2,
      },
    ],
    { context: { spaceId: scope.spaceId } },
  );
});

it("keeps a newer revision accepted by an explicit backup retry", async () => {
  backupApi.backups
    .mockRejectedValueOnce(new Error("Temporary load failure"))
    .mockResolvedValueOnce([
      {
        provider: "anthropic",
        modelId: "claude-sonnet",
        modelCredentialId: "anthropic-credential",
      },
      { provider: "openai", modelId: "gpt-test", modelCredentialId: "openai-credential" },
    ]);
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  const connectionSave = {
    ...scope,
    spaceGeneration: 0,
    credential: { ...credentials[1]!, connectionRevision: 8 },
  };
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 8 }))}
        connectionSave={connectionSave}
      />,
    );
  });
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
        connectionSave={connectionSave}
      />,
    );
  });
  await clickButton("Retry");
  await clickButton("Remove Anthropic · Claude Sonnet");
  await clickButton("Save backups");
  expect(backupApi.setBackups.mock.calls[0]?.[0]).toEqual([
    {
      provider: "openai",
      modelId: "gpt-test",
      modelCredentialId: "openai-credential",
      expectedRevision: 9,
    },
  ]);
});

it("ignores an own-save receipt from before a same-ID Space reselection", async () => {
  await act(async () => {
    root.render(<ModelBackupsSettings {...scope} catalog={catalog} credentials={credentials} />);
  });
  await pickConnectedModel("OpenAI · GPT test");
  const connectionSave = {
    ...scope,
    spaceGeneration: 0,
    credential: { ...credentials[1]!, connectionRevision: 9 },
  };
  backupApi.spaceGeneration = 2;
  await act(async () => {
    root.render(
      <ModelBackupsSettings
        {...scope}
        catalog={catalog}
        credentials={credentials.map((entry) => ({ ...entry, connectionRevision: 9 }))}
        connectionSave={connectionSave}
      />,
    );
  });
  await clickButton("Add");
  await clickButton("Save backups");
  expect(backupApi.setBackups.mock.calls[0]?.[0]).toEqual([
    {
      provider: "openai",
      modelId: "gpt-test",
      modelCredentialId: "openai-credential",
      expectedRevision: 2,
    },
  ]);
});
