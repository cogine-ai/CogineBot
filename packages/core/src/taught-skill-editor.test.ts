import type { TaughtSkill } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTaughtSkillEditor, taughtSkillRoutineSeed } from "./taught-skill-editor.js";

const skill = (status: TaughtSkill["status"] = "draft"): TaughtSkill => ({
  id: "skill-1",
  botId: "bot-1",
  name: "Export",
  goal: "Export synthetic list",
  status,
  playbook: {
    whenToUse: "Weekly",
    inputs: ["List"],
    steps: ["Export"],
    howToCheck: "File exists",
    whatToReturn: "File",
    approvalBoundaries: "Ask before sending",
    failureHandling: "Stop",
  },
  recording: { events: [], snapshots: [] },
  startedAt: null,
  expiresAt: null,
  stoppedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(rows: TaughtSkill[] = []) {
  const transport = {
    list: vi.fn(async () => rows),
    start: vi.fn(async () => skill("recording")),
    stop: vi.fn(async () => skill()),
    update: vi.fn(async (_id: string, name: string, playbook: TaughtSkill["playbook"]) => ({
      ...skill(),
      name,
      playbook,
    })),
    save: vi.fn(async () => skill("saved")),
    get: vi.fn(async () => skill("saved")),
    test: vi.fn(async () => ({ runId: "run-1" })),
  };
  let current = true;
  const editor = createTaughtSkillEditor("bot-1", transport, () => current, vi.fn());
  return {
    editor,
    transport,
    leave: () => {
      current = false;
    },
  };
}

describe("taught skill editor", () => {
  it("fails closed during initial read and recovers an existing recording without start", async () => {
    const { editor, transport } = fixture([skill("recording")]);
    await editor.start("goal");
    editor.setActive(true);
    await editor.start("goal");
    await flush();
    await editor.start("goal");
    expect(transport.start).not.toHaveBeenCalled();
    expect(editor.snapshot().skills[0]!.status).toBe("recording");
  });
  it("requires status recovery after an uncertain start or status failure", async () => {
    const { editor, transport } = fixture();
    editor.setActive(true);
    await flush();
    transport.start.mockRejectedValueOnce(new Error("response lost"));
    await editor.start("goal");
    await editor.start("goal");
    expect(transport.start).toHaveBeenCalledTimes(1);
    transport.list.mockRejectedValueOnce(new Error("offline"));
    await editor.refresh();
    await editor.start("goal");
    expect(editor.snapshot().verified).toBe(false);
    transport.list.mockResolvedValue([skill("recording")]);
    await editor.refresh();
    await editor.start("goal");
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(editor.snapshot().error).toBeUndefined();
  });
  it("recovers uncertain stop as the persisted draft", async () => {
    const { editor, transport } = fixture([skill("recording")]);
    editor.setActive(true);
    await flush();
    transport.stop.mockRejectedValueOnce(new Error("timeout"));
    await editor.stop("skill-1");
    expect(editor.snapshot().verified).toBe(false);
    transport.list.mockResolvedValue([skill()]);
    await editor.refresh();
    expect(editor.snapshot().skills[0]!.status).toBe("draft");
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
  it("persists every current field before testing; save confirms by reading back", async () => {
    const { editor, transport } = fixture([skill()]);
    editor.setActive(true);
    await flush();
    const draft = {
      whenToUse: "Changed",
      inputs: ["New input"],
      steps: ["New step", "Verify"],
      howToCheck: "Changed check",
      whatToReturn: "Receipt",
      approvalBoundaries: "Always ask",
      failureHandling: "Report",
    };
    await editor.submit("skill-1", "Changed", draft, "test");
    expect(transport.update).toHaveBeenCalledWith("skill-1", "Changed", draft);
    expect(transport.update.mock.invocationCallOrder[0]).toBeLessThan(
      transport.test.mock.invocationCallOrder[0]!,
    );
    expect(editor.snapshot().testRunId).toBe("run-1");
    await editor.submit("skill-1", "Changed", draft, "save");
    expect(transport.save).toHaveBeenCalledWith("skill-1", "Changed");
    expect(transport.get).toHaveBeenCalledWith("skill-1");
    expect(editor.snapshot().skills[0]!.status).toBe("saved");
  });
  it("does not execute after update failure or a scope change", async () => {
    const { editor, transport, leave } = fixture([skill()]);
    editor.setActive(true);
    await flush();
    transport.update.mockRejectedValueOnce(new Error("write failed"));
    await editor.submit("skill-1", "name", skill().playbook, "test");
    expect(transport.test).not.toHaveBeenCalled();
    transport.update.mockImplementationOnce(async () => {
      leave();
      return skill();
    });
    await editor.submit("skill-1", "name", skill().playbook, "save");
    expect(transport.save).not.toHaveBeenCalled();
  });
  it("fences a blur/refocus during a mutation and reloads without replaying it", async () => {
    const { editor, transport } = fixture();
    editor.setActive(true);
    await flush();
    let resolve!: (value: TaughtSkill) => void;
    transport.start.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = editor.start("goal");
    editor.setActive(false);
    editor.setActive(true);
    await editor.start("goal");
    transport.list.mockResolvedValue([skill("recording")]);
    resolve(skill("recording"));
    await pending;
    await flush();
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(editor.snapshot().verified).toBe(true);
    expect(editor.snapshot().skills[0]!.status).toBe("recording");
  });
  it("rejects another Bot's rows and cannot mutate unknown skills", async () => {
    const { editor, transport } = fixture([{ ...skill(), botId: "bot-2" }]);
    editor.setActive(true);
    await flush();
    expect(editor.snapshot().verified).toBe(false);
    expect(editor.snapshot().skills).toEqual([]);
    await editor.submit("skill-1", "name", skill().playbook, "save");
    expect(transport.update).not.toHaveBeenCalled();
  });
});

it("seeds the existing routine form only from a saved skill belonging to the selected Bot", () => {
  expect(taughtSkillRoutineSeed(skill(), "bot-1")).toBeNull();
  expect(taughtSkillRoutineSeed(skill("saved"), "bot-2")).toBeNull();
  const seed = taughtSkillRoutineSeed(skill("saved"), "bot-1")!;
  expect(seed.name).toBe("Export");
  expect(seed.prompt).toContain("Export");
  expect(seed.prompt).toContain("Ask before sending");
  expect(seed.prompt).toContain("File exists");
});
