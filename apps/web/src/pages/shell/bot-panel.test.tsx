// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { modelOptionKey } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelScope = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../lib/rpc", () => ({
  currentSpaceSelectionGeneration: () => modelScope.generation,
  rpc: {
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    onCheckedChange,
    checked,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => <button type="button" {...props} onClick={() => onCheckedChange?.(!checked)} />,
  Toggle: ({
    onPressedChange,
    pressed,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      onClick={() => onPressedChange?.(!pressed)}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));

import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const longInstructions = "I".repeat(4_000);

function bot(description = "Billing"): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Ada",
    title: "Helper",
    description,
    instructions: longInstructions,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]) => undefined,
);

async function render(description = "Billing", memoryProviderConfigured = false) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={bot(description)}
        memoryProviderConfigured={memoryProviderConfigured}
        onSkillsChange={() => undefined}
        onSave={onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
}

function descriptionField(): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save" || button.textContent === "Save other settings",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("Missing Save button");
  return found;
}

async function setDescription(value: string) {
  const textarea = descriptionField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSave() {
  const before = onSave.mock.calls.length;
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (onSave.mock.calls.length === before) throw new Error("save did not run");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  modelScope.generation = 0;
  vi.mocked(rpc.voice.voices).mockReset().mockResolvedValue([]);
  vi.mocked(rpc.models.credentials).mockReset().mockResolvedValue([]);
  vi.mocked(rpc.models.list).mockReset().mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BotSettings model choices", () => {
  it("submits DeepSeek API ids and does not offer a display label", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "cred-deepseek",
        provider: "deepseek",
        label: "DeepSeek",
        hasKey: true,
        isDefault: true,
        modelId: "DeepSeek-V4.1-Flash",
      },
    ]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        billing: "",
      },
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        billing: "",
      },
    ]);
    await render();
    await act(async () => {
      await Promise.resolve();
    });
    const model = container.querySelector("select");
    if (!(model instanceof HTMLSelectElement)) throw new Error("Missing model select");
    const values = [...model.options].map((option) => option.value);
    expect(values).toContain(modelOptionKey("deepseek", "deepseek-flash", "cred-deepseek"));
    expect(values).toContain(modelOptionKey("deepseek", "deepseek-v4-pro", "cred-deepseek"));
    expect(values).not.toContain("deepseek::DeepSeek-V4.1-Flash");
    expect(values.some((value) => value.includes("DeepSeek"))).toBe(false);
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
      instructions: "Invoices",
    });

    // The parent still passes the description from when the panel opened.
    await render();
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    await render();
    await setDescription("Billing");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
      instructions: "Billing",
    });
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await clickSave();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
      instructions: "Invoices",
    });
  });
});

describe("BotSettings connection identity", () => {
  it("pins the selected endpoint and captured revision when model IDs overlap", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "connection-a",
        provider: "openai-compatible",
        label: "Server",
        hasKey: true,
        isDefault: true,
        modelId: "shared-model",
        enabledModelIds: ["shared-model", "second-model"],
        baseUrl: "https://one.example.test/v1",
        connectionRevision: 3,
      },
      {
        id: "connection-b",
        provider: "openai-compatible",
        label: "Server",
        hasKey: true,
        isDefault: false,
        modelId: "shared-model",
        enabledModelIds: ["shared-model", "second-model"],
        baseUrl: "https://two.example.test/v1",
        connectionRevision: 8,
      },
    ]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([]);
    await render();
    const model = container.querySelector("select");
    if (!model) throw new Error("Missing model picker");
    const key = modelOptionKey("openai-compatible", "second-model", "connection-b");
    expect([...model.options].map((option) => option.value)).toContain(key);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(model, key);
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      modelProvider: "openai-compatible",
      modelId: "second-model",
      modelCredentialId: "connection-b",
      expectedRevision: 8,
    });
    onSave.mockRejectedValueOnce(new Error("Connection changed. Select it again."));
    await clickSave();
    expect(model.value).toBe(key);
    expect(container.textContent).toContain("Connection changed. Select it again.");
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      modelCredentialId: "connection-b",
      expectedRevision: 8,
    });
  });
});

