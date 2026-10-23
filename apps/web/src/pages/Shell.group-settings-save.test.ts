// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot, Group } from "@rakazo/contracts";
import { createGroupSettingsSave } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: (props: ComponentProps<"button">) =>
    createElement("button", { type: "button", ...props }),
  Input: (props: ComponentProps<"input">) => createElement("input", props),
}));
vi.mock("./shell/dialogs", () => ({ DeleteItemDialog: () => null }));

import { GroupSettings } from "./GroupPanel";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Shell.tsx"), "utf8");
const start = source.indexOf("  const saveGroupSettings = useMemo(");
const callback = stripTypeScriptTypes(
  source.slice(start, source.indexOf("  const groupSettingsActor", start)),
);
const groupPanelStart = source.indexOf("              <GroupSettings");
const onSaveStart = source.indexOf("onSave={", groupPanelStart) + "onSave={".length;
const onSaveCallback = stripTypeScriptTypes(
  source.slice(onSaveStart, source.indexOf("onRemove={", onSaveStart)).trim().slice(0, -1),
);
function groupPanelSave(saveGroupSettings: ReturnType<typeof fixture>["save"] | null) {
  return new Function("saveGroupSettings", `return (${onSaveCallback});`)(
    saveGroupSettings,
  ) as (input: { name?: string; botIds?: string[]; expectedBotIds?: string[] }) => Promise<void>;
}
const group = {
  id: "group-a",
  spaceId: "space-a",
  name: "Team",
  updatedAt: "2026-10-23T00:00:00Z",
  members: [{ botId: "a" }, { botId: "b" }],
};
const updated = {
  ...group,
  members: [...group.members, { botId: "c" }],
  updatedAt: "2026-10-23T01:00:00Z",
};
const input = { botIds: ["a", "b", "c"], expectedBotIds: ["a", "b"] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(missingSpace = false) {
  const owner = { key: "user-a/session-a" };
  const binding = {
    group,
    owner,
    userId: "user-a",
    spaceId: missingSpace ? undefined : "space-a",
    originId: "space-a",
    generation: 0,
  };
  const state = { spaceId: "space-a", generation: 0 };
  const committedGroupEditor = { current: binding as unknown };
  const committedSettingsOwner = { current: owner };
  const groupSettingsActor = { current: { userId: "user-a", spaceId: "space-a" } };
  const pending = deferred<typeof updated>();
  const update = vi.fn((..._args: unknown[]) => pending.promise);
  const read = vi.fn(async (..._args: unknown[]) => {
    throw new Error("Read unavailable");
  });
  const publish = vi.fn();
  const scope = {
    groupEditorBinding: binding,
    committedGroupEditor,
    committedSettingsOwner,
    groupSettingsActor,
    selectedSpaceId: () => state.spaceId,
    currentSpaceSelectionGeneration: () => state.generation,
    createGroupSettingsSave,
    useMemo: (fn: () => unknown) => fn(),
    applySavedGroupUpdate: publish,
    createSpaceRpc: (spaceId: string, current: () => boolean) => ({
      groups: {
        update: (...args: unknown[]) => {
          if (!current()) throw new DOMException("Closed", "AbortError");
          expect(spaceId).toBe("space-a");
          return update(...args);
        },
        get: (...args: unknown[]) => {
          if (!current()) throw new DOMException("Closed", "AbortError");
          return read(...args);
        },
      },
    }),
  };
  const save = new Function(...Object.keys(scope), `${callback}\nreturn saveGroupSettings;`)(
    ...Object.values(scope),
  ) as {
    save: (draft: typeof input) => Promise<typeof updated>;
    publish: (group: typeof updated) => void;
  };
  return {
    state,
    owner,
    binding,
    committedGroupEditor,
    committedSettingsOwner,
    groupSettingsActor,
    pending,
    update,
    read,
    publish,
    save,
  };
}

describe("Shell group save publication", () => {
  it("rejects the panel save when bootstrap has not supplied its Space context", async () => {
    const h = fixture(true);
    expect(h.save).toBeNull();
    await expect(groupPanelSave(h.save)(input)).rejects.toThrow("GROUP_SETTINGS_UNAVAILABLE");
    expect(h.update).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });
  it("does not borrow a newly available helper for an earlier contextless callback", async () => {
    const retained = groupPanelSave(null);
    const h = fixture();
    await expect(retained(input)).rejects.toThrow("GROUP_SETTINGS_UNAVAILABLE");
    expect(h.update).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    const current = groupPanelSave(h.save)(input);
    h.pending.resolve(updated);
    await expect(current).resolves.toBeUndefined();
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ groupId: "group-a", ...input });
    expect(h.publish).toHaveBeenCalledOnce();
  });
  it("keeps a contextless panel's edited name and membership after Save fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    const bots = ["a", "b", "c"].map(
      (id) => ({ id, name: `Bot ${id}`, title: "", archivedAt: null }) as Bot,
    );
    const button = (name: string) => {
      const found = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === name,
      );
      if (!found) throw new Error(`Missing ${name} button`);
      return found;
    };
    try {
      await act(async () => {
        root.render(
          createElement(GroupSettings, {
            group: group as Group,
            bots,
            onSave: groupPanelSave(null),
            onRemove: async () => undefined,
            onClose,
          }),
        );
      });
      const name = container.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          name,
          "Unsaved team",
        );
        name.dispatchEvent(new Event("input", { bubbles: true }));
        button("Show all").click();
      });
      await act(async () => button("Bot c").click());
      await act(async () => button("Save").click());
      expect(onClose).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save group");
      expect(name.value).toBe("Unsaved team");
      expect(button("Bot c").getAttribute("aria-pressed")).toBe("true");
      expect(button("Save").disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
  it("publishes its committed roster once after its editor closes without acknowledging that old editor", async () => {
    const h = fixture();
    const result = h.save.save(input);
    h.committedGroupEditor.current = { ...h.binding };
    h.pending.resolve(updated);
    await expect(result).rejects.toThrow("GROUP_SETTINGS_CLOSED");
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(updated, {
      userId: "user-a",
      spaceId: "space-a",
    });
    expect(h.read).not.toHaveBeenCalled();
  });
  it.each(["session", "session-aba", "space", "selection-aba", "actor"])(
    "rejects a response after %s ownership changes",
    async (change) => {
      const h = fixture();
      const result = h.save.save(input);
      if (change === "session") h.committedSettingsOwner.current = { key: "user-a/session-b" };
      if (change === "session-aba") {
        h.committedSettingsOwner.current = { key: "user-a/session-b" };
        h.committedSettingsOwner.current = { key: "user-a/session-a" };
      }
      if (change === "space") h.state.spaceId = "space-b";
      if (change === "selection-aba") h.state.generation += 2;
      if (change === "actor") h.groupSettingsActor.current.userId = "user-b";
      h.pending.resolve(updated);
      await expect(result).rejects.toThrow("GROUP_SETTINGS_CLOSED");
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...updated, id: "other" },
    { ...updated, spaceId: "other" },
  ])("does not publish an unrelated successful response", async (response) => {
    const h = fixture();
    const result = h.save.save(input);
    h.pending.resolve(response);
    await expect(result).rejects.toThrow("INVALID_GROUP_SAVE_RECEIPT");
    expect(h.publish).not.toHaveBeenCalled();
  });
  it("does not publish the same successful response again when the current editor acknowledges it", async () => {
    const h = fixture();
    const result = h.save.save(input);
    h.pending.resolve(updated);
    h.save.publish(await result);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a retained editor after it was replaced", async () => {
    const h = fixture();
    h.committedGroupEditor.current = { ...h.binding };
    await expect(h.save.save(input)).rejects.toThrow("GROUP_SETTINGS_CLOSED");
    expect(h.update).not.toHaveBeenCalled();
  });
});
