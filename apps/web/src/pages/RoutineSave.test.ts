import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import {
  draftFromNativeRoutineTrigger,
  nativeRoutineTriggerInputs,
} from "@rakazo/core/routine-native-events";
import { saveRoutineDraft } from "@rakazo/core/routine-save";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
const start =
  source.indexOf("onSave={async () => {", source.indexOf("<RoutineEditor")) + "onSave={".length;
const callback = stripTypeScriptTypes(
  source.slice(start, source.indexOf("onTestRun={", start)).trim().slice(0, -1),
);
function fixture(operation: string) {
  const calls: any[] = [];
  let original: any;
  let denied = false;
  let blockResolve: any;
  const scope: any = {
    saveRoutineDraft,
    nativeRoutineTriggerInputs,
    panelStorageKey: "scope-a",
    panelStorageKeyRef: { current: "scope-a" },
    routineSaveState: { current: { key: "", state: {} } },
    routineSavePending: { current: false },
    routineSaveRequest: { current: 0 },
    activeBotId: { current: "bot-a" },
    active: { id: "bot-a", webhookConfigured: true },
    editingRoutine:
      operation === "update" ? { id: "routine-a", botId: "bot-a", nativeTriggers: [] } : null,
    routineDraft: {
      mutationId: "intent-a",
      name: "First",
      prompt: "First prompt",
      schedules: [],
      webhookEnabled: true,
      githubEnabled: false,
      messageProvider: null,
      nativeTriggers: [],
      nativeTriggersDirty: false,
      modelKey: "",
      modelDirty: false,
      thinkingLevel: "",
      active: true,
    },
    routineWebhookSecret: null,
    bootstrapMe: { timezone: "UTC" },
    setRoutineError: vi.fn(),
    setSavingRoutine: vi.fn(),
    setEditingRoutine: vi.fn(),
    setRoutineDraft: vi.fn(),
    draftFromRoutine: (x: any) => x,
    cronFromPreset: (x: any) => x,
    localTimezone: () => "UTC",
    routineNeedsOneShotArm: () => false,
    errorText: (e: Error) => e.message,
    t: (x: any) => x[0],
    refreshThread: vi.fn(async () => {}),
    rpc: { routines: {} },
  };
  const receipts = new Map();
  for (const method of ["create", "update"])
    scope.rpc.routines[method] = async (input: any) => {
      calls.push(structuredClone(input));
      if (denied) throw { code: "FORBIDDEN", message: "Permission revoked" };
      if (blockResolve)
        return await new Promise((resolve) => {
          blockResolve = resolve;
        });
      const prior = receipts.get(input.mutationId);
      if (prior) {
        if (JSON.stringify(input) !== JSON.stringify(prior.input)) throw Error("CONFLICT");
        return prior.result;
      }
      const result = { ...input, id: "saved" };
      receipts.set(input.mutationId, { input: structuredClone(input), result });
      if (!original) {
        original = structuredClone(input);
        throw Error("Lost response");
      }
      return result;
    };
  return {
    scope,
    deny: (value: boolean) => {
      denied = value;
    },
    calls,
    run: () =>
      new Function(...Object.keys(scope), `return (${callback})`)(...Object.values(scope))(),
    block: () => {
      blockResolve = true;
    },
    resolve: () => blockResolve({ id: "old-result" }),
  };
}
it.each(["create", "update"])(
  "Web %s recovers the immutable request before saving later edits",
  async (op) => {
    const h = fixture(op);
    await h.run();
    h.scope.routineDraft = { ...h.scope.routineDraft, name: "Later draft", prompt: "Later prompt" };
    await h.run();
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]).toEqual(h.calls[0]);
    expect(h.calls[2]).toMatchObject({
      routineId: "saved",
      name: "Later draft",
      prompt: "Later prompt",
    });
    expect(h.calls[2].mutationId).not.toBe(h.calls[0].mutationId);
    expect(h.calls[2]).not.toHaveProperty("nativeTriggers");
    expect(h.scope.setEditingRoutine).toHaveBeenCalledOnce();
  },
);
it.each(["create", "update"])("independent Web %s unchanged recovery succeeds", async (op) => {
  const h = fixture(op);
  await h.run();
  await h.run();
  expect(h.calls[0]).toEqual(h.calls[1]);
  expect(h.scope.setEditingRoutine).toHaveBeenCalledOnce();
});
it.each(["create", "update"])(
  "independent Web %s late old-bot result does not overwrite new draft",
  async (op) => {
    const h = fixture(op);
    h.block();
    const pending = h.run();
    h.scope.activeBotId.current = "bot-b";
    h.scope.routineSaveRequest.current++;
    h.scope.routineDraft = { ...h.scope.routineDraft, mutationId: "intent-b", name: "Other scope" };
    h.resolve();
    await pending;
    expect(h.scope.setRoutineDraft).not.toHaveBeenCalled();
    expect(h.scope.setEditingRoutine).not.toHaveBeenCalled();
    expect(h.scope.routineDraft.name).toBe("Other scope");
  },
);

