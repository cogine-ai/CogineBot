import type {
  AdapterContext,
  AgentRunRequest,
  MemoryCommitRequest,
  MemoryReadRequest,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import {
  legacyScopedToolEffectIdempotencyKey,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  executionId: string;
};

function fixture(runId = "run-1", options: { catchToolErrors?: boolean } = {}) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const scratchpadRows: Array<{
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    title: string;
    status: string;
    notes: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const memoryDocuments = new Map<
    string,
    { id: string; path: string; content: string; revision: number }
  >();
  const memoryHistory: MemoryCommitRequest[] = [];
  const memoryKey = (request: MemoryReadRequest, context: AdapterContext) =>
    JSON.stringify([context.spaceId, context.userId, request.scope, request.botId, request.path]);
  const memoryRead = vi.fn(async (request: MemoryReadRequest, context: AdapterContext) => {
    const document = memoryDocuments.get(memoryKey(request, context));
    return { documents: document ? [{ ...document }] : [] };
  });
  const persistMemory = async (request: MemoryCommitRequest, context: AdapterContext) => {
    const key = memoryKey(request, context);
    const previous = memoryDocuments.get(key);
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== (previous?.revision ?? 0)
    )
      throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
    const document = {
      id: previous?.id ?? `document-${memoryDocuments.size + 1}`,
      path: request.path,
      content: request.content,
      revision: (previous?.revision ?? 0) + 1,
    };
    memoryDocuments.set(key, document);
    memoryHistory.push({ ...request });
    return { ...document };
  };
  const memoryCommit = vi.fn(persistMemory);
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; spaceId?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.spaceId && effect.spaceId !== where.spaceId) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Update shared state" })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => scratchpadRows),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            spaceId: string;
            botId: string;
            userId: string;
            title: string;
            status: string;
            notes: string;
          };
        }) => {
          const now = new Date("2026-09-14T00:00:00.000Z");
          const row = {
            id: `scratch-${scratchpadRows.length + 1}`,
            ...data,
            createdAt: now,
            updatedAt: now,
          };
          scratchpadRows.push(row);
          return row;
        },
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const shutdown = new AbortController();
  let calls: ToolCall[] = [];
  let beforeTool: (() => void) | undefined;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      beforeTool?.();
      try {
        const result = await request.executeTool!(call.name, call.args, call.executionId);
        results.push(result);
      } catch (error) {
        if (!options.catchToolErrors) throw error;
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {},
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: memoryRead,
      search: async () => [],
      commit: memoryCommit,
      exportMarkdown: async function* () {},
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    shutdownSignal: shutdown.signal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    effects,
    results,
    scratchpadRows,
    memoryCommit,
    memoryRead,
    memoryDocuments,
    memoryHistory,
    persistMemory,
    externalEffect,
    shutdown,
    setBeforeTool(callback: () => void) {
      beforeTool = callback;
    },
    setCalls(next: ToolCall[]) {
      calls = next;
    },
    async run() {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    },
  };
}

