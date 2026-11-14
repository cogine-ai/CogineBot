import type { Routine } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import type { RoutineSaveState } from "./routine-save.js";
import { saveRoutineDraft } from "./routine-save.js";

const baseline = {
  id: "routine",
  name: "Original",
  prompt: "Original prompt",
  nativeTriggers: [],
} as unknown as Routine;
it("recovers both uncertain writes without replaying unrelated fields", async () => {
  const state: RoutineSaveState = {};
  const receipts = new Map<string, Routine>();
  const send = vi.fn(async ({ input }) => {
    const existing = receipts.get(input.mutationId);
    if (existing) return existing;
    receipts.set(input.mutationId, { ...baseline, ...input });
    throw new Error("Response lost");
  });
  const first = {
    operation: "update" as const,
    input: { routineId: "routine", mutationId: "first-intent", name: "First", nativeTriggers: [] },
  };
  await expect(saveRoutineDraft(state, first, baseline, send, () => true)).rejects.toThrow();
  const later = { ...first, input: { ...first.input, name: "Later" } };
  await expect(saveRoutineDraft(state, later, baseline, send, () => true)).rejects.toThrow();
  const saved = await saveRoutineDraft(state, later, baseline, send, () => true);
  expect(saved?.name).toBe("Later");
  expect(receipts.size).toBe(2);
  expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
  expect(send.mock.calls[3]![0]).toEqual(send.mock.calls[2]![0]);
  expect(send.mock.calls[2]![0].input).not.toHaveProperty("nativeTriggers");
});
it("does not dispatch subsequent edits after scope cancellation during recovery", async () => {
  const state: RoutineSaveState = {
    pending: { operation: "create", input: { mutationId: "first", name: "First" } },
  };
  let current = true;
  const send = vi.fn(async () => {
    current = false;
    return baseline;
  });
  expect(
    await saveRoutineDraft(
      state,
      { operation: "create", input: { name: "Later" } },
      null,
      send,
      () => current,
    ),
  ).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "CONFLICT"])(
  "allows corrected drafts after a first-dispatch %s rejection",
  async (code) => {
    const state: RoutineSaveState = {};
    await expect(
      saveRoutineDraft(
        state,
        { operation: "create", input: { name: "First" } },
        null,
        async () => {
          throw { code };
        },
        () => true,
      ),
    ).rejects.toEqual({ code });
    expect(state.pending).toBeUndefined();
  },
);
it("keeps the immutable request and latest draft when recovery itself fails", async () => {
  const state: RoutineSaveState = {
    pending: { operation: "create", input: { mutationId: "first", name: "First" } },
  };
  const desired = { operation: "create" as const, input: { name: "Later" } };
  await expect(
    saveRoutineDraft(
      state,
      desired,
      null,
      async () => {
        throw new Error("Offline");
      },
      () => true,
    ),
  ).rejects.toThrow("Offline");
  expect(state.pending?.input.name).toBe("First");
  expect(desired.input.name).toBe("Later");
});
it("retains the recovered create identity after a rejected follow-up", async () => {
  const state: RoutineSaveState = {
    pending: { operation: "create", input: { mutationId: "original-create", name: "First" } },
  };
  const calls: string[] = [];
  let reject = true;
  const send = vi.fn(async ({ operation, input }) => {
    calls.push(operation);
    if (operation === "create") return { ...baseline, name: "First" };
    if (reject) {
      reject = false;
      throw { code: "BAD_REQUEST" };
    }
    return { ...baseline, ...input };
  });
  await expect(
    saveRoutineDraft(
      state,
      { operation: "create", input: { name: "Invalid" } },
      null,
      send,
      () => true,
    ),
  ).rejects.toEqual({ code: "BAD_REQUEST" });
  expect(
    (
      await saveRoutineDraft(
        state,
        { operation: "create", input: { name: "Corrected" } },
        null,
        send,
        () => true,
      )
    )?.name,
  ).toBe("Corrected");
  expect(calls).toEqual(["create", "update", "create", "update"]);
  expect(send.mock.calls[2]![0].input.mutationId).toBe("original-create");
});
it("resolves a newly created trigger identity before a later trigger edit", async () => {
  const spec = { kind: "calendar.event_changed", calendarId: "calendar-a" };
  const trigger = { connectionId: "connection", spec };
  const row = {
    ...trigger,
    id: "trigger",
    version: 1,
    state: { cursor: "keep" },
    leaseId: "lease",
  };
  const saved = { ...baseline, nativeTriggers: [row] } as unknown as Routine;
  const state: RoutineSaveState = {
    pending: {
      operation: "create",
      input: { mutationId: "first", nativeTriggers: [trigger] },
      triggerKeys: ["draft-a"],
    },
  };
  const send = vi.fn(async (_request: Parameters<typeof saveRoutineDraft>[1]) => saved);
  await saveRoutineDraft(
    state,
    {
      operation: "create",
      input: { nativeTriggers: [{ ...trigger, spec: { ...spec, calendarId: "calendar-b" } }] },
      triggerKeys: ["draft-a"],
    },
    null,
    send,
    () => true,
  );
  expect(send.mock.calls[1]![0].input.nativeTriggers).toEqual([
    {
      id: "trigger",
      expectedVersion: 1,
      connectionId: "connection",
      spec: { ...spec, calendarId: "calendar-b" },
    },
  ]);
  expect(send.mock.calls[1]![0].input.nativeTriggerBaseline).toEqual([
    { id: "trigger", version: 1 },
  ]);
});
it("does not adopt a concurrent trigger version during recovery", async () => {
  const spec = { kind: "calendar.event_changed", calendarId: "calendar-a" };
  const row = { id: "trigger", version: 1, connectionId: "connection", spec };
  const initial = { ...baseline, nativeTriggers: [row] } as unknown as Routine;
  const trigger = { id: row.id, expectedVersion: 1, connectionId: row.connectionId, spec };
  const state: RoutineSaveState = {
    baseline: initial,
    pending: { operation: "update", input: { mutationId: "first", nativeTriggers: [trigger] } },
  };
  const send = vi.fn(
    async (_request: Parameters<typeof saveRoutineDraft>[1]) =>
      ({ ...initial, nativeTriggers: [{ ...row, version: 2 }] }) as unknown as Routine,
  );
  await expect(
    saveRoutineDraft(
      state,
      { operation: "update", input: { nativeTriggers: [] } },
      initial,
      send,
      () => true,
    ),
  ).rejects.toThrow("changed");
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps a deleted recovered result bound to its original create identity", async () => {
  const state: RoutineSaveState = {
    pending: { operation: "create", input: { mutationId: "first", name: "First" } },
  };
  await expect(
    saveRoutineDraft(
      state,
      { operation: "create", input: { name: "Later" } },
      null,
      async () => {
        throw { code: "NOT_FOUND" };
      },
      () => true,
    ),
  ).rejects.toEqual({ code: "NOT_FOUND" });
  expect(state.pending?.input.mutationId).toBe("first");
});
it.each([
  "FORBIDDEN",
  "BAD_REQUEST",
  "CONFLICT",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "INTERNAL_SERVER_ERROR",
])("retains the immutable recovery submission after %s", async (code) => {
  const state: RoutineSaveState = {
    pending: { operation: "create", input: { mutationId: "first", name: "First" } },
  };
  const before = JSON.parse(JSON.stringify(state));
  await expect(
    saveRoutineDraft(
      state,
      { operation: "create", input: { mutationId: "later", name: "Later" } },
      null,
      async () => {
        throw { code };
      },
      () => true,
    ),
  ).rejects.toEqual({ code });
  expect(state).toEqual(before);
});
it("does not replace an uncertain follow-up with the older recovered request after refusal", async () => {
  const state: RoutineSaveState = {
    pending: {
      operation: "update",
      input: { mutationId: "uncertain-update", routineId: "routine", name: "Later" },
    },
    recovered: {
      pending: { operation: "create", input: { mutationId: "original-create", name: "First" } },
    },
  };
  const before = JSON.parse(JSON.stringify(state));
  await expect(
    saveRoutineDraft(
      state,
      { operation: "create", input: { name: "Newest" } },
      null,
      async () => {
        throw { code: "FORBIDDEN" };
      },
      () => true,
    ),
  ).rejects.toEqual({ code: "FORBIDDEN" });
  expect(state).toEqual(before);
});
it("does not restore cancelled trigger edits when a new edit changes only the name", async () => {
  const state: RoutineSaveState = {
    discarded: true,
    baseline,
    pending: {
      operation: "update",
      input: {
        mutationId: "first",
        name: "First",
        nativeTriggers: [{ connectionId: "connection", spec: { kind: "calendar.event_changed" } }],
      },
    },
  };
  const send = vi.fn(async (_request: Parameters<typeof saveRoutineDraft>[1]) => ({
    ...baseline,
    name: "First",
  }));
  await saveRoutineDraft(
    state,
    { operation: "update", input: { routineId: baseline.id, name: "New edit" } },
    baseline,
    send,
    () => true,
  );
  expect(send.mock.calls[1]![0].input).toMatchObject({ name: "New edit" });
  expect(send.mock.calls[1]![0].input).not.toHaveProperty("nativeTriggers");
});

