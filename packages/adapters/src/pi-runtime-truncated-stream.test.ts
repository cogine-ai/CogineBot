import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent, AgentUsage } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { expect, it, vi } from "vitest";

const delay = vi.hoisted(() => vi.fn(async (_delayMs: number, _signal?: AbortSignal) => undefined));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: delay,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

it.each([408, 504])(
  "bounds completion retries for a real parsed early HTTP %s without timeout text",
  async (status) => {
    delay.mockClear();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Fixture rejected.", type: "fixture_error" } }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    const beforeCall = vi.fn(async () => "fixture-reservation");
    const afterCall = vi.fn(async (_reservation: unknown, _usage: AgentUsage | null) => undefined);
    const events: AgentRuntimeEvent[] = [];
    let failure: unknown;
    try {
      try {
        for await (const event of new PiAgentRuntime({
          modelCallObserver: { beforeCall, afterCall },
        }).run(
          {
            botId: "fixture-bot",
            threadId: "fixture-thread",
            runId: "fixture-run",
            prompt: "Report the fixture.",
            instructions: "Fixture",
            history: [],
            tools: [],
            executeTool: vi.fn(),
            model: {
              provider: "openai-compatible",
              id: "fixture",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            },
          },
          { signal: AbortSignal.timeout(5_000) },
        ))
          events.push(event);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(String(status));
      expect((failure as Error).message).not.toMatch(/timeout|timed out/i);
      expect(requests).toBe(4);
      expect(delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        2_000, 8_000, 20_000,
      ]);
      expect(beforeCall).toHaveBeenCalledTimes(4);
      expect(afterCall).toHaveBeenCalledTimes(4);
      expect(events.some((event) => event.type === "done")).toBe(false);
    } finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  },
);

it("recovers real parsed empty completions after a completed tool without replaying its effect", async () => {
  delay.mockClear();
  const requests: Array<{ messages: unknown[] }> = [];
  const fixtureFailures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const call = requests.length;
      const choice =
        call === 1
          ? {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "effect-once",
                    type: "function",
                    function: { name: "write_effect", arguments: '{"value":"once"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            }
          : call < 4
            ? { delta: { role: "assistant" }, finish_reason: null }
            : { delta: { role: "assistant", content: "Recovered." }, finish_reason: "stop" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: `fixture-${call}`, choices: [{ index: 0, ...choice }] })}\n\ndata: ${JSON.stringify({ id: `fixture-${call}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
      );
    })().catch((error: unknown) => {
      fixtureFailures.push(error);
      response.writeHead(500);
      response.end('{"error":{"message":"Fixture mismatch"}}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const executeTool = vi.fn(async () => ({ ok: true }));
  const beforeCall = vi.fn(async () => "fixture-reservation");
  const afterCall = vi.fn(async (_reservation: unknown, _usage: AgentUsage | null) => undefined);
  const onUsage = vi.fn(async () => undefined);
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of new PiAgentRuntime({
      modelCallObserver: { beforeCall, afterCall },
    }).run(
      {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt: "Write once and report the result.",
        instructions: "Fixture",
        history: [],
        tools: [
          {
            name: "write_effect",
            description: "Write a fixture value.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            readOnly: false,
          },
        ],
        executeTool,
        onUsage,
        model: {
          provider: "openai-compatible",
          id: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      },
      { signal: AbortSignal.timeout(5_000) },
    ))
      events.push(event);
    expect(fixtureFailures).toEqual([]);
    expect(requests).toHaveLength(4);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "effect-once" }),
    );
    expect(requests[2]?.messages).toEqual(requests[1]?.messages);
    expect(requests[3]?.messages).toEqual(requests[1]?.messages);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Recovered." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered." });
    expect(delay.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 8_000]);
    expect(beforeCall).toHaveBeenCalledTimes(4);
    expect(afterCall).toHaveBeenCalledTimes(4);
    expect(onUsage).toHaveBeenCalledTimes(4);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

it.each([
  [401, "authentication_error"],
  [403, "permission_error"],
  [400, "subscription_sharing_usage_limit_exceeded"],
  [400, "subscription_sharing_usage_unavailable"],
] as const)("keeps parsed %s/%s refusal above signature recovery", async (status, code) => {
  delay.mockClear();
  let requests = 0;
  const runtime = new PiAgentRuntime({
    modelFetch: async () => {
      requests += 1;
      return Response.json(
        { error: { code, type: code, message: "Invalid signature in thinking block" } },
        { status },
      );
    },
  });
  const consume = async () => {
    for await (const _event of runtime.run(
      {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt: "Report the fixture",
        instructions: "Fixture",
        history: [],
        tools: [],
        model: { provider: "openai-compatible", id: "fixture", baseUrl: "http://127.0.0.1:1/v1" },
      },
      { signal: AbortSignal.timeout(5_000) },
    )) {
      /* Consume the actual parser and recovery pipeline. */
    }
  };
  await expect(consume()).rejects.toThrow("Invalid signature");
  expect(requests).toBe(1);
  expect(delay).not.toHaveBeenCalled();
});
