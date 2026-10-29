import { randomUUID } from "node:crypto";
import type { MessageBlock, ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import { ReplyAnnouncements } from "@rakazo/core";
import { createDb, finalizeRun } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { reduceThreadSnapshot } from "../../../apps/web/src/lib/thread-events.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("durable completion receipt delivery", () => {
  it.each([
    {
      outcome: "completed",
      blocks: [{ kind: "text", text: "  Final\nUnicode 👩‍👩‍👧‍👦\n" }],
      spoken: "Final Unicode 👩‍👩‍👧‍👦",
    },
    {
      outcome: "completed",
      blocks: [
        { kind: "text", text: "# Done\n\n**Ready** [report](https://example.test/hidden)" },
        { kind: "text", text: "中 é 👩‍👩‍👧‍👦" },
      ],
      spoken: "Done\n\nReady report\n中 é 👩‍👩‍👧‍👦",
    },
    { outcome: "completed", blocks: [], spoken: null },
    {
      outcome: "completed",
      blocks: [{ kind: "steps", steps: [{ label: "Checked", count: 1 }] }],
      spoken: null,
    },
    { outcome: "failed", blocks: [], spoken: null },
    {
      outcome: "cancelled",
      blocks: [{ kind: "text", text: "Late after cancellation" }],
      spoken: null,
    },
  ] as const)(
    "persists and delivers $outcome with $blocks",
    async ({ outcome, blocks, spoken }) => {
      const { prisma, pool } = createDb(process.env.DATABASE_URL!);
      const id = randomUUID();
      const organizationId = `org-${id}`,
        spaceId = `space-${id}`,
        botId = `bot-${id}`,
        threadId = `thread-${id}`,
        taskId = `task-${id}`,
        runId = `run-${id}`,
        attemptId = `attempt-${id}`;
      try {
        await prisma.organization.create({
          data: { id: organizationId, name: "Receipt fixture", slug: id, createdAt: new Date() },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
        await prisma.bot.create({
          data: { id: botId, spaceId, userId: "fixture-user", name: "Fixture", color: "gray" },
        });
        await prisma.thread.create({
          data: { id: threadId, spaceId, botId, userId: "fixture-user" },
        });
        await prisma.task.create({
          data: {
            id: taskId,
            spaceId,
            botId,
            threadId,
            userId: "fixture-user",
            prompt: "Fixture",
            status: "running",
          },
        });
        await prisma.run.create({
          data: {
            id: runId,
            spaceId,
            botId,
            threadId,
            taskId,
            userId: "fixture-user",
            status: outcome === "cancelled" ? "cancelled" : "running",
            trigger: "user",
            leaseOwner: "fixture-worker",
            leaseFence: 1,
            startedAt: new Date(),
          },
        });
        await prisma.attempt.create({
          data: { id: attemptId, runId, fence: 1, status: "running" },
        });
        const run = {
          id: runId,
          botId,
          threadId,
          taskId,
          status: "running" as const,
          trigger: "user" as const,
          routineId: null,
          modelProvider: null,
          modelId: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date().toISOString(),
        };
        let snapshot: ThreadSnapshot | null = {
          botId,
          threadId,
          cursor: -1,
          messages: [],
          olderCursor: null,
          run,
          activeRuns: [run],
        };
        const observer = new ReplyAnnouncements();
        observer.update("scope", true, snapshot);
        const input = {
          spaceId,
          botId,
          threadId,
          taskId,
          runId,
          attemptId,
          leaseOwner: "fixture-worker",
          leaseFence: 1,
          ...(outcome === "failed"
            ? { outcome: "failed" as const, error: "Fixture failure" }
            : { outcome: "completed" as const, blocks: [...blocks] as MessageBlock[] }),
        };
        const result = await finalizeRun(prisma, input);
        expect(result).toEqual(outcome === "cancelled" ? false : { continuationRunId: null });
        // Repeated finalization cannot create another message or completion receipt.
        expect(await finalizeRun(prisma, input)).toBe(false);
        const rows = await prisma.event.findMany({ where: { threadId }, orderBy: { seq: "asc" } });
        const messages = await prisma.message.findMany({ where: { threadId } });
        expect(rows.filter((row) => row.type === "run.completed")).toHaveLength(
          outcome === "completed" ? 1 : 0,
        );
        expect(messages).toHaveLength(outcome === "completed" && blocks.length ? 1 : 0);
        if (messages.length)
          expect(
            (messages[0]!.blocks as MessageBlock[]).filter((block) => block.kind === "text"),
          ).toEqual(blocks.filter((block) => block.kind === "text"));
        const terminal = rows.find((row) => row.type === "run.completed");
        if (terminal)
          expect(terminal.payload).toEqual(messages.length ? { messageId: messages[0]!.id } : {});
        for (const row of rows) {
          const event = {
            ...row,
            createdAt: row.createdAt.toISOString(),
            runId: row.runId ?? undefined,
            payload: row.payload,
          } as ProductEvent;
          snapshot = reduceThreadSnapshot(snapshot, event);
          observer.observe("scope", true, event);
        }
        if (outcome !== "cancelled") expect(snapshot?.run?.status).not.toBe("running");
        if (outcome === "completed") expect(snapshot?.run).toBeNull();
        if (messages.length)
          expect(snapshot?.messages[0]?.blocks.filter((block) => block.kind === "text")).toEqual(
            blocks.filter((block) => block.kind === "text"),
          );
        expect(observer.update("scope", true, snapshot)).toEqual(spoken ? [spoken] : []);
        if (messages.length)
          expect(snapshot?.messages[0]?.blocks.filter((block) => block.kind === "text")).toEqual(
            blocks.filter((block) => block.kind === "text"),
          );
        for (const row of rows)
          observer.observe("scope", true, {
            ...row,
            runId: row.runId ?? undefined,
            payload: row.payload as Record<string, unknown>,
          });
        expect(observer.update("scope", true, snapshot)).toEqual([]);
      } finally {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.$disconnect();
        await pool.end();
      }
    },
  );
});
