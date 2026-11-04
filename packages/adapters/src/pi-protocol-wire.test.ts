import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import type { ModelApiProtocol } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const protocols = ["chat-completions", "responses", "anthropic-messages"] as const;
const frame = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
function reply(protocol: ModelApiProtocol, tool: boolean): string {
  if (protocol === "chat-completions")
    return (
      frame({
        id: "synthetic",
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_evidence",
                      type: "function",
                      function: { name: "fixture_tool", arguments: '{"query":"evidence"}' },
                    },
                  ],
                }
              : { role: "assistant", content: "Done: evidence 1 en xy9" },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
      }) +
      frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) +
      "data: [DONE]\n\n"
    );
  if (protocol === "responses") {
    const item = tool
      ? {
          id: "fc_evidence",
          type: "function_call",
          call_id: "call_evidence",
          name: "fixture_tool",
          arguments: '{"query":"evidence"}',
          status: "completed",
        }
      : {
          id: "msg_evidence",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done: evidence 1 en xy9", annotations: [] }],
        };
    return (
      frame({ type: "response.created", response: { id: "resp_evidence" } }) +
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: tool ? { ...item, arguments: "" } : item,
      }) +
      frame({ type: "response.output_item.done", output_index: 0, item }) +
      frame({
        type: "response.completed",
        response: {
          id: "resp_evidence",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      })
    );
  }
  return [
    {
      type: "message_start",
      message: {
        id: "msg_evidence",
        type: "message",
        role: "assistant",
        model: "synthetic-protocol",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "call_evidence", name: "fixture_tool", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: '{"query":"evidence"}' }
        : { type: "text_delta", text: "Done: evidence 1 en xy9" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((value) => `event: ${value.type}\n${frame(value)}`)
    .join("");
}
const fixtureTool: ConnectorTool = {
  name: "fixture_tool",
  description: "Read synthetic evidence",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const model = (
  apiProtocol: ModelApiProtocol,
  headers: Record<string, string> = { "X-Fixture-Token": " en " },
) => ({
  provider: "openai-compatible",
  id: "synthetic-protocol",
  baseUrl: "https://127.0.0.1/v1",
  apiKey: "synthetic-only-api-key",
  apiProtocol,
  headers,
  maxTokens: 2048,
  contextWindow: 32768,
});
const request = (apiProtocol: ModelApiProtocol) => ({
  botId: "synthetic-bot",
  threadId: "synthetic-thread",
  runId: `synthetic-${apiProtocol}`,
  prompt: "Read the evidence and finish.",
  instructions: "Keep all evidence.",
  history: [],
  tools: [fixtureTool],
  contextStrategy: "retrieval" as const,
  model: model(apiProtocol),
});

describe("actual Pi three-protocol requests", () => {
  it.each(protocols)(
    "executes one tool and resumes %s with usage and connection headers",
    async (apiProtocol) => {
      const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
      const beforeCall = vi.fn(async () => "synthetic-reservation");
      const afterCall = vi.fn();
      const executeTool = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Evidence preserved." }],
      }));
      const runtime = new PiAgentRuntime({
        modelCallObserver: { beforeCall, afterCall },
        modelFetch: async (input, init) => {
          requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(reply(apiProtocol, requests.length === 1), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.run(
        { ...request(apiProtocol), executeTool },
        { signal: AbortSignal.timeout(15000) },
      ))
        events.push(event);
      expect(requests).toHaveLength(2);
      expect(executeTool).toHaveBeenCalledExactlyOnceWith(
        "fixture_tool",
        { query: "evidence" },
        expect.any(String),
        undefined,
        expect.anything(),
      );
      expect(beforeCall).toHaveBeenCalledTimes(2);
      expect(afterCall).toHaveBeenCalledTimes(2);
      expect(events.filter((event) => event.type === "usage")).toHaveLength(2);
      expect(JSON.stringify(events)).toContain("Done: evidence 1 en xy9");
      expect(JSON.stringify(requests[1]?.body)).toContain("Evidence preserved.");
      expect(requests.every((item) => item.headers.get("X-Fixture-Token") === "en")).toBe(true);
      expect(
        requests.every(
          (item) =>
            new URL(item.url).pathname ===
            (apiProtocol === "responses"
              ? "/v1/responses"
              : apiProtocol === "anthropic-messages"
                ? "/v1/messages"
                : "/v1/chat/completions"),
        ),
      ).toBe(true);
      if (apiProtocol === "anthropic-messages") {
        expect(requests.map((item) => new URL(item.url).search)).toEqual([
          "?beta=true",
          "?beta=true",
        ]);
        expect(requests[0]?.headers.get("x-api-key")).toBe("synthetic-only-api-key");
        expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
      } else
        expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-only-api-key");
    },
  );

  it.each(protocols)(
    "keeps header-only authentication without SDK placeholder auth in %s",
    async (apiProtocol) => {
      const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
      const runtime = new PiAgentRuntime({
        modelFetch: async (_input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(reply(apiProtocol, false), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.run(
        {
          ...request(apiProtocol),
          model: {
            ...model(apiProtocol, { "X-Fixture-Token": "header-only-token" }),
            apiKey: undefined,
          },
        },
        { signal: AbortSignal.timeout(15000) },
      ))
        events.push(event);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("x-fixture-token")).toBe("header-only-token");
      expect(requests[0]?.headers.has("authorization")).toBe(false);
      expect(requests[0]?.headers.has("x-api-key")).toBe(false);
      expect(requests[0]?.body.model).toBe("synthetic-protocol");
      expect(JSON.stringify(events)).toContain("Done: evidence 1 en xy9");
    },
  );

  it.each(
    protocols.flatMap((apiProtocol) => [
      {
        apiProtocol,
        key: "local",
        headers: {},
        baseUrl: "https://127.0.0.1/v1",
        expectedKey: "local",
      },
      {
        apiProtocol,
        key: undefined,
        headers: { "x-api-key": "configured-header-key" },
        baseUrl: "https://127.0.0.1/v1",
        expectedKey: "configured-header-key",
      },
      {
        apiProtocol,
        key: undefined,
        headers: {},
        baseUrl: "http://127.0.0.1/v1",
        expectedKey: undefined,
      },
    ]),
  )(
    "preserves configured authentication and keyless local in $apiProtocol/$expectedKey",
    async ({ apiProtocol, key, headers, baseUrl, expectedKey }) => {
      const seen: Headers[] = [];
      const runtime = new PiAgentRuntime({
        modelFetch: async (_input, init) => {
          seen.push(new Headers(init?.headers));
          return new Response(reply(apiProtocol, false), {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.run(
        {
          ...request(apiProtocol),
          model: { ...model(apiProtocol, headers), apiKey: key, baseUrl },
        },
        { signal: AbortSignal.timeout(15000) },
      ))
        events.push(event);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.get("authorization")).toBe(
        key && apiProtocol !== "anthropic-messages" ? `Bearer ${key}` : null,
      );
      expect(seen[0]?.get("x-api-key")).toBe(
        expectedKey && (!key || apiProtocol === "anthropic-messages") ? expectedKey : null,
      );
      expect(JSON.stringify(events)).toContain("Done: evidence 1 en xy9");
    },
  );

  it.each(protocols)("keeps caller abort and one reservation in %s", async (apiProtocol) => {
    const controller = new AbortController();
    const beforeCall = vi.fn(async () => "synthetic-reservation");
    const afterCall = vi.fn();
    const runtime = new PiAgentRuntime({
      modelCallObserver: { beforeCall, afterCall },
      modelFetch: async (_input, init) => {
        controller.abort(new DOMException("Synthetic cancellation", "AbortError"));
        init?.signal?.throwIfAborted();
        throw new Error("Expected cancelled transport");
      },
    });
    await expect(
      (async () => {
        for await (const _event of runtime.run(request(apiProtocol), {
          signal: controller.signal,
        })) {
          /* Actual SDK cancellation. */
        }
      })(),
    ).rejects.toThrow();
    expect(beforeCall).toHaveBeenCalledOnce();
    expect(afterCall).toHaveBeenCalledOnce();
  });

  it.each(
    protocols.flatMap((apiProtocol) =>
      ["1", " en ", " xy9 ", 'q"\\z', " "].map((value) => ({ apiProtocol, value })),
    ),
  )(
    "sanitizes $apiProtocol reflected header $value before Agent/recorder",
    async ({ apiProtocol, value }) => {
      const diagnostics: unknown[] = [];
      const sessionRoot = await mkdtemp(path.join(tmpdir(), "cogine-e05-wire-"));
      const runtime = new PiAgentRuntime({
        modelFetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "authentication_error",
                message: `Reflected private marker ${value.trim()} ${JSON.stringify(value)} synthetic-only-api-key`,
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        sessionRoot,
      });
      let error: unknown;
      try {
        for await (const event of runtime.run(
          { ...request(apiProtocol), model: model(apiProtocol, { "X-Fixture-Token": value }) },
          { userId: "synthetic-user", signal: AbortSignal.timeout(15000) },
        ))
          diagnostics.push(event);
      } catch (caught) {
        error = caught;
      }
      const files = (await readdir(sessionRoot, { recursive: true })).filter((file) =>
        file.endsWith(".jsonl"),
      );
      const records = await Promise.all(
        files.map((file) => readFile(path.join(sessionRoot, file), "utf8")),
      );
      await rm(sessionRoot, { recursive: true, force: true });
      expect(files).toHaveLength(1);
      expect(error).toBeInstanceOf(Error);
      const observed = `${String(error)} ${JSON.stringify(diagnostics)} ${records.join(" ")}`;
      expect(observed).not.toContain("Reflected private marker");
      expect(observed).not.toContain("synthetic-only-api-key");
      expect(observed).toContain("401");
    },
  );
});

it.each(["responses", "anthropic-messages"] as const)(
  "keeps child %s connection errors out of parent tool result and real session",
  async (childProtocol) => {
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "cogine-e05-child-"));
    const requests: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
    const events: AgentRuntimeEvent[] = [];
    let parentCalls = 0;
    const resolveModel = vi.fn(async () => ({
      ...model(childProtocol, { "X-Child-Token": " xy9 " }),
      id: "synthetic-child",
      apiKey: "synthetic-child-api-key",
      modelCredentialId: "child-credential",
    }));
    const runtime = new PiAgentRuntime({
      sessionRoot,
      modelFetch: async (input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ body, headers: new Headers(init?.headers), url: String(input) });
        if (body.model === "synthetic-child")
          return Response.json(
            {
              error: {
                type: "authentication_error",
                message: "Private child reflection xy9 synthetic-child-api-key",
              },
            },
            { status: 401 },
          );
        parentCalls++;
        const data =
          parentCalls === 1
            ? frame({
                id: "synthetic",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "child-call",
                          type: "function",
                          function: {
                            name: "run_subagent",
                            arguments: JSON.stringify({
                              name: "evidence helper",
                              task: "Read independent evidence",
                              model_provider: "openai-compatible",
                              model_id: "synthetic-child",
                              model_credential_id: "child-credential",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }) + "data: [DONE]\n\n"
            : reply("chat-completions", false);
        return new Response(data, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      for await (const event of runtime.run(
        {
          ...request("chat-completions"),
          runId: `parent-child-${childProtocol}`,
          tools: builtinAgentTools.filter((tool) => tool.name === "run_subagent"),
          resolveModel,
        },
        { userId: "synthetic-user", signal: AbortSignal.timeout(15000) },
      ))
        events.push(event);
      expect(requests).toHaveLength(3);
      expect(parentCalls).toBe(2);
      expect(resolveModel).toHaveBeenCalledExactlyOnceWith(
        "openai-compatible",
        "synthetic-child",
        "child-credential",
      );
      const child = requests.find((item) => item.body.model === "synthetic-child");
      expect(child?.headers.get("X-Child-Token")).toBe("xy9");
      expect(new URL(child!.url).search).toBe(
        childProtocol === "anthropic-messages" ? "?beta=true" : "",
      );
      expect(
        new URL(child!.url).pathname ===
          (childProtocol === "responses" ? "/v1/responses" : "/v1/messages"),
      ).toBe(true);
      const files = (await readdir(sessionRoot, { recursive: true })).filter((file) =>
        file.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const records = await Promise.all(
        files.map((file) => readFile(path.join(sessionRoot, file), "utf8")),
      );
      const visible =
        JSON.stringify(events) + records.join(" ") + JSON.stringify(requests.at(-1)?.body);
      expect(visible).not.toContain("Private child reflection");
      expect(visible).not.toContain("synthetic-child-api-key");
      expect(visible).toContain("Subagent failed:");
      expect(visible).toContain("authentication_error");
      expect(visible).toContain("Done: evidence 1 en xy9");
    } finally {
      await rm(sessionRoot, { recursive: true, force: true });
    }
  },
);
