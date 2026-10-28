import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { dispatcherFetch, PiAgentRuntime, resolveRuntimeModel } from "@rakazo/adapters";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { EvalServices } from "./services.js";
import type { DiagnosticWireObservation } from "./wire-observer.js";
import {
  diagnosticResultData,
  diagnosticWireFetch,
  supportsDiagnosticFetchInjection,
} from "./wire-observer.js";

afterEach(() => vi.unstubAllEnvs());

function body(nextCursor: unknown = "segment-3572054") {
  return JSON.stringify({
    model: "fixture",
    messages: [
      { role: "user", content: "private-prompt" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "private-call",
            function: {
              name: "CRM_READ_DIAGNOSTIC",
              arguments: JSON.stringify({ cursor: "start", private: "private-args" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "private-call",
        content: JSON.stringify({
          segment: 1,
          nextCursor,
          diagnostic: "private-result",
          contextTruncated: true,
        }),
      },
    ],
  });
}

it("forwards exact transport arguments and response while retaining only fixture controls", async () => {
  const records: DiagnosticWireObservation[] = [];
  const response = new Response("private-response");
  const upstream = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
  const fetch = diagnosticWireFetch(upstream, "fixture", records);
  const input = new Request("https://private.example.test");
  const init = {
    method: "POST",
    body: body(),
    headers: { authorization: "private-credential" },
    signal: new AbortController().signal,
  };
  expect(await fetch(input, init)).toBe(response);
  expect(upstream.mock.calls[0]?.[0]).toBe(input);
  expect(upstream.mock.calls[0]?.[1]).toBe(init);
  expect(records[0]?.results?.[0]).toMatchObject({
    cursor: "start",
    segment: 1,
    nextCursor: "segment-3572054",
    controlsValidated: true,
    contextTruncated: true,
  });
  expect(JSON.stringify(records)).not.toMatch(/private|https|authorization/);
  await fetch(input, { body: body("private-secret-cursor") });
  expect(records[1]?.results?.[0]).toMatchObject({
    nextCursorPresent: true,
    controlsValidated: false,
  });
  expect(records[1]?.results?.[0]).not.toHaveProperty("nextCursor");
  expect(JSON.stringify(records)).not.toContain("private");
});

it("bounds records, declares unsupported evidence and propagates aborts without global mutation", async () => {
  const original = globalThis.fetch;
  const records: DiagnosticWireObservation[] = [];
  const abort = new DOMException("synthetic abort", "AbortError");
  const upstream = vi.fn<typeof globalThis.fetch>().mockRejectedValue(abort);
  const observed = diagnosticWireFetch(upstream, "fixture", records);
  await expect(observed("synthetic", { body: new Uint8Array([1]) })).rejects.toBe(abort);
  expect(records[0]).toMatchObject({ availability: "unavailable", reason: "unsupported-body" });
  await expect(
    observed("synthetic", { body: JSON.stringify({ model: "fixture", input: [] }) }),
  ).rejects.toBe(abort);
  expect(records[1]).toMatchObject({ availability: "unavailable", reason: "unsupported-protocol" });
  await expect(observed("synthetic", { body: "invalid private payload" })).rejects.toBe(abort);
  expect(records[2]).toMatchObject({ availability: "unavailable", reason: "invalid-json" });
  await expect(observed("synthetic", { body: "private".repeat(400000) })).rejects.toBe(abort);
  expect(records[3]).toMatchObject({ availability: "unavailable", reason: "oversized-body" });
  const ignoredLength = records.length;
  await expect(
    observed("synthetic", { body: JSON.stringify({ model: "different", messages: [] }) }),
  ).rejects.toBe(abort);
  expect(records).toHaveLength(ignoredLength);
  for (let i = 0; i < 65; i++) await observed("synthetic", { body: body() }).catch(() => {});
  expect(records).toHaveLength(60);
  expect(upstream).toHaveBeenCalledTimes(70);
  const second: DiagnosticWireObservation[] = [];
  const secondObserver = diagnosticWireFetch(upstream, "fixture", second);
  await expect(secondObserver("synthetic", { body: body() })).rejects.toBe(abort);
  expect(second).toHaveLength(1);
  expect(records).toHaveLength(60);
  expect(globalThis.fetch).toBe(original);
});

it("observes actual Pi post-selection JSON controls through twelve dependent compressed results", async () => {
  const services = new EvalServices();
  services.enableDiagnosticChain();
  const server = await startModelEmulator({
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "private-first-id",
          name: "CRM_READ_DIAGNOSTIC",
          arguments: { cursor: "start" },
        },
      },
      ...Array.from({ length: 12 }, () => ({
        expect() {},
        response(request: ModelEmulatorRequest) {
          const result = diagnosticResultData(
            JSON.parse(String(request.messages.findLast((m) => m.role === "tool")?.content)),
          )!;
          return result.nextCursor === null
            ? { type: "text" as const, text: "ledger-indexer pending" }
            : {
                type: "tool" as const,
                id: `private-segment-${result.segment}`,
                name: "CRM_READ_DIAGNOSTIC",
                arguments: { cursor: result.nextCursor },
              };
        },
      })),
    ],
  });
  const records: DiagnosticWireObservation[] = [];
  const originalFetch = globalThis.fetch;
  const modelFetch = diagnosticWireFetch(dispatcherFetch, server.model.id, records);
  const context = {
    operationId: "synthetic",
    traceId: "synthetic",
    spaceId: "synthetic",
    userId: "synthetic",
    signal: new AbortController().signal,
  };
  try {
    const request: AgentRunRequest = {
      botId: "synthetic",
      threadId: "synthetic",
      runId: "synthetic",
      prompt: "private-prompt: follow the diagnostic chain",
      instructions: "Do not deploy.",
      history: [],
      contextStrategy: "retrieval",
      model: { ...server.model, contextWindow: 1050000, maxTokens: 4096 },
      tools: [
        {
          name: "CRM_READ_DIAGNOSTIC",
          description: "Read the next segment",
          inputSchema: {
            type: "object",
            properties: { cursor: { type: "string" } },
            required: ["cursor"],
          },
        },
      ],
      executeTool: async (name, args, id) => {
        for await (const event of services.execute({ tool: name, args, executionId: id }, context))
          if (event.type === "result") return event.data;
      },
    };
    for await (const _event of new PiAgentRuntime({ modelFetch }).run(request)) {
      /* Consume the real runtime. */
    }
    server.assertComplete();
    expect(records).toHaveLength(13);
    for (const [index, record] of records.slice(1).entries()) {
      expect(record.availability).toBe("observed");
      expect(record.results?.map((r) => r.segment)).toEqual(
        Array.from({ length: index + 1 }, (_, i) => i + 1),
      );
      expect(
        record.results?.every((r) => r.jsonValid && r.controlsValidated && r.nextCursorPresent),
      ).toBe(true);
      expect(record.results?.at(-1)?.bytes).toBeLessThanOrEqual(12000);
      expect(record.results?.slice(0, -1).every((r) => r.bytes <= 1024)).toBe(true);
    }
    expect(records.at(-1)?.results?.at(-1)?.nextCursor).toBeNull();
    expect(JSON.stringify(records)).not.toMatch(/private|Synthetic detailed|ledger-indexer/);
  } finally {
    await server.close();
    expect(globalThis.fetch).toBe(originalFetch);
  }
}, 20000);

