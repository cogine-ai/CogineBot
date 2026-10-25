import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContextStrategy, AgentRunRequest } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { historyFixture } from "./evals/history-fixtures.js";
import { runTrial } from "./evals/runner.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const declaredCache = { scope: "connection" as const, retentionMs: 300000 };
const cases: Array<{
  name: string;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextStrategy?: AgentContextStrategy;
  expected: AgentContextStrategy | "unsupported";
}> = [
  { name: "declared window", cacheCapabilities: declaredCache, expected: "cache-aware" },
  { name: "unknown window", expected: "retrieval" },
  {
    name: "disabled cache",
    cacheCapabilities: { ...declaredCache, retentionMode: "none" },
    expected: "unsupported",
  },
  {
    name: "explicit retrieval",
    cacheCapabilities: declaredCache,
    contextStrategy: "retrieval",
    expected: "retrieval",
  },
  {
    name: "explicit current",
    cacheCapabilities: declaredCache,
    contextStrategy: "current",
    expected: "current",
  },
];

describe.skipIf(!enabled)("saved connection context selection", () => {
  it.each(cases)(
    "preserves $name through the product executor",
    async ({ name, cacheCapabilities, contextStrategy, expected }) => {
      const fixture = historyFixture(100, "exact");
      // Keep this policy fixture below the separate current-strategy compaction threshold.
      fixture.messages = fixture.messages.slice(0, 40);
      const questions = [
        "Confirm this read-only fixture request.",
        "Confirm this follow-up fixture request.",
      ];
      const decisions: Array<{ strategy: AgentContextStrategy | undefined }> = [];
      const fixtureKey = "synthetic-context-policy-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: (expected === "unsupported" ? [] : questions).map((question) => ({
          expect(request) {
            const wire = JSON.stringify(request.messages);
            expect(wire).toContain(question);
            expect(wire).toContain(fixture.messages.at(-1)!.text);
            const tools = request.tools?.map((tool) => tool.function.name) ?? [];
            if (expected === "current") {
              // Current strategy can recover stored connector results without enabling history search.
              expect(tools).toContain("read_history");
              expect(tools).not.toContain("search_history");
            } else
              expect(tools).toEqual(expect.arrayContaining(["read_history", "search_history"]));
            if (expected === "cache-aware" || expected === "current")
              expect(wire).toContain("ORBIT-731");
          },
          usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
          response: { type: "text" as const, text: "Read-only fixture complete." },
        })),
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "context-policy-product-"));
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const result = await runTrial(
          {
            id: `context-policy-${name.replaceAll(" ", "-")}`,
            purpose: "Select context using a persisted connection and the actual executor.",
            history: fixture,
            connections: [],
            steps: questions.map((ask) => ({ ask })),
            grade: (evidence) => [
              { id: "completed", pass: evidence.text.includes("Read-only fixture complete.") },
            ],
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: fixtureKey,
              contextWindow: 1_000_000,
              maxTokens: 512,
              cacheCapabilities,
            },
            timeoutMs: 30_000,
            maxToolCalls: 0,
            createApp: (composio) =>
              createApp({
                databaseUrl: process.env.DATABASE_URL!,
                realtimeDatabaseUrl: process.env.DATABASE_URL!,
                authUrl: "http://127.0.0.1:5173",
                webOrigin: "http://127.0.0.1:5173",
                dataDir,
                sandboxProvider: "fake",
                agentRuntime: "pi",
                contextStrategy,
                runtime: new PiAgentRuntime({
                  onContextDecision: (decision) => decisions.push(decision),
                }),
                wakeupDriver: "memory",
                signupsEnabled: "true",
                composio,
                encryptionKey: "synthetic-context-policy-encryption-key",
              }),
          },
        );
        model.assertComplete();
        if (expected === "unsupported") {
          expect(result).toMatchObject({ status: "failed", toolCalls: 0, cleanupFailed: false });
          expect(result.reason).toContain("Unsupported prompt-cache retention mode");
          expect(model.requests).toHaveLength(0);
          return;
        }
        expect(result).toMatchObject({
          status: "passed",
          toolCalls: 0,
          modelCalls: 2,
          cleanupFailed: false,
        });
        expect(model.requests).toHaveLength(2);
        expect(decisions).toHaveLength(2);
        expect(decisions.every((decision) => decision.strategy === expected)).toBe(true);
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
