import assert from "node:assert/strict";
import { it as test } from "vitest";
import { NativeActionError } from "./action.js";
import { coginexActions, xOperationId } from "./coginex.js";
import contract from "./coginex.test-fixtures.json" with { type: "json" };
import { conforms, context, KB } from "./conformance-support.js";
import type { Obj, Schema } from "./helpers.js";

type FrozenCall = {
  tool: string;
  request_schema: Schema;
  response_schema: Schema;
  fixture: { request: Obj; response: unknown };
};
const calls = contract.actions.flatMap((action) => action.upstream_calls as FrozenCall[]);
const action = (id: string) => {
  const value = coginexActions.find((item) => item.id === id);
  assert.ok(value);
  return value;
};
const kind = (value: unknown, expected: string) =>
  value instanceof NativeActionError && value.kind === expected;

test("X freezes exactly 12 actions and only the intended 13 MCP business tools", () => {
  assert.equal(coginexActions.length, 12);
  assert.equal(new Set(calls.map((call) => call.tool)).size, 13);
  assert.ok(coginexActions.every((item) => item.scopesAnyOf?.includes("mcp")));
  assert.ok(!calls.some((call) => /Subagent|Execute|RunAgent/i.test(call.tool)));
});

for (const frozen of contract.actions) {
  test(`X fixture conformance: ${frozen.actionId}`, async () => {
    const candidate = action(frozen.actionId);
    const initial = frozen.upstream_calls[frozen.actionId === "coginex.documents.read" ? 1 : 0];
    assert.ok(initial, `Missing initial fixture: ${frozen.actionId}`);
    const args = structuredClone(initial.fixture.request) as Obj;
    delete args.operationId;
    if (frozen.actionId === "coginex.documents.create") delete args.isTask;
    conforms(candidate.inputSchema, args);
    const invoked: { tool: string; args: Obj }[] = [];
    const ctx = context({
      callMcp: async (tool, input) => {
        invoked.push({ tool, args: structuredClone(input) });
        const reference = calls.find((call) => call.tool === tool);
        assert.ok(reference, `Tool outside whitelist: ${tool}`);
        conforms({ ...reference.request_schema, $defs: contract.$defs } as Schema, input);
        const output = structuredClone(reference.fixture.response) as Obj;
        if (input.operationId) output.operationId = input.operationId;
        if (tool === "RenameDocument") output.success = true;
        if (tool === "ReadMetadata" && frozen.actionId === "coginex.documents.rename") {
          (output.documentMetadata as Obj).documentName = args.documentName;
        }
        conforms({ ...reference.response_schema, $defs: contract.$defs } as Schema, output);
        return output;
      },
    });
    const result = await candidate.execute(args, ctx);
    assert.ok(result && typeof result === "object");
    assert.equal(candidate.readOnly, frozen.readOnly);
    assert.equal(
      invoked.length,
      ["coginex.documents.read", "coginex.documents.rename"].includes(frozen.actionId) ? 2 : 1,
    );
    if (args.operationId === undefined && invoked[0]!.args.operationId)
      assert.equal(invoked[0]!.args.operationId, xOperationId(ctx.operationId));
  });
}

test("X uses a stable UUID v8 derived from the existing effect, not model operationId", () => {
  assert.equal(xOperationId("same"), xOperationId("same"));
  assert.notEqual(xOperationId("same"), xOperationId("different"));
  assert.match(xOperationId("same"), /^[a-f0-9-]{14}8[a-f0-9-]{21}$/);
});

test("X rejects implicit all-types, disallowed data types and model identity fields before MCP", async () => {
  for (const args of [
    {},
    { includeTypes: [] },
    { includeTypes: ["email"] },
    { includeTypes: ["document"], organizationId: 999 },
  ]) {
    await assert.rejects(
      action("coginex.entities.list").execute(args, context()),
      (error) => kind(error, "invalid_input") || kind(error, "insufficient_scope"),
    );
  }
  await assert.rejects(
    action("coginex.search.content").execute(
      { query: "Synthetic", entityTypes: ["agent_sessions"] },
      context(),
    ),
    (error) => kind(error, "insufficient_scope"),
  );
});

