import type { Connection, NativeRoutineEventSpec } from "@rakazo/contracts";
import { CreateRoutineInput, nativeEventApp } from "@rakazo/contracts";
import { expect, it } from "vitest";
import triggerFixtures from "../../../../packages/testkit/src/routine-trigger-fixtures.json" with {
  type: "json",
};
import {
  draftFromNativeRoutineTrigger,
  emptyNativeRoutineTriggerDraft,
  nativeEventAccounts,
  nativeEventAppForKind,
  nativeRoutineTriggerInputs,
  resetNativeRoutineTriggerDraft,
} from "./routine-native-events";

const specs = triggerFixtures.specs as NativeRoutineEventSpec[];
function trigger(spec: NativeRoutineEventSpec) {
  return { ...triggerFixtures.trigger, spec };
}

for (const spec of specs)
  it(`${spec.kind} round-trips through the real Routine API input without adding an active flag`, () => {
    const draft = draftFromNativeRoutineTrigger(trigger(spec));
    const parsed = nativeRoutineTriggerInputs([draft]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual([
      { id: "fixture-trigger", expectedVersion: 4, connectionId: "fixture-connection", spec },
    ]);
    expect(nativeEventAppForKind(spec.kind)).toBe(nativeEventApp(spec));
    const create = CreateRoutineInput.parse({
      botId: "fixture-bot",
      name: "Fixture",
      prompt: "Fixture",
      nativeTriggers: parsed.data,
    });
    expect(create.active).toBe(false);
  });
it("Gmail requires an explicit label or thread, deduplicates labels and does not send stale fields", () => {
  const blank = {
    ...emptyNativeRoutineTriggerDraft(),
    connectionId: "fixture-connection",
    kind: "gmail.message_received" as const,
  };
  expect(nativeRoutineTriggerInputs([blank]).success).toBe(false);
  const parsed = nativeRoutineTriggerInputs([
    {
      ...blank,
      labelIds: "Label_Z\nLabel_A\nLabel_Z\n",
      threadId: " thread_fixture ",
      calendarId: "stale_calendar",
      fileId: "stale_file",
      channelId: "stale_channel",
    },
  ]);
  expect(parsed.success && parsed.data[0]!.spec).toEqual({
    kind: "gmail.message_received",
    labelIds: ["Label_A", "Label_Z"],
    threadId: "thread_fixture",
  });
});
it("switching accounts or event kinds clears dependent fields and preserves only the existing trigger revision", () => {
  const draft = draftFromNativeRoutineTrigger(
    trigger({
      kind: "slack.channel_message",
      channelId: "CFIXTURE",
      threadTs: "1234567890.123456",
    }),
  );
  const reset = resetNativeRoutineTriggerDraft(draft, "other_connection", "drive.file_changed");
  expect(reset).toMatchObject({
    id: "fixture-trigger",
    expectedVersion: 4,
    connectionId: "other_connection",
    kind: "drive.file_changed",
    channelId: "",
    threadTs: "",
    fileId: "",
  });
  expect(nativeRoutineTriggerInputs([reset]).success).toBe(false);
});
it("only connected native event-capable accounts are selectable; long-tail accounts are not silently migrated", () => {
  const rows = [
    "google-calendar",
    "notion",
    "gmail",
    "google-drive",
    "slack",
    "google-docs",
    "github",
  ].map(
    (provider) =>
      ({
        id: provider,
        provider,
        connectorId: "native",
        status: "connected",
        capabilities: [],
        displayName: provider,
        createdAt: "2026-10-18T00:00:00Z",
      }) as Connection,
  );
  rows.push(
    { ...rows[2]!, id: "broker-gmail", connectorId: "composio" },
    { ...rows[4]!, id: "revoked-slack", status: "revoked" },
  );
  expect(nativeEventAccounts(rows).map((row) => row.id)).toEqual([
    "google-calendar",
    "notion",
    "gmail",
    "google-drive",
    "slack",
  ]);
});
