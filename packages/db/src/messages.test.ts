import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  assertRunCanWriteHistory,
  createThreadMessage,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("executing run history lease", () => {
  const lease = { owner: "worker-current", fence: 4 };
  const activeRun = {
    status: "running",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    firstResponseAt: null,
    userId: "user-1",
    leaseOwner: lease.owner,
    leaseFence: lease.fence,
  };

  function fixture(
    run: (Omit<typeof activeRun, "leaseOwner"> & { leaseOwner: string | null }) | null = activeRun,
  ) {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (..._args: unknown[]) => {
        order.push("share-lock");
        return [];
      }),
      run: {
        findUnique: vi.fn(async () => {
          order.push("read");
          return run;
        }),
      },
    };
    return { tx, order };
  }

  it("locks the row before reading the current executing attempt", async () => {
    const { tx, order } = fixture();
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
    ).resolves.toEqual(activeRun);
    expect(order).toEqual(["share-lock", "read"]);
    expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual(["run-1"]);
    expect((tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join("?")).toContain(
      "FOR SHARE",
    );
  });

  it.each([
    { leaseOwner: "worker-new", leaseFence: 4 },
    { leaseOwner: lease.owner, leaseFence: 5 },
    { leaseOwner: null, leaseFence: 5 },
  ])("rejects superseded owner/fence %j", async (replacement) => {
    const { tx } = fixture({ ...activeRun, ...replacement });
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
  });

  it.each(["waiting_input", "waiting_takeover", "completed"])(
    "allows the same fence's final output after %s releases ownership",
    async (status) => {
      const run = { ...activeRun, status, leaseOwner: null };
      const { tx } = fixture(run);
      await expect(
        assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
      ).resolves.toEqual(run);
    },
  );

  it("retains the cancellation guard and checks the fence for an opted-in terminal echo", async () => {
    const { tx } = fixture({ ...activeRun, status: "cancelled", leaseOwner: null });
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", {
        lease,
        allowCancelled: true,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", {
        lease: { ...lease, fence: 3 },
        allowCancelled: true,
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
  });

  it("keeps non-executing calls compatible without taking a lease lock", async () => {
    const { tx } = fixture();
    await assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1");
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient),
    ).resolves.toBeUndefined();
    expect(tx.run.findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing Run and propagates a lock failure", async () => {
    const { tx } = fixture(null);
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    tx.$queryRaw.mockRejectedValueOnce(new Error("fixture lock unavailable"));
    tx.run.findUnique.mockClear();
    await expect(
      assertRunCanWriteHistory(tx as unknown as Prisma.TransactionClient, "run-1", { lease }),
    ).rejects.toThrow("fixture lock unavailable");
    expect(tx.run.findUnique).not.toHaveBeenCalled();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