it("uses retained key identities rather than baseline row order after an omitted patch", async () => {
  const rows = ["b", "c", "a"].map((key) => ({
    id: `id-${key}`,
    version: 1,
    connectionId: "connection",
    spec: { kind: "calendar.event_changed", calendarId: key, target: { kind: "calendar" } },
  }));
  const saved = { ...baseline, nativeTriggers: rows } as Routine;
  const state: RoutineSaveState = {
    baseline: saved,
    pending: {
      operation: "update",
      input: { routineId: saved.id, mutationId: "second", name: "Second" },
    },
    triggerIds: { a: "id-a", b: "id-b", c: "id-c" },
    draft: {
      operation: "create",
      input: {
        name: "Second",
        nativeTriggers: [rows[2], rows[0], rows[1]].map((t) => ({
          connectionId: t!.connectionId,
          spec: t!.spec,
        })),
      },
      triggerKeys: ["a", "b", "c"],
    },
  };
  const send = vi.fn(async (_request: Parameters<typeof saveRoutineDraft>[1]) => saved);
  await saveRoutineDraft(
    state,
    {
      operation: "create",
      input: {
        name: "Third",
        nativeTriggers: rows.map((t) => ({
          connectionId: t.connectionId,
          spec: { ...t.spec, calendarId: t.id === "id-a" ? "a-edited" : t.spec.calendarId },
        })),
      },
      triggerKeys: ["b", "c", "a"],
    },
    null,
    send,
    () => true,
  );
  expect(send.mock.calls[1]![0].input.nativeTriggers).toMatchObject([
    { id: "id-b" },
    { id: "id-c" },
    { id: "id-a", spec: { calendarId: "a-edited" } },
  ]);
});

it("refuses ambiguous legacy creation results rather than guessing duplicate configurations", async () => {
  const trigger = {
    connectionId: "connection",
    spec: { kind: "calendar.event_changed", calendarId: "same", target: { kind: "calendar" } },
  };
  const request = {
    operation: "create" as const,
    input: { name: "First", nativeTriggers: [trigger, trigger] },
    triggerKeys: ["a", "b"],
  };
  const state: RoutineSaveState = { pending: request, draft: request };
  const send = vi.fn(
    async () =>
      ({
        ...baseline,
        nativeTriggers: ["id-a", "id-b"].map((id) => ({ ...trigger, id, version: 1 })),
      }) as Routine,
  );
  await expect(
    saveRoutineDraft(
      state,
      { ...request, input: { ...request.input, name: "Second" } },
      null,
      send,
      () => true,
    ),
  ).rejects.toThrow("This native trigger changed");
  expect(send).toHaveBeenCalledOnce();
  expect(state.pending).toEqual(request);
  expect(state.triggerIds).toBeUndefined();
});
