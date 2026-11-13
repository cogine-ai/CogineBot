// @vitest-environment jsdom
import type { AgentSkill, MemoryDocument } from "@rakazo/contracts";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  request: vi.fn(),
  alert: vi.fn(),
  share: vi.fn(),
  current: true,
  generation: 1,
  focusCleanup: undefined as (() => void) | undefined,
  listeners: new Set<() => void>(),
}));
vi.mock("./mobile-scoped-client", () => ({
  mobileScopedClient: async (_scope: unknown, isMounted: () => boolean) => {
    const generation = api.generation;
    return {
      isCurrent: () => isMounted() && api.current && generation === api.generation,
      request: (procedure: string, input: unknown) => api.request(procedure, input),
    };
  },
}));
vi.mock("./bot-package-file", () => ({
  shareMemoryMarkdown: api.share,
  BotPackageFileError: class extends Error {},
}));
vi.mock("./mobile-scope", () => ({
  captureMobileScope: () => ({
    apiBase: "https://api.example.test",
    apiGeneration: 1,
    sessionGeneration: 1,
    spaceId: "space-a",
    spaceGeneration: api.generation,
    selectionSeq: api.generation,
  }),
  mobileScopeKey: () => `scope-${api.generation}`,
  subscribeMobileScope: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: EffectCallback) =>
    useEffect(() => {
      const cleanup = callback();
      api.focusCleanup = typeof cleanup === "function" ? cleanup : undefined;
      return cleanup;
    }, [callback]),
}));
vi.mock("react-native", () => ({
  Alert: { alert: api.alert },
  Pressable: ({
    children,
    accessibilityState,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityState?: { expanded: boolean };
    onPress(): void;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-expanded": accessibilityState?.expanded, onClick: onPress },
      children,
    ),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement("div", { "data-testid": testID }, children),
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("div", { role: accessibilityRole }, children),
  TextInput: ({
    value,
    editable,
    onChangeText,
    accessibilityLabel,
    multiline,
  }: {
    value: string;
    editable?: boolean;
    onChangeText(value: string): void;
    accessibilityLabel?: string;
    multiline?: boolean;
  }) =>
    createElement(multiline ? "textarea" : "input", {
      value,
      disabled: editable === false,
      "aria-label": accessibilityLabel,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    busy,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    busy?: boolean;
    onPress(): void;
  }) =>
    createElement(
      "button",
      { type: "button", disabled: disabled || busy, onClick: onPress },
      label,
    ),
}));
vi.mock("./native", () => ({ native: {} }));

import { NativeKnowledgeTools } from "../components/knowledge-tools";
import { activateUiLocale } from "./i18n";

const memory: MemoryDocument = {
  id: "doc-a",
  scope: "bot",
  botId: "bot-a",
  path: "MEMORY.md",
  content: "Saved memory",
  revision: 1,
  updatedAt: "",
};
const skill: AgentSkill = {
  id: "skill-a",
  name: "recipe",
  description: "Synthetic",
  content: "Saved skill",
  source: "user",
  readOnly: false,
  createdAt: "",
  updatedAt: "",
};
let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  activateUiLocale("en");
  api.current = true;
  api.generation = 1;
  api.listeners.clear();
  api.share.mockResolvedValue(undefined);
  api.request.mockImplementation(async (procedure, input) => {
    if (procedure === "memory/list")
      return [{ ...memory, scope: input.scope, botId: input.botId ?? null }];
    if (procedure === "memory/update") return { ...memory, content: input.content, revision: 2 };
    if (procedure === "agentSkills/list")
      return [
        skill,
        { ...skill, id: "builtin", name: "Builtin", readOnly: true, source: "builtin" },
      ];
    if (procedure === "agentSkills/get")
      return input.skillId === "builtin"
        ? { ...skill, id: "builtin", name: "Builtin", readOnly: true, source: "builtin" }
        : skill;
    if (procedure === "agentSkills/create" || procedure === "agentSkills/update")
      return { ...skill, content: input.content };
    if (procedure === "agentSkills/remove") return { ok: true };
    throw new Error("Unexpected procedure");
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  activateUiLocale("en");
});
function button(label: string) {
  return [...node.querySelectorAll("button")].find((b) => b.textContent === label);
}
async function click(label: string) {
  expect(button(label)).toBeDefined();
  await act(async () => button(label)!.click());
}
async function mount(botId = "bot-a") {
  await act(async () => root.render(<NativeKnowledgeTools botId={botId} />));
}
async function fill(value: string) {
  await act(async () => {
    const input = node.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits memory, cancels a draft and shares only saved readback", async () => {
  await mount();
  await click("Bot memory");
  await click("MEMORY.md");
  await fill("Unsaved");
  await click("Export Markdown");
  expect(api.share).toHaveBeenCalledWith("# MEMORY.md\n\nSaved memory", expect.any(Function));
  await click("Cancel");
  await click("MEMORY.md");
  expect(node.querySelector("textarea")!.value).toBe("Saved memory");
  await fill("New saved memory");
  await click("Save");
  expect(api.request).toHaveBeenCalledWith("memory/update", {
    documentId: "doc-a",
    content: "New saved memory",
  });
  await click("MEMORY.md");
  expect(node.querySelector("textarea")!.value).toBe("New saved memory");
});
it("retains a failed draft and keeps export separate", async () => {
  await mount();
  await click("Bot memory");
  await click("MEMORY.md");
  await fill("Unsaved");
  api.request.mockRejectedValueOnce(new Error("Offline"));
  await click("Save");
  expect(node.textContent).toContain("Could not save");
  expect(node.querySelector("textarea")!.value).toBe("Unsaved");
  await click("Export Markdown");
  expect(api.share.mock.calls[0]?.[0]).toBe("# MEMORY.md\n\nSaved memory");
  expect(node.textContent).toContain("Could not save");
  expect(node.querySelector("textarea")!.value).toBe("Unsaved");
});
it("lists and edits shared skills, confirms deletion, and keeps builtins read only", async () => {
  await mount();
  await click("Shared skills");
  await click("Builtin");
  expect(node.querySelector("textarea")!.disabled).toBe(true);
  expect(button("Save")).toBeUndefined();
  expect(button("Delete")).toBeUndefined();
  await click("Close");
  await click("New skill");
  await fill("New skill content");
  await click("Save");
  expect(api.request).toHaveBeenCalledWith("agentSkills/create", {
    content: "New skill content",
    clientNonce: expect.any(String),
  });
  await click("recipe");
  await fill("Updated skill content");
  await click("Save");
  expect(api.request).toHaveBeenCalledWith("agentSkills/update", {
    skillId: "skill-a",
    content: "Updated skill content",
  });
  await click("recipe");
  await click("Delete");
  expect(api.request.mock.calls.filter(([p]) => p === "agentSkills/remove")).toHaveLength(0);
  const actions = api.alert.mock.calls[0]![2];
  await act(async () => actions[1].onPress());
  expect(api.request).toHaveBeenCalledWith("agentSkills/remove", { skillId: "skill-a" });
});
it("drops a native delete confirmation after switching sections", async () => {
  await mount();
  await click("Shared skills");
  await click("recipe");
  await click("Delete");
  const confirm = api.alert.mock.calls[0]![2][1].onPress;
  await click("Shared documents");
  await act(async () => confirm());
  expect(api.request.mock.calls.filter(([p]) => p === "agentSkills/remove")).toHaveLength(0);
  expect(api.request).toHaveBeenCalledWith("memory/list", { scope: "user" });
});
it("ignores a late Bot response and clears old content on Space/account changes", async () => {
  await mount();
  let resolve!: (value: MemoryDocument[]) => void;
  api.request.mockReturnValueOnce(
    new Promise<MemoryDocument[]>((done) => {
      resolve = done;
    }),
  );
  await click("Bot memory");
  await mount("bot-b");
  await click("Bot memory");
  await act(async () => resolve([{ ...memory, path: "Old bot data" }]));
  expect(node.textContent).not.toContain("Old bot data");
  expect(api.request).toHaveBeenCalledWith("memory/list", { scope: "bot", botId: "bot-b" });
  await click("MEMORY.md");
  await fill("Old private draft");
  await act(async () => {
    api.generation += 1;
    for (const notify of api.listeners) notify();
  });
  expect(node.querySelector("textarea")).toBeNull();
  expect(node.textContent).not.toContain("Old private draft");
});
it("invalidates sharing and editor contents when the screen loses focus", async () => {
  await mount();
  await click("Bot memory");
  await click("Export Markdown");
  const valid = api.share.mock.calls[0]![1];
  expect(valid()).toBe(true);
  await act(async () => api.focusCleanup?.());
  expect(valid()).toBe(false);
  expect(button("Export Markdown")).toBeUndefined();
});
it.each(["zh-CN", "de", "ru"] as const)(
  "translates static and dynamic skill text in %s",
  async (locale) => {
    activateUiLocale(locale);
    await mount();
    const labels = {
      "zh-CN": ["共享技能", "新建技能", "此技能的用途及使用时机。"],
      de: [
        "Geteilte Skills",
        "Neuer Skill",
        "Was dieser Skill tut und wann er verwendet werden soll.",
      ],
      ru: ["Общие навыки", "Новый навык", "Что делает этот навык и когда его использовать."],
    }[locale];
    await click(labels[0]!);
    await click(labels[1]!);
    expect(node.querySelector("textarea")!.value).toContain(labels[2]);
    expect(node.textContent).not.toContain("New skill");
  },
);

it("invalidates a deletion confirmation even when the same skill is reopened", async () => {
  await mount();
  await click("Shared skills");
  await click("recipe");
  await click("Delete");
  const confirm = api.alert.mock.calls[0]![2][1].onPress;
  await click("Cancel");
  await click("recipe");
  await act(async () => confirm());
  expect(api.request.mock.calls.filter(([p]) => p === "agentSkills/remove")).toHaveLength(0);
});

it("does not show cached memory when reopening an uncertain save cannot be verified", async () => {
  await mount();
  await click("Bot memory");
  await click("MEMORY.md");
  await fill("Unknown save result");
  api.request.mockRejectedValueOnce(new Error("Lost update response"));
  await click("Save");
  await click("Cancel");
  api.request.mockRejectedValueOnce(new Error("Readback unavailable"));
  await click("MEMORY.md");
  expect(node.querySelector("textarea")).toBeNull();
  expect(node.textContent).toContain("Could not load");
  api.request.mockResolvedValueOnce([{ ...memory, content: "Actually committed" }]);
  await click("MEMORY.md");
  expect(node.querySelector("textarea")!.value).toBe("Actually committed");
});
