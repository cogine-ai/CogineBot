import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef, PortableFile } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toComputerRef } from "./computer-support.js";
import type { ScriptedFileInput } from "./scripted-file.js";
import {
  commitScriptedFile,
  ScriptedFileUncertainError,
  verifyScriptedFileReceipt,
} from "./scripted-file.js";
import { ScriptedStateInvalidError } from "./scripted-state.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("scripted file receipt boundaries (PostgreSQL)", () => {
  const spaceId = "scripted-file-boundary-space";
  const userId = "scripted-file-boundary-user";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: spaceId,
        name: "File Boundary Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "File Boundary Space" } },
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: spaceId } });
    } finally {
      await close();
    }
  });

  async function fixture(fresh = false) {
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "File Boundary Bot", color: "ink" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: "follow_up",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const computer: ComputerRef = {
      ...toComputerRef({ homeKey: `team-${spaceId}`, kind: "fake", providerRef: randomUUID() }),
      fresh,
    };
    const file = {
      path: "/workspace/notes.md",
      content: new TextEncoder().encode("fixture-content"),
    };
    const input: ScriptedFileInput = {
      runId: run.id,
      spaceId,
      workerId: "worker-1",
      leaseFence: 1,
      turnIndex: 0,
      fileIndex: 0,
      computer,
      file,
    };
    const context: AdapterContext = {
      operationId: run.id,
      traceId: run.id,
      runId: run.id,
      spaceId,
      userId,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const writeFile = vi.fn(
      async (_computer: ComputerRef, _file: PortableFile, _context: AdapterContext) => undefined,
    );
    const sandbox = { writeFile };
    const saved = () => prisma.externalEffect.findFirstOrThrow({ where: { runId: run.id } });
    return { run, input, context, sandbox, saved };
  }

  it.each(["kind", "key"] as const)(
    "rejects a foreign or legacy %s without adopting its receipt",
    async (field) => {
      const f = await fixture();
      await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
      const saved = await f.saved();
      await prisma.externalEffect.update({
        where: { id: saved.id },
        data:
          field === "kind"
            ? { kind: "another-effect" }
            : { idempotencyKey: `legacy:${randomUUID()}` },
      });
      const changed = await f.saved();
      f.sandbox.writeFile.mockClear();
      await expect(
        commitScriptedFile(prisma, f.sandbox, f.input, f.context),
      ).rejects.toBeInstanceOf(ScriptedStateInvalidError);
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();
      expect(await f.saved()).toEqual(changed);
      expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(1);
    },
  );

  it("rejects the same slot with a changed file request", async () => {
    const f = await fixture();
    await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
    const saved = await f.saved();
    f.sandbox.writeFile.mockClear();
    await expect(
      commitScriptedFile(
        prisma,
        f.sandbox,
        { ...f.input, file: { ...f.input.file, content: new TextEncoder().encode("changed") } },
        f.context,
      ),
    ).rejects.toBeInstanceOf(ScriptedStateInvalidError);
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    expect(await f.saved()).toEqual(saved);
  });

  it.each([false, true])(
    "rejects a replacement target before writing a %s new slot",
    async (newSlot) => {
      const f = await fixture();
      await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
      f.sandbox.writeFile.mockClear();
      const changed = {
        ...f.input,
        fileIndex: newSlot ? 1 : 0,
        computer: { ...f.input.computer, providerRef: "replacement-target" },
      };
      await expect(
        commitScriptedFile(prisma, f.sandbox, changed, f.context),
      ).rejects.toBeInstanceOf(ScriptedStateInvalidError);
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();
      expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(1);
    },
  );

  it("allows distinct slots on the same freshly created target in one attempt", async () => {
    const f = await fixture(true);
    await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
    await commitScriptedFile(prisma, f.sandbox, { ...f.input, fileIndex: 1 }, f.context);
    expect(f.sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, status: "completed" } }),
    ).toBe(2);
  });

  it("does not trust an earlier completion when a later attempt receives an empty replacement", async () => {
    const f = await fixture(true);
    await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseOwner: "worker-2", leaseFence: 2 },
    });
    f.sandbox.writeFile.mockClear();
    await expect(
      verifyScriptedFileReceipt(
        prisma,
        { ...f.input, workerId: "worker-2", leaseFence: 2 },
        f.context,
      ),
    ).rejects.toBeInstanceOf(ScriptedStateInvalidError);
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("holds file bytes and target identity stable across the durable claim", async () => {
    const f = await fixture();
    const originalRunId = f.input.runId;
    const originalComputer = { ...f.input.computer };
    const originalActor = { ...f.context };
    const instrumented = prisma.$extends({
      query: {
        externalEffect: {
          async create({ args, query }) {
            const result = await query(args);
            f.input.file.content.fill(0);
            f.input.computer.providerRef = "mutated-target";
            f.input.runId = "mutated-run";
            f.context.botId = "mutated-actor";
            f.context.userId = "mutated-user";
            return result;
          },
        },
      },
    }) as PrismaClient;
    await commitScriptedFile(instrumented, f.sandbox, f.input, f.context);
    expect(f.sandbox.writeFile).toHaveBeenCalledOnce();
    const [computer, file, actor] = f.sandbox.writeFile.mock.calls[0]!;
    expect(computer).toEqual(originalComputer);
    expect(new TextDecoder().decode(file.content)).toBe("fixture-content");
    expect((await f.saved()).runId).toBe(originalRunId);
    expect(actor).toMatchObject({ botId: originalActor.botId, userId: originalActor.userId });
  });

  it("does not dispatch when the run loses its lease after claiming the intent", async () => {
    const f = await fixture();
    let transactions = 0;
    const instrumented = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction")
          return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
            const result = await target.$transaction(callback);
            if (++transactions === 1)
              await prisma.run.update({
                where: { id: f.run.id },
                data: { leaseOwner: "worker-2", leaseFence: 2 },
              });
            return result;
          };
        return Reflect.get(target, property);
      },
    });
    await expect(
      commitScriptedFile(instrumented, f.sandbox, f.input, f.context),
    ).rejects.toBeInstanceOf(ScriptedFileUncertainError);
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    expect(await f.saved()).toMatchObject({ status: "uncertain" });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({
      status: "running",
      leaseOwner: "worker-2",
      leaseFence: 2,
    });
  });

  it("verifies missing and completed receipts without creating or changing effects", async () => {
    const f = await fixture();
    await expect(verifyScriptedFileReceipt(prisma, f.input, f.context)).resolves.toBe("missing");
    expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(0);
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    await commitScriptedFile(prisma, f.sandbox, f.input, f.context);
    const saved = await f.saved();
    await expect(verifyScriptedFileReceipt(prisma, f.input, f.context)).resolves.toBe("completed");
    expect(await f.saved()).toEqual(saved);
    expect(f.sandbox.writeFile).toHaveBeenCalledOnce();
  });

  it("keeps acting bots separate from their shared physical home", async () => {
    const first = await fixture();
    const second = await fixture();
    second.input.computer = { ...first.input.computer };
    expect(first.input.computer.botId).not.toBe(first.context.botId);
    expect(second.input.computer.botId).not.toBe(second.context.botId);
    await commitScriptedFile(prisma, first.sandbox, first.input, first.context);
    await commitScriptedFile(prisma, first.sandbox, second.input, second.context);
    expect(first.sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(await first.saved()).toMatchObject({ runId: first.run.id, status: "completed" });
    expect(await second.saved()).toMatchObject({ runId: second.run.id, status: "completed" });
  });

  it("does not let another acting bot use a valid shared target to write this run", async () => {
    const first = await fixture();
    const second = await fixture();
    await expect(
      commitScriptedFile(prisma, first.sandbox, first.input, {
        ...first.context,
        botId: second.context.botId,
      }),
    ).rejects.toThrow();
    expect(first.sandbox.writeFile).not.toHaveBeenCalled();
    expect(await prisma.externalEffect.count({ where: { runId: first.run.id } })).toBe(0);
  });
});
