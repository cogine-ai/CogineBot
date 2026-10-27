import type { AdapterContext, AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { SingleScreenClaimTracker } from "./computer-screens.js";
import { createRunExecutor } from "./executor.js";

const provisionComputer = vi.hoisted(() => vi.fn());

const leaseBoundary = vi.hoisted(() => ({ real: false }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ComputerLifecycleModule>();
  return {
    ...actual,
    acquireComputerExecutionLease: (
      ...args: Parameters<typeof actual.acquireComputerExecutionLease>
    ) =>
      leaseBoundary.real ? actual.acquireComputerExecutionLease(...args) : Promise.resolve(null),
    acquireDedicatedScreenLeaseFence: async () => null,
    provisionComputer,
  };
});

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/** A routine run whose model makes the given tool calls, then answers. */
async function runRoutine(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: {
    takeover?: boolean;
    abortBeforeTools?: boolean;
    modelId?: string;
    resume?: {
      checkpoint: "takeover" | "takeover-skipped" | null;
      releasedDuringSetup?: "takeover" | "takeover-skipped";
      releasedWhileLoadingMemory?: "takeover" | "takeover-skipped";
      pendingCard?: boolean;
      providerRef?: string | null;
      currentComputer?: {
        kind?: ComputerRef["kind"];
        providerRef?: string;
        screenGeneration?: number;
        state?: "stopped" | "suspended";
        maintenanceId?: string;
        controlLeaseId?: string;
        controlHolder?: "user";
      };
    };
    computer?: {
      storedKind: ComputerRef["kind"];
      providerKind: ComputerRef["kind"];
      graphical: boolean;
      provisionKind?: ComputerRef["kind"];
    };
  } = {},
) {
  leaseBoundary.real = Boolean(options.resume);
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: options.resume?.checkpoint === null ? "waiting_takeover" : "queued",
    trigger: options.resume?.pendingCard ? "user" : "routine",
    routineId: options.resume?.pendingCard ? null : "routine-1",
    retryOfRunId: null,
    leaseFence: options.resume ? 3 : 0,
    checkpoint: options.resume?.checkpoint ?? null,
  };
  const storedComputer = {
    id: "computer-1",
    scope: options.resume ? "team" : "dedicated",
    state: "running",
    maintenanceId: null,
    updatedAt: new Date(),
    kind: options.computer?.storedKind ?? "e2b",
    providerRef:
      options.resume?.providerRef === undefined ? "sandbox-1" : options.resume.providerRef,
    homeKey: "home-1",
    screenGeneration: 7,
    controlLeaseId: null,
    controlHolder: "none",
  };
  const currentComputer = { ...storedComputer, ...options.resume?.currentComputer };
  const retainedLease = {
    computerId: storedComputer.id,
    botId: run.botId,
    runId: run.id,
    fence: 7,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  };
  const takeoverTx = {
    $queryRaw: vi.fn(async () => []),
    run: { findFirst: vi.fn(async () => run) },
    message: { findMany: vi.fn(async () => []) },
  };
  const shutdown = new AbortController();
  const toolResults: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (options.abortBeforeTools) shutdown.abort();
    for (const [index, call] of toolCalls.entries()) {
      toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
    }
    if (options.takeover) {
      yield { type: "takeover" as const, reason: "Sign in to the inbox." };
      return;
    }
    yield { type: "text-delta" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: typeof takeoverTx) => Promise<unknown>) =>
      callback(takeoverTx),
    ),
    run: {
      findUnique: vi.fn(
        async (input?: {
          select?: { checkpoint?: boolean; status?: boolean; leaseOwner?: boolean };
        }) => {
          if (
            options.resume?.releasedDuringSetup &&
            input?.select?.checkpoint &&
            input.select.status &&
            !input.select.leaseOwner
          )
            run.checkpoint = options.resume.releasedDuringSetup;
          return run;
        },
      ),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: false },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: storedComputer,
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () =>
        options.resume?.pendingCard
          ? [
              {
                id: "takeover-card",
                threadId: run.threadId,
                seq: 0,
                role: "bot",
                botId: run.botId,
                runId: run.id,
                blocks: [{ kind: "computer", state: "Needs you", text: "Sign in to the inbox." }],
                createdAt: new Date(),
                replyToMessageId: null,
                replyQuote: null,
                replyTo: null,
              },
            ]
          : [],
      ),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })) },
    computer: {
      findUniqueOrThrow: vi.fn(async () => storedComputer),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            kind: string;
            providerRef: string;
            screenGeneration: number;
            state: string;
            maintenanceId: null;
            controlLeaseId: null;
            controlHolder: { not: string };
          };
        }) =>
          currentComputer.id === where.id &&
          currentComputer.kind === where.kind &&
          currentComputer.providerRef === where.providerRef &&
          currentComputer.screenGeneration === where.screenGeneration &&
          currentComputer.state === where.state &&
          currentComputer.maintenanceId === where.maintenanceId &&
          currentComputer.controlLeaseId === where.controlLeaseId &&
          currentComputer.controlHolder !== where.controlHolder.not
            ? { id: currentComputer.id }
            : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => {
        retainedLease.fence += 1;
        return [{ fence: retainedLease.fence }];
      }),
      create: vi.fn(async () => {
        throw new Error("Expected the retained execution lease to be reclaimed");
      }),
      updateMany: vi.fn(async ({ data }: { data: { expiresAt: Date } }) => {
        retainedLease.expiresAt = data.expiresAt;
        return { count: 1 };
      }),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: options.modelId ?? "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  const provisionKind = options.computer?.provisionKind;
  const screens = new SingleScreenClaimTracker();
  let screenReleased = false;
  if (options.resume)
    screens.claim(COMPUTER.id, {
      operationId: run.id,
      traceId: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      runId: run.id,
      screenLeaseId: "run-1:7",
      signal: new AbortController().signal,
    });
  const sandbox = {
    describe: () => ({
      id: options.computer?.providerKind ?? "e2b",
      capabilities: { graphical: options.computer?.graphical ?? false },
    }),
    ...(provisionKind ? { provisionKind: vi.fn(async () => provisionKind) } : {}),
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async (computer: ComputerRef, context: AdapterContext) => {
      screenReleased = screens.release(computer.id, context);
    }),
    async *exportWorkspace() {
      yield* [];
    },
  };
  const web = {
    describe: () => ({ id: "fixture-web", capabilities: { search: true, fetch: true } }),
    search: vi.fn(async () => [{ title: "Result", url: "https://example.test", snippet: "Found" }]),
    fetch: vi.fn(),
  };
  const finalizeRun = vi.fn(async ({ outcome }: { outcome: string }) => {
    if (options.resume) run.status = outcome;
    return { continuationRunId: null };
  });
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    shutdownSignal: shutdown.signal,
    web,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox,
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: {
      read: async () => {
        await Promise.resolve();
        if (options.resume?.releasedWhileLoadingMemory) {
          run.checkpoint = options.resume.releasedWhileLoadingMemory;
          currentComputer.controlHolder = "none";
          currentComputer.controlLeaseId = null;
        }
        return { documents: [] };
      },
    },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      pauseRunForTakeover: vi.fn(async () => false),
    },
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  const sleepJobs = enqueue.mock.calls
    .map((call) => (call as unknown[])[0] as { name: string })
    .filter((job) => job.name === "computer.sleep");
  return {
    finalizeRun,
    sandbox,
    sleepJobs,
    toolResults,
    web,
    runtimeRun,
    prisma,
    retainedLease,
    screenReleased,
    run,
  };
}

