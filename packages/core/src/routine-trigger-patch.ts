import type { NativeRoutineTriggerInput, Routine } from "@rakazo/contracts";
import { NativeRoutineTriggersInputSchema } from "@rakazo/contracts";
import type { NativeRoutineTriggerDraft } from "./routine-native-events.js";
import {
  draftFromNativeRoutineTrigger,
  nativeRoutineTriggerInputs,
} from "./routine-native-events.js";

export type RoutineTriggerDraft = Pick<
  Routine,
  "webhookEnabled" | "githubEnabled" | "messageProvider"
> & {
  nativeTriggers: NativeRoutineTriggerDraft[];
};

export function routineTriggerDraft(routine: Routine): RoutineTriggerDraft {
  return {
    webhookEnabled: routine.webhookEnabled,
    githubEnabled: routine.githubEnabled,
    messageProvider: routine.messageProvider,
    nativeTriggers: (routine.nativeTriggers ?? []).map(draftFromNativeRoutineTrigger),
  };
}

/** Sparse updates never replay unrelated schedule/model/pause fields or normalize untouched events. */
export function routineTriggerPatch(routine: Routine, draft: RoutineTriggerDraft) {
  const patch: Partial<Pick<Routine, "webhookEnabled" | "githubEnabled" | "messageProvider">> & {
    nativeTriggers?: NativeRoutineTriggerInput[];
    nativeTriggerBaseline?: Array<{ id: string; version: number }>;
  } = {};
  for (const key of ["webhookEnabled", "githubEnabled"] as const) {
    if (draft[key] !== routine[key]) patch[key] = draft[key];
  }
  if (draft.messageProvider !== routine.messageProvider)
    patch.messageProvider = draft.messageProvider;
  const original = routine.nativeTriggers ?? [];
  const unchanged = (item: NativeRoutineTriggerDraft) => {
    const saved = original.find((entry) => entry.id === item.id);
    return saved && JSON.stringify(draftFromNativeRoutineTrigger(saved)) === JSON.stringify(item)
      ? saved
      : undefined;
  };
  if (
    draft.nativeTriggers.length !== original.length ||
    draft.nativeTriggers.some((item, index) => !unchanged(item) || item.id !== original[index]?.id)
  ) {
    patch.nativeTriggerBaseline = original.map(({ id, version }) => ({ id, version }));
    patch.nativeTriggers = draft.nativeTriggers.map((item) => {
      const saved = unchanged(item);
      if (saved)
        return {
          id: saved.id,
          expectedVersion: saved.version,
          connectionId: saved.connectionId,
          spec: saved.spec,
        };
      const result = nativeRoutineTriggerInputs([item]);
      if (!result.success) throw new Error("Invalid application event");
      return result.data[0]!;
    });
  }
  if (
    patch.nativeTriggers &&
    !NativeRoutineTriggersInputSchema.safeParse(patch.nativeTriggers).success
  )
    throw new Error("Invalid application event");
  return patch;
}

/** Save identity, not a credential; works in native runtimes and non-secure Web contexts. */
export function newRoutineMutationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `routine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
