import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { PROTECTED_LOGIN_USERNAME } from "@rakazo/contracts";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import { loadRunTurnCheckpoint, Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { USE_TOOL } from "./builtin-tool-bridge.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { namedAgentTools, partitionRuntimeTools } from "./pi-runtime.js";
import {
  claimTurnEffectOccurrence,
  createRunTurnCheckpointState,
  persistRunTurnCheckpoint,
} from "./run-turn-state.js";
import type { TurnCheckpoint } from "./turn-checkpoint.js";

const run = { id: "state-run", spaceId: "state-space" };
const model = { provider: "fixture", id: "model" };
const args = { path: "report.txt", content: "Exact body" };
const execution = (id: string) => JSON.stringify(["pi-tool", "main", id]);
const fingerprint = toolEffectIdempotencyKey(run.id, "write_file", args);

function builtin(name: string): ConnectorTool {
  const tool = builtinAgentTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing fixture tool ${name}`);
  return tool;
}
function call(
  id = "pending",
  name = "write_file",
  arguments_: ToolCall["arguments"] = args,
): ToolCall {
  return { type: "toolCall", id, name, arguments: arguments_ };
}
function assistant(calls: ToolCall[]): AssistantMessage {
  return {
    role: "assistant",
    content: calls,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}
function checkpoint(overrides: Partial<TurnCheckpoint> = {}): TurnCheckpoint {
  return {
    version: 1,
    provider: model.provider,
    model: model.id,
    systemPrompt: "Saved prompt",
    pendingToolCallId: "pending",
    messages: [{ role: "user", content: "Original request", timestamp: 0 }, assistant([call()])],
    ...overrides,
  };
}
function state(
  blob?: string,
  extra: Partial<Parameters<typeof createRunTurnCheckpointState>[0]> = {},
) {
  return createRunTurnCheckpointState({
    runId: run.id,
    blob,
    model,
    tools: [builtin("write_file")],
    instructionsBaseline: "Current instructions",
    ...extra,
  });
}
const completed = (id: string, name: string) => ({
  role: "toolResult" as const,
  toolCallId: id,
  toolName: name,
  content: [{ type: "text" as const, text: "Completed receipt" }],
  isError: false,
  timestamp: 0,
});

function storage() {
  const client = {
    run: { updateMany: vi.fn(async () => ({ count: 1 })) },
    externalEffect: {
      upsert: vi.fn(
        async (_input: { create: { result: string }; update: { result: string } }) => ({}),
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) => operation(client)),
  };
  return { client, prisma: client as unknown as PrismaClient };
}

describe("run turn checkpoint state", () => {
  it.each([false, true])(
    "keeps a protected login username out of checkpoint JSON (wrapped: %s)",
    async (wrapped) => {
      const f = storage();
      const current = state(undefined, { tools: [builtin("generate_secret")] });
      const login = {
        type: "login",
        name: "fixture-login",
        origin: "https://example.test",
        purpose: "Prepare fixture-account@example.test",
        username: "fixture-account@example.test",
      };
      const captured = checkpoint({
        messages: [
          assistant([
            wrapped
              ? call("pending", USE_TOOL, { name: "generate_secret", arguments: login })
              : call("pending", "generate_secret", login),
          ]),
        ],
      });
      current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
      await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
      const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
      expect(stored).toContain(PROTECTED_LOGIN_USERNAME);
      expect(stored).not.toContain(login.username);
      expect(captured.messages[0]).toEqual(
        assistant([
          wrapped
            ? call("pending", USE_TOOL, { name: "generate_secret", arguments: login })
            : call("pending", "generate_secret", login),
        ]),
      );
    },
  );

  it("retires an unstarted login in a saved sequential batch without leaving its username", async () => {
    const f = storage();
    const current = state(undefined, {
      tools: [builtin("generate_secret"), builtin("write_file")],
    });
    const later = {
      type: "login",
      name: "later-login",
      origin: "https://example.test",
      purpose: "Prepare the next login",
      username: "later-account@example.test",
    };
    const captured = checkpoint({
      executionMode: "sequential",
      messages: [
        assistant([call(), call("later", USE_TOOL, { name: "generate_secret", arguments: later })]),
      ],
    });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
    expect(stored).not.toContain(later.username);
    expect(stored).toContain("This login request did not run before the pause.");
    expect(stored).toContain("Call generate_secret again with the username.");
  });

  it.each([
    ["direct malformed JSON", "generate_secret", {}, true],
    ["unidentified wrapped malformed JSON", USE_TOOL, {}, true],
    [
      "wrapped login arguments sent to the credential request tool",
      USE_TOOL,
      {
        name: "request_secret",
        arguments: { type: "login", username: "fixture-account@example.test" },
      },
      false,
    ],
    [
      "direct login arguments sent to the credential request tool",
      "request_secret",
      { type: "login", username: "fixture-account@example.test" },
      false,
    ],
    [
      "wrapped missing tool name",
      USE_TOOL,
      { arguments: { type: "login", username: "fixture-account@example.test" } },
      false,
    ],
    [
      "wrapped unknown login tool name",
      USE_TOOL,
      {
        name: "generate-secret",
        arguments: { type: "login", username: "fixture-account@example.test" },
      },
      false,
    ],
    ["direct missing type", "generate_secret", { username: "fixture-account@example.test" }, false],
    [
      "wrapped invalid type",
      USE_TOOL,
      {
        name: "generate_secret",
        arguments: { type: "unknown", username: "fixture-account@example.test" },
      },
      false,
    ],
  ] as const)(
    "drops raw login validation diagnostics (%s)",
    async (_label, toolName, args, malformed) => {
      const f = storage();
      const current = state(undefined, {
        tools: [builtin("generate_secret"), builtin("write_file"), builtin("request_secret")],
      });
      const raw = 'Invalid arguments: {"username":"fixture-account@example.test"';
      const invalid = call("malformed", toolName, args);
      const captured = checkpoint({
        messages: [
          assistant([malformed ? { ...invalid, argumentsError: raw } : invalid]),
          {
            ...completed("malformed", toolName),
            content: [{ type: "text", text: raw }],
            details: { error: raw },
            isError: true,
          },
          assistant([call()]),
        ],
      });
      current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
      await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
      const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
      expect(stored).not.toContain("fixture-account@example.test");
      expect(stored).toContain(
        toolName === "generate_secret" || ("name" in args && args.name === "generate_secret")
          ? "The credential generation request had invalid arguments."
          : "The tool call had invalid arguments.",
      );
    },
  );

  it("recovers past an unrecognized login-shaped call in a paused sequential batch", async () => {
    const f = storage();
    const tools = [builtin("generate_secret"), builtin("write_file")];
    const current = state(undefined, { tools });
    const captured = checkpoint({
      executionMode: "sequential",
      messages: [
        assistant([
          call(),
          call("later", USE_TOOL, {
            name: "generate-secret",
            arguments: { type: "login", username: "fixture-account@example.test" },
          }),
        ]),
      ],
    });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
    expect(stored).not.toContain("fixture-account@example.test");
    expect(state(stored, { tools }).pendingToolName).toBe("write_file");
  });

  it("does not carry a protected validation error onto an unrelated reused tool-call ID", async () => {
    const f = storage();
    const current = state();
    const id = "reused";
    const originalError = {
      ...completed(id, "write_file"),
      content: [{ type: "text" as const, text: "File is read-only" }],
      isError: true,
    };
    const captured = checkpoint({
      messages: [
        assistant([call(id, "generate_secret", { username: "fixture-account@example.test" })]),
        { ...completed(id, "generate_secret"), isError: true },
        assistant([call(id, "write_file", { path: "notes.md" })]),
        originalError,
        assistant([call()]),
      ],
    });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
    expect(JSON.parse(stored).messages[3]).toEqual(originalError);
    expect(stored).not.toContain("fixture-account@example.test");
  });

  it("does not reuse a rejected Page error for a later command generation call", async () => {
    const f = storage();
    const current = state(undefined, { tools: [builtin("generate_secret"), builtin("save_page")] });
    const id = "reused";
    const originalError = {
      ...completed(id, USE_TOOL),
      content: [{ type: "text" as const, text: "Name is already in use" }],
      isError: true,
    };
    const captured = checkpoint({
      messages: [
        assistant([call(id, USE_TOOL, { name: "save_page", arguments: {} })]),
        { ...completed(id, USE_TOOL), isError: true },
        assistant([
          call(id, USE_TOOL, {
            name: "generate_secret",
            arguments: { type: "command", name: "fixture-command", purpose: "Prepare command" },
          }),
        ]),
        originalError,
        assistant([call()]),
      ],
    });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const stored = f.client.externalEffect.upsert.mock.calls[0]![0].create.result;
    expect(JSON.parse(stored).messages[3]).toEqual(originalError);
  });

  it("retains validated command generation arguments in a checkpoint", async () => {
    const f = storage();
    const current = state(undefined, { tools: [builtin("generate_secret")] });
    const command = call("pending", USE_TOOL, {
      name: "generate_secret",
      arguments: { type: "command", name: "fixture-command", purpose: "Prepare command" },
    });
    const captured = checkpoint({ messages: [assistant([command])] });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const saved = JSON.parse(f.client.externalEffect.upsert.mock.calls[0]![0].create.result);
    expect(saved.messages).toEqual(captured.messages);
  });
  it("starts fresh with the actual baseline and shares the supplied occurrence map", () => {
    const counts = new Map([[fingerprint, 3]]);
    const current = state(undefined, { counts });
    expect(current).toEqual({
      blob: undefined,
      stored: false,
      ownInstructionsBaseline: "Current instructions",
      counts,
      occurrences: [],
      pendingCaptures: new Map(),
    });
    expect(current.counts).toBe(counts);
  });

  it.each([
    "",
    "not-json",
    JSON.stringify({ ...checkpoint(), version: 2 }),
    JSON.stringify({ ...checkpoint(), messages: [] }),
  ])(
    "rejects a present unsupported or incomplete blob instead of treating it as absent (%s)",
    (blob) => expect(() => state(blob)).toThrow("Unsupported turn checkpoint"),
  );

  it("returns the original blob unchanged and takes only its saved baseline", () => {
    const saved = {
      ...checkpoint({ ownInstructionsBaseline: "Saved baseline" }),
      privateFutureField: { keep: "opaque payload" },
    };
    const blob = JSON.stringify(saved, null, 2);
    const current = state(blob);
    expect(current.blob).toBe(blob);
    expect(current.stored).toBe(true);
    expect(current.ownInstructionsBaseline).toBe("Saved baseline");
    expect(state(JSON.stringify(checkpoint())).ownInstructionsBaseline).toBeUndefined();
  });

  it.each([undefined, "parallel"] as const)(
    "leaves unknown parallel siblings for uncertain recovery (%s)",
    (mode) => {
      const blob = JSON.stringify(
        checkpoint({
          executionMode: mode,
          messages: [assistant([call(), call("unknown", "removed_action", {})])],
        }),
      );
      expect(state(blob).blob).toBe(blob);
    },
  );

  it.each([
    { executionMode: "parallel" as const, pendingToolCallId: "unknown" },
    { executionMode: "sequential" as const, pendingToolCallId: "pending" },
  ])("rejects a pending or explicit sequential unknown tool (%j)", (options) => {
    const blob = JSON.stringify(
      checkpoint({
        ...options,
        messages: [assistant([call(), call("unknown", "removed_action", {})])],
      }),
    );
    expect(() => state(blob)).toThrow("no longer available");
  });

  it("uses the exact stable provider-safe mapping when offered registration order changes", () => {
    const tools: ConnectorTool[] = [
      { name: "record.read", description: "First", inputSchema: { type: "object" } },
      { name: "record_read", description: "Second", inputSchema: { type: "object" } },
    ];
    const named = namedAgentTools(partitionRuntimeTools(tools).listed);
    const exposed = named.find((entry) => entry.tool.name === "record.read")!.name;
    expect(exposed).not.toBe("record.read");
    const blob = JSON.stringify(
      checkpoint({ messages: [assistant([call("pending", exposed, {})])] }),
    );
    expect(state(blob, { tools: [...tools].reverse() }).blob).toBe(blob);
    expect(() =>
      state(
        JSON.stringify(checkpoint({ messages: [assistant([call("pending", "record.read", {})])] })),
        { tools },
      ),
    ).toThrow("no longer available");
  });

  it("accepts only the offered inner map for a pending use_tool without adding a find gate", () => {
    const tools = [builtin("scratchpad_add"), builtin("write_file")];
    const blob = JSON.stringify(
      checkpoint({
        messages: [
          assistant([
            call("pending", USE_TOOL, { name: "scratchpad_add", arguments: { title: "Retain" } }),
          ]),
        ],
      }),
    );
    expect(state(blob, { tools }).blob).toBe(blob);
    const directDeferred = JSON.stringify(
      checkpoint({
        messages: [
          assistant([call("pending", "scratchpad_add", { title: "Unavailable directly" })]),
        ],
      }),
    );
    expect(() => state(directDeferred, { tools })).toThrow("no longer available");
    const invalidArgs = JSON.stringify(
      checkpoint({
        messages: [
          assistant([
            call("pending", USE_TOOL, { name: "write_file", arguments: "runtime validates this" }),
          ]),
        ],
      }),
    );
    expect(state(invalidArgs, { tools }).blob).toBe(invalidArgs);
  });

  it.each(["not-offered", "find_tool", "use_tool", "save_shared_memory"])(
    "rejects unavailable or recursive pending inner name %s",
    (name) => {
      const blob = JSON.stringify(
        checkpoint({ messages: [assistant([call("pending", USE_TOOL, { name, arguments: {} })])] }),
      );
      expect(() => state(blob, { tools: [builtin("scratchpad_add")] })).toThrow(
        "no longer available",
      );
    },
  );

  it("reserves saved assignments without decreasing a newer count and claims only the last pending assignment once", () => {
    const occurrences = [
      { executionId: execution("pending"), fingerprint, occurrence: 1 },
      { executionId: execution("finished"), fingerprint, occurrence: 7 },
      { executionId: execution("pending"), fingerprint, occurrence: 2 },
    ];
    const current = state(JSON.stringify(checkpoint({ effectOccurrences: occurrences })), {
      counts: new Map([[fingerprint, 10]]),
    });
    expect(current.counts.get(fingerprint)).toBe(10);
    expect(current.restoredPending).toEqual(occurrences[2]);
    expect(
      claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending")),
    ).toBe(2);
    expect(current.restoredPending).toBeUndefined();
    expect(current.occurrences).toEqual(occurrences);
    expect(current.counts.get(fingerprint)).toBe(10);
    expect(
      claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending")),
    ).toBe(10);
    expect(current.counts.get(fingerprint)).toBe(11);
  });

  it("does not consume the pending assignment for another execution ID", () => {
    const pending = { executionId: execution("pending"), fingerprint, occurrence: 2 };
    const current = state(JSON.stringify(checkpoint({ effectOccurrences: [pending] })));
    expect(claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("other"))).toBe(
      3,
    );
    expect(current.restoredPending).toEqual(pending);
    expect(
      claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending")),
    ).toBe(2);
    expect(current.counts.get(fingerprint)).toBe(4);
  });

  it.each([0, 4])(
    "prefers the exact canonical approved occurrence %s without rewinding counts",
    (approved) => {
      const current = state(
        JSON.stringify(
          checkpoint({
            effectOccurrences: [{ executionId: execution("pending"), fingerprint, occurrence: 2 }],
          }),
        ),
        { counts: new Map([[fingerprint, 10]]) },
      );
      const key = toolEffectIdempotencyKey(run.id, "write_file", args, approved);
      expect(
        claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending"), key),
      ).toBe(approved);
      expect(current.restoredPending).toBeUndefined();
      expect(current.occurrences.at(-1)).toEqual({
        executionId: execution("pending"),
        fingerprint,
        occurrence: approved,
      });
      expect(current.counts.get(fingerprint)).toBe(10);
      expect(claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("new"))).toBe(
        10,
      );
    },
  );

  it("does not reuse a pending assignment for changed canonical arguments", () => {
    const current = state(
      JSON.stringify(
        checkpoint({
          effectOccurrences: [{ executionId: execution("pending"), fingerprint, occurrence: 2 }],
        }),
      ),
    );
    const changed = { ...args, content: "Different body" };
    expect(
      claimTurnEffectOccurrence(current, run.id, "write_file", changed, execution("pending")),
    ).toBe(0);
    expect(current.restoredPending).toBeUndefined();
    expect(current.counts.get(fingerprint)).toBe(3);
    expect(current.counts.get(toolEffectIdempotencyKey(run.id, "write_file", changed))).toBe(1);
  });

  it("derives old completed use_tool occurrences from real names and args before assigning the pending call", () => {
    const wrapped = (id: string) => call(id, USE_TOOL, { name: "write_file", arguments: args });
    const blob = JSON.stringify(
      checkpoint({
        executionMode: "sequential",
        messages: [
          assistant([wrapped("done")]),
          completed("done", USE_TOOL),
          assistant([wrapped("pending")]),
        ],
      }),
    );
    const current = state(blob, { tools: [builtin("write_file"), builtin("scratchpad_add")] });
    expect(current.occurrences).toEqual([
      { executionId: execution("done"), fingerprint, occurrence: 0 },
    ]);
    expect(current.counts.get(fingerprint)).toBe(1);
    expect([...current.counts.keys()].some((key) => key.includes(":use_tool:"))).toBe(false);
    expect(
      claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending")),
    ).toBe(1);
  });

  it("reserves an old completed occurrence when a later response reuses its wire ID", () => {
    const blob = JSON.stringify(
      checkpoint({
        pendingToolCallId: "same",
        messages: [
          assistant([call("same")]),
          completed("same", "write_file"),
          assistant([call("same")]),
        ],
      }),
    );
    const current = state(blob);
    expect(current.occurrences).toEqual([
      { executionId: execution("same"), fingerprint, occurrence: 0 },
    ]);
    expect(claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("same"))).toBe(
      1,
    );
  });

  it("does not reserve the protected secret interaction as a mutating effect in an older blob", () => {
    const blob = JSON.stringify(
      checkpoint({
        messages: [
          assistant([call("secret", "request_secret", {})]),
          completed("secret", "request_secret"),
          assistant([call()]),
        ],
      }),
    );
    const current = state(blob, { tools: [builtin("request_secret"), builtin("write_file")] });
    expect(current.occurrences).toEqual([]);
    expect(current.counts.size).toBe(0);
  });
});

describe("persist run turn checkpoint", () => {
  it("restores a shared Page approval for the exact pending bridged occurrence", async () => {
    const f = storage();
    const tools = [builtin("save_page")];
    const pageArgs = { pageId: "page-1", title: "Reviewed title" };
    const current = state(undefined, { tools });
    const pending = execution("pending");
    claimTurnEffectOccurrence(current, run.id, "save_page", pageArgs, execution("earlier"));
    claimTurnEffectOccurrence(current, run.id, "save_page", pageArgs, pending);
    const binding = {
      effectKey: toolEffectIdempotencyKey(run.id, "save_page", pageArgs, 1),
      requestDigest: "b".repeat(64),
    };
    current.pendingCaptures.set(pending, () =>
      JSON.stringify(
        checkpoint({
          messages: [
            assistant([call("pending", USE_TOOL, { name: "save_page", arguments: pageArgs })]),
          ],
        }),
      ),
    );

    await persistRunTurnCheckpoint(
      f.prisma,
      run,
      "worker",
      7,
      current,
      pending,
      undefined,
      undefined,
      [],
      binding,
    );

    const blob = f.client.externalEffect.upsert.mock.calls[0]![0].update.result;
    expect(() => JSON.parse(blob)).toThrow();
    const restored = state(blob, { tools });
    expect(restored.sharedPageApproval).toEqual(binding);
    expect(restored.pendingExecutionId).toBe(pending);
    expect(restored.pendingToolName).toBe("save_page");
    expect(JSON.parse(restored.blob!).messages).toEqual([
      assistant([call("pending", USE_TOOL, { name: "save_page", arguments: pageArgs })]),
    ]);
    const prefix = "shared-page-approval-v1:";
    const saved = JSON.parse(blob.slice(prefix.length));
    expect(() =>
      state(`${prefix}${JSON.stringify({ ...saved, effectKey: binding.effectKey.slice(0, -2) })}`, {
        tools,
      }),
    ).toThrow("Unsupported shared Page approval checkpoint");
    expect(() =>
      state(`${prefix}${JSON.stringify({ ...saved, transcript: "" })}`, { tools }),
    ).toThrow("Unsupported turn checkpoint");
  });

  it("persists a helper shared Page approval only against its assigned effect key", async () => {
    const f = storage();
    const tools = [builtin("save_page")];
    const pageArgs = { pageId: "page-1", title: "Reviewed title" };
    const current = state(undefined, { tools });
    const helperExecution = JSON.stringify(["pi-tool", "helper-1", "pending"]);
    const effectKey = toolEffectIdempotencyKey(run.id, "save_page", pageArgs);
    const binding = { effectKey, requestDigest: "c".repeat(64) };
    claimTurnEffectOccurrence(current, run.id, "save_page", pageArgs, helperExecution);

    await expect(
      persistRunTurnCheckpoint(
        f.prisma,
        run,
        "worker",
        7,
        current,
        helperExecution,
        undefined,
        undefined,
        [],
        { ...binding, effectKey: `${effectKey}:1` },
      ),
    ).rejects.toThrow("Unsupported shared Page approval checkpoint");
    expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();

    await persistRunTurnCheckpoint(
      f.prisma,
      run,
      "worker",
      7,
      current,
      helperExecution,
      undefined,
      undefined,
      [],
      binding,
    );
    const blob = f.client.externalEffect.upsert.mock.calls[0]![0].update.result;
    expect(() => JSON.parse(blob)).toThrow();
    expect(state(blob, { tools })).toMatchObject({
      stored: true,
      blob: undefined,
      sharedPageApproval: binding,
    });
  });

  it("keeps canonical Page calls and discards rejected Page inputs and protected result data", async () => {
    const f = storage();
    const secret = 'fixture-"protected"-value';
    const current = state(undefined, { tools: [builtin("write_file"), builtin("save_page")] });
    const safe = { source: "export default function Report() {}", title: "Report" };
    const privateResult = { source: `const credential = ${JSON.stringify(secret)}` };
    const captured = checkpoint({
      executionMode: "sequential",
      messages: [
        assistant([
          call("completed-page", USE_TOOL, { name: "save_page", arguments: { pageId: "page-1" } }),
        ]),
        {
          ...completed("completed-page", USE_TOOL),
          content: [{ type: "text", text: JSON.stringify(privateResult) }],
          details: privateResult,
        },
        assistant([
          call(),
          call("safe-page", USE_TOOL, { name: "save_page", arguments: safe }),
          call("unsafe-page", USE_TOOL, {
            name: "save_page",
            arguments: { ...safe, source: secret },
          }),
          call("invalid-page", "save_page", { ...safe, source: "invalid\0data" }),
          {
            ...call("malformed-page", USE_TOOL, {}),
            argumentsError: `Raw JSON attempted "save_page" with ${secret}`,
          },
          call("ordinary", "write_file", { path: "other.txt", content: "Unchanged ordinary call" }),
        ]),
      ],
    });
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(captured));
    await persistRunTurnCheckpoint(
      f.prisma,
      run,
      "worker",
      7,
      current,
      execution("pending"),
      undefined,
      undefined,
      [secret],
    );
    const blob = f.client.externalEffect.upsert.mock.calls[0]![0].update.result;
    const saved = JSON.parse(blob) as TurnCheckpoint;
    const result = saved.messages[1];
    expect(result).toMatchObject({
      role: "toolResult",
      details: { source: 'const credential = "[redacted]"' },
    });
    expect(result).not.toEqual(captured.messages[1]);
    expect(blob).not.toContain("fixture-");
    expect(blob).not.toContain("invalid\\u0000data");
    expect(saved.messages[2]).toMatchObject({
      role: "assistant",
      content: [
        call(),
        call("safe-page", USE_TOOL, { name: "save_page", arguments: safe }),
        {
          ...call("unsafe-page", USE_TOOL, { name: "save_page", arguments: {} }),
          argumentsError: expect.any(String),
        },
        { ...call("invalid-page", "save_page", {}), argumentsError: expect.any(String) },
        {
          ...call("malformed-page", USE_TOOL, { name: "save_page", arguments: {} }),
          argumentsError: expect.any(String),
        },
        call("ordinary", "write_file", { path: "other.txt", content: "Unchanged ordinary call" }),
      ],
    });
  });

  it("leaves a connector named use_tool and its result unchanged without the actual bridge", async () => {
    const f = storage();
    const connector: ConnectorTool = {
      name: USE_TOOL,
      description: "A connector with its own input schema",
      inputSchema: { type: "object" },
      route: { connectorId: "mcp", resourceId: "connector", toolName: USE_TOOL },
    };
    const current = state(undefined, { tools: [builtin("write_file"), connector] });
    const marker = "ordinary-connector-argument";
    const messages = [
      assistant([
        call("connector", USE_TOOL, { name: "save_page", arguments: { source: marker } }),
      ]),
      { ...completed("connector", USE_TOOL), details: { value: marker } },
      assistant([call()]),
    ];
    current.pendingCaptures.set(execution("pending"), () =>
      JSON.stringify(checkpoint({ messages })),
    );
    await persistRunTurnCheckpoint(
      f.prisma,
      run,
      "worker",
      7,
      current,
      execution("pending"),
      undefined,
      undefined,
      [marker],
    );
    const saved = JSON.parse(f.client.externalEffect.upsert.mock.calls[0]![0].update.result);
    expect(saved.messages).toEqual(messages);
  });

  it("captures only the matching pause, preserves private JSON data and adds executor assignments and baseline", async () => {
    const f = storage();
    const current = state();
    const route = { connectorId: "mcp", resourceId: "service", toolName: "read" };
    const captured = checkpoint({
      messages: [
        assistant([call("completed", "connector_read", {})]),
        completed("completed", "connector_read"),
        assistant([call()]),
      ],
      mcpResultRoutes: [{ messageIndex: 1, route }],
    });
    const selected = vi.fn(() => JSON.stringify(captured));
    const other = vi.fn(() => {
      throw new Error("Wrong capture selected");
    });
    current.pendingCaptures.set(execution("pending"), selected);
    current.pendingCaptures.set(execution("other"), other);
    claimTurnEffectOccurrence(current, run.id, "write_file", args, execution("pending"));
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    expect(selected).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    expect(current.stored).toBe(true);
    expect(f.client.run.updateMany).toHaveBeenCalledWith({
      where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { leaseFence: 7 },
    });
    const written = JSON.parse(f.client.externalEffect.upsert.mock.calls[0]![0].update.result);
    expect(written).toEqual({
      ...captured,
      effectOccurrences: [{ executionId: execution("pending"), fingerprint, occurrence: 0 }],
      ownInstructionsBaseline: "Current instructions",
    });
    expect(f.client.externalEffect.deleteMany).not.toHaveBeenCalled();
  });

  it.each([undefined, "missing"])(
    "drops a stored transcript with the same fence when this pause has no matching capture (%s)",
    async (executionId) => {
      const f = storage();
      const blob = JSON.stringify(checkpoint());
      const current = state(blob);
      await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, executionId);
      expect(current.stored).toBe(false);
      expect(current.blob).toBe(blob);
      expect(f.client.run.updateMany).toHaveBeenCalledWith({
        where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
        data: { leaseFence: 7 },
      });
      expect(f.client.externalEffect.deleteMany).toHaveBeenCalledOnce();
      expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
    },
  );

  it("fences cleanup of a possible private binding even when fresh state has no capture", async () => {
    const f = storage();
    const current = state();
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current);
    expect(current.stored).toBe(false);
    expect(f.client.run.updateMany).toHaveBeenCalledWith({
      where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { leaseFence: 7 },
    });
    expect(f.client.externalEffect.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            idempotencyKey: JSON.stringify(["runtime_checkpoint", run.id]),
            runId: run.id,
            spaceId: run.spaceId,
            kind: "runtime_checkpoint",
            status: "runtime_checkpoint",
          },
        ],
      },
    });
    expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
  });

  it("saves only the selected secret effect binding when a helper has no transcript capture", async () => {
    const f = storage();
    const current = state();
    const helperExecution = JSON.stringify(["pi-tool", execution("helper"), "helper-secret"]);
    const selected = "selected-helper-secret-effect";
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, helperExecution, selected);
    expect(current.stored).toBe(true);
    expect(current.blob).toBeUndefined();
    expect(current.pendingCaptures.size).toBe(0);
    expect(f.client.run.updateMany).toHaveBeenCalledWith({
      where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { leaseFence: 7 },
    });
    const scope = {
      idempotencyKey: JSON.stringify(["runtime_checkpoint", run.id]),
      runId: run.id,
      spaceId: run.spaceId,
      kind: "runtime_checkpoint",
      status: "runtime_checkpoint",
    };
    const request = { pendingSecretEffectId: selected, capture: "none" };
    expect(f.client.externalEffect.upsert).toHaveBeenCalledExactlyOnceWith({
      where: scope,
      create: { ...scope, request, result: Prisma.DbNull },
      update: { request, result: Prisma.DbNull },
    });
    expect(f.client.externalEffect.deleteMany).not.toHaveBeenCalled();
  });

  it("fences removal of a loaded binding-only row even though no transcript marks the state stored", async () => {
    const f = storage();
    const row = {
      runId: run.id,
      spaceId: run.spaceId,
      kind: "runtime_checkpoint",
      status: "runtime_checkpoint",
      request: { pendingSecretEffectId: "previous-helper-secret-effect", capture: "none" },
      result: null,
    };
    const findUnique = vi.fn(async () => row);
    Object.assign(f.client.externalEffect, { findUnique });
    const loaded = await loadRunTurnCheckpoint(f.prisma, run);
    expect(loaded).toBeUndefined();
    const current = state(loaded);
    expect(current.stored).toBe(false);
    await persistRunTurnCheckpoint(
      f.prisma,
      run,
      "worker",
      7,
      current,
      execution("ordinary-no-capture"),
    );
    expect(f.client.run.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { ...run, status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { leaseFence: 7 },
    });
    expect(f.client.externalEffect.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        OR: [
          {
            idempotencyKey: JSON.stringify(["runtime_checkpoint", run.id]),
            runId: run.id,
            spaceId: run.spaceId,
            kind: "runtime_checkpoint",
            status: "runtime_checkpoint",
          },
        ],
      },
    });
    expect(f.client.externalEffect.upsert).not.toHaveBeenCalled();
    expect(current.stored).toBe(false);
  });

  it("preserves an unknown old baseline instead of rebasing it to current instructions", async () => {
    const f = storage();
    const blob = JSON.stringify(checkpoint());
    const current = state(blob);
    current.pendingCaptures.set(execution("pending"), () => blob);
    await persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending"));
    const written = JSON.parse(f.client.externalEffect.upsert.mock.calls[0]![0].update.result);
    expect(written).not.toHaveProperty("ownInstructionsBaseline");
  });

  it("does not mark a failed save as stored", async () => {
    const f = storage();
    const failure = new Error("Storage unavailable");
    f.client.externalEffect.upsert.mockRejectedValueOnce(failure);
    const current = state();
    current.pendingCaptures.set(execution("pending"), () => JSON.stringify(checkpoint()));
    await expect(
      persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending")),
    ).rejects.toBe(failure);
    expect(current.stored).toBe(false);
  });

  it("retains stored state when fenced drop is refused", async () => {
    const f = storage();
    f.client.run.updateMany.mockResolvedValueOnce({ count: 0 });
    const current = state(JSON.stringify(checkpoint()));
    await expect(persistRunTurnCheckpoint(f.prisma, run, "stale", 6, current)).rejects.toThrow(
      "lease expired",
    );
    expect(current.stored).toBe(true);
    expect(f.client.externalEffect.deleteMany).not.toHaveBeenCalled();
  });

  it("propagates malformed capture without database writes or fallback", async () => {
    const f = storage();
    const current = state(JSON.stringify(checkpoint()));
    current.pendingCaptures.set(execution("pending"), () => "not-json");
    await expect(
      persistRunTurnCheckpoint(f.prisma, run, "worker", 7, current, execution("pending")),
    ).rejects.toThrow();
    expect(current.stored).toBe(true);
    expect(f.client.$transaction).not.toHaveBeenCalled();
  });
});
