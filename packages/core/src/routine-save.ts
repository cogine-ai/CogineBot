import type { NativeRoutineTriggerInput, Routine } from "@rakazo/contracts";
import { newRoutineMutationId } from "./routine-trigger-patch.js";

type Input = Record<string, unknown> & { mutationId?: string };
type Request = { operation: "create" | "update"; input: Input; triggerKeys?: string[] };
type Submission = {
  pending?: Request;
  baseline?: Routine | null;
  draft?: Request;
  draftBaseline?: Routine | null;
};
export type RoutineSaveState = Submission & { recovered?: Submission; discarded?: boolean };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A retry recovers the immutable submission before any later draft can write. */
export async function saveRoutineDraft(
  state: RoutineSaveState,
  requested: Request,
  baseline: Routine | null,
  send: (request: Request) => Promise<Routine>,
  current: () => boolean,
): Promise<Routine | undefined> {
  const desired = copy(requested);
  if (state.pending) {
    const previous = state.pending;
    // A refused replay says nothing about the earlier commit: authorization or
    // validation may now fail before receipt lookup. Keep this exact request
    // (including an uncertain follow-up), even when the response is a 4xx.
    const saved = await send(copy(previous));
    if (!current()) return;
    state.recovered ??= copy({
      pending: previous,
      baseline: state.baseline,
      draft: state.draft,
      draftBaseline: state.draftBaseline,
    });
    // Keep recovery information until the follow-up request has been constructed.
    const patch: Input = {};
    const previousDraft = state.draft ?? previous;
    const before = { ...(state.draftBaseline ?? state.baseline), ...previousDraft.input };
    const after = { ...baseline, ...desired.input };
    for (const key of new Set([
      ...(state.discarded ? [] : Object.keys(previousDraft.input)),
      ...Object.keys(desired.input),
    ])) {
      if (
        ["mutationId", "routineId", "botId", "nativeTriggerBaseline", "nativeTriggers"].includes(
          key,
        )
      )
        continue;
      if (!equal(before[key as keyof typeof before], after[key as keyof typeof after]))
        patch[key] = after[key as keyof typeof after];
    }
    const modelFields = [
      "modelProvider",
      "modelId",
      "modelCredentialId",
      "thinkingLevel",
      "expectedRevision",
    ];
    if (modelFields.some((key) => key in patch)) {
      for (const key of modelFields) if (key in desired.input) patch[key] = desired.input[key];
    }
    const oldTriggers = previousDraft.input.nativeTriggers as
      | NativeRoutineTriggerInput[]
      | undefined;
    const nextTriggers = desired.input.nativeTriggers as NativeRoutineTriggerInput[] | undefined;
    const inputs = (routine: Routine | null | undefined) =>
      (routine?.nativeTriggers ?? []).map((t) => ({
        id: t.id,
        expectedVersion: t.version,
        connectionId: t.connectionId,
        spec: t.spec,
      }));
    if (
      (!state.discarded || nextTriggers !== undefined) &&
      !equal(
        oldTriggers ?? inputs(state.draftBaseline ?? state.baseline),
        nextTriggers ?? inputs(baseline),
      )
    ) {
      // Do not adopt concurrent versions blindly. Only our acknowledged configuration
      // may supply identities for formerly unsaved triggers.
      const original = state.baseline?.nativeTriggers ?? [];
      const submitted =
        oldTriggers ??
        original.map((t) => ({
          id: t.id,
          expectedVersion: t.version,
          connectionId: t.connectionId,
          spec: t.spec,
        }));
      const rows = saved.nativeTriggers ?? [];
      const used = new Set<string>();
      const resolved = submitted.map((item) => {
        const matches = rows.filter(
          (row) =>
            !used.has(row.id) &&
            (item.id ? row.id === item.id : !original.some((t) => t.id === row.id)) &&
            row.connectionId === item.connectionId &&
            equal(row.spec, item.spec),
        );
        if (matches.length !== 1)
          throw new Error("This native trigger changed. Read it again before saving.");
        const row = matches[0]!;
        const old = original.find((t) => t.id === item.id);
        const expectedVersion = item.id
          ? (item.expectedVersion ?? 0) +
            (old && (old.connectionId !== item.connectionId || !equal(old.spec, item.spec)) ? 1 : 0)
          : 1;
        if (row.version !== expectedVersion)
          throw new Error("This native trigger changed. Read it again before saving.");
        used.add(row.id);
        return row;
      });
      if (rows.length !== resolved.length)
        throw new Error("This native trigger changed. Read it again before saving.");
      patch.nativeTriggers = (
        nextTriggers ??
        (baseline?.nativeTriggers ?? []).map((t) => ({
          id: t.id,
          expectedVersion: t.version,
          connectionId: t.connectionId,
          spec: t.spec,
        }))
      ).map((item, index) => {
        const priorIndex = item.id
          ? submitted.findIndex((t) => t.id === item.id)
          : desired.triggerKeys?.[index]
            ? (previousDraft.triggerKeys ?? []).indexOf(desired.triggerKeys[index]!)
            : -1;
        const row = resolved[priorIndex];
        return row ? { ...item, id: row.id, expectedVersion: row.version } : item;
      });
      patch.nativeTriggerBaseline = resolved.map(({ id, version }) => ({ id, version }));
    }
    if (!Object.keys(patch).length) {
      delete state.pending;
      delete state.recovered;
      return saved;
    }
    desired.operation = "update";
    desired.input = { ...patch, routineId: saved.id, mutationId: newRoutineMutationId() };
    state.baseline = saved;
  } else state.baseline = baseline;
  if (!current()) return;
  state.pending = copy({
    ...desired,
    input: { ...desired.input, mutationId: desired.input.mutationId ?? newRoutineMutationId() },
  });
  delete state.discarded;
  state.draft = copy(requested);
  state.draftBaseline = baseline;
  try {
    const saved = await send(copy(state.pending));
    if (!current()) return;
    delete state.pending;
    delete state.recovered;
    return saved;
  } catch (error) {
    // This is the first dispatch of this new intent, not recovery of an uncertain
    // submission. A definitive rejection can release it; an already recovered
    // create identity must still survive a rejected follow-up.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "CONFLICT"].includes(String(error.code))
    ) {
      if (state.recovered) {
        const root = copy(state.recovered);
        state.pending = root.pending;
        state.baseline = root.baseline;
        state.draft = root.draft;
        state.draftBaseline = root.draftBaseline;
      } else delete state.pending;
    }
    throw error;
  }
}
