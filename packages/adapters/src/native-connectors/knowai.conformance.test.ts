import assert from "node:assert/strict";
import { it as test } from "vitest";
import type { NativeRequest } from "./action.js";
import { NativeActionError } from "./action.js";
import {
  conforms,
  context,
  DOC,
  KB,
  pathMatches,
  reply,
  requestEnvelope,
  SESSION,
} from "./conformance-support.js";
import type { Obj, Schema } from "./helpers.js";
import { knowaiActions } from "./knowai.js";
import contract from "./knowai.test-fixtures.json" with { type: "json" };

type FrozenCall = {
  method: string;
  path: string;
  request_schema: Schema;
  response_schema: Schema;
  fixture: { request: Obj; response: unknown; http_status: number };
  additional_fixtures?: { successful_frame_sequence: Obj[] };
};
const calls = contract.actions.flatMap((item) => item.upstream_calls as FrozenCall[]);
const qaCall = calls.find((item) => item.path === "/api/v1/knowledge-chat/{session_id}")!;
const successfulSse = qaCall
  .additional_fixtures!.successful_frame_sequence.map(
    (frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`,
  )
  .join("");
const documentResponse = contract.actions.find((item) => item.actionId === "knowai.documents.get")!
  .upstream_calls[0]!.fixture.response;
const action = (id: string) => {
  const value = knowaiActions.find((item) => item.id === id);
  assert.ok(value);
  return value;
};
const kind = (error: unknown, expected: string) =>
  error instanceof NativeActionError && error.kind === expected;

function initialArgs(frozen: (typeof contract.actions)[number]): Obj {
  if (frozen.actionId === "knowai.qa.ask")
    return { query: "Synthetic?", knowledge_base_ids: [KB], title: "Synthetic QA" };
  const call = frozen.upstream_calls[0]!;
  const fixture = call.fixture.request as Obj;
  const path = fixture.path as Obj;
  const args = { ...((fixture.query as Obj) ?? {}), ...((fixture.body as Obj) ?? {}) };
  delete args.resource_urls;
  if (call.path.includes("knowledge-bases/{id}")) args.knowledgeBaseId = path.id;
  else if (path.id || path.knowledge_id) args.knowledgeId = path.id ?? path.knowledge_id;
  if (frozen.actionId === "knowai.documents.chunks") delete args.chunk_type;
  if (frozen.actionId === "knowai.ingest.file") {
    args.artifactId = "synthetic-artifact";
    args.fileName = "synthetic.txt";
  }
  return args;
}

test("Knowai freezes exactly 12 restricted-machine actions and write/compute classifications", () => {
  assert.equal(knowaiActions.length, 12);
  for (const id of [
    "knowai.ingest.file",
    "knowai.ingest.url",
    "knowai.ingest.markdown",
    "knowai.ingest.reparse",
    "knowai.qa.ask",
  ])
    assert.equal(action(id).readOnly, false);
  assert.deepEqual(action("knowai.qa.ask").capabilities, ["chat"]);
});

for (const frozen of contract.actions) {
  test(`Knowai fixture conformance: ${frozen.actionId}`, async () => {
    const candidate = action(frozen.actionId);
    const args = initialArgs(frozen);
    conforms(candidate.inputSchema, args);
    const invoked: NativeRequest[] = [];
    let checkedUrl = false;
    const ctx = context({
      validateResourceUrl: async () => {
        checkedUrl = true;
      },
      request: async (input) => {
        invoked.push(input);
        const frozenCall = calls.find(
          (call) => call.method === input.method && pathMatches(call.path, input.path),
        );
        assert.ok(frozenCall, `Unexpected route: ${input.method} ${input.path}`);
        conforms(
          { ...frozenCall.request_schema, definitions: contract.definitions } as Schema,
          await requestEnvelope(frozenCall.path, input),
        );
        const output = input.path.includes("/knowledge-chat/")
          ? successfulSse
          : frozenCall.fixture.response;
        if (input.path.includes("/knowledge-chat/")) {
          assert.equal(input.responseType, "text");
          const body = input.body as Obj;
          assert.equal(body.agent_enabled, false);
          assert.equal(body.web_search_enabled, false);
          assert.equal(body.local_browser_enabled, false);
          assert.equal(body.disable_title, true);
          assert.equal(body.channel, "api");
          assert.equal(body.mcp_service_ids, undefined);
          assert.equal(body.skill_names, undefined);
        } else
          conforms(
            { ...frozenCall.response_schema, definitions: contract.definitions } as Schema,
            output,
          );
        return reply(output, frozenCall.fixture.http_status);
      },
    });
    const result = (await candidate.execute(args, ctx)) as Obj;
    assert.ok(result);
    assert.equal(candidate.readOnly, frozen.readOnly);
    if (
      ["knowai.documents.chunks", "knowai.ingest.status", "knowai.ingest.reparse"].includes(
        frozen.actionId,
      )
    )
      assert.equal(invoked[0]!.path, `/api/v1/knowledge/${DOC}`);
    if (frozen.actionId === "knowai.qa.ask") {
      assert.equal(result.complete, true);
      assert.equal(result.sessionId, SESSION);
      assert.equal(result.answer, "Synthetic grounded answer.");
    }
    if (frozen.actionId === "knowai.ingest.url") assert.equal(checkedUrl, true);
  });
}

test("Knowai rejects non-allowlisted KB and missing machine scope before making HTTP calls", async () => {
  await assert.rejects(
    action("knowai.knowledge_bases.get").execute({ knowledgeBaseId: "unapproved" }, context()),
    (error) => kind(error, "insufficient_scope"),
  );
  const noKb = context();
  noKb.principal.knowledgeBaseIds = [];
  await assert.rejects(action("knowai.knowledge_bases.list").execute({}, noKb), (error) =>
    kind(error, "not_configured"),
  );
  const noCapability = context();
  noCapability.principal.capabilities = ["retrieve"];
  await assert.rejects(
    action("knowai.ingest.markdown").execute(
      { knowledgeBaseId: KB, title: "Synthetic", content: "Synthetic", status: "publish" },
      noCapability,
    ),
    (error) => kind(error, "insufficient_scope"),
  );
});

test("Knowai document ownership check stops chunks/status/reparse before accessing a foreign KB", async () => {
  for (const id of ["knowai.documents.chunks", "knowai.ingest.status", "knowai.ingest.reparse"]) {
    let count = 0;
    const ctx = context({
      request: async () => {
        count++;
        const value = structuredClone(documentResponse) as Obj;
        (value.data as Obj).knowledge_base_id = "unapproved";
        return reply(value);
      },
    });
    await assert.rejects(action(id).execute({ knowledgeId: DOC }, ctx), (error) =>
      kind(error, "insufficient_scope"),
    );
    assert.equal(count, 1);
  }
});

test("Knowai strips storage credentials, local paths and raw parse trace from model output", async () => {
  const result = (await action("knowai.knowledge_bases.get").execute(
    { knowledgeBaseId: KB },
    context({
      request: async () =>
        reply({
          success: true,
          data: {
            id: KB,
            name: "Synthetic",
            storage_provider_config: { secret_key: "synthetic-secret" },
            storage_config: { bucket: "private" },
          },
        }),
    }),
  )) as Obj;
  assert.equal(result.storage_provider_config, undefined);
  assert.equal(result.storage_config, undefined);
  const doc = structuredClone(documentResponse) as Obj;
  (doc.data as Obj).file_path = "/synthetic/private/path";
  const output = (await action("knowai.documents.get").execute(
    { knowledgeId: DOC },
    context({ request: async () => reply(doc) }),
  )) as Obj;
  assert.equal(output.file_path, undefined);
});

test("Knowai keeps document-only search scoped to that document instead of broadening its KB", async () => {
  const requests: NativeRequest[] = [];
  await action("knowai.search").execute(
    { query: "Synthetic", knowledge_ids: [DOC] },
    context({
      request: async (input) => {
        requests.push(input);
        return input.method === "GET"
          ? reply(documentResponse)
          : reply({
              success: true,
              data: [{ id: DOC, knowledge_id: DOC, knowledge_base_id: KB, content: "Synthetic" }],
              meta: {},
            });
      },
    }),
  );
  assert.equal((requests[1]!.body as Obj).knowledge_base_ids, undefined);
  assert.deepEqual((requests[1]!.body as Obj).knowledge_ids, [DOC]);
});

test("Knowai rejects unspecific search, MCP/Skill mentions, model credentials and internal QA fields", async () => {
  for (const args of [
    { query: "Synthetic" },
    { query: "Synthetic", mentioned_items: [{ type: "mcp", id: "tool" }] },
  ])
    await assert.rejects(action("knowai.search").execute(args, context()), (error) =>
      kind(error, "invalid_input"),
    );
  for (const field of [
    "agent_enabled",
    "agent_id",
    "mcp_service_ids",
    "skill_names",
    "web_search_enabled",
    "assistant_access",
  ])
    await assert.rejects(
      action("knowai.qa.ask").execute(
        { query: "Synthetic", knowledge_base_ids: [KB], [field]: true },
        context(),
      ),
      (error) => kind(error, "invalid_input"),
    );
  await assert.rejects(
    action("knowai.ingest.markdown").execute(
      {
        knowledgeBaseId: KB,
        title: "Synthetic",
        content: "Synthetic",
        status: "publish",
        process_config: { vlm_config: { api_key: "synthetic", base_url: "https://example.test" } },
      },
      context(),
    ),
    (error) => kind(error, "invalid_input"),
  );
});

test("Knowai validates resource URLs before sending an ingestion request", async () => {
  let requests = 0;
  await assert.rejects(
    action("knowai.ingest.url").execute(
      { knowledgeBaseId: KB, url: "http://169.254.169.254/metadata" },
      context({
        validateResourceUrl: async () => {
          throw new NativeActionError("invalid_input", "Blocked resource");
        },
        request: async () => {
          requests++;
          return reply({});
        },
      }),
    ),
    (error) => kind(error, "invalid_input"),
  );
  assert.equal(requests, 0);
});

test("Knowai HTTP 403 is insufficient scope, 429 preserves retry delay, writes timeout once and stay uncertain", async () => {
  for (const [status, expected] of [
    [403, "insufficient_scope"],
    [401, "authorization_expired"],
    [429, "rate_limited"],
  ] as const) {
    await assert.rejects(
      action("knowai.knowledge_bases.get").execute(
        { knowledgeBaseId: KB },
        context({ request: async () => reply({}, status, { "retry-after": "20" }) }),
      ),
      (error) =>
        kind(error, expected) &&
        (status !== 429 || (error as NativeActionError).options.retryAfterSeconds === 20),
    );
  }
  let count = 0;
  await assert.rejects(
    action("knowai.ingest.markdown").execute(
      { knowledgeBaseId: KB, title: "Synthetic", content: "Synthetic", status: "publish" },
      context({
        request: async () => {
          count++;
          throw new Error("Lost response");
        },
      }),
    ),
    (error) =>
      kind(error, "result_unknown") && (error as NativeActionError).options.uncertain === true,
  );
  assert.equal(count, 1);
});

for (const reason of [
  "stop",
  "error",
  "disconnect",
  "tool",
  "foreign_reference",
  "wrong_session",
] as const) {
  test(`Knowai QA ${reason} keeps original session and cannot become a completed answer`, async () => {
    const frames =
      reason === "disconnect"
        ? [{ id: "synthetic-request", response_type: "answer", content: "Partial", done: false }]
        : reason === "tool"
          ? [{ id: "synthetic-request", response_type: "tool_call", content: "", done: false }]
          : reason === "foreign_reference"
            ? [
                {
                  id: "synthetic-request",
                  response_type: "references",
                  content: "",
                  done: false,
                  knowledge_references: [
                    { id: DOC, knowledge_id: DOC, knowledge_base_id: "unapproved" },
                  ],
                },
              ]
            : reason === "wrong_session"
              ? [
                  {
                    id: "synthetic-request",
                    session_id: "another-session",
                    response_type: "complete",
                    content: "",
                    done: true,
                  },
                ]
              : [
                  {
                    id: "synthetic-request",
                    response_type: reason,
                    content: "Interrupted",
                    done: true,
                  },
                ];
    let count = 0;
    const ctx = context({
      request: async () => {
        count++;
        return count === 1
          ? reply({ success: true, data: { id: SESSION } }, 201)
          : reply(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      },
    });
    await assert.rejects(
      action("knowai.qa.ask").execute({ query: "Synthetic", knowledge_base_ids: [KB] }, ctx),
      (error) =>
        kind(error, "incomplete_response") &&
        (error as NativeActionError).options.recovery?.sessionId === SESSION &&
        (error as NativeActionError).options.recovery?.complete === false,
    );
    assert.equal(count, 2); // one session + one QA, never a second question
  });
}

test("Knowai QA checkpoints session ACK before QA POST and completion before returning", async () => {
  const order: string[] = [];
  let saved: Obj | undefined;
  const ctx = context({
    checkpoint: async (value) => {
      saved = structuredClone(value);
      order.push(`checkpoint:${value.phase}`);
    },
    request: async (input) => {
      order.push(input.path === "/api/v1/sessions" ? "POST:session" : "POST:qa");
      if (input.path !== "/api/v1/sessions") assert.equal(saved?.sessionId, SESSION);
      return input.path === "/api/v1/sessions"
        ? reply({ success: true, data: { id: SESSION } }, 201)
        : reply(successfulSse);
    },
  });
  const result = (await action("knowai.qa.ask").execute(
    { query: "Synthetic", knowledge_base_ids: [KB] },
    ctx,
  )) as Obj;
  assert.equal(result.complete, true);
  assert.deepEqual(order, [
    "checkpoint:session_creation_started",
    "POST:session",
    "checkpoint:session_created",
    "checkpoint:knowledge_qa_started",
    "POST:qa",
    "checkpoint:knowledge_qa_complete",
  ]);
  assert.equal(saved?.phase, "knowledge_qa_complete");
});

test("Knowai QA checkpoint fence failure before session POST makes no HTTP call", async () => {
  let calls = 0;
  await assert.rejects(
    action("knowai.qa.ask").execute(
      { query: "Synthetic", knowledge_base_ids: [KB] },
      context({
        checkpoint: async () => {
          throw new NativeActionError("authorization_expired", "Connection changed");
        },
        request: async () => {
          calls++;
          return reply({});
        },
      }),
    ),
    (error) => kind(error, "authorization_expired"),
  );
  assert.equal(calls, 0);
});

test("Knowai QA lost session ACK checkpoint never starts QA and preserves its known session ID", async () => {
  let calls = 0;
  let saved: Obj | undefined;
  const ctx = context({
    checkpoint: async (value) => {
      if (value.phase === "session_created") throw new Error("Checkpoint write unavailable");
      saved = structuredClone(value);
    },
    request: async () => {
      calls++;
      return reply({ success: true, data: { id: SESSION } }, 201);
    },
  });
  await assert.rejects(
    action("knowai.qa.ask").execute({ query: "Synthetic", knowledge_base_ids: [KB] }, ctx),
    (error) =>
      kind(error, "result_unknown") &&
      (error as NativeActionError).options.recovery?.sessionId === SESSION,
  );
  assert.equal(calls, 1);
  assert.equal(saved?.phase, "session_creation_started");
  await assert.rejects(
    action("knowai.qa.ask").execute(
      { query: "Synthetic", knowledge_base_ids: [KB] },
      context({ recovery: saved }),
    ),
    (error) => kind(error, "result_unknown"),
  );
});

test("Knowai QA resumes only session_created; it never recreates the session or replays a started QA", async () => {
  let calls = 0;
  const result = (await action("knowai.qa.ask").execute(
    { query: "Synthetic", knowledge_base_ids: [KB] },
    context({
      recovery: { actionId: "knowai.qa.ask", phase: "session_created", sessionId: SESSION },
      request: async (input) => {
        calls++;
        assert.equal(input.path, `/api/v1/knowledge-chat/${SESSION}`);
        return reply(successfulSse);
      },
    }),
  )) as Obj;
  assert.equal(result.complete, true);
  assert.equal(calls, 1);
  for (const phase of ["session_creation_started", "knowledge_qa_started"]) {
    await assert.rejects(
      action("knowai.qa.ask").execute(
        { query: "Synthetic", knowledge_base_ids: [KB] },
        context({ recovery: { actionId: "knowai.qa.ask", phase, sessionId: SESSION } }),
      ),
      (error) => kind(error, "result_unknown"),
    );
  }
});

test("Knowai acknowledged completed QA can return its same effect result without another request", async () => {
  const result = {
    sessionId: SESSION,
    requestId: "synthetic-request",
    answer: "Synthetic",
    references: [],
    complete: true,
  };
  const actual = await action("knowai.qa.ask").execute(
    { query: "Synthetic", knowledge_base_ids: [KB] },
    context({
      recovery: {
        actionId: "knowai.qa.ask",
        phase: "knowledge_qa_complete",
        sessionId: SESSION,
        result,
      },
    }),
  );
  assert.deepEqual(actual, result);
  const droppedScope = context({
    recovery: {
      actionId: "knowai.qa.ask",
      phase: "knowledge_qa_complete",
      sessionId: SESSION,
      result,
    },
  });
  droppedScope.principal.knowledgeBaseIds = ["another-permitted-KB"];
  await assert.rejects(
    action("knowai.qa.ask").execute({ query: "Synthetic", knowledge_base_ids: [KB] }, droppedScope),
    (error) => kind(error, "insufficient_scope"),
  );
});

for (const id of [
  "knowai.ingest.file",
  "knowai.ingest.url",
  "knowai.ingest.markdown",
  "knowai.ingest.reparse",
]) {
  test(`Knowai ${id} checkpoints its stable knowledge ID and resumes without another submission`, async () => {
    const frozen = contract.actions.find((item) => item.actionId === id)!;
    const args = initialArgs(frozen);
    let saved: Obj | undefined;
    let postCount = 0;
    const ctx = context({
      checkpoint: async (value) => {
        saved = structuredClone(value);
      },
      request: async (input) => {
        if (input.method === "POST") postCount++;
        return reply(documentResponse);
      },
    });
    await action(id).execute(args, ctx);
    assert.equal(postCount, 1);
    assert.equal(saved?.phase, "submitted");
    assert.equal(saved?.knowledgeId, DOC);
    let getCount = 0;
    const recovered = (await action(id).execute(
      args,
      context({
        recovery: saved,
        request: async (input) => {
          assert.equal(input.method, "GET");
          getCount++;
          return reply(documentResponse);
        },
      }),
    )) as Obj;
    assert.equal(recovered.id, DOC);
    assert.equal(getCount, 1);
    assert.equal(postCount, 1);
    await assert.rejects(
      action(id).execute(
        args,
        context({
          recovery: {
            actionId: id,
            phase: "submission_started",
            knowledgeBaseId: KB,
            ...(id.endsWith("reparse") ? { knowledgeId: DOC } : {}),
          },
        }),
      ),
      (error) => kind(error, "result_unknown"),
    );
  });
}

test("Knowai lost ingestion ACK checkpoint retains the known ID and cannot re-enqueue", async () => {
  let saved: Obj | undefined;
  let posts = 0;
  const args = { knowledgeBaseId: KB, title: "Synthetic", content: "Synthetic", status: "publish" };
  await assert.rejects(
    action("knowai.ingest.markdown").execute(
      args,
      context({
        checkpoint: async (value) => {
          if (value.phase === "submitted") throw new Error("Checkpoint unavailable");
          saved = structuredClone(value);
        },
        request: async () => {
          posts++;
          return reply(documentResponse);
        },
      }),
    ),
    (error) =>
      kind(error, "result_unknown") &&
      (error as NativeActionError).options.recovery?.knowledgeId === DOC,
  );
  assert.equal(posts, 1);
  assert.equal(saved?.phase, "submission_started");
  await assert.rejects(
    action("knowai.ingest.markdown").execute(args, context({ recovery: saved })),
    (error) => kind(error, "result_unknown"),
  );
});

test("Knowai ingest-only recovery uses the acknowledged receipt without pretending to read current parse status", async () => {
  const result = structuredClone(documentResponse) as Obj;
  const ctx = context({
    recovery: {
      actionId: "knowai.ingest.markdown",
      phase: "submitted",
      knowledgeBaseId: KB,
      knowledgeId: DOC,
      result: result.data,
    },
  });
  ctx.principal.capabilities = ["ingest"];
  const output = (await action("knowai.ingest.markdown").execute(
    { knowledgeBaseId: KB, title: "Synthetic", content: "Synthetic", status: "publish" },
    ctx,
  )) as Obj;
  assert.equal(output.id, DOC);
  assert.equal(output.parse_status, "pending");
});

for (const finishReason of [
  "incomplete",
  "length",
  "max_tokens",
  "max_output_tokens",
  "content_filter",
  "tool_calls",
  "function_call",
  "unknown_vendor_reason",
]) {
  test(`Knowai complete/done with ${finishReason} is partial and cannot checkpoint completion`, async () => {
    const phases: unknown[] = [];
    let calls = 0;
    const frames = [
      {
        id: "synthetic-request",
        response_type: "answer",
        content: "Partial grounded answer",
        done: false,
      },
      {
        id: "synthetic-request",
        response_type: "references",
        content: "",
        done: false,
        knowledge_references: [
          { id: DOC, knowledge_id: DOC, knowledge_base_id: KB, content: "Synthetic quote" },
        ],
      },
      {
        id: "synthetic-request",
        response_type: "complete",
        content: "",
        done: true,
        finish_reason: finishReason,
      },
    ];
    const ctx = context({
      checkpoint: async (value) => {
        phases.push(value.phase);
      },
      request: async () => {
        calls++;
        return calls === 1
          ? reply({ success: true, data: { id: SESSION } }, 201)
          : reply(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      },
    });
    await assert.rejects(
      action("knowai.qa.ask").execute({ query: "Synthetic", knowledge_base_ids: [KB] }, ctx),
      (error) =>
        kind(error, "incomplete_response") &&
        (error as NativeActionError).options.uncertain === true &&
        (error as NativeActionError).options.recovery?.complete === false &&
        (error as NativeActionError).options.recovery?.answer === "Partial grounded answer" &&
        Array.isArray((error as NativeActionError).options.recovery?.references),
    );
    assert.equal(calls, 2);
    assert.equal(phases.includes("knowledge_qa_complete"), false);
  });
}

for (const [label, metadata] of [
  ["truncated", { truncated: true }],
  ["superseded", { superseded: true }],
  ["suspended", { suspended: { pending_id: "synthetic-pending" } }],
] as const) {
  test(`Knowai ${label} answer followed by complete stays partial`, async () => {
    const phases: unknown[] = [];
    let calls = 0;
    const frames = [
      {
        id: "synthetic-request",
        response_type: "answer",
        content: "Partial grounded answer",
        done: true,
        data: metadata,
      },
      { id: "synthetic-request", response_type: "complete", content: "", done: true },
    ];
    await assert.rejects(
      action("knowai.qa.ask").execute(
        { query: "Synthetic", knowledge_base_ids: [KB] },
        context({
          checkpoint: async (value) => {
            phases.push(value.phase);
          },
          request: async () => {
            calls++;
            return calls === 1
              ? reply({ success: true, data: { id: SESSION } }, 201)
              : reply(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
          },
        }),
      ),
      (error) =>
        kind(error, "incomplete_response") &&
        (error as NativeActionError).options.uncertain === true &&
        (error as NativeActionError).options.recovery?.answer === "Partial grounded answer",
    );
    assert.equal(phases.includes("knowledge_qa_complete"), false);
    assert.equal(calls, 2);
  });
}

for (const finishReason of ["stop", "end_turn", "stop_sequence"]) {
  test(`Knowai normal ${finishReason} terminal marker still completes knowledge-only QA`, async () => {
    let calls = 0;
    const frames = [
      {
        id: "synthetic-request",
        response_type: "answer",
        content: "Synthetic answer",
        done: false,
      },
      {
        id: "synthetic-request",
        response_type: "complete",
        content: "",
        done: true,
        finish_reason: finishReason,
      },
    ];
    const result = (await action("knowai.qa.ask").execute(
      { query: "Synthetic", knowledge_base_ids: [KB] },
      context({
        request: async () => {
          calls++;
          return calls === 1
            ? reply({ success: true, data: { id: SESSION } }, 201)
            : reply(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
        },
      }),
    )) as Obj;
    assert.equal(result.complete, true);
    assert.equal(calls, 2);
  });
}
