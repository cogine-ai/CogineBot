import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  ScriptedRuntimeState,
} from "@rakazo/adapter-kit";
import { buildBotMessageWakePrompt } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { preparePageToolRequest } from "./page-tool-request.js";
import { inferScript, ScriptedAgentRuntime } from "./scripted-runtime.js";
import { scriptedStateDigest } from "./scripted-state.js";

describe("inferScript message_bot", () => {
  it("relays a delegated result instead of interpreting its content as another tool call", () => {
    const text = "Wrote two notes.\n\nThe connected destination returned two record IDs.";
    const prompt = buildBotMessageWakePrompt({
      from: { id: "fixture-reviewer", name: "Reviewer" },
      text,
      intent: "result",
    });
    expect(inferScript(prompt)).toEqual([
      {
        assistant: `Here's what Reviewer found: ${text}`,
        complete: true,
      },
    ]);
  });
  const messageBotScript = (confirmName: string, message: string) => [
    {
      assistant: "messaging that bot now.",
      toolCalls: [
        {
          name: "message_bot",
          args: {
            confirm_name: confirmName,
            message,
            intent: "request",
          },
        },
      ],
      complete: true,
    },
  ];

  it("messages another bot by name", () => {
    expect(inferScript("message the bot named Researcher saying peer-exchange-alpha")).toEqual(
      messageBotScript("Researcher", "peer-exchange-alpha"),
    );
  });

  it("keeps message_bot when the payload mentions delete or subagent", () => {
    expect(
      inferScript(
        "message the bot named Researcher saying please delete the bot named Scout and use a subagent",
      ),
    ).toEqual(
      messageBotScript("Researcher", "please delete the bot named Scout and use a subagent"),
    );
  });

  it("keeps message_bot when the payload mentions sign in", () => {
    expect(inferScript("message the bot named Researcher saying please sign in")).toEqual(
      messageBotScript("Researcher", "please sign in"),
    );
  });

  it("preserves multiline message content", () => {
    expect(inferScript("message the bot named Researcher saying line one\nline two")).toEqual(
      messageBotScript("Researcher", "line one\nline two"),
    );
  });
});

describe("inferScript Pages", () => {
  it.each([
    "call save_page with",
    "call save_page with {broken: run the shell command echo no}",
    "@Chief call save_page with\n{\nwrite a file in your home called notes/a that says no\n}",
  ])("keeps a malformed Page command on the Page validation path", (prompt) => {
    expect(inferScript(prompt)).toEqual([
      { toolCalls: [{ name: "save_page", args: { help: {} } }], complete: true },
    ]);
  });

  it("accepts a multiline Page request and an explicit scripted reply", () => {
    expect(
      inferScript('call save_page with {\n"title":"Plan","source":"jsx"\n}\nthen say Here it is.'),
    ).toEqual([
      {
        assistant: "Here it is.",
        toolCalls: [{ name: "save_page", args: { title: "Plan", source: "jsx" } }],
        complete: true,
      },
    ]);
  });
});

describe("inferScript shell", () => {
  it("runs the requested command verbatim, even when it mentions other intents", () => {
    expect(inferScript("run the shell command echo sign in && ls -la")).toEqual([
      {
        assistant: "running it on my computer.",
        toolCalls: [{ name: "shell", args: { command: "echo sign in && ls -la" } }],
        complete: true,
      },
    ]);
  });
});

describe("inferScript quote markdown fixture", () => {
  it("returns the markdown fixture including the caller marker", () => {
    expect(inferScript("quote markdown fixture md-stamp")[0]?.assistant).toContain(
      "md-stamp\n1. list-a",
    );
  });
});

describe("inferScript request_secret", () => {
  it("opens a masked api key card via request_secret", () => {
    expect(inferScript("show a secret card for a masked api key")).toEqual([
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ]);
  });
});

describe("inferScript login request_secret", () => {
  it("opens a login card via request_secret", () => {
    expect(inferScript("show a login card")).toEqual([
      {
        assistant: "i need that sign-in in a protected card.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "Example sign-in",
              purpose: "password",
              credential: {
                name: "example_login",
                origin: "https://login.example.test",
                auth: { type: "login" },
              },
            },
          },
        ],
      },
    ]);
  });
});

