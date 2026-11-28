import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  CodexCatalogCache,
  ComposioEmulator,
  EncryptedSecretStore,
  ExpoPushProvider,
  listPiCatalog,
  PiAgentRuntime,
  probeCatalogProviderModels,
  serializeModelSecret,
} from "@rakazo/adapters";
import type { ModelConnectResult, ModelCredential } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

function directoryChatCompletion(model: string, content: string): Response {
  const chunk = {
    id: "chunk_directory_fixture",
    object: "chat.completion.chunk",
    created: 1,
    model,
  };
  const frames = [
    {
      ...chunk,
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { ...chunk, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ];
  return new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function directoryAnthropicMessage(model: string, content: string): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg_directory_fixture",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function directoryGeminiMessage(model: string, content: string): Response {
  const frame = {
    modelVersion: model,
    candidates: [
      { index: 0, content: { role: "model", parts: [{ text: content }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
  };
  return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesStream(id: string, items: Array<{ type: string; id: string }>): Response {
  const frames = [
    { type: "response.created", response: { id } },
    ...items.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: items,
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    },
  ];
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesMessage(text: string) {
  return {
    id: "msg_directory_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

const subscriptionDirectoryModel = "gpt-fixture-subscription-discovered";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it.each([
    { provider: "openai", modelId: "gpt-6.1-terra" },
    { provider: "openai-codex", modelId: "gpt-6.1-terra" },
    { provider: "vercel-ai-gateway", modelId: "openai/gpt-6.1-terra" },
    { provider: "openai", modelId: "gpt-6.2-astra" },
    { provider: "openai", modelId: "gpt-6.2-sol" },
    { provider: "openai-codex", modelId: "gpt-6.2-astra" },
    { provider: "openai-codex", modelId: "gpt-6.2-sol" },
    { provider: "openai-codex", modelId: subscriptionDirectoryModel },
    { provider: "vercel-ai-gateway", modelId: "openai/gpt-6.2-astra" },
    { provider: "vercel-ai-gateway", modelId: "openai/gpt-6.2-sol" },
  ])(
    "runs a tool round trip on $provider with $modelId",
    async ({ provider, modelId }) => {
      const gateway = provider === "vercel-ai-gateway";
      const codex = provider === "openai-codex";
      const discovered = modelId === subscriptionDirectoryModel;
      const endpoint = gateway
        ? "https://ai-gateway.vercel.sh/v1/messages"
        : codex
          ? "https://chatgpt.com/backend-api/codex/responses"
          : "https://api.openai.com/v1/responses";
      const apiKey = "fixture-tool-round-trip-key";
      const accountId = "fixture-directory-account";
      const otherAccountId = "fixture-other-directory-account";
      const tokenForAccount = (id: string) => {
        const claims = Buffer.from(
          JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } }),
        ).toString("base64url");
        return `fixture.${claims}.fixture`;
      };
      const oauthToken = tokenForAccount(accountId);
      const encryptionKey = "offline-responses-fixture-encryption-key";
      const filePath = "notes/result.txt";
      const prompt = "Save hello to notes/result.txt.";
      const answer = "Saved notes/result.txt.";
      const reasoning = {
        id: "rs_directory_fixture",
        type: "reasoning",
        summary: [],
        encrypted_content: "opaque-reasoning-fixture",
      };
      const toolCall = {
        id: "fc_directory_fixture",
        type: "function_call",
        call_id: "call_directory_fixture",
        status: "completed",
        name: "write_file",
        arguments: JSON.stringify({ path: filePath, content: "hello" }),
      };
      const modelFetch = vi.fn<typeof fetch>(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(gateway ? `${endpoint}?beta=true` : endpoint);
        expect(request.method).toBe("POST");
        const body =
          request.headers.get("content-encoding") === "zstd"
            ? JSON.parse(zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString())
            : await request.json();
        const firstCall = modelFetch.mock.calls.length === 1;
        if (gateway) {
          expect(request.headers.get("x-api-key")).toBe(apiKey);
          expect(request.headers.has("authorization")).toBe(false);
          expect(body).toMatchObject({
            model: modelId,
            stream: true,
            tools: expect.arrayContaining([expect.objectContaining({ name: "write_file" })]),
          });
          expect(body).not.toHaveProperty("input");
          expect(JSON.stringify(body.messages)).toContain(prompt);
          if (firstCall) {
            const frames = [
              {
                type: "message_start",
                message: {
                  id: "msg_gateway_tool",
                  model: modelId,
                  role: "assistant",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 2, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: toolCall.call_id,
                  name: "write_file",
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: toolCall.arguments },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "tool_use" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ];
            return new Response(
              frames
                .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const result = body.messages
            .at(-1)
            ?.content?.find((item: { type?: string }) => item.type === "tool_result");
          expect(result).toMatchObject({ tool_use_id: toolCall.call_id });
          const content =
            typeof result.content === "string" ? result.content : result.content[0].text;
          expect(JSON.parse(content)).toMatchObject({ ok: true, path: filePath });
          return directoryAnthropicMessage(modelId, answer);
        }
        expect(request.headers.get("authorization")).toBe(`Bearer ${codex ? oauthToken : apiKey}`);
        if (codex) {
          expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
          expect(body.reasoning).toMatchObject({ effort: "low" });
        }
        expect(body).toMatchObject({ model: modelId, store: false, stream: true });
        for (const field of [
          "messages",
          "reasoning_effort",
          "temperature",
          "top_p",
          "top_logprobs",
          "prompt_cache_retention",
        ]) {
          expect(body).not.toHaveProperty(field);
        }
        expect(body.include ?? []).not.toContain("message.output_text.logprobs");
        expect(body.tools).toContainEqual(
          expect.objectContaining({ type: "function", name: "write_file" }),
        );
        expect(JSON.stringify(body.input)).toContain(prompt);
        if (firstCall) {
          return responsesStream("resp_directory_tool", [reasoning, toolCall]);
        }
        expect(modelFetch.mock.calls).toHaveLength(2);
        const toolIndex = body.input.findIndex(
          (item: { type?: string }) => item.type === "function_call",
        );
        expect(toolIndex).toBeGreaterThan(0);
        expect(body.input.slice(toolIndex - 1, toolIndex + 2)).toEqual([
          reasoning,
          expect.objectContaining({
            id: toolCall.id,
            type: toolCall.type,
            call_id: toolCall.call_id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }),
          {
            type: "function_call_output",
            call_id: toolCall.call_id,
            output: expect.any(String),
          },
        ]);
        expect(JSON.parse(body.input[toolIndex + 1].output)).toMatchObject({
          ok: true,
          path: filePath,
        });
        return responsesStream("resp_directory_answer", [responsesMessage(answer)]);
      });
      const catalog = listPiCatalog()
        .filter((entry) => entry.provider === "openai")
        .map(({ id }) => id);
      const codexAnchors = listPiCatalog().filter((entry) => entry.provider === "openai-codex");
      const subscriptionModels = codexAnchors
        .slice(0, Math.ceil(codexAnchors.length / 4))
        .map(({ id }) => id);
      const catalogProbe: typeof probeCatalogProviderModels = (input, _fetch, signal) =>
        probeCatalogProviderModels(
          input,
          async (url, init) => {
            const request = new Request(url, init);
            expect(request.url).toBe("https://api.openai.com/v1/models");
            expect(request.method).toBe("GET");
            expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
            return Response.json({
              data: [...new Set([...catalog, modelId])].map((id) => ({ id })),
            });
          },
          signal,
        );
      const localFetch = globalThis.fetch;
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).origin === fixtureOrigin) return localFetch(input, init);
        expect(request.url).toBe(endpoint);
        expect(request.method).toBe("POST");
        const body = await request.json();
        expect(body).toMatchObject({
          model: modelId,
          [gateway ? "max_tokens" : "max_output_tokens"]: 1024,
          tools: [expect.objectContaining({ name: "noop" })],
        });
        if (gateway) {
          expect(request.headers.get("x-api-key")).toBe(apiKey);
          return directoryAnthropicMessage(modelId, "OK");
        }
        expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
        return responsesStream("resp_directory_probe", [responsesMessage("OK")]);
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "offline-responses-tools-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        let catalogTime = Date.now();
        let modelRetired = false;
        const codexCatalog = codex
          ? new CodexCatalogCache({
              now: () => catalogTime,
              fetch: async (input, init) => {
                const request = new Request(input, init);
                expect(request.url).toBe(
                  "https://chatgpt.com/backend-api/codex/models?client_version=0.169.1",
                );
                const requestedAccount = request.headers.get("chatgpt-account-id");
                expect([accountId, otherAccountId]).toContain(requestedAccount);
                expect(request.headers.get("authorization")).toBe(
                  `Bearer ${tokenForAccount(requestedAccount!)}`,
                );
                const modelIds =
                  requestedAccount === otherAccountId || modelRetired
                    ? subscriptionModels
                    : discovered
                      ? [...subscriptionModels, modelId]
                      : [modelId];
                return Response.json({
                  models: modelIds.map((slug) => ({
                    slug,
                    visibility: "list",
                    supported_in_api: true,
                    input_modalities: ["text"],
                    supported_reasoning_levels: [{ effort: "low" }],
                  })),
                });
              },
            })
          : undefined;
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          runtime: new PiAgentRuntime({ modelFetch }),
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey,
          modelLiveCatalogEnabled: true,
          catalogProbe,
          codexCatalog,
        });
        stop = handles.stop;
        const { app } = handles;
        const email = `responses-${randomUUID()}@example.test`;
        const signup = await app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email,
            password: "password12",
            name: "Responses fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        let connection: Pick<ModelCredential, "id" | "connectionRevision">;
        let otherConnection: typeof connection | undefined;
        if (codex) {
          const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
          const membership = await handles.prisma.spaceMember.findFirstOrThrow({
            where: { userId: user.id },
          });
          const createConnection = async (id: string) => {
            const credential = serializeModelSecret({
              kind: "oauth",
              credential: {
                type: "oauth",
                access: tokenForAccount(id),
                refresh: "fixture-refresh",
                expires: Date.now() + 60 * 60_000,
                accountId: id,
              },
            });
            // Start with an existing synthetic sign-in. OAuth exchange is tested separately.
            const stored = await new EncryptedSecretStore(encryptionKey).put(credential, {
              userId: user.id,
              spaceId: membership.spaceId,
              operationId: "fixture",
              traceId: "fixture",
              signal: new AbortController().signal,
            });
            await handles.prisma.secret.create({
              data: {
                id: stored.id,
                userId: user.id,
                kind: "model",
                ciphertext: stored.ciphertext,
              },
            });
            return handles.prisma.userModelCredential.create({
              data: {
                userId: user.id,
                provider,
                label: "Subscription fixture",
                secretId: stored.id,
              },
            });
          };
          connection = await createConnection(accountId);
          if (discovered) otherConnection = await createConnection(otherAccountId);
        } else {
          const checked = await rpc<ModelConnectResult>(app, cookie, "models/connect", {
            provider,
            modelId,
            apiKey,
            verifyInference: true,
          });
          expect(checked).toMatchObject({ modelId, inferenceStatus: "accepted" });
          connection = checked;
        }
        const selection = {
          provider,
          modelId,
          modelCredentialId: connection.id,
          expectedRevision: connection.connectionRevision,
        };
        if (otherConnection) {
          const connections = await rpc<ModelCredential[]>(app, cookie, "models/credentials", {
            includeProviderCatalog: true,
          });
          expect(
            connections.find(({ id }) => id === connection.id)?.connectionCatalogModels,
          ).toEqual([
            expect.objectContaining({
              id: modelId,
              auth: "oauth",
              thinkingLevels: ["low"],
              images: false,
            }),
          ]);
          expect(
            connections.find(({ id }) => id === otherConnection.id)?.connectionCatalogModels,
          ).toBeUndefined();
          await expect(
            rpc(app, cookie, "models/setDefault", {
              ...selection,
              modelCredentialId: otherConnection.id,
              expectedRevision: otherConnection.connectionRevision,
            }),
          ).rejects.toThrow(/models\/setDefault: 400/);
        } else if (codex) {
          const unavailable = modelId === "gpt-6.2-sol" ? "gpt-6.2-astra" : "gpt-6.2-sol";
          const catalog = await rpc<Array<{ provider: string; id: string }>>(
            app,
            cookie,
            "models/list",
            null,
          );
          const subscriptionModels = catalog.filter((entry) => entry.provider === provider);
          expect(subscriptionModels).toContainEqual(
            expect.objectContaining({
              provider,
              id: modelId,
              thinkingLevels: ["low"],
              images: false,
            }),
          );
          expect(subscriptionModels.map(({ id }) => id)).not.toContain(unavailable);
          await expect(
            rpc(app, cookie, "models/setDefault", { ...selection, modelId: unavailable }),
          ).rejects.toThrow(/models\/setDefault: 400/);
        } else if (gateway) {
          await expect(rpc(app, cookie, "models/list", null)).resolves.toContainEqual(
            expect.objectContaining({ provider, id: modelId, inferenceProbe: true }),
          );
        } else {
          await expect(
            rpc<ModelCredential[]>(app, cookie, "models/credentials", {
              includeProviderCatalog: true,
            }),
          ).resolves.toContainEqual(
            expect.objectContaining({
              id: connection.id,
              modelId,
              providerListedModelIds: expect.arrayContaining([modelId]),
            }),
          );
        }
        await rpc(app, cookie, "models/setDefault", {
          ...selection,
          ...(codex ? { thinkingLevel: "low" } : {}),
        });
        if (discovered) {
          await expect(rpc(app, cookie, "me", null)).resolves.toMatchObject({
            defaultProvider: provider,
            defaultModel: modelId,
            defaultModelCredentialId: connection.id,
          });
        }
        const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
          name: "Responses fixture",
          title: "",
          description: "",
          instructions: "Complete the task.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        if (discovered) {
          await rpc(app, cookie, "bots/update", {
            botId: bot.id,
            modelProvider: provider,
            modelId,
            modelCredentialId: connection.id,
            expectedRevision: selection.expectedRevision,
            thinkingLevel: "low",
          });
          await rpc(app, cookie, "models/setDefault", {
            ...selection,
            modelId: subscriptionModels[0],
          });
          await expect(rpc(app, cookie, "me", null)).resolves.toMatchObject({
            defaultModel: subscriptionModels[0],
            defaultModelCredentialId: connection.id,
          });
          await rpc(app, cookie, "models/setBackups", [{ ...selection, thinkingLevel: "low" }]);
        }
        modelFetch.mockClear();
        const { runId } = await rpc<{ runId: string }>(app, cookie, "threads/send", {
          botId: bot.id,
          text: prompt,
        });
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: runId } });
              if (run?.status === "failed") throw new Error(`Run failed: ${run.error}`);
              return run;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toMatchObject({
            status: "completed",
            modelProvider: provider,
            modelId,
            modelCredentialId: connection.id,
          });
        expect(modelFetch).toHaveBeenCalledTimes(2);
        await expect(
          rpc(app, cookie, "computer/readFile", { botId: bot.id, path: filePath }),
        ).resolves.toMatchObject({ content: "hello" });
        const thread = await rpc<{ messages: unknown[] }>(app, cookie, "threads/get", {
          botId: bot.id,
        });
        expect(JSON.stringify(thread.messages)).toContain(answer);
        if (discovered) {
          await rpc(app, cookie, "models/setDefault", { ...selection, thinkingLevel: "low" });
          modelRetired = true;
          catalogTime += 16 * 60_000;
          await expect
            .poll(async () => {
              const connections = await rpc<ModelCredential[]>(app, cookie, "models/credentials", {
                includeProviderCatalog: true,
              });
              return connections.find(({ id }) => id === connection.id);
            })
            .toMatchObject({
              modelId,
              isDefault: true,
              savedModelDirectory: { confirmationRequired: true, notListed: true },
            });
          await expect(rpc(app, cookie, "models/setDefault", selection)).rejects.toThrow(
            /models\/setDefault: 400/,
          );
          expect(modelFetch).toHaveBeenCalledTimes(2);
        }
      } finally {
        try {
          await stop?.();
        } finally {
          transport.mockRestore();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );

  const directoryRoutes = [
    { provider: "openai", prefix: "gpt", endpoint: "https://api.openai.com/v1/responses" },
    { provider: "xai", prefix: "grok", endpoint: "https://api.x.ai/v1/responses" },
    {
      provider: "deepseek",
      prefix: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
    },
    {
      provider: "groq",
      prefix: "fixture-vendor/chat",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
    },
    {
      provider: "openrouter",
      prefix: "fixture-vendor/chat",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
    },
    {
      provider: "anthropic",
      prefix: "claude",
      endpoint: "https://api.anthropic.com/v1/messages?beta=true",
    },
    {
      provider: "google",
      prefix: "gemini",
      endpoint:
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture-discovered-model:streamGenerateContent?alt=sse",
    },
  ];
  it.each(directoryRoutes)("runs a confirmed $provider model", async (route) => {
    const { provider, prefix, endpoint } = route;
    const chatCompletions = endpoint.endsWith("/chat/completions");
    const deepSeek = provider === "deepseek";
    const anthropic = provider === "anthropic";
    const gemini = provider === "google";
    const openRouter = provider === "openrouter";
    const authHeader = gemini ? "x-goog-api-key" : anthropic ? "x-api-key" : "authorization";
    const headerValue = (key: string) => (anthropic || gemini ? key : `Bearer ${key}`);
    const apiKey = "fixture-discovered-model-key";
    const differentKey = "fixture-replacement-model-key";
    const qualifiedKey = "fixture-qualified-model-key";
    const nextKey = "fixture-next-qualified-key";
    const modelId = `${prefix}-fixture-discovered-model`;
    const rejectedId = `${prefix}-fixture-not-in-directory`;
    const otherModelIds = [
      `${prefix}-fixture-discovered-second`,
      `${prefix}-fixture-discovered-third`,
    ];
    const realtime = `${prefix}-fixture-realtime`;
    const bundled = listPiCatalog().filter((entry) => entry.provider === provider);
    const originalModel = bundled[0]!.id;
    const probe = vi.fn(async ({ apiKey: key }: { apiKey: string }) => {
      const ids = [
        ...bundled.map(({ id }) => id),
        ...(key === apiKey || key === qualifiedKey || key === nextKey
          ? [modelId, ...otherModelIds]
          : []),
        realtime,
      ];
      if (!openRouter) return ids;
      return probeCatalogProviderModels({ provider, apiKey: key }, async (input, init) => {
        const directory = new Request(input, init);
        expect(directory.url).toBe("https://openrouter.ai/api/v1/models/user");
        expect(directory.headers.get("authorization")).toBe(`Bearer ${key}`);
        return Response.json({
          data: ids.map((id) => ({
            id,
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            endpoints: ["/api/v1/chat/completions"],
          })),
          total_count: ids.length,
        });
      });
    });
    let expectedWireModel = modelId;
    let expectedWireKey = apiKey;
    const modelFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      const headers = new Headers(init?.headers);
      expect(headers.get(authHeader)).toBe(headerValue(expectedWireKey));
      const body = JSON.parse(String(init?.body));
      if (gemini) {
        expect(headers.has("authorization")).toBe(false);
        expect(body.contents).toEqual(
          expect.arrayContaining([expect.objectContaining({ role: "user" })]),
        );
        return directoryGeminiMessage(modelId, "Used the selected model.");
      }
      expect(body).toMatchObject({ model: expectedWireModel, stream: true });
      if (anthropic) {
        expect(headers.has("authorization")).toBe(false);
        expect(body).not.toHaveProperty("fallbacks");
        return directoryAnthropicMessage(modelId, "Used the selected model.");
      }
      if (chatCompletions) {
        if (deepSeek) expect(body.thinking).toEqual({ type: "disabled" });
        else if (expectedWireModel === modelId) {
          expect(body).not.toHaveProperty("store");
          expect(body).not.toHaveProperty("reasoning_effort");
        }
        return directoryChatCompletion(expectedWireModel, "Used the selected model.");
      }
      return responsesStream("resp_directory_fixture", [
        responsesMessage("Used the selected model."),
      ]);
    });
    let probeKey = apiKey;
    let probeResponse = "accepted";
    const inferenceFetch = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(endpoint);
      expect(request.headers.get(authHeader)).toBe(headerValue(probeKey));
      const body = await request.json();
      if (gemini) {
        expect(body).toMatchObject({
          generationConfig: { maxOutputTokens: 1024 },
          tools: [{ functionDeclarations: [expect.objectContaining({ name: "noop" })] }],
        });
      } else
        expect(body).toMatchObject({
          model: modelId,
          ...(chatCompletions
            ? {
                [deepSeek ? "max_tokens" : "max_completion_tokens"]: 1024,
                ...(deepSeek ? { thinking: { type: "disabled" } } : {}),
                tools: [
                  expect.objectContaining({ function: expect.objectContaining({ name: "noop" }) }),
                ],
              }
            : {
                [anthropic ? "max_tokens" : "max_output_tokens"]: 1024,
                tools: [expect.objectContaining({ name: "noop" })],
              }),
        });
      if (probeResponse !== "accepted")
        return Response.json(
          {
            error: { code: probeResponse === "auth" ? "invalid_api_key" : "rate_limit_exceeded" },
          },
          { status: probeResponse === "auth" ? 401 : 429 },
        );
      if (chatCompletions) return directoryChatCompletion(modelId, "OK");
      if (anthropic) return directoryAnthropicMessage(modelId, "OK");
      if (gemini) return directoryGeminiMessage(modelId, "OK");
      return new Response(
        'data: {"type":"response.created","response":{"id":"inference-fixture"}}\n\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const fetch = globalThis.fetch;
    const dataDir = await mkdtemp(path.join(tmpdir(), "offline-model-directory-"));
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href === endpoint) {
        // The native Gemini SDK calls global fetch. The check uses a distinct fixed prompt.
        if (gemini && JSON.parse(String(init?.body)).contents?.[0]?.parts?.[0]?.text !== "OK?")
          return modelFetch(input, init);
        return inferenceFetch(input, init);
      }
      if (url.origin === fixtureOrigin) return fetch(input, init);
      throw new Error("Unexpected network request in the model directory test");
    });
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        runtime: new PiAgentRuntime(gemini ? {} : { modelFetch }),
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-directory-fixture-encryption-key",
        modelLiveCatalogEnabled: true,
        catalogProbe: probe,
      });
      stop = handles.stop;
      const { app } = handles;
      const signup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `directory-${randomUUID()}@example.test`,
          password: "password12",
          name: "Directory fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      let saved = await rpc<ModelCredential>(app, cookie, "models/connect", {
        provider,
        apiKey,
        modelId: originalModel,
        label: "Named connection",
        ...(openRouter ? { contextWindow: 24_000 } : {}),
      });
      const read = async (includeProviderCatalog: boolean) =>
        (
          await rpc<ModelCredential[]>(app, cookie, "models/credentials", {
            includeProviderCatalog,
          })
        ).find((item) => item.id === saved.id);
      if (openRouter) {
        const legacyModel = "fixture-vendor/legacy-chat";
        // A pre-directory connection could save a manual ID and context limit.
        await handles.prisma.spaceModelPreference.updateMany({
          where: { credentialId: saved.id },
          data: { modelId: legacyModel },
        });
        expect(await read(true)).toMatchObject({ modelId: legacyModel });
        expect(await read(true)).not.toHaveProperty("savedModelDirectory");
        const legacyReplacement = await rpc<ModelCredential>(app, cookie, "models/connect", {
          provider,
          modelId: legacyModel,
          credentialId: saved.id,
          apiKey: differentKey,
          expectedRevision: saved.connectionRevision,
          label: saved.label,
        });
        expect(legacyReplacement.modelId).toBe(legacyModel);
        const legacyBinding = {
          modelId: legacyModel,
          modelCredentialId: saved.id,
          expectedRevision: legacyReplacement.connectionRevision,
        };
        await rpc(app, cookie, "models/setDefault", { provider, ...legacyBinding });
        await rpc(app, cookie, "models/setDefault", {
          provider,
          ...legacyBinding,
          thinkingLevel: "off",
          updateThinkingLevelOnly: true,
        });
        expectedWireModel = legacyModel;
        expectedWireKey = differentKey;
        const legacyBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
          name: "Legacy model fixture",
          title: "",
          description: "",
          instructions: "Answer briefly.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, legacyBot.id);
        await rpc(app, cookie, "bots/update", {
          botId: legacyBot.id,
          modelProvider: provider,
          ...legacyBinding,
        });
        const legacyRun = await rpc<{ runId: string }>(app, cookie, "threads/send", {
          botId: legacyBot.id,
          text: "Use the existing model.",
        });
        await expect
          .poll(() => handles.prisma.run.findUnique({ where: { id: legacyRun.runId } }), {
            timeout: 15_000,
            interval: 100,
          })
          .toMatchObject({
            status: "completed",
            modelProvider: provider,
            modelId: legacyModel,
            modelCredentialId: saved.id,
          });
        expect(modelFetch).toHaveBeenCalledOnce();
        expect(inferenceFetch).not.toHaveBeenCalled();
        modelFetch.mockClear();
        expectedWireModel = modelId;
        expectedWireKey = apiKey;
        saved = await rpc<ModelCredential>(app, cookie, "models/connect", {
          provider,
          modelId: originalModel,
          credentialId: saved.id,
          apiKey,
          expectedRevision: legacyReplacement.connectionRevision,
          label: saved.label,
        });
      }
      const select = (id: string, expectedRevision = saved.connectionRevision) =>
        rpc(app, cookie, "models/setDefault", {
          provider,
          modelId: id,
          modelCredentialId: saved.id,
          expectedRevision,
        });
      const listed = await read(true);
      expect(listed?.providerCatalogInferenceProbe).toBe("replacement");
      expect(listed?.providerListedModelIds).toContain(modelId);
      expect(listed?.providerListedModelIds).not.toContain(realtime);
      const testModel = (expectedRevision: number | undefined, apiKey?: string) =>
        rpc(app, cookie, "models/probeInference", {
          provider,
          modelId,
          credentialId: saved.id,
          expectedRevision,
          apiKey,
        });
      await expect(testModel(saved.connectionRevision)).resolves.toEqual({ status: "accepted" });
      await expect(testModel(saved.connectionRevision, differentKey)).resolves.toEqual({
        status: "model",
      });
      expect(inferenceFetch).toHaveBeenCalledTimes(1);
      expect((await read(false))?.savedProviderCatalogModelIds).toBeUndefined();
      await expect(select(rejectedId)).rejects.toThrow(/models\/setDefault: 400/);
      expect((await read(false))?.modelId).toBe(originalModel);
      await expect(
        rpc(app, cookie, "models/connect", {
          provider,
          credentialId: saved.id,
          expectedRevision: saved.connectionRevision,
          modelId,
          maxTokens: 1024,
        }),
      ).rejects.toThrow(/models\/connect: 400/);
      const credentialBeforeSelection = await handles.prisma.userModelCredential.findUniqueOrThrow({
        where: { id: saved.id },
        select: { secretId: true, updatedAt: true },
      });
      const secretBeforeSelection = await handles.prisma.secret.findUniqueOrThrow({
        where: { id: credentialBeforeSelection.secretId },
        select: { ciphertext: true },
      });
      await select(modelId);
      const confirmed = await read(false);
      expect(confirmed).toMatchObject({
        id: saved.id,
        label: "Named connection",
        modelId,
        isDefault: true,
        savedProviderCatalogModelIds: [modelId],
      });
      expect(confirmed?.connectionRevision).toBe(saved.connectionRevision);
      const callsBeforeSavedCheck = probe.mock.calls.length;
      await expect(testModel(confirmed?.connectionRevision)).resolves.toEqual({
        status: "accepted",
      });
      expect(probe).toHaveBeenCalledTimes(callsBeforeSavedCheck);
      expect(inferenceFetch).toHaveBeenCalledTimes(2);
      probeKey = qualifiedKey;
      await expect(testModel(confirmed?.connectionRevision, qualifiedKey)).resolves.toEqual({
        status: "accepted",
      });
      expect(inferenceFetch).toHaveBeenCalledTimes(3);
      expect(await read(false)).toEqual(confirmed);
      expect(
        await handles.prisma.userModelCredential.findUniqueOrThrow({
          where: { id: saved.id },
          select: { secretId: true, updatedAt: true },
        }),
      ).toEqual(credentialBeforeSelection);
      expect(
        await handles.prisma.secret.findUniqueOrThrow({
          where: { id: credentialBeforeSelection.secretId },
          select: { ciphertext: true },
        }),
      ).toEqual(secretBeforeSelection);
      await expect(select(modelId, saved.connectionRevision! + 1)).rejects.toThrow(
        /models\/setDefault: 409/,
      );
      await expect(
        rpc(app, cookie, "models/saveModelSettings", {
          credentialId: saved.id,
          modelId,
          settings: { maxTokens: 40_000 },
        }),
      ).rejects.toThrow(/models\/saveModelSettings: 400/);
      // A rejected replacement must not clear the working choice or its key.
      await expect(
        rpc(app, cookie, "models/connect", {
          provider,
          credentialId: saved.id,
          expectedRevision: confirmed?.connectionRevision,
          apiKey: differentKey,
          modelId,
        }),
      ).rejects.toThrow(/models\/connect: 400/);
      expect(await read(false)).toEqual(confirmed);
      // Concurrent confirmations on the same connection must preserve both IDs.
      await Promise.all(otherModelIds.map((id) => select(id, confirmed?.connectionRevision)));
      expect((await read(false))?.savedProviderCatalogModelIds?.sort()).toEqual(
        [modelId, ...otherModelIds].sort(),
      );
      const catalogCalls = probe.mock.calls.length;
      // Explicitly saved choices on the same key can be reused without a catalog
      // request, including after the default was changed to a bundled model.
      await select(originalModel, confirmed?.connectionRevision);
      await select(modelId, confirmed?.connectionRevision);
      expect(probe).toHaveBeenCalledTimes(catalogCalls);
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Directory fixture",
        title: "",
        description: "",
        instructions: "Answer briefly.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
        botId: bot.id,
        text: "Use the saved model.",
      });
      await expect
        .poll(
          () =>
            handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: {
                status: true,
                modelProvider: true,
                modelId: true,
                modelCredentialId: true,
              },
            }),
          { timeout: 15_000, interval: 100 },
        )
        .toEqual({
          status: "completed",
          modelProvider: provider,
          modelId,
          modelCredentialId: saved.id,
        });
      expect(modelFetch).toHaveBeenCalledOnce();
      await rpc(app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: provider,
        modelId,
        modelCredentialId: saved.id,
        expectedRevision: confirmed?.connectionRevision,
      });
      await select(originalModel, confirmed?.connectionRevision);
      expect((await read(false))?.modelId).toBe(originalModel);
      const pinned = await rpc<{ runId: string }>(app, cookie, "threads/send", {
        botId: bot.id,
        text: "Use the pinned model.",
      });
      await expect
        .poll(
          () =>
            handles.prisma.run.findUnique({
              where: { id: pinned.runId },
              select: {
                status: true,
                modelProvider: true,
                modelId: true,
                modelCredentialId: true,
              },
            }),
          { timeout: 15_000, interval: 100 },
        )
        .toEqual({
          status: "completed",
          modelProvider: provider,
          modelId,
          modelCredentialId: saved.id,
        });
      expect(modelFetch).toHaveBeenCalledTimes(2);
      expect(inferenceFetch).toHaveBeenCalledTimes(3);
      expect(probe).toHaveBeenCalledTimes(catalogCalls);
      const thread = await rpc(app, cookie, "threads/get", { botId: bot.id });
      expect(JSON.stringify(thread)).toContain("Used the selected model.");
      expect(JSON.stringify(thread)).not.toContain(apiKey);
      // Another Space can replace an account connection while this Space retains its model and limits.
      const { spaceId } = await rpc<{ spaceId: string }>(app, cookie, "me");
      await select(modelId, confirmed?.connectionRevision);
      await rpc(app, cookie, "models/saveModelSettings", {
        credentialId: saved.id,
        modelId,
        settings: { contextWindow: 32_000, maxTokens: 1024 },
      });
      const otherSpace = await rpc<{ id: string }>(app, cookie, "spaces/create", {
        name: "Other models",
      });
      const rotate = (apiKey: string, expectedRevision?: number) =>
        rpc<ModelCredential>(
          app,
          cookie,
          "models/connect",
          {
            provider,
            modelId: originalModel,
            credentialId: saved.id,
            expectedRevision,
            apiKey,
          },
          otherSpace.id,
        );
      const missing = await rotate(differentKey, confirmed?.connectionRevision);
      if (openRouter) {
        const row = await handles.prisma.userModelCredential.findUniqueOrThrow({
          where: { id: saved.id },
        });
        expect(row.providerCatalogSelection).toEqual({
          requiredModelIds: expect.arrayContaining([modelId]),
        });
        const unconfirmed = await rpc<{ runId: string }>(app, cookie, "threads/send", {
          botId: bot.id,
          text: "Do not run the unconfirmed model.",
        });
        await expect
          .poll(() => handles.prisma.run.findUnique({ where: { id: unconfirmed.runId } }), {
            timeout: 15_000,
            interval: 100,
          })
          .toMatchObject({
            status: "failed",
            error: expect.stringContaining("Confirm this model for the current API key"),
          });
        expect(modelFetch).toHaveBeenCalledTimes(2);
      }
      const readSaved = async () =>
        (
          await rpc<ModelCredential[]>(
            app,
            cookie,
            "models/credentials",
            { includeProviderCatalog: true },
            spaceId,
          )
        ).find(({ id }) => id === saved.id);
      expect(await readSaved()).toMatchObject({
        modelId,
        modelSettings: { [modelId]: { contextWindow: 32_000, maxTokens: 1024 } },
        savedModelDirectory: { confirmationRequired: true, notListed: true },
      });
      await expect(select(modelId, missing.connectionRevision)).rejects.toThrow(
        /models\/setDefault: 400/,
      );
      const qualified = await rotate(qualifiedKey, missing.connectionRevision);
      expect((await readSaved())?.savedModelDirectory).toEqual({ confirmationRequired: true });
      await select(modelId, qualified.connectionRevision);
      expect(await readSaved()).toMatchObject({
        modelId,
        savedProviderCatalogModelIds: [modelId],
        modelSettings: { [modelId]: { contextWindow: 32_000, maxTokens: 1024 } },
      });
      expect(await readSaved()).not.toHaveProperty("savedModelDirectory");
      const verifiedConnect = {
        provider,
        credentialId: saved.id,
        expectedRevision: qualified.connectionRevision,
        apiKey: nextKey,
        modelId,
        verifyInference: true,
      };
      probeKey = nextKey;
      probeResponse = "auth";
      await expect(rpc(app, cookie, "models/connect", verifiedConnect)).rejects.toThrow(
        /models\/connect: 400/,
      );
      expect((await readSaved())?.connectionRevision).toBe(qualified.connectionRevision);
      expectedWireKey = qualifiedKey;
      const recovered = await rpc<{ runId: string }>(app, cookie, "threads/send", {
        botId: bot.id,
        text: "Use the confirmed model after replacing its key.",
      });
      await expect
        .poll(
          async () => {
            const row = await handles.prisma.run.findUnique({
              where: { id: recovered.runId },
              select: {
                status: true,
                error: true,
                modelProvider: true,
                modelId: true,
                modelCredentialId: true,
              },
            });
            if (row?.status === "failed")
              throw new Error(
                `Recovered Run failed: ${row.error}; wire calls: ${modelFetch.mock.calls.length}`,
              );
            return row;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toMatchObject({
          status: "completed",
          modelProvider: provider,
          modelId,
          modelCredentialId: saved.id,
        });
      expect(modelFetch).toHaveBeenCalledTimes(3);
      expect(inferenceFetch).toHaveBeenCalledTimes(4);
      probeResponse = "rate";
      const verified = await rpc<ModelConnectResult>(
        app,
        cookie,
        "models/connect",
        verifiedConnect,
      );
      expect(verified).toMatchObject({
        id: saved.id,
        modelId,
        inferenceStatus: "rate",
        connectionRevision: qualified.connectionRevision! + 1,
      });
      expect((await readSaved())?.savedProviderCatalogModelIds).toEqual([modelId]);
      expect(inferenceFetch).toHaveBeenCalledTimes(5);

      // Header-safe JSON may be the actual key text. It cannot introduce any
      // caller-supplied proof fields, even on an ordinary bundled-model save.
      const forgedKey = JSON.stringify({
        kind: "api_key",
        key: apiKey,
        providerCatalogModels: [rejectedId],
        providerCatalogSignature: "0".repeat(64),
      });
      const replaced = await rpc<ModelCredential>(app, cookie, "models/connect", {
        provider,
        credentialId: saved.id,
        expectedRevision: verified.connectionRevision,
        apiKey: forgedKey,
        modelId: originalModel,
      });
      expect(await read(false)).not.toHaveProperty("savedProviderCatalogModelIds");
      await expect(select(rejectedId, replaced.connectionRevision)).rejects.toThrow(
        /models\/setDefault: 400/,
      );
      expect(probe).toHaveBeenLastCalledWith(
        { provider, apiKey: forgedKey },
        undefined,
        expect.any(AbortSignal),
      );
      expect((await read(false))?.modelId).toBe(originalModel);
    } finally {
      transport.mockRestore();
      await stop?.();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    const fixtureKey = "offline-product-fixture-key";
    let helperCredentialId = "";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            const helper = request.tools?.find((tool) => tool.function.name === "run_subagent");
            expect(helper?.function.description).toContain(helperCredentialId);
            expect(helper?.function.description).toContain('"model_provider":"openai-compatible"');
            expect(helper?.function.description).toContain('"model_ids":["helper-only-model"]');
            expect(helper?.function.description).not.toContain("helper-fixture-key");
            expect(helper?.function.description).not.toContain("http://127.0.0.1:11435");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: {
            type: "tool",
            id: "product-shell",
            name: "shell",
            arguments: { command: "wc -c notes/result.txt" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-shell");
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const credential = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const helper = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: "helper-only-model",
        enabledModelIds: ["helper-only-model"],
        baseUrl: "http://127.0.0.1:11435/v1",
        apiKey: "helper-fixture-key",
      });
      helperCredentialId = helper.id;
      // This account connection remains explicitly available to helpers without a local preference.
      await handles.prisma.spaceModelPreference.deleteMany({ where: { credentialId: helper.id } });
      await rpc(handles.app, cookie, "models/setDefault", {
        provider: model.model.provider,
        modelId: model.model.id,
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "File fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { status: true },
            });
            if (run?.status === "failed") model.assertComplete();
            return run?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/result.txt",
      });
      expect(file.content).toBe("hello");
      const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const messages = JSON.stringify(thread.messages);
      expect(messages).toContain("Saved notes/result.txt.");
      expect(messages).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        select: { payload: true },
      });
      expect(tools).toHaveLength(2);
      expect(JSON.stringify(tools[0])).toContain("write_file");
      const commands = await rpc<Array<Record<string, unknown>>>(
        handles.app,
        cookie,
        "computer/commands",
        { botId: bot.id },
      );
      expect(commands).toEqual([
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-write"]),
          kind: "write_file",
          command: "notes/result.txt",
          status: "done",
          exitCode: 0,
          bytes: 5,
        }),
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-shell"]),
          kind: "shell",
          command: "wc -c notes/result.txt",
          status: "done",
          exitCode: 0,
        }),
      ]);
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("keeps the approved Pi Run on its model and instructions until the next Run", async () => {
    const before = "Use the existing checklist.";
    const after = "Use the approved three-item checklist.";
    const key = "synthetic-bot-settings-key";
    const replacement = await startModelEmulator({
      modelId: "replacement-fixture",
      apiKey: key,
      steps: [
        {
          expect(request) {
            expect(request.messages.find(({ role }) => role === "system")?.content).toContain(
              after,
            );
          },
          response: { type: "text", text: "The new settings are active." },
        },
      ],
    });
    const initial = await startModelEmulator({
      modelId: "initial-fixture",
      apiKey: key,
      steps: [
        {
          expect(request) {
            expect(request.messages.find(({ role }) => role === "system")?.content).toContain(
              before,
            );
          },
          response: {
            type: "tool",
            id: "read-timezone",
            name: "update_preferences",
            arguments: {},
          },
        },
        {
          expect(request) {
            const tool = request.messages.findLast(({ role }) => role === "tool");
            expect(tool?.tool_call_id).toBe("read-timezone");
            expect(JSON.parse(String(tool?.content))).toMatchObject({ timezone: null });
          },
          response: {
            type: "tool",
            id: "write-timezone",
            name: "update_preferences",
            arguments: { timezone: "Pacific/Auckland" },
          },
        },
        {
          expect(request) {
            const tool = request.messages.findLast(({ role }) => role === "tool");
            expect(tool?.tool_call_id).toBe("write-timezone");
            expect(JSON.parse(String(tool?.content))).toMatchObject({
              timezone: "Pacific/Auckland",
            });
          },
          response: { type: "tool", id: "read-settings", name: "update_bot", arguments: {} },
        },
        {
          expect(request) {
            const tool = request.messages.findLast(({ role }) => role === "tool");
            expect(tool?.tool_call_id).toBe("read-settings");
            expect(JSON.parse(String(tool?.content))).toMatchObject({
              instructions: { source: "bot", value: before },
              model: { id: "initial-fixture", source: "bot" },
            });
          },
          response: {
            type: "tool",
            id: "approve-settings",
            name: "update_bot",
            arguments: { instructions: after, model: replacement.model.id },
          },
        },
        {
          expect(request) {
            const prompt = String(request.messages.find(({ role }) => role === "system")?.content);
            expect(prompt).toContain(before);
            expect(prompt).not.toContain(after);
            const tool = request.messages.findLast(({ role }) => role === "tool");
            expect(tool?.tool_call_id).toBe("approve-settings");
            expect(JSON.parse(String(tool?.content))).toMatchObject({ ok: true });
          },
          response: { type: "text", text: "Saved for the next run." },
        },
        {
          expect(request) {
            expect(request.messages.find(({ role }) => role === "system")?.content).toContain(
              before,
            );
          },
          response: {
            type: "tool",
            id: "profile-notify",
            name: "update_bot",
            arguments: { notifyOnFinish: true },
          },
        },
        {
          expect(request) {
            const tool = request.messages.findLast(({ role }) => role === "tool");
            expect(tool?.tool_call_id).toBe("profile-notify");
            expect(JSON.parse(String(tool?.content))).toMatchObject({
              ok: true,
              notifyOnFinish: true,
            });
          },
          response: { type: "text", text: "Notifications enabled." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "bot-settings-product-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: fixtureOrigin,
        webOrigin: fixtureOrigin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        encryptionKey: "offline-settings-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `settings-${randomUUID()}@example.test`,
          password: "password12",
          name: "Settings owner",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      async function connect(model: typeof initial) {
        return rpc<ModelCredential>(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: key,
          enabledModelIds: [model.model.id],
        });
      }
      const oldModel = await connect(initial);
      const newModel = await connect(replacement);
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Checklist",
        title: "",
        description: "",
        instructions: before,
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      const botId = bot.id;
      await rpc(handles.app, cookie, "bots/update", {
        botId,
        modelProvider: initial.model.provider,
        modelId: initial.model.id,
        modelCredentialId: oldModel.id,
        expectedRevision: oldModel.connectionRevision,
      });
      async function send(text: string) {
        return (await rpc<{ runId: string }>(handles.app, cookie, "threads/send", { botId, text }))
          .runId;
      }
      async function wait(runId: string, status: string) {
        await expect
          .poll(
            async () => (await handles.prisma.run.findUnique({ where: { id: runId } }))?.status,
            { timeout: 15_000, interval: 80 },
          )
          .toBe(status);
      }
      const runId = await send("Change the checklist and model for later runs.");
      await wait(runId, "waiting_input");
      const card = await handles.prisma.message.findFirstOrThrow({
        where: { runId, role: "bot" },
        orderBy: { seq: "desc" },
      });
      const approval = MessageBlockSchema.array()
        .parse(card.blocks)
        .find((block) => block.kind === "ask");
      expect(approval).toMatchObject({
        reviewMode: "screen",
        detail: expect.stringContaining(`Before: ${before}\nAfter: ${after}`),
        botSettings: {
          botId,
          changes: expect.arrayContaining([{ field: "instructions", before, after }]),
        },
      });
      await rpc(handles.app, cookie, "threads/answer", {
        botId,
        runId,
        messageId: card.id,
        answer: "allow",
      });
      await wait(runId, "completed");
      const nextId = await send("Check the active settings.");
      await wait(nextId, "completed");
      replacement.assertComplete();
      const current = await handles.prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      expect(current).toMatchObject({ modelCredentialId: newModel.id, instructions: after });
      const history = await rpc<{ revision: number; versions: Array<{ id: string }> }>(
        handles.app,
        cookie,
        "bots/settingsHistory",
        { botId },
      );
      const request = {
        botId,
        versionId: history.versions[0]!.id,
        expectedRevision: history.revision,
        clientNonce: randomUUID(),
      };
      const undo = () => rpc(handles.app, cookie, "bots/undoSettings", request);
      const replies = await Promise.all([undo(), undo()]);
      expect(replies).toEqual(
        Array.from({ length: 2 }, () => ({
          status: "updated",
          revision: history.revision + 1,
        })),
      );
      expect(await handles.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
        instructions: before,
        modelCredentialId: oldModel.id,
        settingsRevision: history.revision + 1,
      });
      await rpc(handles.app, cookie, "approvalRules/set", {
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "update_bot",
      });
      const profileRun = await send("Turn on finish notifications.");
      await wait(profileRun, "waiting_input");
      const profileCard = await handles.prisma.message.findFirstOrThrow({
        where: { runId: profileRun, role: "bot" },
        orderBy: { seq: "desc" },
      });
      await rpc(handles.app, cookie, "threads/answer", {
        botId,
        runId: profileRun,
        messageId: profileCard.id,
        answer: "allow",
      });
      await wait(profileRun, "completed");
      initial.assertComplete();
      expect(await handles.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
        notifyOnFinish: true,
        settingsRevision: history.revision + 1,
      });
    } finally {
      try {
        await stop?.();
      } finally {
        await Promise.all([initial.close(), replacement.close()]);
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 35_000);

  it.each([
    {
      reason: "done" as const,
      note: "The user handed the computer back. Continue from where you left off. Do not request takeover again.",
    },
    {
      reason: "skipped" as const,
      note: "The takeover ended without the user completing it. Continue without assuming that step was done. Do not request takeover again unless you still cannot proceed.",
    },
    {
      reason: "steering" as const,
      note: "Keep the screen with me and summarize what remains to check.",
    },
  ])(
    "passes a neutral $reason takeover resume through the Pi model request",
    async ({ reason, note }) => {
      const fixtureKey = "offline-takeover-fixture-key";
      const task = "Check the login screen, then wait for my manual confirmation.";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              const current = request.messages.findLast((message) => message.role === "user");
              expect(JSON.stringify(current?.content)).toContain(task);
              expect(JSON.stringify(current?.content)).not.toContain(note);
            },
            response: {
              type: "tool",
              id: "manual-screen-choice",
              name: "request_takeover",
              arguments: { reason: "Choose an option on the current screen." },
            },
          },
          {
            expect(request) {
              expect(request.messages.findLast((message) => message.role === "user")).toBeDefined();
            },
            response: { type: "text", text: "Control handoff received." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-takeover-"));
      let stop: (() => Promise<void>) | undefined;
      const notifications = vi.spyOn(ExpoPushProvider.prototype, "send");
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-takeover-fixture-encryption-key",
        });
        stop = handles.stop;
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `offline-takeover-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Takeover fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const credential = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        await rpc(handles.app, cookie, "models/setDefault", {
          provider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Screen fixture",
          title: "",
          description: "",
          instructions: "Continue only from observed state.",
          notifyOnFinish: reason === "steering",
          computerMode: "dedicated",
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: task,
        });
        await expect
          .poll(
            async () =>
              (await handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
            { timeout: 15_000, interval: 50 },
          )
          .toBe("waiting_takeover");
        const waiting = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        const userMessages = await handles.prisma.message.findMany({
          where: { threadId: waiting.threadId, role: "user" },
          select: { id: true },
          orderBy: { seq: "asc" },
        });
        expect(userMessages).toContainEqual({ id: waiting.sourceMessageId });
        await rpc(handles.app, cookie, "computer/boot", { botId: bot.id });
        await rpc(handles.app, cookie, "computer/takeover", { botId: bot.id });
        await handles.awaitIdle?.();
        if (reason === "done") {
          const snapshot = async () => ({
            run: await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
            attempts: await handles.prisma.attempt.findMany({
              where: { runId: sent.runId },
              orderBy: { id: "asc" },
            }),
            effects: await handles.prisma.externalEffect.findMany({
              where: { runId: sent.runId },
              orderBy: { id: "asc" },
            }),
            computer: await handles.prisma.computer.findFirstOrThrow({
              where: { bots: { some: { id: bot.id } } },
            }),
            leases: await handles.prisma.computerExecutionLease.findMany({
              where: { botId: bot.id },
              orderBy: { id: "asc" },
            }),
            messages: await handles.prisma.message.findMany({
              where: { runId: sent.runId },
              orderBy: { seq: "asc" },
            }),
            events: await handles.prisma.event.findMany({
              where: { runId: sent.runId },
              orderBy: { seq: "asc" },
            }),
            requests: structuredClone(model.requests),
          });
          const held = await snapshot();
          expect(held.run).toMatchObject({ status: "waiting_takeover", wakeAt: null });
          await handles.executor.continueRun(sent.runId, "stale-held-delivery");
          await handles.awaitIdle?.();
          expect(await snapshot()).toEqual(held);
        }
        const takeoverFootprint = async () => ({
          cards: (
            await handles.prisma.message.findMany({
              where: { runId: sent.runId, role: "bot" },
              select: { id: true, blocks: true },
              orderBy: { seq: "asc" },
            })
          ).flatMap((message) =>
            MessageBlockSchema.array()
              .parse(message.blocks)
              .filter((block) => block.kind === "computer" && block.state === "Needs you")
              .map((block) => ({ id: message.id, block })),
          ),
          events: await handles.prisma.event.findMany({
            where: { runId: sent.runId, type: "computer.takeover.requested" },
            select: { id: true },
            orderBy: { seq: "asc" },
          }),
          notifications: notifications.mock.calls.filter(
            ([message]) => message.kind === "takeover" && message.botId === bot.id,
          ).length,
        });
        const originalTakeover = reason === "steering" ? await takeoverFootprint() : undefined;
        if (originalTakeover) {
          expect(originalTakeover.cards).toHaveLength(1);
          expect(originalTakeover.events).toHaveLength(1);
          expect(originalTakeover.notifications).toBe(1);
        }
        if (reason === "steering") {
          await rpc(handles.app, cookie, "threads/send", { botId: bot.id, text: note });
        } else {
          await rpc(handles.app, cookie, "computer/release", { botId: bot.id, reason });
        }
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: sent.runId } });
              if (run?.status === "failed") model.assertComplete();
              return run?.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe("completed");
        model.assertComplete();
        expect(model.requests).toHaveLength(2);
        const resumed = model.requests[1]!;
        const takeoverResults = resumed.messages.filter(
          (message) => message.role === "tool" && message.tool_call_id === "manual-screen-choice",
        );
        expect(takeoverResults).toHaveLength(1);
        const prompt = JSON.stringify(takeoverResults[0]!.content);
        if (reason !== "steering") {
          expect(prompt).toContain(note);
          expect(prompt.split(note)).toHaveLength(2);
        }
        const resumedContent = resumed.messages
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        expect(resumedContent).toContain(note);
        if (reason !== "steering") expect(resumedContent.split(note)).toHaveLength(2);
        if (reason === "steering") {
          expect(await takeoverFootprint()).toEqual(originalTakeover);
          expect(
            await handles.prisma.computer.findFirstOrThrow({
              where: { bots: { some: { id: bot.id } } },
            }),
          ).toMatchObject({ controlHolder: "user" });
        }
        expect(resumedContent).not.toMatch(/The user (?:finished|skipped) the login/i);
        const userContext = resumed.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        expect(userContext.split(task)).toHaveLength(2);
        expect(
          await handles.prisma.message.findMany({
            where: { threadId: waiting.threadId, role: "user" },
            select: { id: true },
            orderBy: { seq: "asc" },
          }),
        ).toEqual(
          reason === "steering"
            ? [...userMessages, expect.objectContaining({ id: expect.any(String) })]
            : userMessages,
        );
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
        ).toMatchObject({
          threadId: waiting.threadId,
          sourceMessageId: waiting.sourceMessageId,
          status: "completed",
        });
      } finally {
        try {
          await stop?.();
        } finally {
          notifications.mockRestore();
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: fixtureOrigin,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
