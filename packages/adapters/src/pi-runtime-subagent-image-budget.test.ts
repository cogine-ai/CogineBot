import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { PiAgentRuntime } from "./pi-runtime.js";

type WirePart = { type: string; image_url?: { url: string } };
type WireRequest = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content?: string | WirePart[] }>;
  tools?: Array<{ function: { name: string } }>;
};

const parentTask = "Compare both parent frames, delegate the child comparison, then report both.";
const childTask = "Inspect both child frames and report the two child evidence markers.";
const childAnswer = "Child evidence verified: first and latest child markers are intact.";
const parentAnswer = "Parent and child screenshot evidence checked.";
const apiKey = "synthetic-image-budget-key";

function sendReply(
  response: ServerResponse,
  model: string,
  reply: string | { id: string; name: string; arguments: Record<string, unknown> },
) {
  const text = typeof reply === "string";
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({
      id: "synthetic-image-budget-response",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          delta: text
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: reply.id,
                    type: "function",
                    function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
                  },
                ],
              },
          finish_reason: text ? "stop" : "tool_calls",
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
  );
}

const imageUrls = (request: WireRequest) =>
  request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "image_url" && part.image_url ? [part.image_url.url] : [],
        )
      : [],
  );

describe("parent and child screenshot budgets on the actual provider wire", () => {
  it.each([
    { parentLimit: 2, childLimit: 1, expectedChild: 1 },
    { parentLimit: 1, childLimit: 2, expectedChild: 2 },
    { parentLimit: 2, childLimit: 0, expectedChild: 0 },
    { parentLimit: 0, childLimit: undefined, expectedChild: 2 },
  ])(
    "keeps parent=$parentLimit and selected child=$childLimit independent",
    async ({ parentLimit, childLimit, expectedChild }) => {
      const parentId = "synthetic-parent-vision";
      const childId = "synthetic-child-vision";
      const frames = await Promise.all(
        ["parent-first", "parent-latest", "child-first", "child-latest"].map(async (id, index) => {
          const png = await sharp({
            create: {
              width: 2,
              height: 2,
              channels: 3,
              background: { r: 40 + index * 40, g: 20 + index * 10, b: 60 },
            },
          })
            .png()
            .toBuffer();
          return {
            id,
            callId: `${id}-capture`,
            frameId: `${id}-frame`,
            evidence: `Complete ${id} evidence marker; frameId=${id}-frame.`,
            png: png.toString("base64"),
          };
        }),
      );
      const requests: WireRequest[] = [];
      const serverErrors: unknown[] = [];
      const executions: Array<{ callId: string; executionId: string; namespace: string }> = [];
      const completed = new Map<string, unknown>();
      const resolutions: unknown[][] = [];
      const assertScreenshots = (
        request: WireRequest,
        owner: "parent" | "child",
        count: number,
        available = 2,
      ) => {
        const expected = frames
          .filter((frame) => frame.id.startsWith(owner))
          .slice(0, available)
          .slice(count === 0 ? available : -count)
          .map((frame) => `data:image/png;base64,${frame.png}`);
        expect(imageUrls(request)).toEqual(expected);
      };
      const capture = (owner: "parent" | "child", latest: boolean) => ({
        id: `${owner}-${latest ? "latest" : "first"}-capture`,
        name: "computer_observe",
        arguments: {},
      });
      const server = createServer((request, response) => {
        void (async () => {
          expect(request.method).toBe("POST");
          expect(request.url).toBe("/v1/chat/completions");
          expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of request) {
            bytes += Buffer.byteLength(chunk);
            expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
          requests.push(body);
          expect(body.stream).toBe(true);
          expect([parentId, childId]).toContain(body.model);
          const text = JSON.stringify(body.messages);
          const parent = body.model === parentId;
          const step = requests.filter((row) => row.model === body.model).length;
          expect(text).toContain(parent ? parentTask : childTask);
          expect(body.tools?.map((tool) => tool.function.name)).toContain("computer_observe");
          if (!parent) {
            expect(body.tools?.map((tool) => tool.function.name)).not.toContain("run_subagent");
            expect(text).not.toContain("Complete parent-first evidence marker");
          }
          if (step === 1) {
            assertScreenshots(body, parent ? "parent" : "child", 0);
            sendReply(response, body.model, capture(parent ? "parent" : "child", false));
            return;
          }
          const owner = parent ? "parent" : "child";
          const limit = parent ? parentLimit : expectedChild;
          expect(text).toContain(frames.find((frame) => frame.id === `${owner}-first`)!.evidence);
          if (step === 2) {
            assertScreenshots(body, owner, Math.min(1, limit), 1);
            sendReply(response, body.model, capture(owner, true));
            return;
          }
          expect(text).toContain(frames.find((frame) => frame.id === `${owner}-latest`)!.evidence);
          assertScreenshots(body, owner, limit);
          if (parent && step === 3) {
            sendReply(response, body.model, {
              id: "delegate-image-comparison",
              name: "run_subagent",
              arguments: {
                name: "image-helper",
                task: childTask,
                model_provider: "openai-compatible",
                model_id: childId,
                model_credential_id: "child-image-connection",
              },
            });
          } else if (!parent && step === 3) {
            sendReply(response, body.model, childAnswer);
          } else {
            expect(parent).toBe(true);
            expect(step).toBe(4);
            expect(text).toContain(childAnswer);
            sendReply(response, body.model, parentAnswer);
          }
        })().catch((error: unknown) => {
          serverErrors.push(error);
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic wire assertion failed" } }));
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const events: AgentRuntimeEvent[] = [];
      let runtimeError: unknown;
      try {
        try {
          for await (const event of new PiAgentRuntime().run(
            {
              botId: "image-budget-bot",
              threadId: "image-budget-thread",
              runId: "image-budget-run",
              prompt: parentTask,
              instructions: "Inspect the complete visual evidence and preserve the delegated task.",
              history: [],
              contextStrategy: "retrieval",
              tools: builtinAgentTools.filter((tool) =>
                ["computer_observe", "run_subagent"].includes(tool.name),
              ),
              model: {
                provider: "openai-compatible",
                id: parentId,
                modelCredentialId: "parent-image-connection",
                apiKey,
                baseUrl,
                acceptsImages: true,
                contextWindow: 128_000,
                maxTokens: 4096,
                maxImagesPerPrompt: parentLimit,
              },
              resolveModel: async (provider, id, modelCredentialId) => {
                resolutions.push([provider, id, modelCredentialId]);
                return {
                  provider,
                  id,
                  modelCredentialId,
                  apiKey,
                  baseUrl,
                  acceptsImages: true,
                  contextWindow: 128_000,
                  maxTokens: 4096,
                  ...(childLimit === undefined ? {} : { maxImagesPerPrompt: childLimit }),
                };
              },
              executeTool: async (name, args, executionId, _route, observer) => {
                if (name === "run_subagent") return observer!.runSubagent!(args);
                expect(name).toBe("computer_observe");
                expect(args).toEqual({});
                const [kind, namespace, callId] = JSON.parse(executionId) as string[];
                expect(kind).toBe("pi-tool");
                const frame = frames.find((row) => row.callId === callId);
                if (!frame) throw new Error("Unexpected screenshot execution");
                executions.push({ callId: frame.callId, executionId, namespace: namespace! });
                return {
                  kind: "agent_tool_result",
                  content: [
                    { type: "text", text: frame.evidence },
                    { type: "image", mimeType: "image/png", data: frame.png },
                  ],
                  details: { frameId: frame.frameId },
                  isError: false,
                };
              },
              onToolCompleted: (completion) => {
                completed.set(completion.executionId, completion.result);
              },
            },
            {
              signal: AbortSignal.timeout(15_000),
              userId: "synthetic-user",
              spaceId: "synthetic-space",
            },
          )) {
            events.push(event);
          }
        } catch (error) {
          runtimeError = error;
        }
        // Report actual server-side assertions before a generic SDK error or cleanup can hide them.
        if (serverErrors.length)
          throw new AggregateError(serverErrors, "Image budget wire assertions failed");
        if (runtimeError) throw runtimeError;
        expect(requests.map((request) => request.model)).toEqual([
          parentId,
          parentId,
          parentId,
          childId,
          childId,
          childId,
          parentId,
        ]);
        expect(resolutions).toEqual([["openai-compatible", childId, "child-image-connection"]]);
        expect(executions.map((execution) => execution.callId).sort()).toEqual(
          frames.map((frame) => frame.callId).sort(),
        );
        expect(new Set(executions.map((execution) => execution.executionId)).size).toBe(4);
        for (const execution of executions) {
          const frame = frames.find((row) => row.callId === execution.callId)!;
          expect(execution.namespace === "main").toBe(frame.id.startsWith("parent"));
          expect(completed.get(execution.executionId)).toMatchObject({
            content: [
              { type: "text", text: frame.evidence },
              { type: "image", mimeType: "image/png", data: frame.png },
            ],
            details: { frameId: frame.frameId },
          });
        }
        expect(events).toContainEqual(
          expect.objectContaining({ type: "subagent", status: "completed", result: childAnswer }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ type: "done", text: parentAnswer }),
        );
      } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
    30_000,
  );
});
