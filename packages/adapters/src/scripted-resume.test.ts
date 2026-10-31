import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ScriptedRuntimeState,
  ScriptedTurn,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";
import { scriptedStateDigest } from "./scripted-state.js";

const RUN_ID = "run-durable-script";
const SAME_CALL = { name: "shell", args: { command: "echo fixture" } };

function frozen(
  cursor: ScriptedRuntimeState["cursor"] = { turn: 0, tool: 0, ordinal: 0, phase: "turn" },
): ScriptedRuntimeState {
  const script: ScriptedTurn[] = [
    {
      assistant: "The prefix ran once.",
      toolCalls: [structuredClone(SAME_CALL)],
      memory: [{ scope: "bot", path: "MEMORY.md", content: "keep the deferred prefix" }],
      files: [{ path: "prefix.txt", content: "prefix" }],
    },
    { assistant: "Choose a city.", ask: { text: "Which city?" } },
    {
      assistant: "Continue the original suffix.",
      toolCalls: [structuredClone(SAME_CALL)],
      files: [{ path: "suffix.txt", content: "suffix" }],
      complete: true,
    },
  ];
  return {
    version: 1,
    runId: RUN_ID,
    batch: [
      { id: "steering-a", messageId: "message-a", contentDigest: scriptedStateDigest("first") },
      { id: "steering-b", messageId: "message-b", contentDigest: scriptedStateDigest("second") },
    ],
    script,
    owners: ["steering-a", "steering-a", "steering-b"],
    scriptDigest: scriptedStateDigest(script),
    cursor,
  };
}

function terminalState(): ScriptedRuntimeState {
  const value = frozen();
  const script = [{ memory: value.script[0]!.memory, complete: true }];
  return {
    ...value,
    batch: value.batch.slice(0, 1),
    script,
    owners: ["steering-a"],
    scriptDigest: scriptedStateDigest(script),
  };
}

function harness(
  overrides: Partial<AgentRunRequest> = {},
  save?: (state: ScriptedRuntimeState, count: number) => void | Promise<void>,
) {
  const checkpoints: ScriptedRuntimeState[] = [];
  const resolved: ScriptedTurn[][] = [];
  const completed = vi.fn();
  const request: AgentRunRequest = {
    botId: "bot-fixture",
    threadId: "thread-fixture",
    runId: RUN_ID,
    isSteeringContinuation: true,
    prompt: "Use the selected work.",
    instructions: "",
    history: [],
    tools: [],
    model: { provider: "scripted", id: "scripted" },
    claimSteering: async () => [],
    onScriptCheckpoint: async (state) => {
      checkpoints.push(state);
      await save?.(state, checkpoints.length);
    },
    onScriptResolved: (script) => resolved.push(script),
    onScriptCompleted: completed,
    ...overrides,
  };
  return { request, checkpoints, resolved, completed };
}

async function collect(
  source: AsyncIterable<AgentRuntimeEvent>,
  events: AgentRuntimeEvent[] = [],
): Promise<AgentRuntimeEvent[]> {
  for await (const event of source) events.push(event);
  return events;
}

const toolEvents = (events: AgentRuntimeEvent[]) => events.filter((event) => event.type === "tool");
const eventText = (events: AgentRuntimeEvent[]) =>
  events
    .filter((event) => event.type === "text")
    .map((event) => event.text)
    .join("\n");

