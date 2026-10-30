import type { AgentRunRequest, AgentRuntimeEvent, AgentSteeringMessage } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { inferScript, ScriptedAgentRuntime } from "./scripted-runtime.js";

describe("inferScript message_bot", () => {
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
    expect(text(events)).toContain("Use the revised data.\nKeep it concise.");
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
