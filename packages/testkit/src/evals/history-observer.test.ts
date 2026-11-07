import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentToolExecutionObserver,
} from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import type { DiagnosticToolObservation, HistoryDiagnostic } from "./history-observer.js";
import { observeSyntheticHistory } from "./history-observer.js";

it("delegates the real execution and records only synthetic query metadata", async () => {
  const diagnostics: HistoryDiagnostic[] = [];
  const result = {
    messages: [{ id: "private-reference", text: "private-result-content" }],
    nextBeforeSeq: 8,
  };
  const execute = vi.fn(async () => result);
  let wrapped: AgentRunRequest | undefined;
  const abort = vi.fn(async () => {});
  const real = {
    describe: vi.fn(() => ({ id: "fixture", capabilities: { scripted: true } })),
    abort,
    run: vi.fn((request: AgentRunRequest) => {
      wrapped = request;
      return (async function* () {})();
    }),
  } as unknown as AgentRuntime;
  const observer = observeSyntheticHistory(real, diagnostics, ["synthetic-secret-value"]);
  observer.run({ executeTool: execute } as unknown as AgentRunRequest, {} as AdapterContext);
  const value = await wrapped!.executeTool!(
    "search_history",
    {
      query: "Aurora synthetic-secret-value",
      messageId: "private-reference",
      limit: 2,
      beforeSeq: 20,
    },
    "private-execution",
  );
  expect(value).toBe(result);
  expect(diagnostics).toEqual([
    {
      tool: "search_history",
      query: "Aurora [redacted]",
      limit: 2,
      beforeSeq: 20,
      nextBeforeSeq: 8,
      resultCount: 1,
      failed: false,
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toContain("private");
  await observer.abort("fixture-run");
  expect(abort).toHaveBeenCalledWith("fixture-run");
});

it("observes bounded synthetic diagnostic controls without retaining result bodies", async () => {
  const observations: DiagnosticToolObservation[] = [];
  const result = {
    segment: 1,
    nextCursor: "segment-3571954",
    diagnostic: "private-body".repeat(100),
    privateReference: "private-id",
  };
  let wrapped: AgentRunRequest | undefined;
  const runtime = {
    describe: vi.fn(),
    abort: vi.fn(),
    run(request: AgentRunRequest) {
      wrapped = request;
      return (async function* () {})();
    },
  } as unknown as AgentRuntime;
  const execute = vi.fn(async () => result);
  observeSyntheticHistory(runtime, [], [], observations).run(
    { executeTool: execute } as unknown as AgentRunRequest,
    {} as AdapterContext,
  );
  expect(
    await wrapped!.executeTool!("CRM_READ_DIAGNOSTIC", { cursor: "start" }, "private-call"),
  ).toBe(result);
  expect(observations[0]).toMatchObject({
    cursor: "start",
    resultKind: "object",
    resultKeys: ["segment", "nextCursor", "diagnostic"],
    jsonValid: true,
    segment: 1,
    nextCursor: "segment-3571954",
    failed: false,
  });
  expect(JSON.stringify(observations)).not.toContain("private");
  for (let i = 0; i < 65; i++)
    await wrapped!.executeTool!("CRM_READ_DIAGNOSTIC", { cursor: "private-id" }, "private-call");
  expect(observations).toHaveLength(60);
  expect(observations[1]!.cursor).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(66);
});

it.each(["run_subagent", "search_history", "CRM_READ_DIAGNOSTIC"] as const)(
  "passes the runtime execution observer through %s",
  async (name) => {
    const diagnostics: HistoryDiagnostic[] = [];
    const observations: DiagnosticToolObservation[] = [];
    const result = {
      result: "Synthetic child result",
      messages: [{ text: "private-result-content" }],
      nextBeforeSeq: 8,
      segment: 1,
      nextCursor: null,
    };
    const runSubagent = vi.fn(async (_args: Record<string, unknown>) => result);
    const observer: AgentToolExecutionObserver = { runSubagent };
    const execute = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(
      async (_name, args, _id, _route, forwarded) => forwarded?.runSubagent?.(args),
    );
    const run = vi.fn((_request: AgentRunRequest) => (async function* () {})());
    const runtime: AgentRuntime = { describe: vi.fn(), abort: vi.fn(), run };
    observeSyntheticHistory(runtime, diagnostics, [], observations).run(
      { executeTool: execute } as AgentRunRequest,
      {} as AdapterContext,
    );
    const args = { task: "Inspect the fixture", cursor: "start", query: "Aurora" };
    const route = { connectorId: "fixture", toolName: name };
    const wrapped = run.mock.calls[0]![0];
    await expect(wrapped.executeTool!(name, args, "fixture-call", route, observer)).resolves.toBe(
      result,
    );
    expect(execute.mock.calls[0]?.[4]).toBe(observer);
    expect(runSubagent).toHaveBeenCalledExactlyOnceWith(args);
    expect(diagnostics).toEqual(
      name === "search_history"
        ? [{ tool: name, query: "Aurora", nextBeforeSeq: 8, resultCount: 1, failed: false }]
        : [],
    );
    expect(observations).toEqual(
      name === "CRM_READ_DIAGNOSTIC"
        ? [
            {
              cursor: "start",
              resultKind: "object",
              resultKeys: ["segment", "nextCursor"],
              resultBytes: Buffer.byteLength(JSON.stringify(result)),
              jsonValid: true,
              segment: 1,
              nextCursor: null,
              failed: false,
            },
          ]
        : [],
    );
  },
);