function pinnedCredential(id: string, revision: number) {
  return {
    id,
    provider: "openai-compatible",
    label: "Server",
    hasKey: true,
    isDefault: true,
    modelId: "shared-model",
    enabledModelIds: ["shared-model"],
    baseUrl: "https://models.example.test/v1",
    connectionRevision: revision,
  };
}
async function chooseModel(key: string) {
  const model = container.querySelector("select");
  if (!model) throw new Error("Missing model picker");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(model, key);
    model.dispatchEvent(new Event("change", { bubbles: true }));
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

it("refreshes a conflicted connection and requires explicit acceptance before retrying the preserved draft", async () => {
  vi.mocked(rpc.models.credentials)
    .mockResolvedValueOnce([pinnedCredential("connection-a", 7)])
    .mockResolvedValueOnce([pinnedCredential("connection-a", 9)]);
  onSave.mockRejectedValueOnce(
    Object.assign(new Error("Model connection changed. Reload and try again."), {
      code: "CONFLICT",
    }),
  );
  await render();
  const key = modelOptionKey("openai-compatible", "shared-model", "connection-a");
  await chooseModel(key);
  await setDescription("Preserve these instructions");
  await clickSave();
  expect(rpc.models.credentials).toHaveBeenCalledTimes(2);
  expect(container.querySelector("select")?.value).toBe(key);
  expect(descriptionField().value).toBe("Preserve these instructions");
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(saveButton().disabled).toBe(false);
  expect(saveButton().textContent).toBe("Save other settings");
  const accept = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Use updated connection",
  );
  expect(accept).toBeDefined();
  await act(async () => accept?.click());
  await clickSave();
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({
    description: "Preserve these instructions",
    modelCredentialId: "connection-a",
    expectedRevision: 9,
  });
});

it.each([false, true])(
  "saves unrelated fields without rebinding a conflicted model (refresh fails: %s)",
  async (refreshFails) => {
    const credentials = vi
      .mocked(rpc.models.credentials)
      .mockResolvedValueOnce([pinnedCredential("connection-a", 7)]);
    if (refreshFails) credentials.mockRejectedValueOnce(new Error("Offline"));
    else credentials.mockResolvedValueOnce([pinnedCredential("connection-a", 9)]);
    onSave.mockRejectedValueOnce(
      Object.assign(new Error("Connection changed"), { code: "CONFLICT" }),
    );
    await render();
    const key = modelOptionKey("openai-compatible", "shared-model", "connection-a");
    await chooseModel(key);
    await clickSave();

    const name = container.querySelector<HTMLInputElement>('input[id$="-name"]');
    if (!name) throw new Error("Missing name field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        name,
        "Renamed during conflict",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => name.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ name: "Renamed during conflict" });

    const tool = container.querySelector<HTMLInputElement>('input[id$="-disabled-tools"]');
    if (!tool) throw new Error("Missing disabled tools field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        tool,
        "web_search",
      );
      tool.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      tool.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(onSave.mock.calls[2]?.[0]).toMatchObject({ disabledBuiltinTools: ["web_search"] });
    for (const [patch] of onSave.mock.calls.slice(1)) {
      for (const field of [
        "modelProvider",
        "modelId",
        "modelCredentialId",
        "expectedRevision",
        "thinkingLevel",
      ])
        expect(patch).not.toHaveProperty(field);
    }
    expect(container.querySelector("select")?.value).toBe(key);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Save other settings");

    if (refreshFails) {
      credentials.mockResolvedValueOnce([pinnedCredential("connection-a", 9)]);
      const retry = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
    }
    const accept = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Use updated connection",
    );
    expect(accept).toBeDefined();
    await act(async () => accept?.click());
    await clickSave();
    expect(onSave.mock.calls[3]?.[0]).toMatchObject({
      modelCredentialId: "connection-a",
      expectedRevision: 9,
      name: "Renamed during conflict",
    });
  },
);

it.each(["failed", "ready", "refreshing"] as const)(
  "manually saves other settings while a model conflict is %s without adopting its draft",
  async (refreshState) => {
    const refreshed = deferred<Array<ReturnType<typeof pinnedCredential>>>();
    const credentials = vi
      .mocked(rpc.models.credentials)
      .mockResolvedValueOnce([pinnedCredential("connection-a", 7)]);
    if (refreshState === "ready") {
      credentials.mockResolvedValueOnce([pinnedCredential("connection-a", 9)]);
    } else {
      credentials.mockRejectedValueOnce(new Error("Offline"));
      credentials.mockImplementationOnce(() => refreshed.promise);
    }
    vi.mocked(rpc.voice.voices).mockResolvedValueOnce([{ id: "voice-b", label: "Second voice" }]);
    onSave.mockRejectedValueOnce(
      Object.assign(new Error("Connection changed"), { code: "CONFLICT" }),
    );
    await render("Billing", true);
    const key = modelOptionKey("openai-compatible", "shared-model", "connection-a");
    await chooseModel(key);
    await clickSave();
    if (refreshState === "refreshing") {
      const retry = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
    }

    const option = (label: string) => {
      const entry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      );
      if (!entry) throw new Error(`Missing option ${label}`);
      return entry;
    };
    await act(async () => option("Private").click());
    await act(async () => option("Isolated").click());
    const autoSpeak = container.querySelector<HTMLButtonElement>('button[id$="-auto-speak"]');
    if (!autoSpeak) throw new Error("Missing read-aloud control");
    await act(async () => autoSpeak.click());
    const voice = container.querySelector<HTMLSelectElement>('select[id$="-voice"]');
    if (!voice) throw new Error("Missing voice picker");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        voice,
        "voice-b",
      );
      voice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Save other settings");
    const saved = deferred<undefined>();
    onSave.mockImplementationOnce(() => saved.promise);
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      computerMode: "dedicated",
      memoryScope: "isolated",
      autoSpeak: true,
      voiceId: "voice-b",
    });
    for (const field of [
      "modelProvider",
      "modelId",
      "modelCredentialId",
      "expectedRevision",
      "thinkingLevel",
    ])
      expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty(field);
    expect(saveButton().disabled).toBe(true);
    expect(container.querySelector("select")?.value).toBe(key);
    await act(async () => saved.resolve(undefined));
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe("Save other settings");
    expect(container.querySelector("select")?.value).toBe(key);

    if (refreshState === "failed") {
      const retry = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
    }
    if (refreshState !== "ready") {
      await act(async () => refreshed.resolve([pinnedCredential("connection-a", 9)]));
    }
    const accept = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Use updated connection",
    );
    expect(accept).toBeDefined();
    await act(async () => accept?.click());
    expect(saveButton().textContent).toBe("Save");
    await clickSave();
    expect(onSave.mock.calls[2]?.[0]).toMatchObject({
      modelCredentialId: "connection-a",
      expectedRevision: 9,
      computerMode: "dedicated",
      memoryScope: "isolated",
      autoSpeak: true,
      voiceId: "voice-b",
    });
  },
);