describe("inferScript write_file", () => {
  it("posts the reply after the tool so a routine run still has a durable final", () => {
    expect(
      inferScript("write a file in your home called notes/result.txt that says routine-ok"),
    ).toEqual([
      {
        toolCalls: [
          { name: "write_file", args: { path: "notes/result.txt", content: "routine-ok\n" } },
        ],
      },
      { assistant: "writing that into my home now.", complete: true },
    ]);
  });
});

describe("inferScript update_bot", () => {
  it("silences finish notifications on this bot", () => {
    expect(inferScript("silence finish notifications")).toEqual([
      {
        assistant: "silencing finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: false } }],
        complete: true,
      },
    ]);
  });

  it("resumes finish notifications on this bot", () => {
    expect(inferScript("resume finish notifications")).toEqual([
      {
        assistant: "enabling finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: true } }],
        complete: true,
      },
    ]);
  });
});

describe("ScriptedAgentRuntime executionIds", () => {
  it("gives repeated tools distinct executionIds within a run", async () => {
    const runtime = new ScriptedAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "ping",
      instructions: "",
      history: [],
      tools: [],
      model: { provider: "scripted", id: "scripted" },
      script: [
        {
          toolCalls: [
            { name: "message_agent", args: { address: "+15551111111", message: "one" } },
            { name: "message_agent", args: { address: "+15551111111", message: "two" } },
          ],
          complete: true,
        },
      ],
    })) {
      events.push(event);
    }

    const toolIds = events
      .filter(
        (event): event is Extract<AgentRuntimeEvent, { type: "tool" }> => event.type === "tool",
      )
      .map((event) => event.executionId);
    expect(toolIds).toEqual(["run-1:message_agent:0", "run-1:message_agent:1"]);
  });
});