beforeEach(() => {
  leaseBoundary.real = false;
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("run computer provisioning", () => {
  it("never starts the computer for a run that does not use it", async () => {
    const { finalizeRun, sandbox, sleepJobs } = await runRoutine([]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it.each(["takeover", "takeover-skipped"] as const)(
    "releases a retained screen after a text-only %s resume without provisioning",
    async (checkpoint) => {
      const { finalizeRun, sandbox, runtimeRun, prisma, retainedLease, screenReleased } =
        await runRoutine([], { resume: { checkpoint } });

      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(runtimeRun).toHaveBeenCalledOnce();
      expect(runtimeRun.mock.calls[0]![0].resumeFromCheckpoint).toBe(checkpoint);
      expect(prisma.computerExecutionLease.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            computerId: "computer-1",
            botId: "bot-1",
            OR: expect.arrayContaining([{ runId: "run-1" }]),
          }),
          data: expect.objectContaining({ fence: { increment: 1 } }),
        }),
      );
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.listFiles).not.toHaveBeenCalled();
      expect(sandbox.writeFile).not.toHaveBeenCalled();
      expect(prisma.computer.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: {
          id: "computer-1",
          kind: "e2b",
          providerRef: "sandbox-1",
          screenGeneration: 7,
          state: "running",
          maintenanceId: null,
          controlLeaseId: null,
          controlHolder: { not: "user" },
        },
        select: { id: true },
      });
      expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(
        COMPUTER,
        expect.objectContaining({
          botId: "bot-1",
          runId: "run-1",
          spaceId: "space-1",
          screenLeaseId: "run-1:8",
        }),
        { onlyIfRunning: true },
      );
      expect(screenReleased).toBe(true);
      expect(retainedLease.fence).toBe(8);
      expect(retainedLease.expiresAt).toEqual(new Date(0));
      expect(prisma.computerExecutionLease.create).not.toHaveBeenCalled();
      expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          computerId: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 8,
        },
        data: { expiresAt: new Date(0) },
      });
    },
  );

  it("releases a retained takeover screen when model validation fails before the runtime", async () => {
    const { finalizeRun, sandbox, runtimeRun, retainedLease, screenReleased, run } =
      await runRoutine([], { modelId: "", resume: { checkpoint: "takeover" } });

    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Connect a model in Settings before running bots.",
      }),
    );
    expect(run.status).toBe("failed");
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(retainedLease.fence).toBe(8);
    expect(retainedLease.expiresAt).toEqual(new Date(0));
    expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(
      COMPUTER,
      expect.objectContaining({ botId: "bot-1", runId: "run-1", screenLeaseId: "run-1:8" }),
      { onlyIfRunning: true },
    );
    expect(screenReleased).toBe(true);
  });

  it("releases a screen handed back during setup before model validation fails", async () => {
    const { finalizeRun, sandbox, runtimeRun, retainedLease, screenReleased, run } =
      await runRoutine([], {
        modelId: "",
        resume: {
          checkpoint: null,
          releasedWhileLoadingMemory: "takeover",
          currentComputer: { controlHolder: "user", controlLeaseId: "user-control-1" },
        },
      });

    expect(finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        error: "Connect a model in Settings before running bots.",
      }),
    );
    expect(run.status).toBe("failed");
    expect(run.checkpoint).toBe("takeover");
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(retainedLease.fence).toBe(8);
    expect(retainedLease.expiresAt).toEqual(new Date(0));
    expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(
      COMPUTER,
      expect.objectContaining({ botId: "bot-1", runId: "run-1", screenLeaseId: "run-1:8" }),
      { onlyIfRunning: true },
    );
    expect(screenReleased).toBe(true);
  });

  it("keeps the retained screen while the user still holds takeover", async () => {
    const { finalizeRun, sandbox, runtimeRun, screenReleased } = await runRoutine([], {
      resume: {
        checkpoint: null,
        currentComputer: { controlHolder: "user", controlLeaseId: "user-control-1" },
      },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(screenReleased).toBe(false);
  });

  it("releases an unheld pending takeover screen when the run completes", async () => {
    const { finalizeRun, sandbox, runtimeRun, screenReleased, run } = await runRoutine([], {
      resume: { checkpoint: null, pendingCard: true },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(run.status).toBe("completed");
    expect(run.checkpoint).toBeNull();
    expect(runtimeRun).toHaveBeenCalledOnce();
    const request = runtimeRun.mock.calls[0]![0];
    expect(request.history.find((message) => message.id === "takeover-card")?.content).toContain(
      "Sign in to the inbox.",
    );
    expect(request.resumeFromCheckpoint).toBeUndefined();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(
      COMPUTER,
      expect.objectContaining({ botId: "bot-1", runId: "run-1", screenLeaseId: "run-1:8" }),
      { onlyIfRunning: true },
    );
    expect(screenReleased).toBe(true);
  });

  it("releases retained cleanup registered after a held takeover ends during setup", async () => {
    const { finalizeRun, sandbox, runtimeRun, screenReleased } = await runRoutine([], {
      resume: { checkpoint: null, releasedDuringSetup: "takeover" },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(runtimeRun.mock.calls[0]![0].resumeFromCheckpoint).toBe("takeover");
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(
      COMPUTER,
      expect.objectContaining({ screenLeaseId: "run-1:8" }),
      { onlyIfRunning: true },
    );
    expect(screenReleased).toBe(true);
  });

  it("does not clean up an old provider after the configured provider changes", async () => {
    const { finalizeRun, sandbox, prisma, screenReleased } = await runRoutine([], {
      resume: { checkpoint: "takeover" },
      computer: { storedKind: "e2b", providerKind: "docker", graphical: true },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(prisma.computer.findFirst).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(screenReleased).toBe(false);
  });

  it("does not start or clean up a takeover resume with no retained provider reference", async () => {
    const { finalizeRun, sandbox, prisma } = await runRoutine([], {
      resume: { checkpoint: "takeover", providerRef: null },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(prisma.computer.findFirst).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "a newer screen generation", currentComputer: { screenGeneration: 8 } },
    { reason: "a different provider kind", currentComputer: { kind: "docker" } },
    { reason: "a replacement provider reference", currentComputer: { providerRef: "replacement" } },
    { reason: "a stopped computer", currentComputer: { state: "stopped" } },
    { reason: "a suspended computer", currentComputer: { state: "suspended" } },
    { reason: "maintenance", currentComputer: { maintenanceId: "maintenance-1" } },
    { reason: "a new control lease", currentComputer: { controlLeaseId: "user-control-1" } },
    { reason: "a user control holder", currentComputer: { controlHolder: "user" } },
  ] as const)(
    "does not release retained takeover cleanup after $reason wins",
    async ({ currentComputer }) => {
      const { finalizeRun, sandbox, prisma, screenReleased } = await runRoutine([], {
        resume: { checkpoint: "takeover", currentComputer },
      });

      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(prisma.computer.findFirst).toHaveBeenCalledOnce();
      expect(sandbox.releaseScreen).not.toHaveBeenCalled();
      expect(screenReleased).toBe(false);
    },
  );

  it("completes API-backed search without starting a computer", async () => {
    const { finalizeRun, sandbox, sleepJobs, toolResults, web } = await runRoutine([
      { name: "web_search", args: { query: "fixture query" } },
    ]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(web.search).toHaveBeenCalledOnce();
    expect(toolResults[0]).toMatchObject({ results: [{ title: "Result" }] });
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it("does not start or dispatch computer work after the run signal is aborted", async () => {
    const { sandbox, runtimeRun } = await runRoutine([{ name: "list_files", args: { path: "" } }], {
      abortBeforeTools: true,
    });

    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.listFiles).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
  });

  it.each(["e2b", "docker"] as const)(
    "offers graphical tools for the current %s provider after a stored desktop computer",
    async (providerKind) => {
      const { finalizeRun, sandbox, sleepJobs, runtimeRun } = await runRoutine([], {
        modelId: "openai/gpt-4o",
        computer: { storedKind: "desktop", providerKind, graphical: true },
      });

      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      const request = runtimeRun.mock.calls[0]![0];
      expect(request.model.id).toBe("openai/gpt-4o");
      expect(request.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["computer_observe", "computer_act", "open_path", "launch_app"]),
      );
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.releaseScreen).not.toHaveBeenCalled();
      expect(sleepJobs).toEqual([]);
    },
  );

  it("suppresses graphical tools for the current desktop provider after a stored remote computer", async () => {
    const { finalizeRun, sandbox, sleepJobs, runtimeRun } = await runRoutine([], {
      modelId: "openai/gpt-4o",
      computer: { storedKind: "e2b", providerKind: "desktop", graphical: false },
    });

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const request = runtimeRun.mock.calls[0]![0];
    expect(request.model.id).toBe("openai/gpt-4o");
    const names = request.tools.map((tool) => tool.name);
    for (const name of ["computer_observe", "computer_act", "open_path", "launch_app"])
      expect(names).not.toContain(name);
    expect(names).toContain("list_files");
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it.each(["desktop", "docker"] as const)(
    "prefers a routed %s provision kind over stored and described kinds without starting the computer",
    async (routedKind) => {
      const { finalizeRun, sandbox, sleepJobs, runtimeRun } = await runRoutine([], {
        modelId: "openai/gpt-4o",
        computer: {
          storedKind: routedKind === "desktop" ? "e2b" : "desktop",
          providerKind: "docker",
          graphical: true,
          provisionKind: routedKind,
        },
      });

      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      const request = runtimeRun.mock.calls[0]![0];
      expect(request.model.id).toBe("openai/gpt-4o");
      const names = request.tools.map((tool) => tool.name);
      for (const name of ["computer_observe", "computer_act", "open_path", "launch_app"])
        expect(names.includes(name)).toBe(routedKind !== "desktop");
      expect(sandbox.provisionKind).toHaveBeenCalledOnce();
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.releaseScreen).not.toHaveBeenCalled();
      expect(sleepJobs).toEqual([]);
    },
  );

  it("starts the computer the first time a tool needs it and reuses it", async () => {
    const { finalizeRun, sandbox, sleepJobs, toolResults } = await runRoutine([
      { name: "list_files", args: { path: "" } },
      { name: "list_files", args: { path: "" } },
    ]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledWith(
      expect.anything(),
      "computer-1",
      expect.objectContaining({ runId: "run-1" }),
      "bot",
    );
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledWith(COMPUTER, expect.any(String), expect.anything());
    expect(toolResults[0]).toMatchObject({ entries: [{ path: "notes.txt" }] });
    expect(sleepJobs).toHaveLength(1);
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(COMPUTER, expect.anything());
  });

  it.each([
    { probedKind: "e2b", actualKind: "desktop" },
    { probedKind: "desktop", actualKind: "e2b" },
  ] as const)(
    "retries setup when a $probedKind probe provisions a $actualKind computer",
    async ({ probedKind, actualKind }) => {
      provisionComputer.mockResolvedValue({ ...COMPUTER, kind: actualKind });

      await expect(
        runRoutine([{ name: "list_files", args: { path: "" } }], {
          computer: {
            storedKind: "e2b",
            providerKind: "docker",
            graphical: true,
            provisionKind: probedKind,
          },
        }),
      ).rejects.toThrow("Run setup failed; retrying");
      expect(provisionComputer).toHaveBeenCalledOnce();
    },
  );

  it("starts the computer before handing its screen to the user", async () => {
    await runRoutine([], { takeover: true });

    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("keeps setup-failure retry semantics when the computer cannot start", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    await expect(runRoutine([{ name: "list_files", args: { path: "" } }])).rejects.toThrow(
      "Run setup failed; retrying",
    );
    expect(provisionComputer).toHaveBeenCalledOnce();
  });
});
