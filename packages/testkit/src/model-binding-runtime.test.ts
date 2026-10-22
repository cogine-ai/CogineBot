import type { AgentRunModel, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { createRunExecutor, PiAgentRuntime, serializeModelSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllEnvs();
});

function fixture(endpoints: Array<{ baseUrl: string; apiKey: string }>) {
  const rows = endpoints.map((endpoint, index) => ({
    id: `connection-${index}`,
    userId: "fixture-user",
    provider: "openai-compatible",
    label: `Server ${index}`,
    secretId: `secret-${index}`,
    connectionRevision: 1,
    supportsImages: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    endpoint,
  }));
  const retired = new Set<string>();
  const enabled = new Map(rows.map((row) => [row.id, ["same-model", "extra-model"]]));
  const findFirst = vi.fn(
    async ({ where }: { where: { id: string; userId: string; provider: string } }) => {
      const row = rows.find(
        (entry) =>
          entry.id === where.id &&
          entry.userId === where.userId &&
          entry.provider === where.provider &&
          !retired.has(entry.id),
      );
      if (!row) return null;
      return {
        ...row,
        preferences: [{ modelId: "same-model", thinkingLevel: null, isDefault: true }],
      };
    },
  );
  const prisma = {
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: string } }) => {
          const index = where.id === "bot-a" ? 0 : 1;
          if (
            where.userId !== "fixture-user" ||
            where.spaceId !== (index === 0 ? "space-a" : "space-b")
          )
            return null;
          return {
            modelProvider: "openai-compatible",
            modelId: "same-model",
            modelCredentialId: `connection-${index}`,
            thinkingLevel: null,
          };
        },
      ),
    },
    userModelCredential: { findFirst },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: null } }) => {
          const row = rows.find(
            (entry) =>
              entry.secretId === where.id &&
              entry.userId === where.userId &&
              where.spaceId === null,
          );
          if (!row) return null;
          return {
            id: row.secretId,
            ciphertext: serializeModelSecret({
              kind: "openai_compatible",
              baseUrl: row.endpoint.baseUrl,
              apiKey: row.endpoint.apiKey,
              enabledModelIds: enabled.get(row.id),
            }),
          };
        },
      ),
    },
  } as unknown as PrismaClient;
  const executor = createRunExecutor({
    prisma,
    secretStore: { load: async (ciphertext: string) => ciphertext },
  } as Parameters<typeof createRunExecutor>[0]);
  return { executor, prisma, retired, enabled, findFirst };
}