describe("ScriptedAgentRuntime steering", () => {
  const continuation = "Respond to the user's steering context.";
  const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
    botId: "bot-steering",
    threadId: "thread-steering",
    runId: "run-steering",
    isSteeringContinuation: true,
    prompt: continuation,
    instructions: "",
    history: [],
    tools: [],
    model: { provider: "scripted", id: "scripted" },
    ...overrides,
  });
  const collect = async (events: AsyncIterable<AgentRuntimeEvent>) => {
    const result: AgentRuntimeEvent[] = [];
    for await (const event of events) result.push(event);
    return result;
  };
  const text = (events: AgentRuntimeEvent[]) =>
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("\n");

  it("revalidates saved Page inputs at restore and after a sibling discovers a secret", async () => {
    const knownOnRestore = "fixture-secret-before-resume";
    const learnedInRun = "fixture-secret-during-resume";
    const known = [knownOnRestore];
    const ordinary = { path: "notes/unrelated.txt" };
    const pageCall = (source: string) => ({
      name: "save_page",
      args: { title: "Report", source },
    });
    const script = [
      { toolCalls: [{ name: "write_file", args: { ...ordinary, content: "Already saved" } }] },
      {
        toolCalls: [
          pageCall(knownOnRestore),
          { name: "read_file", args: ordinary },
          pageCall(learnedInRun),
          { name: "save_page", args: { help: true } },
        ],
        complete: true,
      },
    ];
    const prior: ScriptedRuntimeState = {
      version: 1,
      runId: "run-steering",
      batch: [
        {
          id: "steering",
          messageId: "message",
          contentDigest: scriptedStateDigest("Original request"),
        },
      ],
      script,
      scriptDigest: scriptedStateDigest(script),
      owners: ["steering", "steering"],
      cursor: { turn: 1, tool: 0, ordinal: 1, phase: "tool" },
    };
    const saves: { state: ScriptedRuntimeState; learned: boolean }[] = [];
    const claimSteering = vi.fn(async () => []);
    const calls: Extract<AgentRuntimeEvent, { type: "tool" }>[] = [];
    for await (const event of new ScriptedAgentRuntime().run(
      request({
        scriptedState: prior,
        claimSteering,
        prepareScriptedToolArgs: (name, args) => {
          if (name !== "save_page") return args;
          const prepared = preparePageToolRequest(args, known);
          return prepared.ok ? prepared.args : { help: {} };
        },
        onScriptCheckpoint: async (state) => {
          saves.push({ state, learned: known.includes(learnedInRun) });
        },
      }),
    )) {
      if (event.type !== "tool") continue;
      calls.push(event);
      if (event.name === "read_file") known.push(learnedInRun);
    }
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith(["steering"]);
    expect(calls.map(({ name, args, executionId }) => ({ name, args, executionId }))).toEqual([
      { name: "save_page", args: { help: {} }, executionId: "run-steering:save_page:1" },
      { name: "read_file", args: ordinary, executionId: "run-steering:read_file:2" },
      { name: "save_page", args: { help: {} }, executionId: "run-steering:save_page:3" },
      { name: "save_page", args: { help: true }, executionId: "run-steering:save_page:4" },
    ]);
    expect(saves[0]?.state.cursor).toEqual(prior.cursor);
    expect(saves.some(({ learned }) => learned)).toBe(true);
    for (const { state, learned } of saves) {
      expect(state.batch).toEqual(prior.batch);
      expect(state.owners).toEqual(prior.owners);
      expect(state.script[0]).toEqual(script[0]);
      expect(state.scriptDigest).toBe(scriptedStateDigest(state.script));
      expect(JSON.stringify(state)).not.toContain(knownOnRestore);
      if (learned) expect(JSON.stringify(state)).not.toContain(learnedInRun);
    }
    expect(JSON.stringify(prior)).toContain(knownOnRestore);
    expect(JSON.stringify(prior)).toContain(learnedInRun);
  });

  it("answers the claimed batch in order instead of the prepared continuation script", async () => {
    const batch: AgentSteeringMessage[] = [
      { id: "steering-a", messageId: "message-a", text: "Use the revised data." },
      { id: "steering-b", messageId: "message-b", text: "Keep it concise." },
    ];
    const original = structuredClone(batch);
    const claimSteering = vi.fn().mockResolvedValue(batch);
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          prompt: `${continuation}\n\nCurrent time: 2030-01-01T00:00:00Z`,
          script: [{ assistant: "prepared placeholder", complete: true }],
          claimSteering,
        }),
      ),
    );

    expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
    expect(text(events)).toContain("Use the revised data.");
    expect(text(events)).toContain("Keep it concise.");
    expect(text(events).indexOf("Use the revised data.")).toBeLessThan(
      text(events).indexOf("Keep it concise."),
    );
    expect(text(events)).not.toContain("prepared placeholder");
    expect(text(events)).not.toContain(continuation);
    expect(batch).toEqual(original);
  });

  it.each(["remember the synthetic orbit preference", "Use the revised synthetic orbit plan."])(
    "reports the selected steering script before its events: %s",
    async (prompt) => {
      const resolved = vi.fn();
      const iterator = new ScriptedAgentRuntime()
        .run(
          request({
            script: [{ assistant: "prepared placeholder", complete: true }],
            claimSteering: async () => [{ id: "steering", messageId: "message", text: prompt }],
            onScriptResolved: resolved,
          }),
        )
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(resolved).toHaveBeenCalledExactlyOnceWith(inferScript(prompt));
      expect(first.value).toMatchObject({ type: "progress" });
      await collect({ [Symbol.asyncIterator]: () => iterator });
    },
  );

  it("reports an ordinary request's explicit script as its authoritative effects", async () => {
    const script = [
      { memory: [{ scope: "bot" as const, path: "MEMORY.md", content: "kept" }], complete: true },
    ];
    const resolved = vi.fn();
    await collect(
      new ScriptedAgentRuntime().run(
        request({ isSteeringContinuation: false, script, onScriptResolved: resolved }),
      ),
    );
    expect(resolved).toHaveBeenCalledExactlyOnceWith(script);
    expect(resolved.mock.calls[0]![0]).toBe(script);
  });

  it.each([false, true])(
    "completes only after the final yield resumes (explicit end: %s)",
    async (complete) => {
      const completed = vi.fn();
      const iterator = new ScriptedAgentRuntime()
        .run(
          request({
            isSteeringContinuation: false,
            script: [{ assistant: "normal", complete }],
            onScriptCompleted: completed,
          }),
        )
        [Symbol.asyncIterator]();
      let result = await iterator.next();
      while (!result.done && result.value.type !== "done") result = await iterator.next();
      expect(completed).not.toHaveBeenCalled();
      expect((await iterator.next()).done).toBe(true);
      expect(completed).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each(["progress", "text", "tool", "done"] as const)(
    "does not authorize effects when stopped at a %s yield",
    async (type) => {
      for (const external of [false, true]) {
        const runtime = new ScriptedAgentRuntime();
        const controller = new AbortController();
        const completed = vi.fn();
        const iterator = runtime
          .run(
            request({
              isSteeringContinuation: false,
              script: [
                {
                  assistant: "selected",
                  toolCalls: [{ name: "list_files", args: { path: "" } }],
                  memory: [{ scope: "bot", path: "MEMORY.md", content: "unexecuted" }],
                  complete: true,
                },
              ],
              onScriptCompleted: completed,
            }),
            { signal: controller.signal },
          )
          [Symbol.asyncIterator]();
        let result = await iterator.next();
        while (!result.done && result.value.type !== type) result = await iterator.next();
        expect(result.done).toBe(false);
        if (external) controller.abort();
        else await runtime.abort("run-steering");
        const remaining = await collect({ [Symbol.asyncIterator]: () => iterator });
        expect(completed).not.toHaveBeenCalled();
        if (type === "progress" || type === "text")
          expect(remaining.some((event) => event.type === "tool")).toBe(false);
      }
    },
  );

  it.each([false, true])("retains both independent batch tools (reversed: %s)", async (reverse) => {
    const prompts = [
      "save shared memory ROUTING.md with: orbit-shared-ok",
      "write a file called notes/orbit.txt that says orbit-file-ok",
    ];
    if (reverse) prompts.reverse();
    const completed = vi.fn();
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          claimSteering: async () =>
            prompts.map((text, index) => ({
              id: `steering-${index}`,
              messageId: `message-${index}`,
              text,
            })),
          onScriptCompleted: completed,
        }),
      ),
    );
    expect(events.filter((event) => event.type === "tool").map((event) => event.name)).toEqual(
      reverse ? ["write_file", "save_shared_memory"] : ["save_shared_memory", "write_file"],
    );
    expect(completed).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects a failing member before executing any batch effects", async () => {
    const completed = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new ScriptedAgentRuntime().run(
          request({
            claimSteering: async () => [
              {
                id: "first",
                messageId: "first",
                text: "save shared memory ROUTING.md with: orbit-shared-ok",
              },
              { id: "second", messageId: "second", text: "fail this run" },
            ],
            onScriptCompleted: completed,
          }),
        ))
          events.push(event);
      })(),
    ).rejects.toThrow("Scripted run failure");
    expect(events).toEqual([]);
    expect(completed).not.toHaveBeenCalled();
  });

  it("does not infer quoted payload intent from any batch member", async () => {
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          claimSteering: async () => [
            {
              id: "first",
              messageId: "first",
              historyText: "Use the revised plan.",
              text: "save shared memory ROUTING.md with: quoted payload",
            },
            {
              id: "second",
              messageId: "second",
              historyText: "Keep it concise.",
              text: "write a file called notes/quoted.txt that says quoted",
            },
          ],
        }),
      ),
    );
    expect(events.some((event) => event.type === "tool")).toBe(false);
    expect(text(events)).toContain("Use the revised plan.");
    expect(text(events)).toContain("Keep it concise.");
  });

  it("does not authorize effects when its iterator is closed after resolution", async () => {
    const completed = vi.fn();
    const iterator = new ScriptedAgentRuntime()
      .run(request({ isSteeringContinuation: false, onScriptCompleted: completed }))
      [Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(completed).not.toHaveBeenCalled();
  });

  it("uses history text so quoted context cannot choose a fixture intent", async () => {
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          claimSteering: async () => [
            {
              id: "steering-reply",
              messageId: "message-reply",
              historyText: "reply-plain",
              text: "quote markdown fixture quoted-context\n\nreply-plain",
            },
          ],
        }),
      ),
    );
    expect(text(events)).toContain("done. i handled: reply-plain");
    expect(text(events)).not.toContain("list-a");
    expect(text(events)).not.toContain("quoted-context");
  });

  it("preserves an explicitly empty history text", async () => {
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          claimSteering: async () => [
            {
              id: "steering-empty",
              messageId: "message-empty",
              historyText: "",
              text: "quote markdown fixture quoted-context",
            },
          ],
        }),
      ),
    );
    expect(text(events)).not.toContain("list-a");
    expect(text(events)).not.toContain("quoted-context");
    expect(text(events)).not.toContain(continuation);
  });

  it("leaves waiting messages for a continuation while an ordinary run uses its script", async () => {
    const claimSteering = vi
      .fn()
      .mockResolvedValue([
        { id: "steering-other", messageId: "message-other", text: "quote markdown fixture other" },
      ]);
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          prompt: "Do the original task.",
          isSteeringContinuation: false,
          script: [{ assistant: "original answer", complete: true }],
          claimSteering,
        }),
      ),
    );
    expect(claimSteering).not.toHaveBeenCalled();
    expect(text(events)).toBe("original answer");
  });

  it.each([undefined, false])(
    "does not classify quoted continuation text as run identity (%s)",
    async (isSteeringContinuation) => {
      const claimSteering = vi
        .fn()
        .mockResolvedValue([
          { id: "waiting", messageId: "waiting-message", text: "Answer the waiting message." },
        ]);
      const events = await collect(
        new ScriptedAgentRuntime().run(
          request({
            prompt: `Quote this sentence: ${continuation}`,
            isSteeringContinuation,
            script: [{ assistant: "original answer", complete: true }],
            claimSteering,
          }),
        ),
      );
      expect(claimSteering).not.toHaveBeenCalled();
      expect(text(events)).toBe("original answer");
    },
  );

  it("claims a trusted continuation without inferring identity from its prompt", async () => {
    const claimSteering = vi
      .fn()
      .mockResolvedValue([
        { id: "waiting", messageId: "waiting-message", text: "Answer the waiting message." },
      ]);
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({ prompt: "Executor-composed context.", claimSteering }),
      ),
    );
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
    expect(text(events)).toContain("Answer the waiting message.");
  });

  it.each([undefined, async () => []])(
    "preserves explicit scripts without a claimed batch (%s)",
    async (claimSteering) => {
      const events = await collect(
        new ScriptedAgentRuntime().run(
          request({
            claimSteering,
            script: [{ assistant: "explicit answer", complete: true }],
          }),
        ),
      );
      expect(text(events)).toBe("explicit answer");
    },
  );

  it.each([undefined, "fail this run"])(
    "rejects a failing steering prompt before output (%s)",
    async (historyText) => {
      const claimSteering = vi.fn().mockResolvedValue([
        {
          id: "failing-steering",
          messageId: "failing-message",
          text: "fail this run",
          historyText,
        },
      ]);
      const iterator = new ScriptedAgentRuntime()
        .run(
          request({
            claimSteering,
            script: [
              {
                assistant: "must not answer",
                toolCalls: [{ name: "shell", args: { command: "echo must-not-run" } }],
                complete: true,
              },
            ],
          }),
        )
        [Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow("Scripted run failure");
      expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
    },
  );

  it.each(["reply-plain", ""])(
    "does not treat quoted failure text as a steering failure (%s)",
    async (historyText) => {
      const events = await collect(
        new ScriptedAgentRuntime().run(
          request({
            claimSteering: async () => [
              {
                id: "quoted-failure",
                messageId: "quoted-failure-message",
                historyText,
                text: "Quoted context: fail this run\n\nreply-plain",
              },
            ],
          }),
        ),
      );
      expect(text(events)).toContain(`done. i handled: ${historyText}`);
      expect(text(events)).not.toContain("fail this run");
    },
  );

  it("keeps an injected run failure before any steering claim", async () => {
    const claimSteering = vi.fn();
    await expect(
      collect(
        new ScriptedAgentRuntime().run(
          request({
            prompt: "fail this run",
            claimSteering,
          }),
        ),
      ),
    ).rejects.toThrow("Scripted run failure");
    expect(claimSteering).not.toHaveBeenCalled();
  });

  it("propagates a failed claim before producing any answer", async () => {
    const error = new Error("claim unavailable");
    const iterator = new ScriptedAgentRuntime()
      .run(
        request({
          claimSteering: async () => {
            throw error;
          },
        }),
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(error);
  });

  it("does not claim messages after the request is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const claimSteering = vi.fn();
    const events = await collect(
      new ScriptedAgentRuntime().run(request({ claimSteering }), {
        signal: controller.signal,
      }),
    );
    expect(claimSteering).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "done", text: "stopped" }]);
  });

  it("does not execute a claimed script when cancellation arrives during the claim", async () => {
    const controller = new AbortController();
    const events = await collect(
      new ScriptedAgentRuntime().run(
        request({
          claimSteering: async () => {
            controller.abort();
            return [
              {
                id: "cancelled",
                messageId: "message-cancelled",
                text: "run the shell command echo unsafe",
              },
            ];
          },
        }),
        { signal: controller.signal },
      ),
    );
    expect(events).toEqual([{ type: "done", text: "stopped" }]);
  });

  it("honors runtime abort while the initial claim is pending", async () => {
    let resolveClaim!: (batch: AgentSteeringMessage[]) => void;
    let started!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = new ScriptedAgentRuntime();
    const result = collect(
      runtime.run(
        request({
          claimSteering: () => {
            started();
            return new Promise((resolve) => {
              resolveClaim = resolve;
            });
          },
        }),
      ),
    );
    await claimStarted;
    await runtime.abort("run-steering");
    resolveClaim([
      { id: "aborted", messageId: "message-aborted", text: "run the shell command echo unsafe" },
    ]);
    await expect(result).resolves.toEqual([{ type: "done", text: "stopped" }]);
  });

  it("takes long-work behavior from a continuation's actual steering text", async () => {
    const runtime = new ScriptedAgentRuntime();
    const iterator = runtime
      .run(
        request({
          claimSteering: async () => [
            { id: "hang", messageId: "message-hang", text: "keep working" },
          ],
        }),
      )
      [Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toMatchObject({ type: "tool", name: "list_files" });
    } finally {
      await runtime.abort("run-steering");
      await iterator.return?.();
    }
  });
});

