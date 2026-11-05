import { currentDbContext, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";

const ambient = { spaceId: "space-enqueue", userId: "user-enqueue" };
const owner = { spaceId: "space-stored", userId: "user-stored" };

function fixture(findOwner: () => Promise<typeof owner | null>) {
  const observed: unknown[] = [];
  const findUnique = vi.fn(async () => {
    observed.push({ step: "owner", context: currentDbContext() });
    return findOwner();
  });
  const continueRun = vi.fn(async (_runId, _workerId, onRunStarted) => {
    await Promise.resolve();
    observed.push({ step: "execute", context: currentDbContext() });
    await onRunStarted?.();
  });
  const handlers = createBackgroundJobHandlers({
    prisma: { run: { findUnique } },
    executor: { continueRun },
    workerId: "worker-context",
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  return { handlers, observed, findUnique, continueRun };
}

describe("persisted background job identity", () => {
  it("discovers the stored owner before running the complete callback and restores ambient context", async () => {
    const { handlers, observed, findUnique } = fixture(async () => owner);
    const onRunStarted = vi.fn(async () => {
      observed.push({ step: "started", context: currentDbContext() });
    });
    await runAsTenant(ambient, async () => {
      await handlers["run.continue"]({ runId: "run-stored" }, { onRunStarted });
      expect(currentDbContext()).toEqual({ kind: "tenant", ...ambient });
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-stored" },
      select: { spaceId: true, userId: true },
    });
    expect(observed).toEqual([
      { step: "owner", context: { kind: "system", reason: expect.any(String) } },
      { step: "execute", context: { kind: "tenant", ...owner } },
      { step: "started", context: { kind: "tenant", ...owner } },
    ]);
    expect(currentDbContext()).toBeUndefined();
  });

  it("does not run a job after its persisted owner row was deleted", async () => {
    const { handlers, continueRun, findUnique } = fixture(async () => null);
    await handlers["run.continue"]({ runId: "run-deleted" });
    expect(findUnique).toHaveBeenCalledOnce();
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("propagates owner lookup errors without executing under a fallback identity", async () => {
    const failure = new Error("Database unavailable");
    const { handlers, continueRun } = fixture(async () => {
      throw failure;
    });
    await expect(handlers["run.continue"]({ runId: "run-retry" })).rejects.toBe(failure);
    expect(continueRun).not.toHaveBeenCalled();
    expect(currentDbContext()).toBeUndefined();
  });
});
