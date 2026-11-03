import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";

describe("terminal cancellation winners", () => {
  it("clears only returned winners and leaves a concurrently completed candidate untouched", async () => {
    const runs = [
      { id: "cancelled-run", taskId: "cancelled-task" },
      { id: "finished-run", taskId: "finished-task" },
    ];
    const tx = {
      run: { updateManyAndReturn: vi.fn(async () => [{ id: runs[0]!.id, spaceId: "space" }]) },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const at = new Date(0);
    await expect(cancelRunsInTransaction(tx as never, runs, at)).resolves.toEqual([runs[0]]);
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: runs.map((run) => run.id) }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: { status: "cancelled", completedAt: at, leaseOwner: null, leaseExpiresAt: null },
      select: { id: true, spaceId: true },
    });
    expect(tx.externalEffect.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            runId: runs[0]!.id,
            spaceId: "space",
            kind: "runtime_checkpoint",
            status: "runtime_checkpoint",
            idempotencyKey: JSON.stringify(["runtime_checkpoint", runs[0]!.id]),
          },
        ],
      },
    });
    expect(tx.attempt.updateMany).toHaveBeenCalledWith({
      where: { runId: { in: [runs[0]!.id] }, status: "running" },
      data: { status: "cancelled", finishedAt: at },
    });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [runs[0]!.taskId] } },
      data: { status: "cancelled" },
    });
  });

  it("does not clear checkpoint or task state when cancellation wins no rows", async () => {
    const tx = {
      run: { updateManyAndReturn: vi.fn(async () => []) },
      externalEffect: { deleteMany: vi.fn() },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
    };
    await expect(
      cancelRunsInTransaction(tx as never, [{ id: "finished", taskId: "task" }], new Date()),
    ).resolves.toEqual([]);
    expect(tx.externalEffect.deleteMany).not.toHaveBeenCalled();
    expect(tx.attempt.updateMany).not.toHaveBeenCalled();
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });
});
