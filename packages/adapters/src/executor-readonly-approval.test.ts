import type {
  AgentRunRequest,
  AgentRuntime,
  AutoReviewProvider,
  ConnectorCall,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { ActionApprovalRule } from "@rakazo/core";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import { MAX_SHARED_MEMORY_CHARS } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { connectorAccountRevision } from "./connector-account-binding.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";
import { serializeModelSecret } from "./pi-oauth.js";
import { PiAgentRuntime } from "./pi-runtime.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

const reviewMock = vi.fn();
const autoReviewProvider: AutoReviewProvider = {
  describe: () => ({
    id: "mock",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: { offline: true, keyless: true },
  }),
  review: reviewMock,
};

type Effect = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
  runId?: string;
};

type TestConnection = {
  id: string;
  connectorId: string;
  provider: string;
  providerRef: string;
  displayName: string;
  status: string;
  userId: string;
  spaceId: string;
  metadata: { authRevision: string };
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  readOnly = true,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  reviewProvider = autoReviewProvider,
  deploymentModelKey,
  trigger = "user",
  secrets = [] as string[],
  prompt = "Read the item",
  bot = {
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
  },
  shutdownSignal,
  builtin = false,
  disabledBuiltinTools = [],
  existingSharedMemory,
  advanceRevisionAfterRead = false,
  connections = [],
  connectionIds = [],
  onConnectionRead,
}: {
  builtin?: boolean;
  disabledBuiltinTools?: string[];
  existingSharedMemory?: string;
  /** Simulates another writer landing between the save's read and its commit. */
  advanceRevisionAfterRead?: boolean;
  name?: string;
  catalog?: boolean;
  readOnly?: boolean;
  rules?: ActionApprovalRule[];
  autoReview?: boolean;
  reviewProvider?: AutoReviewProvider | null;
  deploymentModelKey?: string;
  trigger?: string;
  secrets?: string[];
  prompt?: string;
  bot?: { name: string; title: string; description: string; instructions?: string };
  shutdownSignal?: AbortSignal;
  connections?: TestConnection[];
  connectionIds?: string[];
  onConnectionRead?: (count: number) => void;
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    route: { connectorId: "demo", resourceId: "resource-1", toolName: name },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const sharedMemoryState = {
    content: existingSharedMemory as string | undefined,
    revision: existingSharedMemory === undefined ? 0 : 1,
  };
  const commit = vi.fn(
    async (request: { path: string; content: string; expectedRevision?: number }) => {
      if (
        request.expectedRevision !== undefined &&
        request.expectedRevision !== sharedMemoryState.revision
      ) {
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      sharedMemoryState.content = request.content;
      sharedMemoryState.revision = (sharedMemoryState.revision || 0) + 1;
      return {
        id: "doc-1",
        path: request.path,
        revision: sharedMemoryState.revision,
        content: request.content,
      };
    },
  );
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
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
  let connectionReadCount = 0;
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
        name: bot.name,
        title: bot.title,
        description: bot.description,
        instructions: bot.instructions ?? "",
        disabledBuiltinTools,
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
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt, connectionIds })) },
    connection: {
      findMany: vi.fn(async () => {
        onConnectionRead?.(++connectionReadCount);
        return connections.filter(
          (row) => row.userId === run.userId && row.spaceId === run.spaceId,
        );
      }),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    secret: { findMany: vi.fn(async () => []) },
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
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (call: ConnectorCall) {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: { args: Record<string, unknown>; executionId: string }[] = [
    { args: { id: "item-1" }, executionId: "call-1" },
  ];
  const runtimeRun = vi.fn<AgentRuntime["run"]>(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(
        catalog ? "demo_execute_tool" : name,
        catalog ? { id: `resource-1:${name}`, arguments: call.args } : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        builtin
          ? []
          : catalog
            ? [
                {
                  name: "demo_execute_tool",
                  description: "Execute a catalog tool",
                  inputSchema: { type: "object" },
                  route: { connectorId: "demo", toolName: "__catalog_execute" },
                },
              ]
            : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog ? resolveCatalogCall(call, catalogEntries([tool])) : undefined,
      execute,
    },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
    memory: {
      read: async (request: { scope: string; path?: string }) => {
        const documents =
          request.scope === "user" &&
          request.path === "MEMORY.md" &&
          sharedMemoryState.content !== undefined
            ? [
                {
                  id: "doc-1",
                  path: "MEMORY.md",
                  content: sharedMemoryState.content,
                  revision: sharedMemoryState.revision,
                  updatedAt: "",
                },
              ]
            : [];
        if (advanceRevisionAfterRead && request.path === "MEMORY.md") {
          sharedMemoryState.content = "Someone else edited";
          sharedMemoryState.revision += 1;
        }
        return { documents };
      },
      commit,
    },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    secretStore: { load: async (ciphertext: string) => ciphertext },
    deploymentModelKey,
    autoReview: reviewProvider ?? undefined,
    shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    tool,
    prisma,
    runtimeRun,
    effects,
    results,
    execute,
    commit,
    sharedMemoryState,
    pauseRunForInput,
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run(expectedOutcome: "completed" | "failed" = "completed") {
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      if (expectedOutcome === "failed") {
        expect(finalizeRun).toHaveBeenCalledWith(
          expect.objectContaining({
            outcome: "failed",
            error: "Approved tool requests were not fully replayed",
          }),
        );
      } else {
        expect(finalizeRun).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "failed" }),
        );
      }
    },
  };
}

