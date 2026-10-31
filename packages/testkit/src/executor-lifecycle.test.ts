import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent, AgentSteeringMessage } from "@rakazo/adapter-kit";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import {
  createThreadEvents,
  createThreadMessage,
  loadRunHistoryMessages,
  Prisma,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import * as replyContext from "../../adapters/src/reply-context.js";
import { parseStoredScriptedState, ScriptedStateError } from "../../adapters/src/scripted-state.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;

describeIntegration("run executor lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-executor-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
    });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows only one worker to claim a queued run", async () => {
    const seeded = await seedRun("concurrent", "write a file that says one-claim");

    await Promise.all([
      handles.executor.continueRun(seeded.run.id, "worker-a"),
      handles.executor.continueRun(seeded.run.id, "worker-b"),
    ]);

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 1, status: "completed" });
  });

  it("reclaims an expired running lease with a higher fence", async () => {
    const seeded = await seedRun("expired", "write a file that says recovered", {
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 7,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    });

    await handles.executor.continueRun(seeded.run.id, "recovery-worker");

    const [run, attempts] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findMany({ where: { runId: seeded.run.id } }),
    ]);
    expect(run.status).toBe("completed");
    expect(run.leaseFence).toBe(8);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ fence: 8, status: "completed" });
  });

  it.each(["completed", "cancelled"])("does not rerun a %s run", async (status) => {
    const seeded = await seedRun(`terminal-${status}`, "write a destination record", {
      status,
      completedAt: new Date(),
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "late-worker");

    expect(await handles.prisma.attempt.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(handles.connector.records).toHaveLength(recordsBefore);
    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status });
  });

  it("records an uncertain result without replaying an interrupted external effect", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("uncertain-effect", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "executing",
        request: args,
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, effect] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.externalEffect.findUniqueOrThrow({ where: { idempotencyKey: executionId } }),
    ]);
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(attempt).toMatchObject({ status: "completed", error: null });
    expect(effect).toMatchObject({
      status: "uncertain",
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(handles.connector.records).toHaveLength(recordsBefore);
    expect(
      await handles.prisma.event.count({
        where: { runId: seeded.run.id, type: "effect.reconciled" },
      }),
    ).toBe(1);
  });

  it("recreates the approval pause when an intended effect was interrupted before the card", async () => {
    const prompt = "write this to the destination crm as a note";
    const seeded = await seedRun("interrupted-before-approval", prompt);
    const args = { collection: "notes", title: "Rakazo result", body: prompt };
    const executionId = approvalEffectKey(seeded.run.id, "destination.write", args);
    const effect = await handles.prisma.externalEffect.create({
      data: {
        spaceId: seeded.me.spaceId,
        runId: seeded.run.id,
        kind: "destination.write",
        idempotencyKey: executionId,
        status: "intended",
        request: args,
      },
    });
    await handles.prisma.actionApprovalRule.create({
      data: {
        spaceId: seeded.me.spaceId,
        createdByUserId: seeded.me.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "destination.write",
      },
    });
    const recordsBefore = handles.connector.records.length;

    await handles.executor.continueRun(seeded.run.id, "retry-worker");

    const [run, attempt, message] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findFirstOrThrow({ where: { runId: seeded.run.id } }),
      handles.prisma.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      }),
    ]);
    expect(run.status).toBe("waiting_input");
    expect(attempt.status).toBe("waiting_input");
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ask", approvalEffectId: effect.id, status: "pending" }),
      ]),
    );
    expect(handles.connector.records).toHaveLength(recordsBefore);
  });

  it("fences concurrent terminal commits so only one final message is durable", async () => {
    const seeded = await seedRun("terminal-fence", "finish once", {
      status: "running",
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    const input = {
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "terminal-worker",
      leaseFence: 4,
      outcome: "completed" as const,
      blocks: [{ kind: "text" as const, text: "the one final answer" }],
    };

    const results = await Promise.all([events.finalizeRun(input), events.finalizeRun(input)]);

    expect(results.filter((result) => result === false)).toHaveLength(1);
    expect(results.filter(Boolean)).toEqual([{ continuationRunId: null }]);
    const [run, storedAttempt, task, messages, terminalEvents] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
      handles.prisma.message.findMany({ where: { runId: seeded.run.id } }),
      handles.prisma.event.findMany({
        where: {
          runId: seeded.run.id,
          type: { in: ["thread.message.created", "run.completed"] },
        },
        orderBy: { seq: "asc" },
      }),
    ]);
    expect(run).toMatchObject({ status: "completed", leaseOwner: null, leaseExpiresAt: null });
    expect(storedAttempt.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(messages).toHaveLength(1);
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "thread.message.created",
      "run.completed",
    ]);
  });

  it("rolls back every terminal write when the atomic commit fails", async () => {
    const seeded = await seedRun("terminal-rollback", "do not partially finish", {
      status: "running",
      leaseOwner: "rollback-worker",
      leaseFence: 9,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 9, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);

    await expect(
      events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: "missing-attempt",
        leaseOwner: "rollback-worker",
        leaseFence: 9,
        outcome: "completed",
        blocks: [{ kind: "text", text: "must roll back" }],
      }),
    ).rejects.toThrow();

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "running", leaseOwner: "rollback-worker" });
    await expect(
      handles.prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ status: "running", finishedAt: null });
    await expect(
      handles.prisma.task.findUniqueOrThrow({ where: { id: seeded.task.id } }),
    ).resolves.toMatchObject({ status: "queued" });
    expect(await handles.prisma.message.count({ where: { runId: seeded.run.id } })).toBe(0);
    expect(await handles.prisma.event.count({ where: { runId: seeded.run.id } })).toBe(0);
  });

  it("coalesces steering that races finalization into one durable continuation", async () => {
    const seeded = await seedRun("steering-race", "start the analysis", {
      status: "running",
      leaseOwner: "steering-worker",
      leaseFence: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 3, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    for (const text of ["Use the revised data.", "Keep it concise."]) {
      await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "follow_up",
      });
    }

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "steering-worker",
      leaseFence: 3,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Initial answer" }],
    });

    if (!finalized) throw new Error("Expected the active run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    const [continuation, steering] = await Promise.all([
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
      handles.prisma.steeringMessage.findMany({
        where: { botId: seeded.bot.id },
        orderBy: { message: { seq: "asc" } },
      }),
    ]);
    expect(continuation).toMatchObject({ status: "queued", trigger: "follow_up" });
    expect(continuation.task.prompt).toBe("Respond to the user's steering context.");
    expect(steering).toHaveLength(2);
    expect(steering).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
        expect.objectContaining({ runId: continuationRunId, claimedAt: null }),
      ]),
    );
    const userMessages = await handles.prisma.message.findMany({
      where: { threadId: seeded.thread.id, role: "user" },
      orderBy: { seq: "asc" },
    });
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.seq).toBeLessThan(userMessages[1]!.seq);
  });

  it.each([false, true])(
    "consumes a scripted continuation batch without requeueing it (fresh: %s)",
    async (fresh) => {
      const seeded = await seedRun(`scripted-steering-${fresh}`, "Initial task", {
        status: "running",
        leaseOwner: "initial-worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      });
      const attempt = await handles.prisma.attempt.create({
        data: { runId: seeded.run.id, fence: 2, status: "running" },
      });
      const events = createThreadEvents(handles.prisma);
      const send = (text: string) =>
        events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text }],
          prompt: text,
          trigger: "follow_up",
        });
      for (const text of ["Use the revised data.", "Keep it concise."]) await send(text);
      await expect(
        events.claimSteering({
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          runId: seeded.run.id,
          leaseOwner: "initial-worker",
          leaseFence: 1,
          seenIds: [],
        }),
      ).resolves.toEqual([]);
      expect(
        await handles.prisma.steeringMessage.count({
          where: { runId: seeded.run.id, claimedAt: null },
        }),
      ).toBe(2);
      const finalized = await events.finalizeRun({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        taskId: seeded.task.id,
        attemptId: attempt.id,
        leaseOwner: "initial-worker",
        leaseFence: 2,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Initial answer" }],
      });
      if (!finalized?.continuationRunId) throw new Error("Expected a steering continuation");
      const continuationRunId = finalized.continuationRunId;
      const originalBatch = await handles.prisma.steeringMessage.findMany({
        where: { runId: continuationRunId },
        orderBy: { message: { seq: "asc" } },
      });
      expect(originalBatch).toHaveLength(2);
      const captured: Array<{ runId: string; batch: AgentSteeringMessage[] }> = [];
      const published: string[] = [];
      let freshMessageId: string | undefined;
      const enqueue = handles.jobs.enqueue.bind(handles.jobs);
      // Exercise the real finalizer and its queue publication once per invocation.
      // This boundary keeps a regression from dispatching an unbounded chain of runs.
      const publish = vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
        if (job.name === "run.continue") {
          const run = await handles.prisma.run.findUnique({ where: { id: job.payload.runId } });
          if (run?.botId === seeded.bot.id) {
            published.push(job.payload.runId);
            return;
          }
        }
        await enqueue(job);
      });
      const runRuntime = handles.runtime.run.bind(handles.runtime);
      const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
        if (request.botId !== seeded.bot.id || !request.claimSteering)
          return runRuntime(request, context);
        const claimSteering = request.claimSteering;
        return runRuntime(
          {
            ...request,
            claimSteering: async (seenIds) => {
              const batch = await claimSteering(seenIds);
              captured.push({ runId: request.runId, batch });
              for (const item of batch) {
                await expect(
                  handles.prisma.steeringMessage.findUniqueOrThrow({ where: { id: item.id } }),
                ).resolves.toMatchObject({
                  messageId: item.messageId,
                  runId: request.runId,
                  claimedAt: expect.any(Date),
                });
              }
              if (fresh && request.runId === continuationRunId) {
                freshMessageId = (await send("A fresh message after claim.")).messageId;
              }
              return batch;
            },
          },
          context,
        );
      });
      try {
        await handles.executor.continueRun(continuationRunId, "continuation-worker");
        const pending = await handles.prisma.steeringMessage.findMany({
          where: { botId: seeded.bot.id },
        });
        expect({
          claimedBatches: captured.length,
          pendingMessages: pending.length,
          published,
        }).toEqual({
          claimedBatches: 1,
          pendingMessages: fresh ? 1 : 0,
          published: fresh ? [expect.any(String)] : [],
        });
        expect(captured[0]).toEqual({
          runId: continuationRunId,
          batch: originalBatch.map((item, index) =>
            expect.objectContaining({
              id: item.id,
              messageId: item.messageId,
              historyText: index === 0 ? "Use the revised data." : "Keep it concise.",
            }),
          ),
        });
        const answer = await handles.prisma.message.findMany({
          where: { runId: continuationRunId, role: "bot" },
        });
        const batchAnswer = JSON.stringify(answer.map((item) => item.blocks));
        expect(batchAnswer).toContain("Use the revised data.");
        expect(batchAnswer).toContain("Keep it concise.");
        expect(batchAnswer.indexOf("Use the revised data.")).toBeLessThan(
          batchAnswer.indexOf("Keep it concise."),
        );
        expect(JSON.stringify(answer.map((item) => item.blocks))).not.toContain(
          "done. i handled: Respond to the user's steering context.",
        );
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "completed" });
        if (fresh) {
          expect(pending).toEqual([
            expect.objectContaining({
              messageId: freshMessageId,
              claimedAt: null,
              runId: expect.any(String),
            }),
          ]);
          const nextRunId = pending[0]!.runId!;
          expect(nextRunId).not.toBe(continuationRunId);
          expect(published).toEqual([nextRunId]);
          await handles.executor.continueRun(nextRunId, "fresh-worker");
          expect(captured[1]).toEqual({
            runId: nextRunId,
            batch: [
              expect.objectContaining({
                id: pending[0]!.id,
                messageId: freshMessageId,
                historyText: "A fresh message after claim.",
              }),
            ],
          });
          const freshAnswer = await handles.prisma.message.findMany({
            where: { runId: nextRunId, role: "bot" },
          });
          expect(JSON.stringify(freshAnswer.map((item) => item.blocks))).toContain(
            "done. i handled: A fresh message after claim.",
          );
          expect(published).toEqual([nextRunId]);
        } else {
          expect(pending).toEqual([]);
          expect(published).toEqual([]);
        }
        expect(
          await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } }),
        ).toBe(0);
        expect(
          await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
        ).toBe(0);
        expect(
          await handles.prisma.run.count({
            where: { botId: seeded.bot.id, trigger: { not: "created" } },
          }),
        ).toBe(fresh ? 3 : 2);
      } finally {
        // Cleanup follows the assertions; it cannot make a non-consuming run pass.
        try {
          await handles.prisma.run.updateMany({
            where: { botId: seeded.bot.id, status: { in: ["queued", "leased", "running"] } },
            data: {
              status: "cancelled",
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: new Date(),
            },
          });
        } finally {
          runtime.mockRestore();
          publish.mockRestore();
        }
      }
    },
  );

  it.each([false, true])(
    "keeps pending messages through an ordinary scripted run for one answering continuation (quoted marker: %s)",
    async (quotedMarker) => {
      const prompt = quotedMarker
        ? "Quote this sentence: Respond to the user's steering context."
        : "Finish the original task.";
      const seeded = await seedRun(`scripted-ordinary-pending-${quotedMarker}`, prompt);
      const events = createThreadEvents(handles.prisma);
      const message = await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: "Answer this follow-up separately." }],
        prompt: "Answer this follow-up separately.",
        trigger: "follow_up",
      });
      const steering = await handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, messageId: message.messageId },
      });
      const held = holdContinuationJobs(seeded.bot.id);
      try {
        await handles.executor.continueRun(seeded.run.id, "ordinary-worker");
        const pending = await handles.prisma.steeringMessage.findMany({
          where: { botId: seeded.bot.id },
        });
        expect({ pending: pending.length, publications: held.published.length }).toEqual({
          pending: 1,
          publications: 1,
        });
        expect(pending).toEqual([
          expect.objectContaining({
            id: steering.id,
            messageId: message.messageId,
            runId: held.published[0],
            claimedAt: null,
          }),
        ]);
        const originalAnswer = await handles.prisma.message.findMany({
          where: { runId: seeded.run.id, role: "bot" },
        });
        expect(JSON.stringify(originalAnswer.map((item) => item.blocks))).toContain(
          `done. i handled: ${prompt}`,
        );
        expect(JSON.stringify(originalAnswer.map((item) => item.blocks))).not.toContain(
          "Answer this follow-up separately.",
        );
        await handles.executor.continueRun(held.published[0]!, "answering-worker");
        const followUp = await handles.prisma.message.findMany({
          where: { runId: held.published[0], role: "bot" },
        });
        expect(JSON.stringify(followUp.map((item) => item.blocks))).toContain(
          "done. i handled: Answer this follow-up separately.",
        );
        expect(
          await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } }),
        ).toBe(0);
        expect(
          await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
        ).toBe(0);
        expect(
          await handles.prisma.run.count({
            where: { botId: seeded.bot.id, trigger: { not: "created" } },
          }),
        ).toBe(2);
        expect(held.published).toHaveLength(1);
      } finally {
        await cleanupHeldRuns(seeded.bot.id, held.restore);
      }
    },
  );

  it.each([
    { kind: "memory", prompt: "remember the synthetic orbit preference" },
    { kind: "file", prompt: "Use the revised synthetic orbit plan." },
  ])("persists the claimed steering script's $kind effects", async ({ kind, prompt }) => {
    const { seeded, continuationRunId } = await seedSteeringContinuation(
      `scripted-effects-${kind}`,
      prompt,
    );
    const held = holdContinuationJobs(seeded.bot.id);
    try {
      await handles.executor.continueRun(continuationRunId, "effects-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      const answer = await handles.prisma.message.findMany({
        where: { runId: continuationRunId, role: "bot" },
      });
      const memories = await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
        botId: seeded.bot.id,
      });
      if (kind === "memory") {
        expect(JSON.stringify(answer.map((item) => item.blocks))).toContain(
          "noted — i will keep that in memory.",
        );
        expect(memories.some((item) => item.content === `# Memory\n\n- ${prompt}\n`)).toBe(true);
        await expect(
          rpc(seeded.cookie, "computer/readFile", {
            botId: seeded.bot.id,
            path: "notes/last-task.md",
          }),
        ).rejects.toThrow();
      } else {
        expect(JSON.stringify(answer.map((item) => item.blocks))).toContain(prompt);
        const file = await rpc<{ content: string }>(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/last-task.md",
        });
        expect(file.content).toBe(`# Task\n\n${prompt}\n`);
        expect(file.content).not.toContain("Respond to the user's steering context.");
        expect(memories.some((item) => item.content.includes(prompt))).toBe(false);
      }
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
      expect(held.published).toEqual([]);
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it("does not persist unresolved effects when a hanging scripted continuation stops", async () => {
    const { seeded, continuationRunId } = await seedSteeringContinuation(
      "scripted-unresolved-stop",
      "keep working on the synthetic orbit plan",
    );
    const memoryBefore = await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
      botId: seeded.bot.id,
    });
    const held = holdContinuationJobs(seeded.bot.id);
    let stoppedBeforeHandoff = false;
    const runRuntime = handles.runtime.run.bind(handles.runtime);
    const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
      if (request.runId !== continuationRunId) return runRuntime(request, context);
      return (async function* () {
        for await (const event of runRuntime(request, context)) {
          if (!stoppedBeforeHandoff && event.type === "tool") {
            expect(event.name).toBe("list_files");
            // Stop the real producer before its first tool reaches the executor's lease poll.
            await handles.runtime.abort(request.runId);
            stoppedBeforeHandoff = true;
          }
          yield event;
        }
      })();
    });
    try {
      await handles.executor.continueRun(continuationRunId, "unresolved-stop-worker");
      expect(stoppedBeforeHandoff).toBe(true);
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      const answer = await handles.prisma.message.findMany({
        where: { runId: continuationRunId, role: "bot" },
      });
      expect(JSON.stringify(answer.map((item) => item.blocks))).toContain("stopped");
      await expect(
        rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/last-task.md",
        }),
      ).rejects.toThrow();
      expect(
        await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
          botId: seeded.bot.id,
        }),
      ).toEqual(memoryBefore);
      expect(held.published).toEqual([]);
    } finally {
      await cleanupHeldRuns(seeded.bot.id, () => {
        runtime.mockRestore();
        held.restore();
      });
    }
  });

  it("resumes a paused scripted continuation with its answer on the same run", async () => {
    const { seeded, continuationRunId, steering } = await seedSteeringContinuation(
      "scripted-ask-resume",
      "ask me which city to use",
    );
    const held = holdContinuationJobs(seeded.bot.id);
    try {
      await handles.executor.continueRun(continuationRunId, "ask-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "waiting_input" });
      await expect(
        handles.prisma.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } }),
      ).resolves.toMatchObject({ runId: continuationRunId, claimedAt: expect.any(Date) });
      await rpc(seeded.cookie, "threads/send", {
        botId: seeded.bot.id,
        text: "Paris",
        clientNonce: `scripted-answer-${stamp}`,
      });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "queued" });
      const answered = await handles.prisma.message.findMany({
        where: { runId: continuationRunId, role: "bot" },
      });
      expect(JSON.stringify(answered.map((item) => item.blocks))).toContain('"status":"answered"');
      expect(JSON.stringify(answered.map((item) => item.blocks))).toContain("Paris");
      await handles.executor.continueRun(continuationRunId, "answer-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it("retains a legacy paused continuation instead of guessing its missing progress after an answer", async () => {
    const { seeded, continuationRunId } = await seedSteeringContinuation("scripted-legacy-pause", [
      "ask me which city to use",
      "write this to the destination crm after the legacy answer",
    ]);
    const held = holdContinuationJobs(seeded.bot.id);
    const recordsBefore = handles.connector.records.length;
    const runRuntime = handles.runtime.run.bind(handles.runtime);
    const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
      if (request.runId !== continuationRunId) return runRuntime(request, context);
      // Reproduce an already-paused pre-cursor run without changing its script or trigger.
      const legacy = { ...request };
      delete legacy.onScriptCheckpoint;
      delete legacy.scriptedState;
      delete legacy.scriptedResume;
      return runRuntime(legacy, context);
    });
    try {
      await handles.executor.continueRun(continuationRunId, "legacy-pause-worker");
      runtime.mockRestore();
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "waiting_input", scriptedState: null });
      const [card] = await scriptedAskCards(continuationRunId);
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: card!.message.id,
        answer: "Paris",
      });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "queued" });
      const retained = await handles.prisma.steeringMessage.findMany({
        where: { botId: seeded.bot.id },
        orderBy: { id: "asc" },
      });
      expect(retained).toHaveLength(2);
      const attemptsBefore = await handles.prisma.attempt.count({
        where: { runId: continuationRunId },
      });
      await handles.executor.continueRun(continuationRunId, "new-cursor-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({
        status: "queued",
        scriptedState: null,
        error: "Scripted continuation progress could not be verified",
      });
      expect(await handles.prisma.attempt.count({ where: { runId: continuationRunId } })).toBe(
        attemptsBefore,
      );
      expect(
        await handles.prisma.steeringMessage.findMany({
          where: { botId: seeded.bot.id },
          orderBy: { id: "asc" },
        }),
      ).toEqual(retained);
      expect(handles.connector.records).toHaveLength(recordsBefore);
      expect(
        await handles.prisma.externalEffect.count({ where: { runId: continuationRunId } }),
      ).toBe(0);
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
    } finally {
      await cleanupHeldRuns(seeded.bot.id, () => {
        runtime.mockRestore();
        held.restore();
      });
    }
  });

  it.sequential.each([
    {
      kind: "ask",
      prompt: "ask me which city to use",
      phase: "ask",
      status: "waiting_input",
      event: "run.waiting_input",
    },
    {
      kind: "takeover",
      prompt: "take over so I can sign in",
      phase: "takeover",
      status: "waiting_takeover",
      event: "computer.takeover.requested",
    },
  ] as const)(
    "rolls back the $kind pause transaction when its scripted receipt cannot be saved",
    async ({ kind, prompt, phase, status, event }) => {
      const { seeded, continuationRunId } = await seedSteeringContinuation(
        `scripted-pause-receipt-${kind}`,
        [
          "remember the synthetic pause-receipt preference",
          prompt,
          "Use the synthetic pause receipt recovery plan.",
        ],
      );
      const held = holdContinuationJobs(seeded.bot.id);
      const memoryBefore = await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id });
      let functionInstalled = false;
      let triggerInstalled = false;
      const removeFault = async () => {
        if (triggerInstalled) {
          await handles.prisma.$executeRawUnsafe(
            "DROP TRIGGER test_scripted_pause_receipt_failure ON runs",
          );
          triggerInstalled = false;
        }
        if (functionInstalled) {
          await handles.prisma.$executeRawUnsafe(
            "DROP FUNCTION test_scripted_pause_receipt_failure()",
          );
          functionInstalled = false;
        }
      };
      try {
        // Static fixture DDL targets the real receipt UPDATE inside the pause transaction.
        // Both parameterized cases are serial and use this suite's temporary database.
        await handles.prisma.$executeRawUnsafe(`
          CREATE FUNCTION test_scripted_pause_receipt_failure() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."scriptedState" ? 'pause'
               AND NOT COALESCE(OLD."scriptedState" ? 'pause', false) THEN
              RAISE EXCEPTION 'Synthetic scripted pause receipt failure';
            END IF;
            RETURN NEW;
          END;
          $$
        `);
        functionInstalled = true;
        await handles.prisma.$executeRawUnsafe(`
          CREATE TRIGGER test_scripted_pause_receipt_failure
          BEFORE UPDATE OF "scriptedState" ON runs
          FOR EACH ROW EXECUTE FUNCTION test_scripted_pause_receipt_failure()
        `);
        triggerInstalled = true;

        await handles.executor.continueRun(continuationRunId, "receipt-failure-worker");
        const retained = await handles.prisma.run.findUniqueOrThrow({
          where: { id: continuationRunId },
        });
        expect(retained).toMatchObject({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          error: "Scripted continuation progress could not be verified",
        });
        const cursor = parseStoredScriptedState(retained.scriptedState, continuationRunId);
        expect(cursor.state.cursor.phase).toBe(phase);
        expect(cursor.pause).toBeUndefined();
        expect(
          await handles.prisma.attempt.findMany({
            where: { runId: continuationRunId },
            select: { status: true },
          }),
        ).toEqual([{ status: "failed" }]);
        expect(await scriptedAskCards(continuationRunId)).toHaveLength(0);
        if (kind === "takeover") {
          const messages = await handles.prisma.message.findMany({
            where: { runId: continuationRunId, role: "bot" },
          });
          const computerCards = messages.flatMap((message) =>
            MessageBlockSchema.array()
              .parse(message.blocks)
              .filter((block) => block.kind === "computer"),
          );
          expect
            .soft(computerCards, "failed takeover receipt rolls back its computer card")
            .toHaveLength(0);
        }
        expect(
          await handles.prisma.event.count({
            where: { runId: continuationRunId, type: event },
          }),
        ).toBe(0);
        const rows = await handles.prisma.steeringMessage.findMany({
          where: { botId: seeded.bot.id },
          orderBy: { id: "asc" },
        });
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.runId === continuationRunId && row.claimedAt !== null)).toBe(
          true,
        );
        expect(
          await handles.prisma.externalEffect.count({ where: { runId: continuationRunId } }),
        ).toBe(0);
        expect(await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id })).toEqual(
          memoryBefore,
        );
        await expect(
          rpc(seeded.cookie, "computer/readFile", {
            botId: seeded.bot.id,
            path: "notes/last-task.md",
          }),
        ).rejects.toThrow();

        await removeFault();
        await handles.executor.continueRun(continuationRunId, "receipt-retry-worker");
        const paused = await handles.prisma.run.findUniqueOrThrow({
          where: { id: continuationRunId },
        });
        expect(paused).toMatchObject({ status, error: null });
        const saved = parseStoredScriptedState(paused.scriptedState, continuationRunId);
        expect(saved.pause?.kind).toBe(kind === "ask" ? "input" : "takeover");
        expect(
          await handles.prisma.attempt.findMany({
            where: { runId: continuationRunId },
            orderBy: { startedAt: "asc" },
            select: { status: true },
          }),
        ).toEqual([{ status: "failed" }, { status }]);
        const cards = await scriptedAskCards(continuationRunId);
        expect(cards).toHaveLength(kind === "ask" ? 1 : 0);
        if (kind === "takeover") {
          const messages = await handles.prisma.message.findMany({
            where: { runId: continuationRunId, role: "bot" },
          });
          const computerCards = messages.flatMap((message) =>
            MessageBlockSchema.array()
              .parse(message.blocks)
              .filter((block) => block.kind === "computer"),
          );
          expect
            .soft(computerCards, "retried takeover publishes exactly one computer card")
            .toHaveLength(1);
        }
        if (kind === "ask") expect(saved.pause?.messageId).toBe(cards[0]!.message.id);
        const receipts = await handles.prisma.event.findMany({
          where: { runId: continuationRunId, type: event },
        });
        expect(receipts).toHaveLength(1);
        if (kind === "takeover") expect(saved.pause?.eventSeq).toBe(receipts[0]!.seq);
        expect(
          await handles.prisma.steeringMessage.findMany({
            where: { botId: seeded.bot.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(rows);
        expect(
          await handles.prisma.externalEffect.count({ where: { runId: continuationRunId } }),
        ).toBe(0);
        expect(await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id })).toEqual(
          memoryBefore,
        );
      } finally {
        try {
          await removeFault();
        } finally {
          try {
            await rpc(seeded.cookie, "threads/stop", { botId: seeded.bot.id });
          } finally {
            await cleanupHeldRuns(seeded.bot.id, held.restore);
          }
        }
      }
    },
  );

  it("recovers a complete cursor after lease loss before deferred effects are committed", async () => {
    const preference = "remember the synthetic recovered-completion preference";
    const finalPrompt = "Use the synthetic recovered completion plan.";
    const { seeded, continuationRunId } = await seedSteeringContinuation(
      "scripted-complete-recovery",
      ["write this to the destination crm before recovering completion", preference, finalPrompt],
    );
    const held = holdContinuationJobs(seeded.bot.id);
    const memoryBefore = await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id });
    const recordsBefore = handles.connector.records.length;
    let interrupted = false;
    const runRuntime = handles.runtime.run.bind(handles.runtime);
    const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
      if (request.runId !== continuationRunId) return runRuntime(request, context);
      const save = request.onScriptCheckpoint;
      if (!save) throw new Error("Expected a durable scripted checkpoint callback");
      return runRuntime(
        {
          ...request,
          onScriptCheckpoint: async (state) => {
            await save(state);
            if (!interrupted && state.cursor.phase === "complete") {
              interrupted = true;
              await handles.prisma.run.update({
                where: { id: continuationRunId },
                data: {
                  leaseOwner: "replacement-completion-worker",
                  leaseFence: { increment: 1 },
                  leaseExpiresAt: new Date(Date.now() - 60_000),
                },
              });
              throw new ScriptedStateError();
            }
          },
        },
        context,
      );
    });
    try {
      await handles.executor.continueRun(continuationRunId, "interrupted-completion-worker");
      runtime.mockRestore();
      expect(interrupted).toBe(true);
      const interruptedRun = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      expect(interruptedRun).toMatchObject({
        status: "running",
        leaseOwner: "replacement-completion-worker",
      });
      const saved = parseStoredScriptedState(interruptedRun.scriptedState, continuationRunId);
      expect(saved.state.cursor.phase).toBe("complete");
      expect(saved.state.script.flatMap((turn) => turn.files ?? [])).toContainEqual({
        path: "notes/last-task.md",
        content: `# Task\n\n${finalPrompt}\n`,
      });
      expect(saved.state.script.flatMap((turn) => turn.memory ?? [])).toContainEqual({
        scope: "bot",
        path: "MEMORY.md",
        content: `# Memory\n\n- ${preference}\n`,
      });
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        3,
      );
      expect(await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id })).toEqual(
        memoryBefore,
      );
      await expect(
        rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/last-task.md",
        }),
      ).rejects.toThrow();
      expect(handles.connector.records).toHaveLength(recordsBefore + 1);
      const effectsBefore = await handles.prisma.externalEffect.findMany({
        where: { runId: continuationRunId },
      });
      expect(effectsBefore).toHaveLength(1);
      expect(effectsBefore[0]).toMatchObject({ kind: "destination.write", status: "completed" });
      // The lost worker has returned; only this fixture makes its durable progress runnable.
      await handles.prisma.run.update({
        where: { id: continuationRunId },
        data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
      });
      await handles.executor.continueRun(continuationRunId, "recovered-completion-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(
        await rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/last-task.md",
        }),
      ).toMatchObject({ content: `# Task\n\n${finalPrompt}\n` });
      expect(
        await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
          botId: seeded.bot.id,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: `# Memory\n\n- ${preference}\n` }),
        ]),
      );
      expect(handles.connector.records).toHaveLength(recordsBefore + 1);
      const effectsAfter = await handles.prisma.externalEffect.findMany({
        where: { runId: continuationRunId },
      });
      expect(effectsAfter).toHaveLength(1);
      expect(effectsAfter[0]).toMatchObject({
        id: effectsBefore[0]!.id,
        idempotencyKey: effectsBefore[0]!.idempotencyKey,
        request: effectsBefore[0]!.request,
        status: "completed",
      });
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, () => {
        runtime.mockRestore();
        held.restore();
      });
    }
  });

  it("reuses the committed effect when its cursor advance fails before an identical suffix tool", async () => {
    const requestText = "write this to the destination crm as an identical recovery note";
    const { seeded, continuationRunId } = await seedSteeringContinuation(
      "scripted-effect-advance-recovery",
      [requestText, requestText],
    );
    const held = holdContinuationJobs(seeded.bot.id);
    const recordsBefore = handles.connector.records.length;
    let interrupted = false;
    const runRuntime = handles.runtime.run.bind(handles.runtime);
    const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
      if (request.runId !== continuationRunId) return runRuntime(request, context);
      const save = request.onScriptCheckpoint;
      if (!save) throw new Error("Expected a durable scripted checkpoint callback");
      return runRuntime(
        {
          ...request,
          onScriptCheckpoint: async (state) => {
            if (
              !interrupted &&
              state.cursor.phase === "after-tools" &&
              state.cursor.ordinal === 1
            ) {
              interrupted = true;
              throw new ScriptedStateError();
            }
            await save(state);
          },
        },
        context,
      );
    });
    try {
      await handles.executor.continueRun(continuationRunId, "effect-advance-worker");
      runtime.mockRestore();
      expect(interrupted).toBe(true);
      const retained = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      expect(retained).toMatchObject({
        status: "queued",
        error: "Scripted continuation progress could not be verified",
      });
      const saved = parseStoredScriptedState(retained.scriptedState, continuationRunId);
      expect(saved.state.cursor).toMatchObject({ phase: "tool", ordinal: 0 });
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        2,
      );
      expect(handles.connector.records).toHaveLength(recordsBefore + 1);
      const first = await handles.prisma.externalEffect.findMany({
        where: { runId: continuationRunId },
        orderBy: { createdAt: "asc" },
      });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ status: "completed" });
      expect(saved.pendingEffect).toMatchObject({
        id: first[0]!.id,
        idempotencyKey: first[0]!.idempotencyKey,
      });
      await handles.executor.continueRun(continuationRunId, "effect-advance-recovery-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(handles.connector.records).toHaveLength(recordsBefore + 2);
      const recovered = await handles.prisma.externalEffect.findMany({
        where: { runId: continuationRunId },
        orderBy: { createdAt: "asc" },
      });
      expect(recovered).toHaveLength(2);
      expect(recovered[0]).toMatchObject({
        id: first[0]!.id,
        idempotencyKey: first[0]!.idempotencyKey,
        request: first[0]!.request,
        status: "completed",
      });
      expect(recovered[0]!.request).toEqual(recovered[1]!.request);
      expect(new Set(recovered.map((effect) => effect.idempotencyKey)).size).toBe(2);
      expect(recovered.map((effect) => effect.status)).toEqual(["completed", "completed"]);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, () => {
        runtime.mockRestore();
        held.restore();
      });
    }
  });

  it("retains deferred prefix effects, untouched suffix and fresh steering across an answer", async () => {
    const preference = "remember the synthetic resume-prefix preference";
    const { seeded, events, continuationRunId } = await seedSteeringContinuation(
      "scripted-resume-batch",
      [
        preference,
        "ask me which city to use",
        "write a file called notes/resume-suffix.txt that says suffix-retained",
      ],
    );
    const held = holdContinuationJobs(seeded.bot.id);
    const memoryBefore = await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id });
    try {
      await handles.executor.continueRun(continuationRunId, "batch-pause-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "waiting_input" });
      expect(await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id })).toEqual(
        memoryBefore,
      );
      await expect(
        rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/resume-suffix.txt",
        }),
      ).rejects.toThrow();
      const fresh = "write a file called notes/resume-fresh.txt that says fresh-retained";
      await events.sendUserMessage({
        spaceId: seeded.me.spaceId,
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        userId: seeded.me.userId,
        blocks: [{ kind: "text", text: fresh }],
        prompt: fresh,
        trigger: "follow_up",
      });
      // Inbound steering is not an answer to the pending card.
      await handles.executor.continueRun(continuationRunId, "still-waiting-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "waiting_input" });
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        4,
      );
      const [card] = await scriptedAskCards(continuationRunId);
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: card!.message.id,
        answer: "Paris",
      });
      await handles.executor.continueRun(continuationRunId, "batch-resume-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(
        await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
          botId: seeded.bot.id,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: `# Memory\n\n- ${preference}\n` }),
        ]),
      );
      for (const [file, content] of [
        ["notes/resume-suffix.txt", "suffix-retained\n"],
        ["notes/resume-fresh.txt", "fresh-retained\n"],
      ]) {
        expect(
          await rpc(seeded.cookie, "computer/readFile", { botId: seeded.bot.id, path: file }),
        ).toMatchObject({ content });
      }
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it("requires a distinct answer for each ask in the same scripted run", async () => {
    const { seeded, continuationRunId } = await seedSteeringContinuation("scripted-two-asks", [
      "ask me which city to use",
      "ask me which city to use",
      "remember both answers completed",
    ]);
    const held = holdContinuationJobs(seeded.bot.id);
    try {
      await handles.executor.continueRun(continuationRunId, "first-question-worker");
      const [first] = await scriptedAskCards(continuationRunId);
      expect(first!.ask.status).not.toBe("answered");
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: first!.message.id,
        answer: "Paris",
      });
      await handles.executor.continueRun(continuationRunId, "second-question-worker");
      const cards = await scriptedAskCards(continuationRunId);
      expect(cards).toHaveLength(2);
      expect(cards.filter(({ ask }) => ask.status === "answered")).toHaveLength(1);
      const second = cards.find(({ ask }) => ask.status !== "answered")!;
      expect(second.message.id).not.toBe(first!.message.id);
      await handles.executor.continueRun(continuationRunId, "old-answer-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "waiting_input" });
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(2);
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: second.message.id,
        answer: "Tokyo",
      });
      await handles.executor.continueRun(continuationRunId, "second-answer-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect((await scriptedAskCards(continuationRunId)).map(({ ask }) => ask.status)).toEqual([
        "answered",
        "answered",
      ]);
      expect((await scriptedAskCards(continuationRunId)).map(({ ask }) => ask.answer)).toEqual([
        "Paris",
        "Tokyo",
      ]);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it("resumes a choice without replacing its frozen suffix or native checkpoint semantics", async () => {
    const { seeded, continuationRunId } = await seedSteeringContinuation("scripted-choice-resume", [
      "show tappable choices",
      "write a file called notes/choice-suffix.txt that says choice-retained",
    ]);
    const held = holdContinuationJobs(seeded.bot.id);
    try {
      await handles.executor.continueRun(continuationRunId, "choice-pause-worker");
      const paused = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      expect(paused).toMatchObject({ status: "waiting_input", scriptedState: expect.any(Object) });
      expect(paused.checkpoint).toContain("Seoul");
      const [card] = await scriptedAskCards(continuationRunId);
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: card!.message.id,
        answer: "choice-2",
      });
      const queued = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      expect(queued).toMatchObject({ status: "queued", checkpoint: null });
      const task = await handles.prisma.task.findUniqueOrThrow({ where: { id: queued.taskId } });
      expect(task.prompt).toBe("Selected choice choice-2: Seoul");
      await handles.executor.continueRun(continuationRunId, "choice-answer-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
      expect(
        await rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/choice-suffix.txt",
        }),
      ).toMatchObject({ content: "choice-retained\n" });
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it.each(["done", "skipped"] as const)(
    "resumes takeover %s once and preserves the suffix and fresh steering",
    async (reason) => {
      const { seeded, events, continuationRunId } = await seedSteeringContinuation(
        `scripted-takeover-${reason}`,
        [
          "take over so I can sign in",
          "write a file called notes/takeover-suffix.txt that says takeover-retained",
        ],
      );
      const held = holdContinuationJobs(seeded.bot.id);
      let controlled = false;
      try {
        await handles.executor.continueRun(continuationRunId, "takeover-pause-worker");
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "waiting_takeover" });
        const fresh = "remember the synthetic takeover-fresh preference";
        await events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text: fresh }],
          prompt: fresh,
          trigger: "follow_up",
        });
        await handles.executor.continueRun(continuationRunId, "unreleased-takeover-worker");
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "waiting_takeover" });
        await rpc(seeded.cookie, "computer/boot", { botId: seeded.bot.id });
        await rpc(seeded.cookie, "computer/takeover", { botId: seeded.bot.id });
        controlled = true;
        await rpc(seeded.cookie, "computer/release", { botId: seeded.bot.id, reason });
        controlled = false;
        await handles.executor.continueRun(continuationRunId, "takeover-resume-worker");
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(
          await handles.prisma.event.count({
            where: {
              runId: continuationRunId,
              type: "computer.takeover.released",
            },
          }),
        ).toBe(1);
        const messages = await handles.prisma.message.findMany({
          where: { runId: continuationRunId, role: "bot" },
        });
        expect(JSON.stringify(messages.map((message) => message.blocks))).toContain(
          reason === "done" ? "signed in." : "login was skipped.",
        );
        expect(
          await rpc(seeded.cookie, "computer/readFile", {
            botId: seeded.bot.id,
            path: "notes/takeover-suffix.txt",
          }),
        ).toMatchObject({ content: "takeover-retained\n" });
        expect(
          await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
            botId: seeded.bot.id,
          }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: `# Memory\n\n- ${fresh}\n` }),
          ]),
        );
        expect(
          await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } }),
        ).toBe(0);
      } finally {
        try {
          if (controlled) await rpc(seeded.cookie, "computer/release", { botId: seeded.bot.id });
        } finally {
          await cleanupHeldRuns(seeded.bot.id, held.restore);
        }
      }
    },
  );

  it.each(["allow", "always"] as const)(
    "retains occurrence and exact pending effect identity when resuming approval with %s",
    async (answer) => {
      const request = "write this to the destination crm as a synthetic resume note";
      const { seeded, continuationRunId } = await seedSteeringContinuation(
        `scripted-approval-${answer}`,
        [request, "ask me which city to use", request],
      );
      const held = holdContinuationJobs(seeded.bot.id);
      const recordsBefore = handles.connector.records.length;
      try {
        await handles.executor.continueRun(continuationRunId, "effect-prefix-worker");
        expect(handles.connector.records).toHaveLength(recordsBefore + 1);
        const [question] = await scriptedAskCards(continuationRunId);
        await handles.prisma.actionApprovalRule.create({
          data: {
            spaceId: seeded.me.spaceId,
            createdByUserId: seeded.me.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "destination.write",
          },
        });
        await rpc(seeded.cookie, "threads/answer", {
          botId: seeded.bot.id,
          runId: continuationRunId,
          messageId: question!.message.id,
          answer: "Paris",
        });
        await handles.executor.continueRun(continuationRunId, "approval-pause-worker");
        expect(handles.connector.records).toHaveLength(recordsBefore + 1);
        const before = await handles.prisma.externalEffect.findMany({
          where: { runId: continuationRunId, kind: "destination.write" },
          orderBy: { createdAt: "asc" },
        });
        expect(before).toHaveLength(2);
        expect(before[0]!.request).toEqual(before[1]!.request);
        expect(new Set(before.map((effect) => effect.idempotencyKey)).size).toBe(2);
        expect(before.map((effect) => effect.status)).toEqual(["completed", "intended"]);
        const approval = (await scriptedAskCards(continuationRunId)).find(
          ({ ask }) => ask.status !== "answered",
        )!;
        expect(approval.ask).toMatchObject({ approvalEffectId: before[1]!.id });
        await rpc(seeded.cookie, "threads/answer", {
          botId: seeded.bot.id,
          runId: continuationRunId,
          messageId: approval.message.id,
          answer,
        });
        await handles.executor.continueRun(continuationRunId, "approval-resume-worker");
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(handles.connector.records).toHaveLength(recordsBefore + 2);
        const after = await handles.prisma.externalEffect.findMany({
          where: { runId: continuationRunId, kind: "destination.write" },
          orderBy: { createdAt: "asc" },
        });
        expect(after.map(({ id, idempotencyKey }) => ({ id, idempotencyKey }))).toEqual(
          before.map(({ id, idempotencyKey }) => ({ id, idempotencyKey })),
        );
        expect(after.map((effect) => effect.status)).toEqual(["completed", "completed"]);
        expect(await scriptedAskCards(continuationRunId)).toHaveLength(2);
        expect(
          await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } }),
        ).toBe(0);
      } finally {
        await cleanupHeldRuns(seeded.bot.id, held.restore);
      }
    },
  );

  it("resumes the exact protected secret tool without using a changed task prompt", async () => {
    const { seeded, continuationRunId } = await seedSteeringContinuation("scripted-secret-resume", [
      "show a secret card",
      "write a file called notes/secret-suffix.txt that says secret-retained",
    ]);
    const held = holdContinuationJobs(seeded.bot.id);
    const secret = "fake-scripted-resume-api-key";
    try {
      await handles.executor.continueRun(continuationRunId, "secret-pause-worker");
      const paused = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      const originalTask = await handles.prisma.task.findUniqueOrThrow({
        where: { id: paused.taskId },
      });
      const before = await handles.prisma.externalEffect.findFirstOrThrow({
        where: { runId: continuationRunId, kind: "request_secret" },
      });
      const [card] = await scriptedAskCards(continuationRunId);
      expect(card!.ask).toMatchObject({ input: "secret", status: "pending" });
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: continuationRunId,
        messageId: card!.message.id,
        answer: secret,
      });
      await expect(
        handles.prisma.task.findUniqueOrThrow({ where: { id: paused.taskId } }),
      ).resolves.toMatchObject({ prompt: originalTask.prompt });
      await handles.executor.continueRun(continuationRunId, "secret-resume-worker");
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
      ).resolves.toMatchObject({ status: "completed" });
      const effects = await handles.prisma.externalEffect.findMany({
        where: { runId: continuationRunId, kind: "request_secret" },
      });
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        id: before.id,
        idempotencyKey: before.idempotencyKey,
        status: "completed",
      });
      expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
      expect(
        await rpc(seeded.cookie, "computer/readFile", {
          botId: seeded.bot.id,
          path: "notes/secret-suffix.txt",
        }),
      ).toMatchObject({ content: "secret-retained\n" });
      const messages = await handles.prisma.message.findMany({
        where: { runId: continuationRunId },
      });
      expect(JSON.stringify(messages)).not.toContain(secret);
      const completed = await handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId },
      });
      expect(JSON.stringify(completed.scriptedState)).not.toContain(secret);
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    } finally {
      await cleanupHeldRuns(seeded.bot.id, held.restore);
    }
  });

  it.each(["missing", "malformed", "wrong run", "edited source", "deleted source"] as const)(
    "retains the claimed batch and blocks effects when resume state has %s",
    async (damage) => {
      const { seeded, continuationRunId, steering, message } = await seedSteeringContinuation(
        `scripted-corrupt-${damage.replaceAll(" ", "-")}`,
        ["ask me which city to use", "write this to the destination crm as a protected suffix"],
      );
      const held = holdContinuationJobs(seeded.bot.id);
      const recordsBefore = handles.connector.records.length;
      try {
        await handles.executor.continueRun(continuationRunId, "state-pause-worker");
        const paused = await handles.prisma.run.findUniqueOrThrow({
          where: { id: continuationRunId },
        });
        expect(paused.scriptedState).toEqual(expect.any(Object));
        const [card] = await scriptedAskCards(continuationRunId);
        await rpc(seeded.cookie, "threads/answer", {
          botId: seeded.bot.id,
          runId: continuationRunId,
          messageId: card!.message.id,
          answer: "Paris",
        });
        if (damage === "missing" || damage === "malformed") {
          await handles.prisma.run.update({
            where: { id: continuationRunId },
            data: { scriptedState: damage === "missing" ? Prisma.DbNull : {} },
          });
        } else if (damage === "wrong run") {
          const state = paused.scriptedState;
          if (!state || typeof state !== "object" || Array.isArray(state))
            throw new Error("Expected saved state object");
          await handles.prisma.run.update({
            where: { id: continuationRunId },
            data: {
              scriptedState: { ...state, runId: seeded.run.id },
            },
          });
        } else if (damage === "edited source") {
          await handles.prisma.message.update({
            where: { id: message.messageId },
            data: {
              blocks: [
                { kind: "text", text: "write this to the destination crm as edited content" },
              ],
            },
          });
        } else {
          await handles.prisma.message.delete({ where: { id: message.messageId } });
        }
        const remaining = await handles.prisma.steeringMessage.findMany({
          where: { botId: seeded.bot.id },
          orderBy: { id: "asc" },
        });
        expect(remaining).toHaveLength(damage === "deleted source" ? 1 : 2);
        if (damage !== "deleted source")
          expect(remaining.some((row) => row.id === steering.id)).toBe(true);
        await handles.executor.continueRun(continuationRunId, "invalid-state-worker");
        const rejected = await handles.prisma.run.findUniqueOrThrow({
          where: { id: continuationRunId },
        });
        expect(rejected.status).not.toBe("completed");
        expect(handles.connector.records).toHaveLength(recordsBefore);
        expect(
          await handles.prisma.steeringMessage.findMany({
            where: { botId: seeded.bot.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(remaining);
        expect(await scriptedAskCards(continuationRunId)).toHaveLength(1);
      } finally {
        await cleanupHeldRuns(seeded.bot.id, held.restore);
      }
    },
  );

  it.each(["after resolution", "mid tool", "after done"] as const)(
    "does not persist deferred effects when a resolved script stops %s",
    async (stage) => {
      const fixture =
        stage === "mid tool"
          ? await (async () => {
              const seeded = await seedRun(
                "resolved-stop-mid-tool",
                "Explicit deferred effects fixture.",
              );
              return { seeded, continuationRunId: seeded.run.id };
            })()
          : await seedSteeringContinuation(
              `resolved-stop-${stage.replaceAll(" ", "-")}`,
              "remember the synthetic resolved-stop preference",
            );
      const { seeded, continuationRunId } = fixture;
      const held = holdContinuationJobs(seeded.bot.id);
      const memoryBefore = await rpc<Array<{ content: string }>>(seeded.cookie, "memory/list", {
        botId: seeded.bot.id,
      });
      let stopped = false;
      const runRuntime = handles.runtime.run.bind(handles.runtime);
      const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
        if (request.runId !== continuationRunId) return runRuntime(request, context);
        const input =
          stage === "mid tool"
            ? {
                ...request,
                isSteeringContinuation: false,
                script: [
                  {
                    assistant: "selected fixture",
                    toolCalls: [{ name: "list_files", args: { path: "" } }],
                    files: [{ path: "notes/deferred-stop.txt", content: "must not persist" }],
                    memory: [
                      { scope: "bot" as const, path: "MEMORY.md", content: "must not persist" },
                    ],
                    complete: true,
                  },
                ],
              }
            : request;
        return (async function* () {
          for await (const event of runRuntime(input, context)) {
            if (
              !stopped &&
              ((stage === "after resolution" && event.type === "progress") ||
                (stage === "after done" && event.type === "done"))
            ) {
              await handles.runtime.abort(request.runId);
              stopped = true;
            }
            yield event;
          }
        })();
      });
      const listFiles = handles.sandbox.listFiles.bind(handles.sandbox);
      const list = vi.spyOn(handles.sandbox, "listFiles").mockImplementation(async (...args) => {
        if (stage === "mid tool" && args[2].runId === continuationRunId && !stopped) {
          await handles.runtime.abort(continuationRunId);
          stopped = true;
        }
        return listFiles(...args);
      });
      try {
        await handles.executor.continueRun(continuationRunId, "resolved-stop-worker");
        expect(stopped).toBe(true);
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(await rpc(seeded.cookie, "memory/list", { botId: seeded.bot.id })).toEqual(
          memoryBefore,
        );
        await expect(
          rpc(seeded.cookie, "computer/readFile", {
            botId: seeded.bot.id,
            path: "notes/deferred-stop.txt",
          }),
        ).rejects.toThrow();
      } finally {
        await cleanupHeldRuns(seeded.bot.id, () => {
          list.mockRestore();
          runtime.mockRestore();
          held.restore();
        });
      }
    },
  );

  it.each([false, true])(
    "persists every independent batch effect (reversed: %s)",
    async (reverse) => {
      const prompts = [
        "save shared memory ROUTING.md with: orbit-shared-ok",
        "write a file called notes/orbit.txt that says orbit-file-ok",
      ];
      if (reverse) prompts.reverse();
      const { seeded, continuationRunId } = await seedSteeringContinuation(
        `independent-batch-${reverse}`,
        prompts,
      );
      const held = holdContinuationJobs(seeded.bot.id);
      try {
        await handles.executor.continueRun(continuationRunId, "independent-batch-worker");
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "completed" });
        expect(
          await rpc<Array<{ path: string; content: string }>>(seeded.cookie, "memory/list", {
            scope: "user",
          }),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "ROUTING.md", content: "orbit-shared-ok" }),
          ]),
        );
        expect(
          (
            await rpc<{ content: string }>(seeded.cookie, "computer/readFile", {
              botId: seeded.bot.id,
              path: "notes/orbit.txt",
            })
          ).content,
        ).toBe("orbit-file-ok\n");
        expect(
          await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } }),
        ).toBe(0);
        expect(held.published).toEqual([]);
      } finally {
        await cleanupHeldRuns(seeded.bot.id, held.restore);
      }
    },
  );

  it.each([
    { kind: "steered failure", fresh: false },
    { kind: "steered failure", fresh: true },
    { kind: "reply-context failure", fresh: false },
    { kind: "reply-context failure", fresh: true },
  ])(
    "bounds a scripted $kind after claiming its batch (fresh: $fresh)",
    async ({ kind, fresh }) => {
      const input = kind === "steered failure" ? "fail this run" : "Use the queued context.";
      const fixture = await seedSteeringContinuation(
        `sc-${kind === "steered failure" ? "steered" : "reply"}-${fresh}`,
        input,
      );
      const { seeded, events, continuationRunId, message, steering } = fixture;
      const held = holdContinuationJobs(seeded.bot.id);
      const recordsBefore = handles.connector.records.length;
      const observed: AgentRuntimeEvent[] = [];
      let claimedAtFailure = false;
      let freshMessage: Awaited<ReturnType<typeof events.sendUserMessage>> | undefined;
      const sendFresh = async () => {
        freshMessage = await events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text: "Use the fresh context." }],
          prompt: "Use the fresh context.",
          trigger: "follow_up",
        });
        expect(freshMessage.seq).toBeGreaterThan(message.seq);
      };
      const loadReply = replyContext.loadReplyContext;
      const reply = vi
        .spyOn(replyContext, "loadReplyContext")
        .mockImplementation(async (prisma, threadId, messageId) => {
          if (kind === "reply-context failure" && messageId === message.messageId) {
            const row = await handles.prisma.steeringMessage.findUniqueOrThrow({
              where: { id: steering.id },
            });
            if (row.runId === continuationRunId && row.claimedAt) {
              // The real database claim has committed; fail the subsequent context read.
              claimedAtFailure = true;
              if (fresh) await sendFresh();
              throw new Error("Reply context unavailable");
            }
          }
          return loadReply(prisma, threadId, messageId);
        });
      const runRuntime = handles.runtime.run.bind(handles.runtime);
      const runtime = vi.spyOn(handles.runtime, "run").mockImplementation((request, context) => {
        if (request.runId !== continuationRunId || !request.claimSteering)
          return runRuntime(request, context);
        const claimSteering = request.claimSteering;
        return (async function* () {
          for await (const event of runRuntime(
            {
              ...request,
              claimSteering: async (seenIds) => {
                const batch = await claimSteering(seenIds);
                if (kind === "steered failure") {
                  expect(batch).toEqual([
                    expect.objectContaining({ id: steering.id, messageId: message.messageId }),
                  ]);
                  const row = await handles.prisma.steeringMessage.findUniqueOrThrow({
                    where: { id: steering.id },
                  });
                  expect(row).toMatchObject({
                    runId: continuationRunId,
                    claimedAt: expect.any(Date),
                  });
                  claimedAtFailure = true;
                  if (fresh) await sendFresh();
                }
                return batch;
              },
            },
            context,
          )) {
            observed.push(event);
            yield event;
          }
        })();
      });
      const error =
        kind === "steered failure" ? "Scripted run failure" : "Reply context unavailable";
      try {
        await handles.executor.continueRun(continuationRunId, "failing-worker");
        expect(claimedAtFailure).toBe(true);
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: continuationRunId } }),
        ).resolves.toMatchObject({ status: "failed", error });
        await expect(
          handles.prisma.attempt.findFirstOrThrow({ where: { runId: continuationRunId } }),
        ).resolves.toMatchObject({ status: "failed", error });
        expect(observed).toEqual([]);
        expect(
          await handles.prisma.message.count({ where: { runId: continuationRunId, role: "bot" } }),
        ).toBe(0);
        expect(
          await handles.prisma.externalEffect.count({ where: { runId: continuationRunId } }),
        ).toBe(0);
        expect(handles.connector.records).toHaveLength(recordsBefore);
        await expect(
          handles.prisma.message.findUniqueOrThrow({ where: { id: message.messageId } }),
        ).resolves.toMatchObject({ role: "user", blocks: [{ kind: "text", text: input }] });
        await expect(
          handles.prisma.steeringMessage.findUniqueOrThrow({ where: { id: steering.id } }),
        ).resolves.toMatchObject({
          messageId: message.messageId,
          runId: continuationRunId,
          claimedAt: expect.any(Date),
        });
        const queued = await handles.prisma.run.findMany({
          where: { botId: seeded.bot.id, status: "queued" },
        });
        expect({ queued: queued.length, publications: held.published.length }).toEqual({
          queued: fresh ? 1 : 0,
          publications: fresh ? 1 : 0,
        });
        if (fresh) {
          expect(queued[0]).toMatchObject({
            id: held.published[0],
            sourceMessageId: freshMessage!.messageId,
          });
          const pending = await handles.prisma.steeringMessage.findMany({
            where: { botId: seeded.bot.id, claimedAt: null },
          });
          expect(pending).toEqual([
            expect.objectContaining({ messageId: freshMessage!.messageId, runId: queued[0]!.id }),
          ]);
          await handles.executor.continueRun(queued[0]!.id, "fresh-after-failure-worker");
          await expect(
            handles.prisma.run.findUniqueOrThrow({ where: { id: queued[0]!.id } }),
          ).resolves.toMatchObject({ status: "completed" });
          const answer = await handles.prisma.message.findMany({
            where: { runId: queued[0]!.id, role: "bot" },
          });
          expect(JSON.stringify(answer.map((item) => item.blocks))).toContain(
            "done. i handled: Use the fresh context.",
          );
        }
        expect(
          await handles.prisma.steeringMessage.findMany({ where: { botId: seeded.bot.id } }),
        ).toEqual([
          expect.objectContaining({
            id: steering.id,
            runId: continuationRunId,
            claimedAt: expect.any(Date),
          }),
        ]);
        expect(
          await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
        ).toBe(0);
        expect(
          await handles.prisma.run.count({
            where: { botId: seeded.bot.id, trigger: { not: "created" } },
          }),
        ).toBe(fresh ? 3 : 2);
        expect(held.published).toHaveLength(fresh ? 1 : 0);
      } finally {
        await cleanupHeldRuns(seeded.bot.id, () => {
          runtime.mockRestore();
          reply.mockRestore();
          held.restore();
        });
      }
    },
  );

  it.each([
    { claim: false, fresh: false, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "failed" as const },
    { claim: false, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: true, outcome: "failed" as const },
    { claim: true, fresh: false, outcome: "completed" as const },
  ])("bounds steering recovery ($claim, $fresh, $outcome)", async ({ claim, fresh, outcome }) => {
    const seeded = await seedRun(`steering-${claim}-${fresh}-${outcome}`, "start the analysis", {
      status: "running",
      leaseOwner: "failure-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 4, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    await events.sendUserMessage({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      userId: seeded.me.userId,
      blocks: [{ kind: "text", text: "Recover this context." }],
      prompt: "Recover this context.",
      trigger: "follow_up",
    });
    await expect(
      events.claimSteering({
        threadId: seeded.thread.id,
        botId: seeded.bot.id,
        runId: seeded.run.id,
        leaseOwner: "failure-worker",
        leaseFence: 4,
        seenIds: [],
      }),
    ).resolves.toHaveLength(1);

    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "failure-worker",
      leaseFence: 4,
      outcome: "failed",
      error: "provider failed",
    });
    if (!finalized) throw new Error("Expected the failed run to finalize");
    const continuationRunId = finalized.continuationRunId;
    expect(continuationRunId).toEqual(expect.any(String));
    await expect(
      handles.prisma.run.findUniqueOrThrow({
        where: { id: continuationRunId! },
        include: { task: true },
      }),
    ).resolves.toMatchObject({
      status: "queued",
      trigger: "follow_up",
      task: { prompt: "Respond to the user's steering context." },
    });
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({ where: { botId: seeded.bot.id } }),
    ).resolves.toMatchObject({ runId: continuationRunId, claimedAt: null });

    const lease = { leaseOwner: "failure-worker", leaseFence: 1 };
    async function startContinuation(runId: string) {
      const run = await handles.prisma.run.update({
        where: { id: runId },
        data: { status: "running", ...lease },
      });
      const attempt = await handles.prisma.attempt.create({
        data: { runId, fence: lease.leaseFence, status: "running" },
      });
      return {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: run.taskId,
        runId,
        attemptId: attempt.id,
        ...lease,
      };
    }

    const continuation = await startContinuation(continuationRunId!);
    if (claim) {
      await expect(events.claimSteering({ ...continuation, seenIds: [] })).resolves.toHaveLength(1);
    }
    // A failure before claimSteering (such as missing model configuration) must also stop.
    const freshMessage = fresh
      ? await events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text: "Try this new instruction." }],
          prompt: "Try this new instruction.",
          trigger: "follow_up",
        })
      : null;
    const recovered = await events.finalizeRun({
      ...continuation,
      ...(outcome === "completed"
        ? { outcome, blocks: [] }
        : { outcome, error: "provider failed" }),
    });
    if (!recovered) throw new Error("Expected the continuation to finalize");
    if (freshMessage) {
      expect(recovered.continuationRunId).toEqual(expect.any(String));
      const next = await startContinuation(recovered.continuationRunId!);
      await expect(events.claimSteering({ ...next, seenIds: [] })).resolves.toEqual([
        expect.objectContaining({ messageId: freshMessage.messageId }),
      ]);
      await expect(
        events.finalizeRun({ ...next, outcome: "failed", error: "provider failed" }),
      ).resolves.toEqual({ continuationRunId: null });
    } else {
      expect(recovered.continuationRunId).toBeNull();
    }
    expect(
      await handles.prisma.run.count({
        where: { botId: seeded.bot.id, trigger: { not: "created" } },
      }),
    ).toBe(fresh ? 3 : 2);
    expect(
      await handles.prisma.run.count({ where: { botId: seeded.bot.id, status: "queued" } }),
    ).toBe(0);
    // Settled steering cannot be reclaimed by unrelated future runs; chat history is retained.
    expect(
      await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id, runId: null } }),
    ).toBe(0);
    expect(
      await handles.prisma.message.count({ where: { threadId: seeded.thread.id, role: "user" } }),
    ).toBe(fresh ? 2 : 1);
    if (outcome === "completed") {
      expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(
        0,
      );
    }
  });

  it("discards pending steering when the user stops active work", async () => {
    const seeded = await seedRun("steering-stop", "keep working", {
      status: "running",
      leaseOwner: "stop-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    await rpc(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "Context that should stop with the run.",
      clientNonce: `stop-steering-${stamp}`,
    });

    await rpc(seeded.cookie, "threads/stop", { botId: seeded.bot.id });

    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(await handles.prisma.steeringMessage.count({ where: { botId: seeded.bot.id } })).toBe(0);
    expect(
      await handles.prisma.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
  });

  it("turns a regular bot-thread send during active work into steering", async () => {
    const seeded = await seedRun("bot-steering-send", "keep working", {
      status: "running",
      leaseOwner: "busy-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Use this additional context.",
      clientNonce: `bot-steering-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(
      await handles.prisma.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id, claimedAt: null });
  });

  it("turns a send during waiting takeover into steering", async () => {
    const seeded = await seedRun("bot-steering-takeover", "keep working", {
      status: "waiting_takeover",
    });

    const steeringInput = {
      botId: seeded.bot.id,
      text: "Skip that and tell me what you were going to check.",
      clientNonce: `bot-steering-takeover-${stamp}`,
    };
    await rpc(seeded.cookie, "threads/send", steeringInput);
    await rpc(seeded.cookie, "threads/send", steeringInput);

    expect(
      await handles.prisma.run.count({
        where: { threadId: seeded.thread.id, trigger: { not: "created" } },
      }),
    ).toBe(1);
    expect(
      await handles.prisma.message.count({
        where: { threadId: seeded.thread.id, clientNonce: steeringInput.clientNonce },
      }),
    ).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: seeded.bot.id, message: { threadId: seeded.thread.id } },
      }),
    ).resolves.toMatchObject({ runId: seeded.run.id });
  });

  it("applies the same no-parallel-run rule to the targeted group member", async () => {
    const cookie = await signup(
      `executor-group-steering-${stamp}@rakazo.test`,
      "Executor group steering",
    );
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const botA = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group lead",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const botB = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Group helper",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const group = await rpc<{ id: string }>(cookie, "groups/create", {
      name: "Steering group",
      botIds: [botA.id, botB.id],
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const member = await handles.prisma.chatGroupMember.findFirstOrThrow({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        userId: me.userId,
        prompt: "keep working",
        status: "queued",
      },
    });
    const activeRun = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: member.botId,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: "running",
        trigger: "user",
        leaseOwner: "group-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        startedAt: new Date(),
      },
    });

    await rpc(cookie, "threads/send", {
      groupId: group.id,
      text: "Use this group context.",
      mentions: [{ kind: "bot", id: member.botId }],
      clientNonce: `group-steering-${stamp}`,
    });

    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(1);
    await expect(
      handles.prisma.steeringMessage.findFirstOrThrow({
        where: { botId: member.botId, message: { threadId: thread.id } },
      }),
    ).resolves.toMatchObject({ runId: activeRun.id, claimedAt: null });

    const otherBotId = botA.id === member.botId ? botB.id : botA.id;
    const mixedInput = {
      groupId: group.id,
      text: "Use both agents.",
      mentions: [
        { kind: "bot", id: member.botId },
        { kind: "bot", id: otherBotId },
      ],
      clientNonce: `group-mixed-${stamp}`,
    };
    const first = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    const replay = await rpc<{ runIds: string[] }>(cookie, "threads/send", mixedInput);
    expect(first.runIds).toHaveLength(2);
    expect(replay.runIds).toEqual(first.runIds);
    expect(await handles.prisma.run.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it("leaves private steering for a private continuation and excludes it from group recovery", async () => {
    const seeded = await seedRun("channel-steering", "Group request", {
      status: "running",
      leaseOwner: "channel-worker",
      leaseFence: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const scope = { ...seeded.me, threadId: seeded.thread.id, botId: seeded.bot.id };
    const events = createThreadEvents(handles.prisma);
    await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [{ kind: "text", text: "Older private detail" }],
    });
    const channel = {
      kind: "channel_message" as const,
      provider: "fake",
      channelId: "fake-group",
      fromAddress: "sender",
      fromLabel: "Sender",
      text: "Group request",
      hop: 0,
    };
    const source = await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [channel],
    });
    await handles.prisma.run.update({
      where: { id: seeded.run.id },
      data: { trigger: "messaging", sourceMessageId: source.id },
    });
    await createThreadMessage(handles.prisma, {
      threadId: seeded.thread.id,
      role: "user",
      blocks: [{ ...channel, channelId: "other-group", text: "Other group detail" }],
    });
    const privateDm = await events.sendUserMessage({
      ...scope,
      trigger: "messaging",
      blocks: [{ kind: "text", text: "Private DM detail" }],
      prompt: "Private DM detail",
    });
    const privateSend = await rpc<{ runId: string }>(seeded.cookie, "threads/send", {
      botId: seeded.bot.id,
      text: "New private detail",
      clientNonce: `private-channel-${stamp}`,
    });
    expect(privateSend.runId).toBe(seeded.run.id);
    const privateMessage = await handles.prisma.message.findUniqueOrThrow({
      where: {
        threadId_clientNonce: {
          threadId: seeded.thread.id,
          clientNonce: `private-channel-${stamp}`,
        },
      },
    });
    const publicSend = await events.sendUserMessage({
      ...scope,
      trigger: "messaging",
      blocks: [{ ...channel, text: "Group follow-up" }],
      prompt: "Group follow-up",
    });
    const fence = { ...scope, runId: seeded.run.id, leaseOwner: "channel-worker", leaseFence: 1 };
    const claimed = await events.claimSteering({ ...fence, seenIds: [] });
    expect(claimed.map((item) => item.messageId)).toEqual([publicSend.messageId]);
    const history = await loadRunHistoryMessages(
      handles.prisma,
      seeded.run,
      100,
      channel.channelId,
    );
    expect(history.map((message) => message.id).sort()).toEqual(
      [source.id, publicSend.messageId].sort(),
    );
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 1, status: "running" },
    });
    const result = await events.finalizeRun({
      ...fence,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Public reply" }],
    });
    if (result === false || !result.continuationRunId)
      throw new Error("Missing private continuation");
    const continuation = await handles.prisma.run.findUniqueOrThrow({
      where: { id: result.continuationRunId },
    });
    expect(continuation).toMatchObject({
      trigger: "follow_up",
      sourceMessageId: privateMessage.id,
    });
    const steering = await handles.prisma.steeringMessage.findUniqueOrThrow({
      where: { messageId_botId: { messageId: privateMessage.id, botId: seeded.bot.id } },
    });
    expect(steering).toMatchObject({ runId: continuation.id, claimedAt: null });
    expect(
      await handles.prisma.steeringMessage.findUniqueOrThrow({
        where: { messageId_botId: { messageId: privateDm.messageId, botId: seeded.bot.id } },
      }),
    ).toMatchObject({ runId: continuation.id, claimedAt: null });
    // A later group run gets channel inputs, without either run's private context or bot answers.
    expect(
      (
        await loadRunHistoryMessages(
          handles.prisma,
          { ...seeded.run, id: "next-group-run" },
          100,
          channel.channelId,
        )
      )
        .map((message) => message.id)
        .sort(),
    ).toEqual([source.id, publicSend.messageId].sort());
  });

  it("recovers a computer a crashed worker left booting", async () => {
    const seeded = await seedRun("stale-boot", "write a file that says recovered");
    const bot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;
    expect(computerId).toBeTruthy();

    // A worker killed between the boot claim and its own failure handler: the row keeps
    // "booting" and its execution lease is gone. Age the claim stamp past the execution-lease
    // TTL so reclaim treats it as abandoned, not a live mid-provision claim.
    await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        // Matches BOOT_CLAIM_STALE_MS (execution-lease TTL) plus a small cushion.
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    await handles.executor.continueRun(seeded.run.id, "worker-stale-boot");

    const computer = await handles.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(computer.state).toBe("running");
    const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
    expect(run.status).toBe("completed");
  });

  it("leaves a booting computer alone while its worker still holds the lease", async () => {
    const seeded = await seedRun("live-boot", "write a file that says waited");
    const bot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: seeded.bot.id } });
    const computerId = bot.computerId!;

    await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await handles.prisma.computerExecutionLease.create({
      data: {
        computerId,
        botId: "another-bot",
        runId: "run-still-booting",
        fence: 1,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    // Age past BOOT_CLAIM_STALE_MS so reclaim reaches the live foreign-lease check
    // instead of refusing on a fresh mid-provision stamp.
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "booting",
        providerRef: "",
        updatedAt: new Date(Date.now() - (5 * 60_000 + 1_000)),
      },
    });

    try {
      await handles.executor.continueRun(seeded.run.id, "worker-live-boot");

      const computer = await handles.prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
      });
      expect(computer.state).toBe("booting");
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } });
      expect(run.status).not.toBe("completed");
    } finally {
      // Shared Postgres journeys reuse one database. Leave this run terminal and the computer
      // unblocked so later suites' reconcilers do not keep retrying a wedged boot forever.
      await handles.prisma.computerExecutionLease.deleteMany({ where: { computerId } });
      await handles.prisma.computer.update({
        where: { id: computerId },
        data: { state: "error", providerRef: "" },
      });
      await handles.prisma.run.updateMany({
        where: { id: seeded.run.id, status: { notIn: ["completed", "failed", "cancelled"] } },
        data: {
          status: "failed",
          error: "test cleanup after live-boot lease check",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    }
  });

  async function scriptedAskCards(runId: string) {
    const messages = await handles.prisma.message.findMany({
      where: { runId, role: "bot" },
      orderBy: { seq: "asc" },
    });
    return messages.flatMap((message) =>
      MessageBlockSchema.array()
        .parse(message.blocks)
        .flatMap((ask) => (ask.kind === "ask" ? [{ message, ask }] : [])),
    );
  }

  function holdContinuationJobs(botId: string) {
    const published: string[] = [];
    const enqueue = handles.jobs.enqueue.bind(handles.jobs);
    const spy = vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
      if (job.name === "run.continue") {
        const run = await handles.prisma.run.findUnique({ where: { id: job.payload.runId } });
        if (run?.botId === botId) {
          published.push(job.payload.runId);
          return;
        }
      }
      await enqueue(job);
    });
    return { published, restore: () => spy.mockRestore() };
  }

  async function cleanupHeldRuns(botId: string, restore: () => void) {
    // Teardown follows all assertions and cannot turn a non-consuming run into a pass.
    try {
      await handles.prisma.run.updateMany({
        where: { botId, status: { in: ["queued", "leased", "running"] } },
        data: {
          status: "cancelled",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
    } finally {
      restore();
    }
  }

  async function seedSteeringContinuation(label: string, text: string | string[]) {
    const seeded = await seedRun(label, "Initial task", {
      status: "running",
      leaseOwner: "initial-worker",
      leaseFence: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      startedAt: new Date(),
    });
    const attempt = await handles.prisma.attempt.create({
      data: { runId: seeded.run.id, fence: 2, status: "running" },
    });
    const events = createThreadEvents(handles.prisma);
    const messages = [];
    for (const content of typeof text === "string" ? [text] : text)
      messages.push(
        await events.sendUserMessage({
          spaceId: seeded.me.spaceId,
          threadId: seeded.thread.id,
          botId: seeded.bot.id,
          userId: seeded.me.userId,
          blocks: [{ kind: "text", text: content }],
          prompt: content,
          trigger: "follow_up",
        }),
      );
    const message = messages[0]!;
    const finalized = await events.finalizeRun({
      spaceId: seeded.me.spaceId,
      threadId: seeded.thread.id,
      botId: seeded.bot.id,
      runId: seeded.run.id,
      taskId: seeded.task.id,
      attemptId: attempt.id,
      leaseOwner: "initial-worker",
      leaseFence: 2,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Initial answer" }],
    });
    if (!finalized?.continuationRunId) throw new Error("Expected a steering continuation");
    const steering = await handles.prisma.steeringMessage.findFirstOrThrow({
      where: { botId: seeded.bot.id, messageId: message.messageId },
    });
    return { seeded, events, message, steering, continuationRunId: finalized.continuationRunId };
  }

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(cookie: string, procedure: string, body: unknown = {}): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return discardBotIntroFromCreate(handles, cookie, procedure, payload.json as T);
  }
});
