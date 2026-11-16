import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_FRESH_CHECK } from "./evals/cases.js";
import { observeFreshHistoryCheck } from "./evals/history-observer.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("a fresh check after history retrieval", () => {
  it.each([
    "original constraint",
    "unrelated history",
    "the right history in the same batch",
  ] as const)(
    "grades the same current answer differently when reading %s",
    async (mode) => {
      const correctSource = mode !== "unrelated history";
      const sameBatch = mode === "the right history in the same batch";
      const fixture = HISTORY_FRESH_CHECK.history!;
      const [file, current] = Object.entries(HISTORY_FRESH_CHECK.seedFiles!)[0]!;
      const constraint = fixture.messages[30]!.text;
      const stale = fixture.messages[31]!.text;
      const source = correctSource ? constraint : fixture.messages[60]!.text;
      const sandbox = new EvalSandboxProvider(HISTORY_FRESH_CHECK.seedFiles);
      const read = vi.spyOn(sandbox, "readFile");
      const historyConstraintReads = new Set<string>();
      let originalId = "";
      const tool = (request: ModelEmulatorRequest, id: string) => {
        const message = request.messages.findLast(
          (row) => row.role === "tool" && row.tool_call_id === id,
        );
        expect(message).toBeDefined();
        return JSON.parse(String(message?.content));
      };
      const inputEstimates: number[] = [];
      const contextWindow = 64_000;
      const maxTokens = 4096;
      const apiKey = "offline-fresh-check-fixture-key";
      const checkConstraint = (request: ModelEmulatorRequest) => {
        const rows = tool(request, "read-constraint").messages;
        expect(rows).toContainEqual(
          expect.objectContaining({ messageId: originalId, text: source }),
        );
        if (correctSource) expect(rows).toContainEqual(expect.objectContaining({ text: stale }));
        else expect(rows).not.toContainEqual(expect.objectContaining({ text: constraint }));
      };
      const steps: ModelEmulatorStep[] = [
        {
          expect(request) {
            const messages = JSON.stringify(request.messages);
            expect(messages).toContain(fixture.ask);
            expect(messages).not.toContain(constraint);
          },
          response: {
            type: "tool",
            id: "find-constraint",
            name: "search_history",
            arguments: { query: correctSource ? "Aurora recheck" : "Archive note 60" },
          },
        },
        {
          expect(request) {
            const result = tool(request, "find-constraint");
            originalId = result.messages.find((row: { text: string }) =>
              row.text.includes(source),
            )?.messageId;
            expect(originalId).toBeTruthy();
          },
          response: () => {
            const history = {
              id: "read-constraint",
              name: "read_history",
              arguments: { messageId: originalId, limit: 3 },
            };
            return sameBatch
              ? {
                  type: "tool-batch",
                  calls: [
                    history,
                    { id: "read-current", name: "read_file", arguments: { path: file } },
                  ],
                }
              : { type: "tool", ...history };
          },
        },
        ...(sameBatch
          ? []
          : [
              {
                expect(request) {
                  checkConstraint(request);
                  expect(read).not.toHaveBeenCalled();
                },
                response: (request) => ({
                  type: "tool",
                  id: "read-current",
                  name: "read_file",
                  arguments: {
                    path: correctSource
                      ? tool(request, "read-constraint")
                          .messages.find(
                            (row: { messageId: string }) => row.messageId === originalId,
                          )
                          .text.match(/read only (\S+)\. Do not edit it\.$/)[1]
                      : file,
                  },
                }),
              } satisfies ModelEmulatorStep,
            ]),
        {
          expect(request) {
            if (sameBatch) checkConstraint(request);
            expect(tool(request, "read-current")).toEqual({ path: file, content: current });
          },
          response: (request) => ({
            type: "text",
            text: `The current Aurora report shows ${tool(request, "read-current").content}.`,
          }),
        },
      ];
      const model = await startModelEmulator({ apiKey, steps });
      const dataDir = await mkdtemp(path.join(tmpdir(), "cogine-history-fresh-check-"));
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const result = await runTrial(HISTORY_FRESH_CHECK, 1, {
          connection: {
            provider: model.model.provider,
            modelId: model.model.id,
            baseUrl: model.baseUrl,
            apiKey,
            contextWindow,
            maxTokens,
          },
          timeoutMs: 30_000,
          maxToolCalls: 3,
          createApp: async (composio) => ({
            ...(await createApp({
              databaseUrl: process.env.DATABASE_URL!,
              realtimeDatabaseUrl: process.env.DATABASE_URL!,
              authUrl: "http://127.0.0.1:5173",
              webOrigin: "http://127.0.0.1:5173",
              dataDir,
              sandboxProvider: "fake",
              sandbox,
              agentRuntime: "pi",
              runtime: observeFreshHistoryCheck(
                new PiAgentRuntime({
                  onContextDecision: (decision) => {
                    inputEstimates.push(decision.estimatedInputTokens);
                  },
                }),
                historyConstraintReads,
              ),
              wakeupDriver: "memory",
              signupsEnabled: "true",
              composio,
              encryptionKey: "offline-fresh-check-fixture-encryption-key",
            })),
            fileReads: sandbox.fileReads,
            historyConstraintReads,
          }),
        });
        model.assertComplete();
        expect(result).toMatchObject({
          status: mode === "original constraint" ? "passed" : "failed",
          cleanupFailed: false,
          toolCalls: 3,
        });
        expect(result.criteria.filter((criterion) => !criterion.pass).map(({ id }) => id)).toEqual(
          mode === "original constraint" ? [] : ["history-read"],
        );
        expect(result.trace).toEqual([
          { step: 1, status: "completed", tools: ["search_history", "read_history", "read_file"] },
        ]);
        // One product tool read, then one independent readback by the grader.
        expect(read.mock.calls.map((call) => call[1])).toEqual([file, file]);
        expect(model.requests).toHaveLength(steps.length);
        expect(inputEstimates).toHaveLength(steps.length);
        expect(
          inputEstimates.every((tokens) => tokens > 0 && tokens <= contextWindow - maxTokens),
        ).toBe(true);
        console.info("Same-chat fresh check input estimates", inputEstimates);
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
