import type { AgentRunRequest, AutoReviewProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { LlmAutoReviewProvider } from "./auto-review.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import { JevAutoReviewProvider } from "./jev-auto-review.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

const context = {
  operationId: "auto-review",
  traceId: "auto-review",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const request = {
  toolName: "gmail_send_email",
  connectorKind: "gmail",
  args: { to: "a@b.test" },
  userTask: "Draft a reply",
  botDescription: "Mail bot",
  matchingRules: [],
};

describe("createAutoReviewProvider", () => {
  it.each(["chat-completions", "responses", "anthropic-messages"] as const)(
    "passes the bound %s configuration to the checker without putting secrets in its prompt",
    async (apiProtocol) => {
      const runtime = new ScriptedAgentRuntime();
      const inputs: AgentRunRequest[] = [];
      vi.spyOn(runtime, "run").mockImplementation(async function* (input) {
        inputs.push(input);
        yield { type: "done", text: '{"decision":"pass"}' };
      });
      const headers = { "X-Checker": "synthetic-checker-header-secret" };
      const provider = createAutoReviewProvider("llm", {
        llm: {
          runtime,
          checker: { provider: "openai-compatible", model: "checker-model" },
          modelCredentialId: "checker-connection",
          apiKey: "synthetic-checker-key",
          baseUrl: "https://checker.example.test/v1",
          apiProtocol,
          headers,
          runId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          threadId: "thread",
        },
      });
      await expect(provider.review(request, context)).resolves.toMatchObject({ decision: "pass" });
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.model).toMatchObject({
        modelCredentialId: "checker-connection",
        apiProtocol,
        headers,
        baseUrl: "https://checker.example.test/v1",
        apiKey: "synthetic-checker-key",
      });
      expect(inputs[0]!.tools).toEqual([]);
      expect(inputs[0]!.prompt).not.toContain(headers["X-Checker"]);
      expect(inputs[0]!.prompt).not.toContain("synthetic-checker-key");
      expect(inputs[0]!.instructions).not.toContain(headers["X-Checker"]);
    },
  );

  it("constructs Jev, LLM, and scripted adapters", () => {
    expect(createAutoReviewProvider("jev", { apiKey: "ts-key" })).toBeInstanceOf(
      JevAutoReviewProvider,
    );
    expect(
      createAutoReviewProvider("llm", {
        llm: {
          runtime: {
            describe: () => ({ capabilities: { scripted: false } }),
            run: async function* () {},
            abort: async () => {},
          } as never,
          checker: { provider: "openrouter", model: "x" },
          runId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          threadId: "thread",
        },
      }),
    ).toBeInstanceOf(LlmAutoReviewProvider);
    expect(createAutoReviewProvider("scripted")).toBeInstanceOf(ScriptedAutoReviewProvider);
    expect(() => createAutoReviewProvider("unknown")).toThrow(/unknown auto-review provider/i);
    expect(() => createAutoReviewProvider("jev", { env: {} })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => createAutoReviewProvider("llm")).toThrow(/runtime checker/i);
  });

  it("resolves the default kind from options.env instead of process.env", () => {
    expect(
      createAutoReviewProvider(undefined, {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "scripted", AGENT_RUNTIME: "scripted" },
      }),
    ).toBeInstanceOf(ScriptedAutoReviewProvider);
    expect(
      createAutoReviewProvider(undefined, {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "jev", TYPESAFE_API_KEY: "ts-key" },
      }),
    ).toBeInstanceOf(JevAutoReviewProvider);
    expect(
      createAutoReviewProvider("scripted", {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "jev", TYPESAFE_API_KEY: "ts-key" },
      }),
    ).toBeInstanceOf(ScriptedAutoReviewProvider);
  });

  it("uses the scripted emulator for deterministic offline answers", async () => {
    const pass = createAutoReviewProvider("scripted") as AutoReviewProvider;
    await expect(pass.review(request, context)).resolves.toEqual({
      decision: "pass",
      model: "scripted",
    });
    const ask = createAutoReviewProvider("scripted", {
      scripted: { decision: "ask", reason: "Flagged", model: "scripted" },
    });
    await expect(ask.review(request, context)).resolves.toEqual({
      decision: "ask",
      reason: "Flagged",
      model: "scripted",
    });
  });
});