describe("inferScript save_shared_memory", () => {
  it("saves shared memory from the prompt", () => {
    expect(inferScript("save shared memory MEMORY.md with: Printing jobs go to Clyde.")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "MEMORY.md", content: "Printing jobs go to Clyde." },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("uses an explicit named path", () => {
    expect(inferScript("save shared memory named ROUTING.md with: Route print jobs.")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "ROUTING.md", content: "Route print jobs." },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("defaults the path when none is given", () => {
    expect(inferScript("save shared memory with: Team facts")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "MEMORY.md", content: "Team facts" },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("beats write_file when the payload mentions notes", () => {
    const script = inferScript("write shared memory MEMORY.md with: Keep notes concise.");
    expect(script?.[0]?.toolCalls?.[0]?.name).toBe("save_shared_memory");
    expect(script?.[0]?.toolCalls?.[0]?.args).toEqual({
      path: "MEMORY.md",
      content: "Keep notes concise.",
    });
  });

  it("accepts write shared memory file <path>", () => {
    expect(inferScript("write shared memory file ROUTING.md with: Keep notes concise.")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "ROUTING.md", content: "Keep notes concise." },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("accepts with without a colon", () => {
    expect(inferScript("save shared memory with Team facts")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "MEMORY.md", content: "Team facts" },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("does not take named paths from the content body", () => {
    expect(inferScript("save shared memory ROUTING.md with: Team named Alice.")).toEqual([
      {
        assistant: "saving that to shared memory.",
        toolCalls: [
          {
            name: "save_shared_memory",
            args: { path: "ROUTING.md", content: "Team named Alice." },
          },
        ],
        complete: true,
      },
    ]);
  });
});