async function collect(
  model: AgentRunModel,
  overrides: Partial<AgentRunRequest> = {},
  runtimeOptions?: ConstructorParameters<typeof PiAgentRuntime>[0],
) {
  const request: AgentRunRequest = {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: "fixture-run",
    prompt: "Reply to this request.",
    instructions: "Answer briefly.",
    history: [],
    tools: [],
    model,
    ...overrides,
  };
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime(runtimeOptions).run(request, {
    operationId: "fixture-operation",
    traceId: "fixture-trace",
    userId: "fixture-user",
    spaceId: "space-a",
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events;
}

describe("bound model execution through real HTTP and SSE", () => {
  it("keeps two spaces on their selected endpoints when both serve the same model id", async () => {
    const a = await startModelEmulator({
      modelId: "same-model",
      apiKey: "fake-key-a",
      steps: [{ expect: () => undefined, response: { type: "text", text: "From A" } }],
    });
    const b = await startModelEmulator({
      modelId: "same-model",
      apiKey: "fake-key-b",
      steps: [{ expect: () => undefined, response: { type: "text", text: "From B" } }],
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const { executor, findFirst } = fixture([
      { baseUrl: a.baseUrl, apiKey: "fake-key-a" },
      { baseUrl: b.baseUrl, apiKey: "fake-key-b" },
    ]);
    try {
      const modelA = await executor.resolveModel({
        userId: "fixture-user",
        spaceId: "space-a",
        botId: "bot-a",
      });
      const modelB = await executor.resolveModel({
        userId: "fixture-user",
        spaceId: "space-b",
        botId: "bot-b",
      });
      expect(modelA.modelCredentialId).toBe("connection-0");
      expect(modelB.modelCredentialId).toBe("connection-1");
      expect(await collect(modelA)).toContainEqual({ type: "done", text: "From A" });
      expect(await collect(modelB)).toContainEqual({ type: "done", text: "From B" });
      expect(findFirst.mock.calls.map(([args]) => args.where.id)).toEqual([
        "connection-0",
        "connection-1",
      ]);
    } finally {
      a.assertComplete();
      b.assertComplete();
    }
  });

  it.each([
    {
      label: "inherits the current connection",
      bound: true,
      requestedId: "same-model",
      succeeds: true,
    },
    {
      label: "rejects an ambiguous unbound override",
      bound: false,
      requestedId: "same-model",
      succeeds: false,
    },
    {
      label: "rejects a model disabled on the inherited connection",
      bound: true,
      requestedId: "disabled-model",
      succeeds: false,
    },
  ])(
    "$label before a helper can contact another endpoint",
    async ({ bound, requestedId, succeeds }) => {
      const a = await startModelEmulator({
        modelId: "same-model",
        apiKey: "fake-key-a",
        steps: [
          {
            expect: () => undefined,
            response: {
              type: "tool",
              id: "helper-call",
              name: "run_subagent",
              arguments: {
                name: "helper",
                task: "Inspect this fixture",
                model_provider: "openai-compatible",
                model_id: requestedId,
              },
            },
          },
          ...(succeeds
            ? [{ expect: () => undefined, response: { type: "text" as const, text: "Helper A" } }]
            : []),
          { expect: () => undefined, response: { type: "text", text: "Parent A" } },
        ],
      });
      const b = await startModelEmulator({
        modelId: "same-model",
        apiKey: "fake-key-b",
        steps: [],
      });
      cleanups.push(
        () => a.close(),
        () => b.close(),
      );
      const { executor } = fixture([
        { baseUrl: a.baseUrl, apiKey: "fake-key-a" },
        { baseUrl: b.baseUrl, apiKey: "fake-key-b" },
      ]);
      const resolveModel = vi.fn(
        async (provider: string, modelId: string, modelCredentialId?: string | null) =>
          executor.resolveConnectedModel(
            { userId: "fixture-user", spaceId: "space-a" },
            provider,
            modelId,
            undefined,
            true,
            modelCredentialId,
          ),
      );
      const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
      try {
        const model = await executor.resolveModel({
          userId: "fixture-user",
          spaceId: "space-a",
          botId: "bot-a",
        });
        const events = await collect(
          { ...model, modelCredentialId: bound ? model.modelCredentialId : undefined },
          {
            tools: [
              {
                name: "run_subagent",
                description: "Delegate a short task",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            resolveModel,
            onUsage,
          },
        );
        expect(events).toContainEqual({ type: "done", text: "Parent A" });
        expect(events).toContainEqual(
          expect.objectContaining({ type: "subagent", status: succeeds ? "completed" : "failed" }),
        );
        if (bound)
          expect(resolveModel).toHaveBeenCalledExactlyOnceWith(
            "openai-compatible",
            requestedId,
            "connection-0",
          );
        else expect(resolveModel).not.toHaveBeenCalled();
        expect(a.requests).toHaveLength(succeeds ? 3 : 2);
        expect(b.requests).toHaveLength(0);
        if (succeeds)
          expect(onUsage.mock.calls.map(([event]) => event)).toContainEqual(
            expect.objectContaining({
              operationKind: "subagent",
              modelCredentialId: "connection-0",
            }),
          );
      } finally {
        a.assertComplete();
        b.assertComplete();
      }
    },
  );

  it("uses a different connection as a backup even when its provider and model id match the primary", async () => {
    const a = await startModelEmulator({
      modelId: "same-model",
      apiKey: "fake-key-a",
      steps: Array.from({ length: 1 }, () => ({
        expect: () => undefined,
        response: { type: "error" as const, status: 429, message: "rate_limit_error" },
      })),
    });
    let selected = false;
    const b = await startModelEmulator({
      modelId: "same-model",
      apiKey: "fake-key-b",
      steps: [
        {
          expect: () => expect(selected).toBe(true),
          response: { type: "text", text: "Backup B" },
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, cost: 0.00123 },
        },
      ],
    });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const { executor } = fixture([
      { baseUrl: a.baseUrl, apiKey: "fake-key-a" },
      { baseUrl: b.baseUrl, apiKey: "fake-key-b" },
    ]);
    const resolveFallbackModel = vi.fn(
      async (provider: string, modelId: string, modelCredentialId?: string | null) =>
        executor.resolveConnectedModel(
          { userId: "fixture-user", spaceId: "space-a" },
          provider,
          modelId,
          undefined,
          true,
          modelCredentialId,
        ),
    );
    const onModelChange = vi.fn(async () => {
      selected = true;
    });
    const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
    try {
      const model = await executor.resolveModel({
        userId: "fixture-user",
        spaceId: "space-a",
        botId: "bot-a",
      });
      const events = await collect(
        model,
        {
          fallbackModels: [
            { provider: model.provider, id: model.id, modelCredentialId: "connection-1" },
          ],
          resolveFallbackModel,
          onModelChange,
          onUsage,
        },
        {
          modelCallObserver: {
            beforeCall: async () => "fixture-reservation",
            afterCall: async () => undefined,
          },
        },
      );
      expect(events).toContainEqual({ type: "done", text: "Backup B" });
      expect(resolveFallbackModel).toHaveBeenCalledExactlyOnceWith(
        "openai-compatible",
        "same-model",
        "connection-1",
      );
      expect(onModelChange).toHaveBeenCalledExactlyOnceWith(
        "openai-compatible",
        "same-model",
        "connection-1",
      );
      expect(onUsage.mock.calls.map(([event]) => event.modelCredentialId)).toEqual([
        "connection-0",
        "connection-1",
      ]);
      expect(onUsage.mock.calls.at(-1)?.[0]).toMatchObject({
        provider: "openai-compatible",
        model: "same-model",
        modelCredentialId: "connection-1",
        costUsd: 0.00123,
        costSource: "provider-reported",
      });
    } finally {
      a.assertComplete();
      b.assertComplete();
    }
  });

  it("rejects retired or disabled bindings without sending a request to another connection", async () => {
    const a = await startModelEmulator({ modelId: "same-model", apiKey: "fake-key-a", steps: [] });
    const b = await startModelEmulator({ modelId: "same-model", apiKey: "fake-key-b", steps: [] });
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const { executor, retired, enabled } = fixture([
      { baseUrl: a.baseUrl, apiKey: "fake-key-a" },
      { baseUrl: b.baseUrl, apiKey: "fake-key-b" },
    ]);
    retired.add("connection-0");
    await expect(
      executor.resolveModel({ userId: "fixture-user", spaceId: "space-a", botId: "bot-a" }),
    ).rejects.toThrow("Connect that model provider first");
    retired.clear();
    enabled.set("connection-0", ["same-model"]);
    await expect(
      executor.resolveConnectedModel(
        { userId: "fixture-user", spaceId: "space-a" },
        "openai-compatible",
        "extra-model",
        undefined,
        true,
        "connection-0",
      ),
    ).rejects.toThrow("Unknown model for that provider");
    a.assertComplete();
    b.assertComplete();
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(0);
  });
});