describe("bot instructions in actual model requests", () => {
  async function modelRequest(instructions: string, trigger = "user") {
    const provider = "openrouter";
    const modelId = "openai/gpt-5.6-luna";
    const payloads: Array<{
      messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
      tools?: unknown[];
    }> = [];
    const frames = [
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    const reply = `${frames
      .map((frame) => `data: ${JSON.stringify({ id: "profile-fixture", ...frame })}\n\n`)
      .join("")}data: [DONE]\n\n`;
    const fetcher = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(reply, { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("PI_DEFAULT_PROVIDER", provider);
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-profile-key");
    try {
      const f = fixture({
        builtin: true,
        trigger,
        prompt: "Answer this check.",
        deploymentModelKey: "synthetic-profile-key",
        bot: {
          name: "PUBLIC_NAME_CANARY",
          title: "PUBLIC_TITLE_CANARY",
          description: "PUBLIC_DESCRIPTION_CANARY",
          instructions,
        },
      });
      f.prisma.deploymentSettings.findUnique.mockResolvedValue({
        defaultModelProvider: provider,
        defaultModelId: modelId,
      });
      Object.assign(f.prisma, {
        usageRecord: { createMany: vi.fn(async () => ({ count: 1 })) },
      });
      const pi = new PiAgentRuntime();
      f.runtimeRun.mockImplementation(async function* (
        request: AgentRunRequest,
        context?: Parameters<typeof pi.run>[1],
      ) {
        yield* pi.run({ ...request, claimSteering: undefined }, context);
      });
      await f.run();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
      const payload = payloads[0]!;
      const system = payload.messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text).join("\n"),
        )
        .join("\n");
      expect(system).toContain("A bot and a subagent are different.");
      return { payload, system, request: f.runtimeRun.mock.calls[0]![0] };
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }

  it.each(["user", "routine"])(
    "honors explicitly empty stored instructions during a %s run",
    async (trigger) => {
      const { system, request, payload } = await modelRequest("", trigger);
      expect(system).not.toContain("PUBLIC_DESCRIPTION_CANARY");
      expect(system).not.toContain("PUBLIC_NAME_CANARY");
      expect(system).not.toContain("PUBLIC_TITLE_CANARY");
      expect(request.tools.length).toBeGreaterThan(0);
      expect(payload.tools?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it.each([" \n\t ", "  PRIVATE_RULE_CANARY\n\tKeep the raw ending.  "])(
    "preserves the stored instruction bytes in the actual request: %j",
    async (instructions) => {
      const { system, request } = await modelRequest(instructions);
      expect(request.instructions.startsWith(`${instructions}\n\n`)).toBe(true);
      expect(system.startsWith(`${instructions}\n\n`)).toBe(true);
      expect(system).not.toContain("PUBLIC_DESCRIPTION_CANARY");
      expect(system).not.toContain("PUBLIC_NAME_CANARY");
      expect(system).not.toContain("PUBLIC_TITLE_CANARY");
    },
  );

  it("retains the creation intro profile with no executor or model tools", async () => {
    const { system, request, payload } = await modelRequest("", "created");
    expect(system).toContain("Name: PUBLIC_NAME_CANARY");
    expect(system).toContain("Title: PUBLIC_TITLE_CANARY");
    expect(system).toContain("Description: PUBLIC_DESCRIPTION_CANARY");
    expect(system).toContain("Instructions: (none)");
    expect(request.tools).toEqual([]);
    expect(payload.tools ?? []).toEqual([]);
  });
});

describe("automatic review connection accounting", () => {
  it.each([
    {
      selected: "connection-a",
      missingSecret: false,
      answerId: "connection-a",
      reviewId: "connection-a",
    },
    {
      selected: "connection-b",
      missingSecret: false,
      answerId: "connection-a",
      reviewId: "connection-b",
    },
    { selected: null, missingSecret: false, answerId: null, reviewId: null },
    { selected: "connection-a", missingSecret: true, answerId: null, reviewId: null },
  ])(
    "attributes actual answer and review calls to their auth source ($selected, missing=$missingSecret)",
    async ({ selected, missingSecret, answerId, reviewId }) => {
      const provider = "openrouter";
      const modelId = "openai/gpt-5.6-luna";
      vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", provider);
      vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", modelId);
      vi.stubEnv("PI_DEFAULT_PROVIDER", provider);
      vi.stubEnv("OPENROUTER_API_KEY", "synthetic-host-key");
      const reply = `${[
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: '{"decision":"pass"}' },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]
        .map((frame) => `data: ${JSON.stringify({ id: "review-fixture", ...frame })}\n\n`)
        .join("")}data: [DONE]\n\n`;
      const fetcher = vi.fn(
        async () => new Response(reply, { headers: { "content-type": "text/event-stream" } }),
      );
      vi.stubGlobal("fetch", fetcher);
      try {
        const f = fixture({
          name: "demo_send_message",
          autoReview: true,
          reviewProvider: null,
          deploymentModelKey: "synthetic-host-key",
        });
        const at = new Date("2026-01-01T00:00:00Z");
        const credentials = selected
          ? ["connection-a", "connection-b"].map((id) => ({
              id,
              userId: "user-1",
              provider,
              label: id,
              secretId: `secret-${id}`,
              connectionRevision: 1,
              createdAt: at,
              updatedAt: at,
            }))
          : [];
        const preferences = credentials.map((credential) => ({
          id: `preference-${credential.id}`,
          credentialId: credential.id,
          spaceId: "space-1",
          userId: "user-1",
          modelId,
          thinkingLevel: null,
          isDefault: credential.id === selected,
          updatedAt: at,
          credential,
        }));
        const chosen = preferences.find((row) => row.isDefault) ?? null;
        Object.assign(f.prisma.spaceModelPreference, {
          findFirst: vi.fn(async () => chosen),
          findMany: vi.fn(async () => preferences),
        });
        Object.assign(f.prisma.userModelCredential, {
          findFirst: vi.fn(async ({ where }: { where: { id?: string; userId: string } }) => {
            const row = credentials.find(
              (row) => row.id === where.id && row.userId === where.userId,
            );
            return row
              ? { ...row, preferences: preferences.filter((item) => item.credentialId === row.id) }
              : null;
          }),
          findMany: vi.fn(async () => credentials),
        });
        Object.assign(f.prisma.secret, {
          findFirst: vi.fn(
            async ({ where }: { where: { id: string; userId: string; spaceId: null } }) => {
              const credential = credentials.find(
                (row) => row.secretId === where.id && row.userId === where.userId,
              );
              if (!credential || missingSecret || where.spaceId !== null) return null;
              return {
                id: where.id,
                ciphertext: serializeModelSecret({
                  kind: "api_key",
                  key: `synthetic-${credential.id}-key`,
                  maxTokens: 64,
                }),
              };
            },
          ),
        });
        f.prisma.deploymentSettings.findUnique.mockResolvedValue({
          defaultModelProvider: provider,
          defaultModelId: modelId,
        });
        if (selected === "connection-b") {
          const originalBot = f.prisma.bot.findUniqueOrThrow.getMockImplementation()!;
          f.prisma.bot.findUniqueOrThrow.mockImplementation(async () => ({
            ...(await originalBot()),
            modelProvider: provider,
            modelId,
            modelCredentialId: "connection-a",
            thinkingLevel: null,
          }));
        }
        const ledger: Array<Record<string, unknown>> = [];
        Object.assign(f.prisma, {
          usageRecord: {
            createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
              ledger.push(...data);
              return { count: data.length };
            }),
          },
        });
        const primary = f.runtimeRun.getMockImplementation()!;
        const pi = new PiAgentRuntime();
        f.runtimeRun.mockImplementation(async function* (
          request: AgentRunRequest,
          context?: Parameters<typeof pi.run>[1],
        ) {
          yield* pi.run({ ...request, tools: [], claimSteering: undefined }, context);
          if (!request.runId.endsWith(":auto-review")) yield* primary(request);
        });
        await f.run();
        expect(f.execute).toHaveBeenCalledOnce();
        expect(f.prisma.run.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              modelProvider: provider,
              modelId,
              modelCredentialId: answerId,
            }),
          }),
        );
        expect(
          f.runtimeRun.mock.calls.map(([request]) => ({
            id: request.model.modelCredentialId,
            key: request.model.apiKey,
          })),
        ).toEqual([
          { id: answerId, key: answerId ? `synthetic-${answerId}-key` : "synthetic-host-key" },
          { id: reviewId, key: reviewId ? `synthetic-${reviewId}-key` : "synthetic-host-key" },
        ]);
        expect(
          ledger.map((row) => ({
            credential: row.modelCredentialId,
            operation: row.operationKind,
            provider: row.provider,
            model: row.model,
          })),
        ).toEqual([
          { credential: answerId, operation: "answer", provider, model: modelId },
          { credential: reviewId, operation: "setup", provider, model: modelId },
        ]);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(new Set(ledger.map((row) => row.callId)).size).toBe(2);
        for (const row of ledger) expect(row.callId).toEqual(expect.any(String));
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("optional helper model discovery", () => {
  it.each([
    ["database", new Error("model connection database unavailable")],
    ["secret store", new SecretStoreUnavailableError(503)],
  ])("continues the active run when the %s hint lookup fails", async (_kind, error) => {
    const f = fixture();
    f.prisma.userModelCredential.findMany.mockRejectedValue(error);

    await f.run();

    expect(f.prisma.userModelCredential.findMany).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results).toHaveLength(1);
    const helper = f.runtimeRun.mock.calls[0]?.[0].tools.find(
      (tool) => tool.name === "run_subagent",
    );
    expect(helper).toBeDefined();
    expect(helper?.description).not.toContain("Available explicit model choices");
  });
});

describe("disabled builtins", () => {
  it("refuses a direct call before any effect or memory write", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      disabledBuiltinTools: ["save_shared_memory", "unknown"],
    });
    f.setCalls([{ args: { content: "Must not be saved" }, executionId: "call-1" }]);
    await f.run();
    expect(f.results).toEqual([{ error: "This tool is disabled for this bot." }]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.effects).toEqual([]);
  });
});

