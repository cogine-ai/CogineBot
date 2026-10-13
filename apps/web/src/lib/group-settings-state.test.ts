import type { Group, ThreadSnapshot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { syncSavedGroupSnapshot } from "./group-settings-state";

const savedGroup: Pick<Group, "id" | "threadId" | "name" | "members"> = {
  id: "group-1",
  threadId: "thread-1",
  name: "Afternoon companions",
  members: [
    { botId: "bot-1", name: "Robin", color: "default" },
    { botId: "bot-3", name: "Alex", color: "default" },
  ],
};

const activeRun: NonNullable<ThreadSnapshot["run"]> = {
  id: "run-1",
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
  status: "running",
  trigger: "user",
  routineId: null,
  modelProvider: null,
  modelId: null,
  error: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-10-11T00:00:00.000Z",
};

const snapshot: ThreadSnapshot = {
  groupId: "group-1",
  groupName: "Old group name",
  threadId: "thread-1",
  cursor: 12,
  olderCursor: 4,
  members: [{ botId: "bot-2", name: "Old member", color: "default" }],
  messages: [
    {
      id: "message-1",
      threadId: "thread-1",
      botId: "bot-2",
      role: "bot",
      seq: 12,
      blocks: [{ kind: "text", text: "Keep this conversation." }],
      createdAt: "2026-10-11T00:00:00.000Z",
    },
  ],
  run: activeRun,
  activeRuns: [activeRun],
};

describe("saved group metadata", () => {
  it("updates confirmed members without discarding history, pagination or live runs", () => {
    const next = syncSavedGroupSnapshot(snapshot, savedGroup);
    expect(next).toEqual({ ...snapshot, groupName: savedGroup.name, members: savedGroup.members });
    expect(next?.messages).toBe(snapshot.messages);
    expect(next?.run).toBe(snapshot.run);
    expect(next?.activeRuns).toBe(snapshot.activeRuns);
    expect(snapshot.members?.[0]?.botId).toBe("bot-2");
  });

  it("does not apply an old group's receipt to the currently open other group", () => {
    const other = { ...snapshot, groupId: "group-2" };
    expect(syncSavedGroupSnapshot(other, savedGroup)).toBe(other);
  });

  it("does not restore metadata onto another thread or create an unloaded snapshot", () => {
    const otherThread = { ...snapshot, threadId: "thread-2" };
    expect(syncSavedGroupSnapshot(otherThread, savedGroup)).toBe(otherThread);
    expect(syncSavedGroupSnapshot(null, savedGroup)).toBeNull();
    expect(syncSavedGroupSnapshot(snapshot, undefined)).toBe(snapshot);
  });
});