describe("mutating tool effect idempotency keys", () => {
  it("appends facts with normalized paths, revisions and run provenance", async () => {
    const f = fixture("run-append");
    f.setCalls([
      { name: "remember", args: { path: "   ", content: "first fact" }, executionId: "first" },
      {
        name: "remember",
        args: { path: " MEMORY.md ", content: "second fact" },
        executionId: "second",
      },
    ]);

    await f.run();

    expect([...f.memoryDocuments.values()]).toEqual([
      { id: "document-1", path: "MEMORY.md", content: "first fact\nsecond fact\n", revision: 2 },
    ]);
    expect(f.memoryHistory).toEqual([
      expect.objectContaining({
        expectedRevision: 0,
        sourceRunId: "run-append",
        sourceThreadId: "thread-1",
      }),
      expect.objectContaining({
        expectedRevision: 1,
        sourceRunId: "run-append",
        sourceThreadId: "thread-1",
      }),
    ]);
    expect(
      f.memoryCommit.mock.calls.every(
        ([, context]) => context.spaceId === "space-1" && context.userId === "user-1",
      ),
    ).toBe(true);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
  });

  it("finishes an empty fact without creating a memory document or revision", async () => {
    const f = fixture();
    f.setCalls([{ name: "remember", args: { content: " \r\n " }, executionId: "empty" }]);
    await f.run();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.memoryHistory).toHaveLength(0);
    expect(f.memoryDocuments.size).toBe(0);
    expect(f.results).toEqual([{ ok: true }]);
    expect(f.effects[0]?.status).toBe("completed");
  });

  it.each([1, 2])(
    "re-reads after %i conflicts and preserves competing facts",
    async (conflicts) => {
      const f = fixture();
      for (let i = 0; i < conflicts; i += 1) {
        f.memoryCommit.mockImplementationOnce(async (request, context) => {
          await f.persistMemory({ ...request, content: `competing fact ${i}\n` }, context);
          throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
        });
      }
      f.setCalls([{ name: "remember", args: { content: "new fact" }, executionId: "append" }]);
      await f.run();
      expect(f.memoryCommit).toHaveBeenCalledTimes(conflicts + 1);
      expect(f.memoryCommit.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          content: `competing fact ${conflicts - 1}\nnew fact\n`,
          expectedRevision: conflicts,
        }),
      );
      expect(f.results).toEqual([{ ok: true }]);
    },
  );

  it("surfaces the third conflict without a fourth read or commit", async () => {
    const f = fixture("run-conflicts", { catchToolErrors: true });
    f.memoryCommit.mockRejectedValue(new Error(MEMORY_REVISION_CONFLICT_ERROR));
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledTimes(3);
    expect(
      f.memoryRead.mock.calls.filter(([request]) => request.path === "MEMORY.md"),
    ).toHaveLength(3);
    expect(f.results).toEqual([{ error: MEMORY_REVISION_CONFLICT_ERROR }]);
    expect(f.memoryHistory).toHaveLength(0);
    expect(f.effects.every((effect) => effect.status !== "completed")).toBe(true);
  });

  it("does not retry unrelated storage errors", async () => {
    const f = fixture("run-storage-error", { catchToolErrors: true });
    f.memoryCommit.mockRejectedValue(new Error("storage unavailable"));
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.results).toEqual([{ error: "storage unavailable" }]);
  });

  it("does not commit or retry when reading memory fails", async () => {
    const f = fixture("run-read-error", { catchToolErrors: true });
    const read = f.memoryRead.getMockImplementation()!;
    f.memoryRead.mockImplementation(async (request, context) => {
      if (request.path) throw new Error("read unavailable");
      return read(request, context);
    });
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryRead.mock.calls.filter(([request]) => request.path)).toHaveLength(1);
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.results).toEqual([{ error: "read unavailable" }]);
  });

  it("preserves facts from concurrent runs by re-reading their shared document", async () => {
    const first = fixture("run-race-first");
    const second = fixture("run-race-second");
    const read = first.memoryRead.getMockImplementation()!;
    let snapshots = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.memoryRead.mockImplementation(async (request, context) => {
      const snapshot = await read(request, context);
      if (request.path) {
        snapshots += 1;
        if (snapshots === 2) release();
        if (snapshots <= 2) await bothRead;
      }
      return snapshot;
    });
    second.memoryRead.mockImplementation((request, context) => first.memoryRead(request, context));
    second.memoryCommit.mockImplementation((request, context) =>
      first.memoryCommit(request, context),
    );
    first.setCalls([{ name: "remember", args: { content: "first fact" }, executionId: "first" }]);
    second.setCalls([
      { name: "remember", args: { content: "second fact" }, executionId: "second" },
    ]);

    await Promise.all([first.run(), second.run()]);

    expect(snapshots).toBe(3);
    expect(first.memoryCommit).toHaveBeenCalledTimes(3);
    expect(first.memoryHistory).toHaveLength(2);
    expect([...first.memoryDocuments.values()]).toEqual([
      expect.objectContaining({ revision: 2, content: "first fact\nsecond fact\n" }),
    ]);
    expect(first.memoryHistory.map((request) => request.sourceRunId)).toEqual([
      "run-race-first",
      "run-race-second",
    ]);
    expect(
      [...first.effects, ...second.effects].every((effect) => effect.status === "completed"),
    ).toBe(true);
  });

  it("stops before a tool entry when cancellation has arrived", async () => {
    const f = fixture("run-cancel-entry", { catchToolErrors: true });
    f.setBeforeTool(() => f.shutdown.abort());
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryRead.mock.calls.filter(([request]) => request.path)).toHaveLength(0);
    expect(f.memoryCommit).not.toHaveBeenCalled();
  });

  it("stops after an awaited read when cancellation arrives before commit", async () => {
    const f = fixture("run-cancel-read", { catchToolErrors: true });
    const read = f.memoryRead.getMockImplementation()!;
    f.memoryRead.mockImplementation(async (request, context) => {
      const snapshot = await read(request, context);
      if (request.path) {
        f.shutdown.abort();
        expect(context.signal.aborted).toBe(true);
      }
      return snapshot;
    });
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.memoryHistory).toHaveLength(0);
    expect(f.effects.every((effect) => effect.status !== "completed")).toBe(true);
  });

  it("retains a commit already started when cancellation arrives", async () => {
    const f = fixture("run-cancel-commit", { catchToolErrors: true });
    f.memoryCommit.mockImplementationOnce(async (request, context) => {
      const document = await f.persistMemory(request, context);
      f.shutdown.abort();
      return document;
    });
    f.setCalls([{ name: "remember", args: { content: "fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryHistory).toHaveLength(1);
    expect([...f.memoryDocuments.values()][0]?.content).toBe("fact\n");
  });

  it("deduplicates a persisted write with a lost response on a later permitted invocation", async () => {
    const first = fixture("run-lost-response", { catchToolErrors: true });
    first.memoryCommit.mockImplementationOnce(async (request, context) => {
      await first.persistMemory(request, context);
      throw new Error("response lost after commit");
    });
    const call = { name: "remember", args: { content: "durable fact" }, executionId: "append" };
    first.setCalls([call]);
    await first.run();
    expect(first.results).toEqual([{ error: "response lost after commit" }]);
    expect(first.memoryHistory).toHaveLength(1);
    expect(first.memoryCommit).toHaveBeenCalledOnce();

    const later = fixture("run-later-permitted");
    for (const [key, document] of first.memoryDocuments) later.memoryDocuments.set(key, document);
    later.setCalls([call]);
    await later.run();
    expect(later.memoryRead.mock.calls.some(([request]) => request.path === "MEMORY.md")).toBe(
      true,
    );
    expect(later.memoryCommit).not.toHaveBeenCalled();
    expect([...later.memoryDocuments.values()][0]?.revision).toBe(1);
    expect(later.results).toEqual([{ ok: true }]);
  });

  it("returns uncertainty if the effect result cannot be persisted after the memory commit", async () => {
    const f = fixture("run-effect-result");
    const update = f.externalEffect.updateMany.getMockImplementation()!;
    f.externalEffect.updateMany.mockImplementation(async (request) =>
      request.data.status === "completed" ? { count: 0 } : update(request),
    );
    f.setCalls([{ name: "remember", args: { content: "durable fact" }, executionId: "append" }]);
    await f.run();
    expect(f.memoryHistory).toHaveLength(1);
    expect(f.results).toEqual([expect.objectContaining({ uncertain: true })]);
    expect(f.effects.every((effect) => effect.status !== "completed")).toBe(true);
  });

  it("does not replay an existing uncertain memory effect", async () => {
    const f = fixture("run-uncertain");
    const args = { content: "durable fact" };
    f.effects.push({
      id: "uncertain-1",
      spaceId: "space-1",
      runId: "run-uncertain",
      kind: "remember",
      idempotencyKey: toolEffectIdempotencyKey("run-uncertain", "remember", args),
      status: "uncertain",
      request: args,
    });
    f.setCalls([{ name: "remember", args, executionId: "retry" }]);
    await f.run();
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.memoryRead.mock.calls.filter(([request]) => request.path)).toHaveLength(0);
    expect(f.results).toEqual([expect.objectContaining({ uncertain: true })]);
  });

  it("executes different tools that share a reused provider tool-call id", async () => {
    const f = fixture("run-a");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "team preference" },
        executionId: "call_0",
      },
      {
        name: "scratchpad_add",
        args: { title: "follow up with design" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.scratchpadRows).toHaveLength(1);
    expect(f.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-a", "remember", {
        path: "MEMORY.md",
        content: "team preference",
      }),
      toolEffectIdempotencyKey("run-a", "scratchpad_add", {
        title: "follow up with design",
      }),
    ]);
    expect(f.effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(f.results[0]).toEqual({ ok: true });
    expect(f.results[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({ title: "follow up with design" }),
      }),
    );
  });

  it("executes the same provider tool-call id on different runs", async () => {
    const first = fixture("run-1");
    first.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first bot note" },
        executionId: "call_0",
      },
    ]);
    await first.run();

    const second = fixture("run-2");
    // Shared ExternalEffect table: prior completed rows remain visible by idempotency key.
    second.effects.push(...first.effects);
    second.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second bot note" },
        executionId: "call_0",
      },
    ]);
    await second.run();

    expect(second.memoryCommit).toHaveBeenCalledOnce();
    expect(second.effects.map((effect) => effect.idempotencyKey)).toEqual([
      toolEffectIdempotencyKey("run-1", "remember", {
        path: "MEMORY.md",
        content: "first bot note",
      }),
      toolEffectIdempotencyKey("run-2", "remember", {
        path: "MEMORY.md",
        content: "second bot note",
      }),
    ]);
    expect(second.results[0]).toEqual({ ok: true });
  });

  it("replays a true retry of the same effect without re-executing", async () => {
    const f = fixture("run-retry");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "call_0",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-retry", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("replays the same logical effect when restart assigns a new tool-call id", async () => {
    const f = fixture("run-replay-id");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_abc",
      },
    ]);
    await f.run();
    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);

    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "durable fact" },
        executionId: "toolu_xyz",
      },
    ]);
    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-replay-id", "remember", {
        path: "MEMORY.md",
        content: "durable fact",
      }),
    );
    expect(f.results[1]).toEqual({ ok: true });
  });

  it("executes the same tool twice in one run when args differ but the provider id is reused", async () => {
    const f = fixture("run-args");
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "first fact" },
        executionId: "call_0",
      },
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "second fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledTimes(2);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).not.toBe(f.effects[1]?.idempotencyKey);
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy bare provider idempotency key for the same run and tool", async () => {
    const f = fixture("run-legacy");
    f.effects.push({
      id: "legacy-1",
      spaceId: "space-1",
      runId: "run-legacy",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "completed",
      request: { path: "MEMORY.md", content: "legacy fact" },
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "legacy fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("replays a legacy scoped key that included the provider tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-scoped");
    f.effects.push({
      id: "legacy-scoped-1",
      spaceId: "space-1",
      runId: "run-legacy-scoped",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-scoped",
        "remember",
        "call_0",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });

  it("does not reuse an incomplete legacy effect when the request differs", async () => {
    const f = fixture("run-legacy-mismatch");
    f.effects.push({
      id: "legacy-open",
      spaceId: "space-1",
      runId: "run-legacy-mismatch",
      kind: "remember",
      idempotencyKey: "call_0",
      status: "intended",
      request: { path: "MEMORY.md", content: "old fact" },
    });
    f.setCalls([
      {
        name: "remember",
        args: { path: "MEMORY.md", content: "new fact" },
        executionId: "call_0",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(2);
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-legacy-mismatch", "remember", {
        path: "MEMORY.md",
        content: "new fact",
      }),
    );
    expect(f.results[0]).toEqual({ ok: true });
  });

  it("records two identical live calls but commits a remembered fact only once", async () => {
    const args = { path: "MEMORY.md", content: "same fact" };
    const f = fixture("run-live-repeat");
    f.setCalls([
      { name: "remember", args, executionId: "call_a" },
      { name: "remember", args, executionId: "call_b" },
    ]);

    await f.run();

    expect(f.memoryCommit).toHaveBeenCalledOnce();
    expect(f.memoryHistory).toHaveLength(1);
    expect(f.effects).toHaveLength(2);
    expect(f.effects[0]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args),
    );
    expect(f.effects[1]?.idempotencyKey).toBe(
      toolEffectIdempotencyKey("run-live-repeat", "remember", args, 1),
    );
    expect(f.results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("replays a legacy scoped key when restart assigns a new tool-call id", async () => {
    const args = { path: "MEMORY.md", content: "legacy scoped fact" };
    const f = fixture("run-legacy-new-id");
    f.effects.push({
      id: "legacy-scoped-old-id",
      spaceId: "space-1",
      runId: "run-legacy-new-id",
      kind: "remember",
      idempotencyKey: legacyScopedToolEffectIdempotencyKey(
        "run-legacy-new-id",
        "remember",
        "call_old",
        args,
      ),
      status: "completed",
      request: args,
      result: { ok: true, legacy: true },
    });
    f.setCalls([
      {
        name: "remember",
        args,
        executionId: "call_new",
      },
    ]);

    await f.run();

    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.results[0]).toEqual({ ok: true, legacy: true });
  });
});
