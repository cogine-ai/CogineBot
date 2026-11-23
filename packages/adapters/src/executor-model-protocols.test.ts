import type { ModelApiProtocol } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import { createRunExecutor } from "./executor.js";
import { parseModelSecret, serializeModelSecret } from "./pi-oauth.js";
import { resolveRuntimeModel } from "./pi-runtime.js";
import { observedPiStream } from "./pi-usage.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

const scope = { userId: "model-owner", spaceId: "model-space", botId: "model-bot" };
const protocols: ModelApiProtocol[] = ["chat-completions", "responses", "anthropic-messages"];

function fixture(protocol: ModelApiProtocol) {
  const rows = ["a", "b"].map((suffix) => ({
    id: `connection-${suffix}`,
    userId: scope.userId,
    provider: "openai-compatible",
    secretId: `secret-${suffix}`,
    connectionRevision: 1,
    preferences: [{ modelId: "shared-model", thinkingLevel: null, isDefault: suffix === "b" }],
  }));
  const otherProtocol = protocol === "responses" ? "anthropic-messages" : "responses";
  const secrets = new Map(
    rows.map((row, index) => [
      row.secretId,
      {
        id: row.secretId,
        userId: scope.userId,
        spaceId: null,
        ciphertext: serializeModelSecret({
          kind: "openai_compatible",
          apiKey: `synthetic-key-${index}`,
          baseUrl: `http://127.0.0.1:${8090 + index}/v1`,
          apiProtocol: index === 0 ? protocol : otherProtocol,
          headers: { "X-Tenant": `private-${index}`, "X-Locale": "en" },
          enabledModelIds: ["shared-model"],
          maxTokens: 512,
        }),
      },
    ]),
  );
  const findCredential = vi.fn(
    async ({ where }: { where: { id?: string; userId: string; provider: string } }) =>
      rows.find(
        (row) =>
          row.id === where.id && row.userId === where.userId && row.provider === where.provider,
      ) ?? null,
  );
  const findSecret = vi.fn(
    async ({ where }: { where: { id: string; userId: string; spaceId: null } }) => {
      const row = secrets.get(where.id);
      return row?.userId === where.userId && where.spaceId === null ? row : null;
    },
  );
  const prisma = {
    userModelCredential: { findFirst: findCredential },
    secret: { findFirst: findSecret },
    spaceMember: { findUnique: vi.fn(async () => null) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: rows[1],
        modelId: "shared-model",
        thinkingLevel: null,
        isDefault: true,
      })),
    },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    bot: {
      findFirst: vi.fn(async () => ({
        modelProvider: "openai-compatible",
        modelId: "shared-model",
        modelCredentialId: "connection-a",
        thinkingLevel: null,
      })),
    },
  };
  const executor = createRunExecutor({
    prisma,
    runtime: new ScriptedAgentRuntime(),
    secretStore: { load: async (ciphertext: string) => ciphertext },
    web: {},
    browser: {},
  } as unknown as ExecutorDeps);
  return { executor, secrets, otherProtocol, findSecret };
}