it.each(["create", "update"])(
  "Web %s does not resume a later draft across panel scope",
  async (operation) => {
    const h = fixture(operation);
    await h.run();
    h.scope.routineDraft = { ...h.scope.routineDraft, name: "Later draft" };
    h.block();
    const recovery = h.run();
    h.scope.panelStorageKeyRef.current = "scope-b";
    h.resolve();
    await recovery;
    expect(h.calls).toHaveLength(2);
    expect(h.scope.setRoutineDraft).not.toHaveBeenCalled();
    expect(h.scope.setEditingRoutine).not.toHaveBeenCalled();
  },
);

it.each(["create", "update"])(
  "Web %s recovers original input after authorization returns",
  async (operation) => {
    const h = fixture(operation);
    await h.run();
    h.deny(true);
    await h.run();
    h.deny(false);
    h.scope.routineDraft = { ...h.scope.routineDraft, name: "Later", prompt: "Later prompt" };
    await h.run();
    expect(h.calls[2]).toEqual(h.calls[0]);
    expect(h.calls[3]).toMatchObject({ routineId: "saved", name: "Later", prompt: "Later prompt" });
    expect(h.scope.setEditingRoutine).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "Web preserves trigger identities across lost writes (rejected follow-up=%s)",
  async (rejectFollowUp) => {
    const h = fixture("create");
    h.scope.routineDraft.nativeTriggers = ["a", "b", "c"].map((calendarId, index) => ({
      ...draftFromNativeRoutineTrigger({
        id: `key-${index}`,
        version: 1,
        routineId: "saved",
        connectionId: "connection",
        armedAt: "2020-01-01T00:00:00Z",
        spec: { kind: "calendar.event_changed", calendarId, target: { kind: "calendar" } },
      }),
      id: undefined,
      expectedVersion: undefined,
    }));
    h.scope.routineDraft.nativeTriggersDirty = true;
    let saved: any = { id: "saved", nativeTriggers: [] };
    const receipts = new Set();
    const writes: any[] = [];
    let refused = false;
    const send = async (input: any) => {
      if (receipts.has(input.mutationId))
        return { ...saved, nativeTriggers: [...saved.nativeTriggers].reverse() };
      if (rejectFollowUp && writes.length === 2 && !refused) {
        refused = true;
        throw Object.assign(new Error("Synthetic first-dispatch refusal"), { code: "BAD_REQUEST" });
      }
      receipts.add(input.mutationId);
      writes.push(structuredClone(input));
      saved = {
        ...saved,
        ...input,
        nativeTriggers:
          input.nativeTriggers?.map((t: any, i: number) => ({
            ...t,
            id: t.id ?? `saved-${i}`,
            version: t.id
              ? saved.nativeTriggers.find((old: any) => old.id === t.id).version +
                (JSON.stringify(t.spec) !==
                JSON.stringify(saved.nativeTriggers.find((old: any) => old.id === t.id).spec)
                  ? 1
                  : 0)
              : 1,
          })) ?? saved.nativeTriggers,
      };
      if (writes.length <= 2) throw Error("Lost committed response");
      return saved;
    };
    h.scope.rpc.routines = { create: send, update: send };
    await h.run();
    h.scope.routineDraft.name = "Second";
    if (rejectFollowUp) h.scope.routineDraft.nativeTriggers[0].calendarId = "a2";
    await h.run();
    if (!rejectFollowUp) expect(writes[1]).not.toHaveProperty("nativeTriggers");
    const [a, b, c] = h.scope.routineDraft.nativeTriggers;
    h.scope.routineDraft.nativeTriggers = [b, c, { ...a, calendarId: "a-edited" }];
    await h.run();
    if (rejectFollowUp) {
      expect(h.scope.setRoutineError).toHaveBeenLastCalledWith("Synthetic first-dispatch refusal");
      expect(h.scope.routineDraft.nativeTriggers[2].calendarId).toBe("a-edited");
      await h.run();
    }
    expect(writes).toHaveLength(3);
    expect(writes[2].nativeTriggers).toMatchObject([
      { id: "saved-1", spec: { calendarId: "b" } },
      { id: "saved-2", spec: { calendarId: "c" } },
      { id: "saved-0", spec: { calendarId: "a-edited" } },
    ]);
  },
);
