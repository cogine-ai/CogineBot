import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findRunRecoveryBlockers } from "./run-recovery.js";

const now = new Date("2026-01-01T00:00:00.000Z");
const run = { id: "run-1", botId: "bot-1", bot: { computerId: "computer-1" } };
const lease = { computerId: "computer-1", botId: "bot-1", runId: "earlier-run" };

function fixture(leases = [lease]) {
  const findMany = vi.fn(async () => leases);
  const prisma = { computerExecutionLease: { findMany } } as unknown as PrismaClient;
  return { prisma, findMany };
}

describe("run recovery resource blockers", () => {
  it("queries only the requested bots and live leases, matching the current computer", async () => {
    const { prisma, findMany } = fixture();
    expect(await findRunRecoveryBlockers(prisma, [run], now)).toEqual(
      new Map([[run.id, lease.runId]]),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { botId: { in: [run.botId] }, expiresAt: { gt: now } },
      select: { computerId: true, botId: true, runId: true },
    });
  });

  it("does not block a run on its own lease or another bot or computer", async () => {
    const { prisma } = fixture([
      { ...lease, runId: run.id },
      { ...lease, botId: "another-bot" },
      { ...lease, computerId: "previous-computer" },
    ]);
    expect(await findRunRecoveryBlockers(prisma, [run], now)).toEqual(new Map());
    expect(
      await findRunRecoveryBlockers(prisma, [{ ...run, bot: { computerId: null } }], now),
    ).toEqual(new Map());
  });

  it("does not query leases when there are no candidate runs", async () => {
    const { prisma, findMany } = fixture();
    expect(await findRunRecoveryBlockers(prisma, [], now)).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("propagates a failed lease read instead of treating resource ownership as absent", async () => {
    const { prisma, findMany } = fixture();
    const failure = new Error("fixture lease read failure");
    findMany.mockRejectedValueOnce(failure);
    await expect(findRunRecoveryBlockers(prisma, [run], now)).rejects.toBe(failure);
  });
});