describe("executor connection protocol resolution", () => {
  it.each(protocols)(
    "keeps a pinned %s connection distinct from the default and helper connection",
    async (protocol) => {
      const f = fixture(protocol);
      const expected = {
        provider: "openai-compatible",
        id: "shared-model",
        modelCredentialId: "connection-a",
        baseUrl: "http://127.0.0.1:8090/v1",
        apiKey: "synthetic-key-0",
        apiProtocol: protocol,
        headers: { "X-Tenant": "private-0", "X-Locale": "en" },
        maxTokens: 512,
      };
      await expect(f.executor.resolveModel(scope)).resolves.toMatchObject(expected);
      const registered: string[] = [];
      await expect(
        f.executor.resolveConnectedModel(
          scope,
          "openai-compatible",
          "shared-model",
          (values) => registered.push(...values),
          true,
          "connection-b",
        ),
      ).resolves.toMatchObject({
        modelCredentialId: "connection-b",
        apiProtocol: f.otherProtocol,
        baseUrl: "http://127.0.0.1:8091/v1",
        headers: { "X-Tenant": "private-1", "X-Locale": "en" },
      });
      expect(registered).not.toContain("en");
      await expect(f.executor.resolveModel(scope)).resolves.toMatchObject(expected);
      await expect(
        f.executor.resolveModel({ userId: scope.userId, spaceId: scope.spaceId }),
      ).resolves.toMatchObject({
        modelCredentialId: "connection-b",
        apiProtocol: f.otherProtocol,
        headers: { "X-Tenant": "private-1", "X-Locale": "en" },
      });
      expect(
        f.findSecret.mock.calls.every(
          ([{ where }]) => where.userId === scope.userId && where.spaceId === null,
        ),
      ).toBe(true);
    },
  );

  it.each(protocols)(
    "uses each actual %s model's settings without changing its stored effort",
    async (protocol) => {
      const f = fixture(protocol);
      const first = f.secrets.get("secret-a")!;
      const parsed = parseModelSecret(first.ciphertext);
      first.ciphertext = serializeModelSecret({
        ...parsed,
        models: {
          "shared-model": {
            maxTokens: 2048,
            contextWindow: 64000,
            reasoning: true,
            images: true,
            maxImagesPerPrompt: 3,
          },
        },
      });
      const main = await f.executor.resolveModel(scope);
      expect(main).toMatchObject({
        modelCredentialId: "connection-a",
        apiProtocol: protocol,
        maxTokens: 2048,
        contextWindow: 64000,
        reasoning: true,
        acceptsImages: true,
        maxImagesPerPrompt: 3,
      });
      const other = await f.executor.resolveConnectedModel(
        scope,
        "openai-compatible",
        "shared-model",
        undefined,
        true,
        "connection-b",
      );
      expect(other).toMatchObject({
        modelCredentialId: "connection-b",
        maxTokens: 512,
        apiProtocol: f.otherProtocol,
      });
      expect(other.contextWindow).toBeUndefined();
      expect(other.maxImagesPerPrompt).toBeUndefined();
      const runtime = resolveRuntimeModel(main);
      expect(runtime.model).toMatchObject({
        contextWindow: 64000,
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
      });
      const requests: Record<string, unknown>[] = [];
      const beforeCall = vi.fn(() => "reservation");
      const stream = observedPiStream(
        runtime.models,
        runtime.model!,
        {
          messages: [{ role: "user", content: "Short offline request", timestamp: 1 }],
        },
        {
          apiKey: main.apiKey,
          maxTokens: 17,
          fetch: async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return Response.json(
              {
                error: {
                  message: "Synthetic serialization complete",
                  type: "invalid_request_error",
                },
              },
              { status: 400 },
            );
          },
        },
        vi.fn(),
        { beforeCall, afterCall: vi.fn() },
      );
      for await (const _event of stream) {
        /* The real SDK serializes the controlled request. */
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(requests, result.errorMessage).toHaveLength(1);
      const wireField =
        protocol === "responses"
          ? "max_output_tokens"
          : protocol === "anthropic-messages"
            ? "max_tokens"
            : "max_completion_tokens";
      expect(requests[0]?.[wireField]).toBe(17);
      expect(beforeCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ maxOutputTokens: 17 }),
      );
      expect(parseModelSecret(first.ciphertext).models?.["shared-model"]).toEqual({
        maxTokens: 2048,
        contextWindow: 64000,
        reasoning: true,
        images: true,
        maxImagesPerPrompt: 3,
      });
    },
  );

  it("does not resolve another connection when the pinned protocol secret disappears", async () => {
    const f = fixture("responses");
    f.secrets.delete("secret-a");
    await expect(f.executor.resolveModel(scope)).rejects.toThrow("Model connection is unavailable");
    expect(f.findSecret.mock.calls.every(([{ where }]) => where.id === "secret-a")).toBe(true);
  });
});