it("observes a failed model request through the explicit transport without changing global fetch", async () => {
  const originalFetch = globalThis.fetch;
  const records: DiagnosticWireObservation[] = [];
  const server = await startModelEmulator({
    steps: [
      {
        expect() {},
        response: { type: "error", status: 400, message: "Synthetic model rejection" },
      },
    ],
  });
  try {
    const runtime = new PiAgentRuntime({
      modelFetch: diagnosticWireFetch(dispatcherFetch, server.model.id, records),
    });
    const run = async () => {
      for await (const _event of runtime.run({
        botId: "synthetic",
        threadId: "synthetic",
        runId: "synthetic",
        prompt: "private-prompt",
        instructions: "Use the fixture.",
        history: [],
        tools: [],
        model: server.model,
      })) {
        /* Consume the real runtime until its provider failure. */
      }
    };
    await expect(run()).rejects.toThrow("Synthetic model rejection");
    server.assertComplete();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ availability: "observed", request: 1, results: [] });
    expect(JSON.stringify(records)).not.toMatch(/private|Synthetic model rejection/);
  } finally {
    await server.close();
    expect(globalThis.fetch).toBe(originalFetch);
  }
});

it.each([
  { provider: "google", api: "google-generative-ai", missingConfig: "No API key" },
  { provider: "google-vertex", api: "google-vertex", missingConfig: "requires a project ID" },
])(
  "keeps $provider evals on the SDK transport when injection is unsupported",
  async ({ provider, api, missingConfig }) => {
    const originalFetch = globalThis.fetch;
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GCLOUD_PROJECT", "");
    const { model, models } = resolveRuntimeModel({ provider, id: "gemini-2.5-flash" });
    expect(model?.api).toBe(api);
    if (!model) throw new Error("Fixture model missing");
    const sdk = models.getProvider(provider);
    if (!sdk) throw new Error("Fixture provider missing");
    const injected = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected model request"));
    const context = { messages: [] };
    const withInjected = sdk.stream(model, context, {
      apiKey: "",
      env: {},
      fetch: injected,
    });
    expect((await withInjected.result()).errorMessage).toContain("Custom fetch is not supported");
    const modelFetch = supportsDiagnosticFetchInjection(model.api) ? injected : undefined;
    const withSdk = sdk.stream(model, context, { apiKey: "", env: {}, fetch: modelFetch });
    expect((await withSdk.result()).errorMessage).toContain(missingConfig);
    expect(injected).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(originalFetch);
  },
);

it("allows diagnostic injection for an actual compatible API without claiming protocol observability", () => {
  const { model } = resolveRuntimeModel({
    provider: "openai-compatible",
    id: "fixture",
    baseUrl: "http://127.0.0.1:1/v1",
  });
  expect(model?.api).toBe("openai-completions");
  expect(supportsDiagnosticFetchInjection(model?.api)).toBe(true);
  expect(supportsDiagnosticFetchInjection("anthropic-messages")).toBe(true);
});