test("X requires the bound v2 identity and MCP permission", async () => {
  const missing = context();
  missing.principal.context = {};
  await assert.rejects(
    action("coginex.documents.read").execute({ documentId: KB }, missing),
    (error) => error instanceof NativeActionError,
  );
  const noScope = context();
  noScope.principal.scopes = [];
  await assert.rejects(
    action("coginex.tasks.status.get").execute({ taskId: KB }, noScope),
    (error) => kind(error, "insufficient_scope"),
  );
});

test("X create task defaults selfOnly and refuses a stale expected team", async () => {
  let actual: Obj | undefined;
  const ctx = context({
    callMcp: async (_tool, args) => {
      actual = args;
      return {
        schemaVersion: 1,
        operationId: args.operationId,
        outcome: "confirmed",
        task: { id: KB },
      };
    },
  });
  await action("coginex.tasks.create").execute({ title: "Synthetic" }, ctx);
  assert.deepEqual(actual?.visibility, { scope: "selfOnly" });
  await assert.rejects(
    action("coginex.tasks.create").execute(
      {
        title: "Synthetic",
        visibility: {
          scope: "teamVisible",
          expectedTeamId: "99999999-9999-4999-8999-999999999999",
        },
      },
      context(),
    ),
    (error) => kind(error, "insufficient_scope"),
  );
});

test("X confirmed without task.id is incomplete and cannot be reported as creation success", async () => {
  const ctx = context({
    callMcp: async (_tool, args) => ({
      schemaVersion: 1,
      operationId: args.operationId,
      outcome: "confirmed",
    }),
  });
  await assert.rejects(
    action("coginex.tasks.create").execute({ title: "Synthetic" }, ctx),
    (error) =>
      kind(error, "incomplete_response") && (error as NativeActionError).options.uncertain === true,
  );
});

test("X only permits inProgress → inReview and preserves conflict", async () => {
  const valid = {
    taskId: KB,
    expectedStatus: { value: "inProgress", version: "task-status-version/v1/0123456789abcdef" },
    newStatus: "inReview",
  };
  for (const args of [
    { ...valid, newStatus: "completed" },
    { ...valid, expectedStatus: { ...valid.expectedStatus, value: "notStarted" } },
  ]) {
    await assert.rejects(action("coginex.tasks.status.set").execute(args, context()), (error) =>
      kind(error, "invalid_input"),
    );
  }
  let count = 0;
  await assert.rejects(
    action("coginex.tasks.status.set").execute(
      valid,
      context({
        callMcp: async (_tool, args) => {
          count++;
          return { schemaVersion: 1, operationId: args.operationId, outcome: "statusConflict" };
        },
      }),
    ),
    (error) => kind(error, "version_conflict"),
  );
  assert.equal(count, 1);
});

test("X arbitrary sourceRef cannot redirect a task comment to another thread", async () => {
  const sourceRef = `task-channel-thread/v1/${KB}`;
  const args = { taskId: KB, content: "Synthetic", mode: "commit", sourceRef };
  await assert.rejects(action("coginex.tasks.progress.post").execute(args, context()), (error) =>
    kind(error, "insufficient_scope"),
  );
  const ctx = context({
    callMcp: async (_tool, input) => ({
      schemaVersion: 1,
      operationId: input.operationId,
      outcome: "posted",
      message: { id: KB },
    }),
  });
  ctx.principal.context.taskThreadSourceRefs = { [KB]: [sourceRef] };
  await action("coginex.tasks.progress.post").execute(args, ctx);
});

