import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import {
  clearRunTurnCheckpoints,
  dropRunTurnCheckpoint,
  loadRunTurnCheckpoint,
  saveRunTurnCheckpoint,
} from "./run-turn-checkpoint.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled).sequential("run turn checkpoint fencing (PostgreSQL)", () => {
  const organizationId = "turn-checkpoint-organization";
  const spaceId = "turn-checkpoint-space";
  const otherSpaceId = "turn-checkpoint-other-space";
  const userId = "turn-checkpoint-user";
  const botId = "turn-checkpoint-bot";
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Checkpoint fixture", email: "checkpoint@example.test" },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Checkpoint fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: {
          create: [
            {
              id: spaceId,
              name: "Checkpoint fixture",
              bots: { create: { id: botId, userId, name: "Fixture", color: "ink" } },
            },
            { id: otherSpaceId, name: "Other checkpoint fixture" },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await close();
    }
  });

  async function seed() {
    const group = await prisma.chatGroup.create({
      data: { spaceId, userId, name: "Checkpoint fixture", members: { create: { botId } } },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, groupId: group.id } });
    const task = await prisma.task.create({
      data: { spaceId, botId, userId, threadId: thread.id, prompt: "fixture", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        userId,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 7,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 7, status: "running" },
    });
    return { run, thread, task, attempt };
  }

  function finishInput(f: Awaited<ReturnType<typeof seed>>) {
    return {
      runId: f.run.id,
      spaceId,
      botId,
      threadId: f.thread.id,
      taskId: f.task.id,
      attemptId: f.attempt.id,
      leaseOwner: "worker",
      leaseFence: 7,
      outcome: "completed" as const,
      blocks: [],
    };
  }

  it("backfills existing MCP rows by executing the actual migration on a transaction-local old table", async () => {
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20261103020000_mcp_verbatim_results/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$transaction(async (tx) => {
      // The actual migration can resolve only this connection's synthetic table.
      // COMMIT drops it; rollback also undoes its creation if an assertion fails.
      await tx.$executeRaw`CREATE TEMP TABLE mcp_servers (id text PRIMARY KEY) ON COMMIT DROP`;
      await tx.$executeRaw`SET LOCAL search_path = pg_temp`;
      await tx.$executeRaw`INSERT INTO pg_temp.mcp_servers (id) VALUES ('existing-fixture-row')`;
      await tx.$executeRawUnsafe(migration);
      const rows = await tx.$queryRaw<Array<{ id: string; verbatimResults: boolean }>>`
        SELECT id, "verbatimResults" FROM pg_temp.mcp_servers`;
      expect(rows).toEqual([{ id: "existing-fixture-row", verbatimResults: false }]);
    });
  });

  it("defaults MCP result retention off and persists explicit choices without granting tools", async () => {
    const server = await prisma.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "checkpoint-fixture-server",
        name: "Fixture",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
      },
    });
    expect(server.verbatimResults).toBe(false);
    for (const verbatimResults of [true, false]) {
      const updated = await prisma.mcpServer.update({
        where: { id: server.id },
        data: { verbatimResults },
      });
      expect(updated).toMatchObject({ verbatimResults, allowAllTools: false, allowedTools: [] });
      expect(
        (await prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).verbatimResults,
      ).toBe(verbatimResults);
    }
  });

  it("stores the latest opaque turn only, without events or normal effect mutation", async () => {
    const f = await seed();
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: f.run.id,
        kind: "write_effect",
        status: "completed",
        idempotencyKey: `ordinary:${f.run.id}`,
        request: {},
        result: { receipt: "keep" },
      },
    });
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "first fixture turn");
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "latest fixture turn");
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("latest fixture turn");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_checkpoint" } }),
    ).toBe(1);
    expect(await prisma.event.count({ where: { runId: f.run.id } })).toBe(0);
    expect(await prisma.message.count({ where: { runId: f.run.id } })).toBe(0);
    await dropRunTurnCheckpoint(prisma, f.run, "worker", 7);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect(await prisma.externalEffect.findUnique({ where: { id: effect.id } })).toEqual(effect);
  });

  it("fails closed on a mismatching Space and a malformed persisted value", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "keep scoped fixture");
    await expect(
      loadRunTurnCheckpoint(prisma, { ...f.run, spaceId: otherSpaceId }),
    ).rejects.toThrow("Unsupported turn checkpoint");
    await expect(
      saveRunTurnCheckpoint(prisma, { ...f.run, spaceId: otherSpaceId }, "worker", 7, "foreign"),
    ).rejects.toThrow("lease expired");
    await clearRunTurnCheckpoints(prisma, [{ id: f.run.id, spaceId: otherSpaceId }]);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("keep scoped fixture");
    await prisma.externalEffect.update({
      where: { idempotencyKey: JSON.stringify(["runtime_checkpoint", f.run.id]) },
      data: { result: { invalid: true } },
    });
    await expect(loadRunTurnCheckpoint(prisma, f.run)).rejects.toThrow(
      "Unsupported turn checkpoint",
    );
  });

  it("rejects stale owner/fence writes and drops without losing the current turn", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "keep");
    for (const [owner, fence] of [
      ["other-worker", 7],
      ["worker", 6],
    ] as const) {
      await expect(saveRunTurnCheckpoint(prisma, f.run, owner, fence, "wrong")).rejects.toThrow(
        "lease expired",
      );
      await expect(dropRunTurnCheckpoint(prisma, f.run, owner, fence)).rejects.toThrow(
        "lease expired",
      );
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("keep");
  });

  it("clears a save that acquired the Run lock before cancellation", async () => {
    const f = await seed();
    let entered!: () => void;
    const atUpsert = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This query extension pauses the real transaction after its real Run write lock.
    const blocked = prisma.$extends({
      query: {
        externalEffect: {
          async upsert({ args, query }) {
            entered();
            await gate;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const save = saveRunTurnCheckpoint(blocked, f.run, "worker", 7, "racing save");
    try {
      await Promise.race([
        atUpsert,
        save.then(() => {
          throw new Error("Save bypassed the checkpoint upsert");
        }),
      ]);
      const cancel = prisma.$transaction((tx) => cancelRunsInTransaction(tx, [f.run], new Date()));
      release();
      await save;
      expect(await cancel).toHaveLength(1);
    } finally {
      release();
      await save.catch(() => undefined);
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "cancelled",
    );
  });

  it("rejects a late save when cancellation has already won the Run lock", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "old turn");
    let entered!: () => void;
    const terminalWritten = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = prisma.$transaction(async (tx) => {
      const winners = await cancelRunsInTransaction(tx, [f.run], new Date());
      entered();
      await gate;
      return winners;
    });
    try {
      await Promise.race([
        terminalWritten,
        cancel.then(() => {
          throw new Error("Cancellation bypassed its terminal barrier");
        }),
      ]);
      const late = saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "must not return");
      const rejected = expect(late).rejects.toThrow("lease expired");
      release();
      await cancel;
      await rejected;
    } finally {
      release();
      await cancel.catch(() => undefined);
    }
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
  });

  it("does not cancel or clear a run that completed after the caller's snapshot", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "retained winning state");
    await prisma.run.update({ where: { id: f.run.id }, data: { status: "completed" } });
    expect(
      await prisma.$transaction((tx) => cancelRunsInTransaction(tx, [f.run], new Date())),
    ).toEqual([]);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("retained winning state");
    expect((await prisma.attempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).status).toBe(
      "running",
    );
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe(
      "running",
    );
  });

  it("clears only the finalized turn and rolls checkpoint deletion back on finalization failure", async () => {
    const f = await seed();
    const peer = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "finishing turn");
    await saveRunTurnCheckpoint(prisma, peer.run, "worker", 7, "peer turn");
    await expect(
      finalizeRun(prisma, { ...finishInput(f), attemptId: "missing-attempt" }),
    ).rejects.toThrow("Active run attempt");
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("finishing turn");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "running",
    );
    await expect(finalizeRun(prisma, { ...finishInput(f), leaseFence: 6 })).resolves.toBe(false);
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("finishing turn");
    await expect(finalizeRun(prisma, finishInput(f))).resolves.toEqual({ continuationRunId: null });
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
    expect(await loadRunTurnCheckpoint(prisma, peer.run)).toBe("peer turn");
    const events = await prisma.event.findMany({ where: { runId: f.run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.completed");
    expect(JSON.stringify(events)).not.toContain("finishing turn");
  });

  it("only clears an aged wait after its exact episode wins", async () => {
    const f = await seed();
    await saveRunTurnCheckpoint(prisma, f.run, "worker", 7, "waiting turn");
    const waiting = await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "waiting_input" },
    });
    const input = {
      runId: f.run.id,
      threadId: f.thread.id,
      status: "waiting_input" as const,
      updatedAt: waiting.updatedAt,
      now: new Date(),
    };
    await expect(
      prisma.$transaction((tx) => expireStuckRun(tx, { ...input, updatedAt: new Date(0) })),
    ).resolves.toBeNull();
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBe("waiting turn");
    await expect(prisma.$transaction((tx) => expireStuckRun(tx, input))).resolves.toMatchObject({
      continuationRunId: null,
    });
    expect(await loadRunTurnCheckpoint(prisma, f.run)).toBeUndefined();
  });
});