it("does not replace a newer model draft or its revision when an older save conflicts and refreshes late", async () => {
  const initial = [pinnedCredential("connection-a", 7), pinnedCredential("connection-b", 4)];
  const refresh = deferred<typeof initial>();
  const saving = deferred<undefined>();
  vi.mocked(rpc.models.credentials)
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(() => refresh.promise);
  onSave.mockImplementationOnce(() => saving.promise);
  await render();
  await chooseModel(modelOptionKey("openai-compatible", "shared-model", "connection-a"));
  await clickSave();
  const newerKey = modelOptionKey("openai-compatible", "shared-model", "connection-b");
  await chooseModel(newerKey);
  await setDescription("Newer draft");
  await act(async () => {
    saving.reject(Object.assign(new Error("Connection changed"), { code: "CONFLICT" }));
    await Promise.resolve();
  });
  expect(rpc.models.credentials).toHaveBeenCalledTimes(2);
  await act(async () => {
    refresh.resolve(initial.map((entry) => ({ ...entry, connectionRevision: 9 })));
    await refresh.promise;
  });
  expect(container.querySelector("select")?.value).toBe(newerKey);
  expect(descriptionField().value).toBe("Newer draft");
  expect(container.textContent).not.toContain("Use updated connection");
  await clickSave();
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({
    modelCredentialId: "connection-b",
    expectedRevision: 4,
    description: "Newer draft",
  });
});

it("retries only the connection refresh after a failed conflict reload before accepting its revision", async () => {
  vi.mocked(rpc.models.credentials)
    .mockResolvedValueOnce([pinnedCredential("connection-a", 7)])
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce([pinnedCredential("connection-a", 9)]);
  onSave.mockRejectedValueOnce(
    Object.assign(new Error("Connection changed"), { code: "CONFLICT" }),
  );
  await render();
  const key = modelOptionKey("openai-compatible", "shared-model", "connection-a");
  await chooseModel(key);
  await setDescription("Keep while offline");
  await clickSave();
  expect(saveButton().disabled).toBe(false);
  expect(saveButton().textContent).toBe("Save other settings");
  const retry = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(rpc.models.credentials).toHaveBeenCalledTimes(3);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(descriptionField().value).toBe("Keep while offline");
  expect(container.querySelector("select")?.value).toBe(key);
  const accept = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Use updated connection",
  );
  expect(accept).toBeDefined();
  await act(async () => accept?.click());
  await clickSave();
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({
    modelCredentialId: "connection-a",
    expectedRevision: 9,
  });
});

it("ignores a conflict refresh after the Space epoch changes and returns", async () => {
  const refresh = deferred<Array<ReturnType<typeof pinnedCredential>>>();
  vi.mocked(rpc.models.credentials)
    .mockResolvedValueOnce([pinnedCredential("connection-a", 7)])
    .mockImplementationOnce(() => refresh.promise);
  onSave.mockRejectedValueOnce(
    Object.assign(new Error("Connection changed"), { code: "CONFLICT" }),
  );
  await render();
  const key = modelOptionKey("openai-compatible", "shared-model", "connection-a");
  await chooseModel(key);
  await clickSave();
  modelScope.generation += 2;
  await setDescription("Newer instructions");
  await act(async () => {
    refresh.resolve([pinnedCredential("connection-b", 9)]);
    await refresh.promise;
  });
  expect(descriptionField().value).toBe("Newer instructions");
  expect(container.querySelector("select")?.value).toBe(key);
  expect(
    [...container.querySelectorAll("option")].some((entry) => entry.value.includes("connection-b")),
  ).toBe(false);
  expect(container.textContent).not.toContain("Use updated connection");
  expect(onSave).toHaveBeenCalledTimes(1);
});