describe("durable scripted continuation", () => {
  it("freezes every claimed member before exposing the first ask", async () => {
    const claimSteering = vi.fn().mockResolvedValue([
      { id: "memory", messageId: "message-memory", text: "remember the prefix fact" },
      { id: "question", messageId: "message-question", text: "ask me which city" },
      {
        id: "file",
        messageId: "message-file",
        text: "write a file called suffix.txt that says suffix",
      },
    ]);
    const h = harness({ claimSteering });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of new ScriptedAgentRuntime().run(h.request)) {
      if (event.type === "ask") {
        expect(h.checkpoints.at(-1)?.cursor.phase).toBe("ask");
        expect(h.checkpoints.at(-1)?.batch.map((item) => item.id)).toEqual([
          "memory",
          "question",
          "file",
        ]);
      }
      events.push(event);
    }
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
    expect(events.filter((event) => event.type === "ask")).toHaveLength(1);
    expect(toolEvents(events)).toEqual([]);
    expect(h.resolved[0]?.flatMap((turn) => turn.memory ?? [])).toEqual([
      expect.objectContaining({ content: expect.stringContaining("prefix fact") }),
    ]);
    expect(h.resolved[0]?.flatMap((turn) => turn.toolCalls ?? [])).toEqual([
      { name: "write_file", args: { path: "suffix.txt", content: "suffix\n" } },
    ]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("uses an answered pause once, retaining deferred prefix, suffix and fresh intents", async () => {
    const prior = frozen({ turn: 1, tool: 0, ordinal: 1, phase: "ask" });
    const original = structuredClone(prior);
    const claimSteering = vi
      .fn()
      .mockResolvedValue([
        { id: "fresh", messageId: "message-fresh", text: "remember the fresh fact" },
      ]);
    const h = harness({
      scriptedState: prior,
      scriptedResume: "answer",
      prompt: "Paris",
      script: [{ assistant: "The selected city is Paris.", complete: true }],
      claimSteering,
    });
    const events = await collect(new ScriptedAgentRuntime().run(h.request));
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith(["steering-a", "steering-b"]);
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(eventText(events)).toContain("The selected city is Paris.");
    expect(eventText(events)).not.toContain("The prefix ran once.");
    expect(eventText(events)).not.toContain("Choose a city.");
    expect(toolEvents(events).map((event) => event.executionId)).toEqual([`${RUN_ID}:shell:1`]);
    expect(h.resolved[0]?.flatMap((turn) => turn.files ?? []).map((file) => file.path)).toEqual([
      "prefix.txt",
      "suffix.txt",
    ]);
    expect(
      h.resolved[0]?.flatMap((turn) => turn.memory ?? []).map((memory) => memory.content),
    ).toEqual(["keep the deferred prefix", expect.stringContaining("fresh fact")]);
    expect(h.checkpoints.at(-1)?.batch.map((item) => item.id)).toEqual([
      "steering-a",
      "steering-b",
      "fresh",
    ]);
    expect(prior).toEqual(original);
    expect(h.completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps distinct execution ordinals for identical tools on both sides of an answered ask", async () => {
    const first = harness({ scriptedState: frozen() });
    const firstEvents = await collect(new ScriptedAgentRuntime().run(first.request));
    const paused = first.checkpoints.at(-1)!;
    expect(paused.cursor.phase).toBe("ask");
    const pausedCopy = structuredClone(paused);
    const resumed = harness({
      scriptedState: paused,
      scriptedResume: "answer",
      script: [{ assistant: "Paris", complete: true }],
    });
    const secondEvents = await collect(new ScriptedAgentRuntime().run(resumed.request));
    const tools = [...toolEvents(firstEvents), ...toolEvents(secondEvents)];
    expect(tools.map((event) => event.args)).toEqual([SAME_CALL.args, SAME_CALL.args]);
    expect(tools.map((event) => event.executionId)).toEqual([
      `${RUN_ID}:shell:0`,
      `${RUN_ID}:shell:1`,
    ]);
    expect(paused).toEqual(pausedCopy);
    expect(first.completed).not.toHaveBeenCalled();
    expect(resumed.completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("replays only the pending tool at its original ordinal", async () => {
    const h = harness({ scriptedState: frozen({ turn: 2, tool: 0, ordinal: 1, phase: "tool" }) });
    const events = await collect(new ScriptedAgentRuntime().run(h.request));
    expect(toolEvents(events)).toEqual([
      { type: "tool", ...SAME_CALL, executionId: `${RUN_ID}:shell:1` },
    ]);
    expect(events.some((event) => event.type === "ask")).toBe(false);
    expect(eventText(events)).not.toContain("The prefix ran once.");
    expect(eventText(events)).not.toContain("Continue the original suffix.");
    expect(h.completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("recovers a complete cursor with the full deferred script and no tool replay", async () => {
    const prior = frozen({ turn: 3, tool: 0, ordinal: 2, phase: "complete" });
    const h = harness({ scriptedState: prior });
    const iterator = new ScriptedAgentRuntime().run(h.request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("usage");
    expect((await iterator.next()).value?.type).toBe("done");
    expect(h.resolved).toEqual([prior.script]);
    expect(h.completed).not.toHaveBeenCalled();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(h.completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not mutate previously persisted snapshots while advancing later checkpoints", async () => {
    const copies: ScriptedRuntimeState[] = [];
    const h = harness({ scriptedState: frozen() }, (state) => {
      copies.push(structuredClone(state));
    });
    await collect(new ScriptedAgentRuntime().run(h.request));
    expect(h.checkpoints.length).toBeGreaterThan(2);
    expect(h.checkpoints).toEqual(copies);
    expect(h.checkpoints[0]?.cursor).toEqual({ turn: 0, tool: 0, ordinal: 0, phase: "turn" });
    expect(h.checkpoints.at(-1)?.cursor.phase).toBe("ask");
  });

  it("isolates cursor and frozen tool arguments from accidental checkpoint-sink mutation", async () => {
    const prior = frozen({ turn: 2, tool: 0, ordinal: 1, phase: "tool" });
    const original = structuredClone(prior);
    const h = harness({ scriptedState: prior }, (state, count) => {
      if (count !== 1) return;
      state.cursor = { turn: 3, tool: 0, ordinal: 2, phase: "complete" };
      state.script[2]!.toolCalls![0]!.args.command = "mutated by a persistence sink";
      state.owners.reverse();
    });
    const events = await collect(new ScriptedAgentRuntime().run(h.request));
    expect(toolEvents(events)).toEqual([
      { type: "tool", ...SAME_CALL, executionId: `${RUN_ID}:shell:1` },
    ]);
    expect(prior).toEqual(original);
    expect(h.resolved).toEqual([original.script]);
    expect(h.completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects an initial save failure before resolving or yielding selected work", async () => {
    const h = harness({ scriptedState: frozen() }, () => {
      throw new Error("save rejected");
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(collect(new ScriptedAgentRuntime().run(h.request), events)).rejects.toThrow(
      "save rejected",
    );
    expect(events).toEqual([]);
    expect(h.resolved).toEqual([]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("never exposes a tool whose prerequisite checkpoint failed", async () => {
    const h = harness({ scriptedState: frozen() }, (state) => {
      if (state.cursor.phase === "tool") throw new Error("lease lost before tool");
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(collect(new ScriptedAgentRuntime().run(h.request), events)).rejects.toThrow(
      "lease lost before tool",
    );
    expect(toolEvents(events)).toEqual([]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("does not advance to the ask after a tool-return checkpoint fails", async () => {
    const h = harness({ scriptedState: frozen() }, (state) => {
      if (state.cursor.phase === "after-tools") throw new Error("save failed after tool");
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(collect(new ScriptedAgentRuntime().run(h.request), events)).rejects.toThrow(
      "save failed after tool",
    );
    expect(toolEvents(events)).toHaveLength(1);
    expect(events.some((event) => event.type === "ask" || event.type === "done")).toBe(false);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("does not authorize deferred effects if saving the completion cursor fails", async () => {
    const h = harness({ scriptedState: terminalState() }, (state) => {
      if (state.cursor.phase === "complete") throw new Error("completion save failed");
    });
    const events: AgentRuntimeEvent[] = [];
    await expect(collect(new ScriptedAgentRuntime().run(h.request), events)).rejects.toThrow(
      "completion save failed",
    );
    expect(events.some((event) => event.type === "usage" || event.type === "done")).toBe(false);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("stops before claiming or persisting work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const claimSteering = vi.fn().mockResolvedValue([]);
    const h = harness({ scriptedState: frozen(), claimSteering });
    expect(
      await collect(new ScriptedAgentRuntime().run(h.request, { signal: controller.signal })),
    ).toEqual([{ type: "done", text: "stopped" }]);
    expect(claimSteering).not.toHaveBeenCalled();
    expect(h.checkpoints).toEqual([]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("rechecks Stop after an awaited checkpoint before resolving or executing", async () => {
    const controller = new AbortController();
    const h = harness({ scriptedState: frozen() }, () => {
      controller.abort();
    });
    expect(
      await collect(new ScriptedAgentRuntime().run(h.request, { signal: controller.signal })),
    ).toEqual([{ type: "done", text: "stopped" }]);
    expect(h.resolved).toEqual([]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("stops at a narration yield without executing the pending tool", async () => {
    const runtime = new ScriptedAgentRuntime();
    const h = harness({ scriptedState: frozen() });
    const iterator = runtime.run(h.request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("progress");
    await runtime.abort(RUN_ID);
    const remaining = await collect({ [Symbol.asyncIterator]: () => iterator });
    expect(toolEvents(remaining)).toEqual([]);
    expect(remaining).toEqual([{ type: "done", text: "stopped" }]);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it("does not record tool completion or authorize effects when stopped at the tool yield", async () => {
    const runtime = new ScriptedAgentRuntime();
    const h = harness({ scriptedState: frozen({ turn: 2, tool: 0, ordinal: 1, phase: "tool" }) });
    const iterator = runtime.run(h.request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: "tool",
      ...SAME_CALL,
      executionId: `${RUN_ID}:shell:1`,
    });
    await runtime.abort(RUN_ID);
    expect(await collect({ [Symbol.asyncIterator]: () => iterator })).toEqual([
      { type: "done", text: "stopped" },
    ]);
    expect(h.checkpoints.every((state) => state.cursor.ordinal === 1)).toBe(true);
    expect(h.completed).not.toHaveBeenCalled();
  });

  it.each(["abort", "close"] as const)(
    "does not authorize effects when the consumer will %s at done",
    async (action) => {
      const runtime = new ScriptedAgentRuntime();
      const h = harness({ scriptedState: terminalState() });
      const iterator = runtime.run(h.request)[Symbol.asyncIterator]();
      let next = await iterator.next();
      while (!next.done && next.value.type !== "done") next = await iterator.next();
      expect(next.done).toBe(false);
      expect(h.completed).not.toHaveBeenCalled();
      if (action === "abort") {
        await runtime.abort(RUN_ID);
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
      } else {
        await iterator.return?.();
      }
      expect(h.completed).not.toHaveBeenCalled();
    },
  );
});
