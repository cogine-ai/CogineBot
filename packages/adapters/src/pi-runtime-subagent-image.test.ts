import type { Api, Context, Model } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

const captured = vi.hoisted(() => ({
  policies: [] as unknown[],
  childTarget: undefined as
    | { model_provider: string; model_id: string; model_credential_id: string }
    | undefined,
}));

vi.mock("./runtime-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-context.js")>();
  return {
    ...actual,
    createRuntimeContextPolicy: (...args: Parameters<typeof actual.createRuntimeContextPolicy>) => {
      const policy = actual.createRuntimeContextPolicy(...args);
      captured.policies.push(policy);
      return policy;
    },
  };
});

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: Array<{
      name: string;
      execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
    }>;
    constructor(options: {
      initialState: {
        tools: Array<{
          name: string;
          execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
        }>;
      };
    }) {
      this.tools = options.initialState.tools;
    }
    subscribe() {}
    async prompt() {
      await this.tools
        .find((tool) => tool.name === "run_subagent")
        ?.execute("subagent-call", {
          name: "helper",
          task: "Inspect the screen",
          ...captured.childTarget,
        });
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => {
      const legacy = provider === "test" && id === "vision-test-model";
      const astra = provider === "openai" && id === "gpt-6-astra";
      const sonnet = provider === "anthropic" && id === "claude-sonnet-5-5";
      return legacy || astra || sonnet
        ? {
            provider,
            id,
            api: astra ? "openai-responses" : sonnet ? "anthropic-messages" : "openai-completions",
            baseUrl: astra
              ? "https://api.openai.com/v1"
              : sonnet
                ? "https://api.anthropic.com"
                : "http://127.0.0.1/unused",
            contextWindow: 128_000,
            maxTokens: 4096,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }
        : undefined;
    },
    streamSimple: () => {
      throw new Error("The fake agent must not make a model request");
    },
  }),
}));

vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import type { createRuntimeContextPolicy } from "./runtime-context.js";

it("uses the image planner in a nested subagent's screenshot context", async () => {
  captured.policies = [];
  for await (const _event of new PiAgentRuntime().run(
    {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "Delegate the visual task.",
      instructions: "Keep the answer brief.",
      history: [],
      tools: builtinAgentTools,
      model: { provider: "test", id: "vision-test-model" },
    },
    {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  )) {
  }
  expect(captured.policies).toHaveLength(2);
  const policy = captured.policies[1] as ReturnType<typeof createRuntimeContextPolicy>;
  const pixels = Buffer.alloc(1024 * 1024);
  let seed = 1;
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[index] = seed & 255;
  }
  const png = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 1 } })
    .png()
    .toBuffer();
  expect(png.length).toBeGreaterThan(1_000_000);
  const image = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
  const context = {
    systemPrompt: "Inspect the screen.",
    tools: [],
    messages: [
      { role: "user" as const, content: "Check this screen", timestamp: 1 },
      {
        role: "assistant" as const,
        content: [
          { type: "toolCall" as const, id: "capture", name: "computer_observe", arguments: {} },
        ],
        api: "openai-completions" as const,
        provider: "test",
        model: "vision-test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse" as const,
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "capture",
        toolName: "computer_observe",
        content: [image],
        details: {},
        isError: false,
        timestamp: 3,
      },
    ],
  } satisfies Context;
  const model = {
    provider: "test",
    id: "vision-test-model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1/unused",
    contextWindow: 128_000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<"openai-completions">;
  const prepared = policy.prepareContext(context, model);
  expect(prepared.messages.at(-1)).toMatchObject({
    content: [
      { type: "text", text: expect.stringContaining("Screenshot(s) returned by this tool call.") },
      image,
    ],
  });
  expect(policy.getDecision()!.estimatedInputTokens).toBeLessThan(128_000 - 4096);
});

it.each([false, true])(
  "keeps parent and selected child current-model image policies separate (%s)",
  async (childIsAstra) => {
    captured.policies = [];
    const astra = {
      provider: "openai",
      id: "gpt-6-astra",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const sonnet = {
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    };
    const child = childIsAstra ? astra : sonnet;
    const parent = childIsAstra ? sonnet : astra;
    captured.childTarget = {
      model_provider: child.provider,
      model_id: child.id,
      model_credential_id: "child-connection",
    };
    const resolveModel = vi.fn(
      async (provider: string, id: string, modelCredentialId?: string | null) => ({
        provider,
        id,
        modelCredentialId,
        contextWindow: 16_384,
        maxTokens: 4096,
        apiKey: "fake-child-key",
      }),
    );
    try {
      for await (const _event of new PiAgentRuntime().run(
        {
          botId: "bot",
          threadId: "thread",
          runId: "run-current-child-policy",
          prompt: "Delegate this image task.",
          instructions: "Be concise.",
          history: [],
          tools: builtinAgentTools,
          model: {
            provider: parent.provider,
            id: parent.id,
            modelCredentialId: "parent-connection",
            contextWindow: 16_384,
            maxTokens: 4096,
          },
          resolveModel,
        },
        { signal: new AbortController().signal },
      )) {
      }
      expect(resolveModel).toHaveBeenCalledExactlyOnceWith(
        child.provider,
        child.id,
        "child-connection",
      );
      expect(captured.policies).toHaveLength(2);
      const png = await sharp({
        create: { width: 4096, height: 4096, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const part = { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
      const context = {
        systemPrompt: "Inspect the image.",
        tools: [],
        messages: [{ role: "user" as const, content: [part], timestamp: 1 }],
      } satisfies Context;
      for (const [index, target] of [parent, child].entries()) {
        const policy = captured.policies[index] as ReturnType<typeof createRuntimeContextPolicy>;
        const model = {
          ...target,
          contextWindow: 16_384,
          maxTokens: 4096,
          input: ["text", "image"],
          reasoning: false,
          name: target.id,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as Model<Api>;
        if (target === astra)
          expect(() => policy.prepareContext(context, model)).toThrow(/context.*exceed/i);
        else {
          const prepared = policy.prepareContext(context, model);
          expect(prepared.messages[0]!.content).toEqual([part]);
          expect(policy.getDecision()!.estimatedInputTokens).toBeGreaterThanOrEqual(4784);
          expect(policy.getDecision()!.estimatedInputTokens).toBeLessThan(8000);
        }
      }
    } finally {
      captured.childTarget = undefined;
    }
  },
);