describe("executor connector account revalidation", () => {
  const account = (): TestConnection => ({
    id: "selected",
    connectorId: "demo",
    provider: "gmail",
    providerRef: "upstream-selected",
    displayName: "Selected",
    status: "connected",
    userId: "user-1",
    spaceId: "space-1",
    metadata: { authRevision: "auth-1" },
  });
  const bind = (f: ReturnType<typeof fixture>, row: TestConnection) => {
    f.tool.route = {
      connectorId: row.connectorId,
      resourceId: row.provider,
      toolName: f.tool.name,
      connectionId: row.id,
      resourceRevision: connectorAccountRevision({
        id: row.id,
        connectorId: row.connectorId,
        externalId: row.provider,
        providerRef: row.providerRef,
        displayName: row.displayName,
        revision: row.metadata.authRevision,
      }),
    };
  };

  it("executes a still-authorized account with the freshly scoped context", async () => {
    const row = account();
    const f = fixture({ connections: [row], connectionIds: [row.id] });
    bind(f, row);
    await f.run();
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.prisma.connection.findMany).toHaveBeenCalledTimes(3);
    expect(f.prisma.task.findUniqueOrThrow).toHaveBeenCalledTimes(3);
    expect(f.execute).toHaveBeenCalledWith(
      expect.objectContaining({ route: expect.objectContaining({ connectionId: row.id }) }),
      expect.objectContaining({
        userId: row.userId,
        spaceId: row.spaceId,
        connectedConnections: [
          expect.objectContaining({ id: row.id, providerRef: row.providerRef, revision: "auth-1" }),
        ],
      }),
    );
  });

  it.each(["revoked", "ref", "generation", "intent"])(
    "blocks a %s change between resolution and the outbound execute",
    async (change) => {
      const row = account();
      const sibling = { ...account(), id: "sibling", providerRef: "upstream-sibling" };
      const connectionIds = [row.id];
      const f = fixture({
        connections: [row, sibling],
        connectionIds,
        onConnectionRead: (count) => {
          if (count !== 3) return;
          if (change === "revoked") row.status = "revoked";
          if (change === "ref") row.providerRef = "new-upstream-account";
          if (change === "generation") row.metadata.authRevision = "auth-2";
          if (change === "intent") connectionIds.splice(0, 1, sibling.id);
        },
      });
      bind(f, row);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toMatchObject({
        error: expect.stringMatching(/selected|authorization|unavailable/i),
      });
      expect(f.effects.at(-1)?.status).toBe("completed");
    },
  );

  it.each([false, true])(
    "rejects an old account approval after reauthorization (catalog %s)",
    async (catalog) => {
      const row = account();
      const f = fixture({
        catalog,
        connections: [row],
        connectionIds: [row.id],
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      bind(f, row);
      // Keep the fixture's existing catalog id stable while its route is account-bound.
      f.tool.route!.resourceId = "resource-1";
      row.provider = "resource-1";
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      row.metadata.authRevision = "auth-2";
      bind(f, row);
      await f.run("failed");
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toMatchObject({
        error: expect.stringContaining("different connector resource"),
      });
    },
  );
});

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    reviewMock.mockReset();
  });

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );

  it("writes shared memory directly, including when an always-allow rule exists", async () => {
    const args = { path: " MEMORY.md ", content: "Printing: all print jobs go to Clyde." };
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      autoReview: true,
      rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "save_shared_memory" }],
    });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "user",
        path: "MEMORY.md",
        content: args.content,
        expectedRevision: 0,
      }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
    expect(f.commit.mock.calls[0]![0]).not.toHaveProperty("botId");
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 1 });
  });

  it("replaces an existing shared document at the revision it just read", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
    });
    f.setCalls([{ args: { path: "MEMORY.md", content: "New rule" }, executionId: "call-1" }]);
    await f.run();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: "New rule", expectedRevision: 1 }),
      expect.anything(),
    );
    expect(f.results.at(-1)).toEqual({ ok: true, path: "MEMORY.md", revision: 2 });
  });

  it("does not overwrite shared memory that changed after it was read", async () => {
    const f = fixture({
      name: "save_shared_memory",
      builtin: true,
      existingSharedMemory: "Old rule",
      advanceRevisionAfterRead: true,
    });
    f.setCalls([{ args: { path: "MEMORY.md", content: "New rule" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
      expect.anything(),
    );
    expect(f.sharedMemoryState.content).toBe("Someone else edited");
    expect(f.results.at(-1)).toEqual({ error: MEMORY_REVISION_CONFLICT_ERROR });
  });

  it("rejects shared memory content over the size limit", async () => {
    const args = {
      path: "MEMORY.md",
      content: "x".repeat(MAX_SHARED_MEMORY_CHARS + 1),
    };
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({
      error: `content exceeds ${MAX_SHARED_MEMORY_CHARS} characters`,
    });
  });

  it("rejects a shared memory save without a path", async () => {
    const f = fixture({ name: "save_shared_memory", builtin: true });
    f.setCalls([{ args: { path: "  ", content: "ok" }, executionId: "call-1" }]);
    await f.run();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.results.at(-1)).toEqual({ error: "path is required" });
  });

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(reviewMock).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("executes a later identical-args call after an approved replay when approval is not required by default", async () => {
      const args = { id: "item-1" };
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([
        { args, executionId: "call-2" },
        { args, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.effects).toHaveLength(2);
      expect(f.effects[0]?.idempotencyKey).toBe(approvalEffectKey("run-1", "demo_get_item", args));
      expect(f.effects[1]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", args, 1),
      );
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({
        error:
          "The user denied this action. Do not retry or rephrase it; tell the user and ask what they want instead.",
      });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("replays a non-approval connector effect when the tool-call id changes", async () => {
      const f = fixture({ catalog });
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects[0]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", { id: "item-1" }),
      );

      f.setCalls([{ args: { id: "item-1" }, executionId: "call-new" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for a webhook-triggered read-named write operation", async () => {
      const f = fixture({
        catalog,
        name: "demo_read_profile_card",
        readOnly: false,
        trigger: "webhook",
        rules: [
          { effect: "always_allow", matchKind: "tool", matchValue: "demo_read_profile_card" },
        ],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
    });

    it("lets a webhook-triggered declared read run unattended", async () => {
      const f = fixture({ catalog, trigger: "webhook" });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });

    it("treats a read-named write operation as consequential for automatic review", async () => {
      reviewMock.mockResolvedValue({ decision: "ask", reason: "Writes data", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_find_validator_record",
        readOnly: false,
        autoReview: true,
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledOnce();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it.each(["ask", "error", "pass"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        reviewMock.mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(reviewMock).toHaveBeenCalledOnce();
        expect(reviewMock).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "demo_send_message", connectorKind: "demo" }),
          expect.objectContaining({ runId: "run-1" }),
        );
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(decision === "pass" ? 0 : 1);
      },
    );

    it("redacts run secrets from automatic review task and bot context", async () => {
      reviewMock.mockResolvedValue({ decision: "pass", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        secrets: ["super-secret-token"],
        prompt: "Send mail with super-secret-token",
        bot: {
          name: "Mail",
          title: "Helper",
          description: "Uses super-secret-token",
        },
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userTask: "Send mail with [redacted]",
          botDescription: "Mail: Helper\nUses [redacted]",
        }),
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    it("does not persist a review decision when the run is cancelled", async () => {
      const shutdown = new AbortController();
      reviewMock.mockImplementation(async () => {
        shutdown.abort();
        return { decision: "error", reason: "Checker timed out or failed.", model: "mock" };
      });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        shutdownSignal: shutdown.signal,
      });
      await f.run();
      expect(f.effects[0]?.reviewDecision).toBeUndefined();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });
  });
});
