import type { NativeRoutineEventSpec, Routine } from "@rakazo/contracts";
import { CreateRoutineInput } from "@rakazo/contracts";
import { expect, it } from "vitest";
import triggerFixtures from "../../testkit/src/routine-trigger-fixtures.json" with { type: "json" };
import {
  draftFromNativeRoutineTrigger,
  NATIVE_ROUTINE_EVENT_KINDS,
  nativeRoutineTriggerInputs,
} from "./routine-native-events.js";
import { routineTriggerDraft, routineTriggerPatch } from "./routine-trigger-patch.js";

const routineTriggerSpecs = triggerFixtures.specs as NativeRoutineEventSpec[];
function routineTriggerFixture(spec: NativeRoutineEventSpec) {
  return { ...triggerFixtures.trigger, spec };
}

const routine = {
  id: "fixture-routine",
  botId: "fixture-bot",
  name: "Fixture",
  prompt: "Fixture",
  crons: ["0 0 9 * * MON-FRI"],
  timezone: "UTC",
  active: false,
  modelProvider: "fixture",
  modelId: "model",
  modelCredentialId: "credential",
  webhookEnabled: true,
  githubEnabled: true,
  messageProvider: "slack",
  nativeTriggers: [routineTriggerFixture({ kind: "gmail.message_received", labelIds: ["Z", "A"] })],
} as Routine;

it("covers every Web-open application kind", () => {
  expect([...new Set(routineTriggerSpecs.map((spec) => spec.kind))].sort()).toEqual(
    [...NATIVE_ROUTINE_EVENT_KINDS].sort(),
  );
});
for (const spec of routineTriggerSpecs) {
  it(`preserves untouched ${JSON.stringify(spec)} while editing another trigger`, () => {
    const original = { ...routine, nativeTriggers: [routineTriggerFixture(spec)] };
    const draft = routineTriggerDraft(original);
    expect(routineTriggerPatch(original, draft)).toEqual({});
    draft.githubEnabled = false;
    expect(routineTriggerPatch(original, draft)).toEqual({ githubEnabled: false });
    const added = draftFromNativeRoutineTrigger({
      ...routineTriggerFixture({ kind: "planner.task.changed", planId: "other" }),
      id: "other-trigger",
    });
    draft.nativeTriggers.push(added);
    expect(routineTriggerPatch(original, draft).nativeTriggers?.[0]).toEqual({
      id: "fixture-trigger",
      expectedVersion: 4,
      connectionId: "fixture-connection",
      spec,
    });
  });
  it(`creates external-only and scheduled routines with ${JSON.stringify(spec)}`, () => {
    const draft = draftFromNativeRoutineTrigger(routineTriggerFixture(spec));
    delete draft.id;
    delete draft.expectedVersion;
    const parsed = nativeRoutineTriggerInputs([draft]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const crons of [[], ["0 9 * * *"]]) {
      const result = CreateRoutineInput.parse({
        botId: "fixture-bot",
        name: "Fixture",
        prompt: "Fixture",
        crons,
        nativeTriggers: parsed.data,
      });
      expect(result.crons).toEqual(crons);
      expect(result.nativeTriggers?.[0]?.spec).toEqual(spec);
    }
  });
}
it("removes events without replaying unrelated routine settings", () => {
  const draft = routineTriggerDraft(routine);
  draft.nativeTriggers = [];
  expect(routineTriggerPatch(routine, draft)).toEqual({ nativeTriggers: [] });
  expect(routine.nativeTriggers).toHaveLength(1);
});
it("rejects invalid, duplicate and oversized drafts before update", () => {
  const draft = routineTriggerDraft(routine);
  draft.nativeTriggers[0]!.labelIds = "";
  expect(() => routineTriggerPatch(routine, draft)).toThrow();
  const duplicate = routineTriggerDraft(routine);
  duplicate.nativeTriggers.push({ ...duplicate.nativeTriggers[0]! });
  expect(() => routineTriggerPatch(routine, duplicate)).toThrow();
  duplicate.nativeTriggers = Array.from({ length: 21 }, (_, i) => ({
    ...duplicate.nativeTriggers[0]!,
    id: undefined,
    expectedVersion: undefined,
    key: String(i),
    labelIds: String(i),
  }));
  expect(() => routineTriggerPatch(routine, duplicate)).toThrow();
});
