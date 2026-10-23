import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createGroupSettingsSave } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const saveGroupSettings = useMemo(");
const callback = stripTypeScriptTypes(
  source.slice(start, source.indexOf("  const groupSettingsActor", start)),
);
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
function fixture() {
  const owner = { key: "user-a/session-a" };
  const binding = {
    group,
    owner,
    userId: "user-a",
    spaceId: "space-a",
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