test("X non-idempotent create/send timeout is uncertain and never retried", async () => {
  for (const [id, args] of [
    [
      "coginex.documents.create",
      { documentName: "Synthetic", fileContent: "Synthetic", fileExtension: "md" },
    ],
    ["coginex.channels.message.send", { channel_id: KB, content: "Synthetic" }],
  ] as const) {
    let count = 0;
    await assert.rejects(
      action(id).execute(
        args,
        context({
          callMcp: async () => {
            count++;
            throw new Error("Lost response");
          },
        }),
      ),
      (error) =>
        kind(error, "result_unknown") && (error as NativeActionError).options.uncertain === true,
    );
    assert.equal(count, 1);
  }
});

for (const outcome of ["updated", "alreadyApplied"]) {
  for (const [label, status] of [
    ["missing", undefined],
    ["empty", {}],
    ["missing-value", { version: "task-status-version/v1/0123456789abcdef" }],
    ["missing-version", { value: "inReview" }],
    ["wrong-value", { value: "completed", version: "task-status-version/v1/0123456789abcdef" }],
    ["invalid-version", { value: "inReview", version: "unverified" }],
  ] as const) {
    test(`X ${outcome} with ${label} status cannot confirm the write`, async () => {
      let calls = 0;
      const ctx = context({
        callMcp: async (_tool, input) => {
          calls++;
          return {
            schemaVersion: 1,
            operationId: input.operationId,
            outcome,
            ...(status === undefined ? {} : { status }),
          };
        },
      });
      await assert.rejects(
        action("coginex.tasks.status.set").execute(
          {
            taskId: KB,
            expectedStatus: {
              value: "inProgress",
              version: "task-status-version/v1/0123456789abcdef",
            },
            newStatus: "inReview",
          },
          ctx,
        ),
        (error) =>
          kind(error, "incomplete_response") &&
          (error as NativeActionError).options.uncertain === true &&
          (error as NativeActionError).options.recovery?.upstreamOperationId ===
            xOperationId(ctx.operationId),
      );
      assert.equal(calls, 1);
    });
  }
}

for (const [label, receipt] of [
  ["empty", {}],
  ["missing-id", { success: true, message: "Synthetic" }],
  ["false", { success: false, documentId: KB, message: "Synthetic" }],
  [
    "wrong-id",
    { success: true, documentId: "99999999-9999-4999-8999-999999999999", message: "Synthetic" },
  ],
  ["missing-message", { success: true, documentId: KB }],
] as const) {
  test(`X rename ${label} receipt is uncertain instead of a confirmed non-write`, async () => {
    let calls = 0;
    const ctx = context({
      callMcp: async (tool) => {
        calls++;
        return tool === "RenameDocument"
          ? receipt
          : { documentMetadata: { documentId: KB, documentName: "Synthetic rename" } };
      },
    });
    await assert.rejects(
      action("coginex.documents.rename").execute(
        { documentId: KB, documentName: "Synthetic rename" },
        ctx,
      ),
      (error) =>
        kind(error, "incomplete_response") &&
        (error as NativeActionError).options.uncertain === true &&
        (error as NativeActionError).options.recovery?.documentId === KB,
    );
    assert.equal(calls, 1);
  });
}

for (const [label, metadata] of [
  ["missing-document", {}],
  ["empty-document", { documentMetadata: {} }],
  [
    "other-document",
    {
      documentMetadata: {
        documentId: "99999999-9999-4999-8999-999999999999",
        documentName: "Synthetic rename",
      },
    },
  ],
] as const) {
  test(`X rename ${label} readback cannot verify the acknowledged write`, async () => {
    const ctx = context({
      callMcp: async (tool) =>
        tool === "RenameDocument"
          ? { success: true, documentId: KB, message: "Synthetic" }
          : metadata,
    });
    await assert.rejects(
      action("coginex.documents.rename").execute(
        { documentId: KB, documentName: "Synthetic rename" },
        ctx,
      ),
      (error) =>
        kind(error, "incomplete_response") &&
        (error as NativeActionError).options.uncertain === true,
    );
  });
}
