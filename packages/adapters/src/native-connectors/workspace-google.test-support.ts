import assert from "node:assert/strict";
import { it as test } from "vitest";
import type { NativeAction, NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";

type Obj = Record<string, unknown>;
export interface FrozenWorkspaceRow {
  id: string;
  inputSchema: Obj;
  readOnly: boolean;
  authorization: { acceptedAnyOfScopes: string[] };
  rejectedInputFixtures: { id: string; input: Obj }[];
  fixtures: {
    id: string;
    input: Obj;
    scopes: string[];
    upstream: { request: NativeRequest; response: { body: unknown; status: number } }[];
    expectedOutput: Obj;
  }[];
}
export function workspaceContext(
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  return {
    operationId: "fixture-workspace-operation",
    signal: new AbortController().signal,
    principal: {
      subject: "fixture-google-subject",
      tenant: null,
      scopes: ["https://www.googleapis.com/auth/drive"],
      capabilities: [],
      knowledgeBaseIds: [],
      context: {},
    },
    checkpoint: async () => {},
    request,
    callMcp: async () => {
      throw new Error("Unexpected MCP");
    },
    readArtifact: async () => {
      throw new Error("Unexpected artifact");
    },
    validateResourceUrl: async () => {},
    ...extra,
  };
}
export function workspaceResponse(body: unknown, status = 200): NativeResponse {
  return { body: structuredClone(body), status, headers: new Headers() };
}
export function workspaceFailure(kind: string): (error: unknown) => boolean {
  return (error) => error instanceof NativeActionError && error.kind === kind;
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, clean(child)]),
    );
  return value;
}
function envelope(request: NativeRequest): unknown {
  return clean({ ...request, query: request.query ?? {}, headers: request.headers ?? {} });
}
function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(expected.length, actual.length);
    expected.forEach((value, index) => {
      subset(value, actual[index]);
    });
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [key, value] of Object.entries(expected)) subset(value, (actual as Obj)[key]);
    return;
  }
  assert.deepEqual(actual, expected);
}
export function testFrozenWorkspace(
  actions: readonly NativeAction[],
  rows: FrozenWorkspaceRow[],
): void {
  const byId = new Map(actions.map((action) => [action.id, action]));
  test("exact frozen action IDs, schemas, scopes and effect classification", () => {
    assert.deepEqual(
      [...byId.keys()],
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      const actual = byId.get(row.id)!;
      assert.deepEqual(actual.inputSchema, row.inputSchema);
      assert.deepEqual(actual.scopesAnyOf, row.authorization.acceptedAnyOfScopes);
      assert.equal(actual.readOnly, row.readOnly);
    }
  });
  for (const row of rows) {
    const action = byId.get(row.id)!;
    const fixture = row.fixtures[0]!;
    test(`frozen request/response: ${row.id}`, async () => {
      let index = 0;
      const states: Obj[] = [];
      const context = workspaceContext(
        async (request) => {
          const step = fixture.upstream[index++];
          assert.ok(step, `Unexpected ${request.method} ${request.path}`);
          assert.deepEqual(envelope(request), envelope(step.request));
          return workspaceResponse(step.response.body, step.response.status);
        },
        {
          checkpoint: async (state) => {
            states.push(structuredClone(state));
          },
        },
      );
      context.principal.scopes = fixture.scopes;
      subset(fixture.expectedOutput, await action.execute(structuredClone(fixture.input), context));
      assert.equal(index, fixture.upstream.length);
      if (!row.readOnly) {
        assert.equal(states[0]!.stage, "prepared");
        assert.ok(states.some((state) => String(state.stage).endsWith("dispatching")));
        assert.equal(states.at(-1)!.stage, "committed");
        const ack = workspaceContext(
          async () => {
            throw new Error("A committed receipt must not replay or reread");
          },
          { recovery: states.at(-1) },
        );
        ack.principal.scopes = fixture.scopes;
        const output = (await action.execute(structuredClone(fixture.input), ack)) as Obj;
        assert.equal(output.acknowledged, true);
        assert.equal(output.resourceState, "not-refreshed");
      }
    });
    for (const rejected of row.rejectedInputFixtures)
      test(`strict input: ${row.id} / ${rejected.id}`, async () => {
        await assert.rejects(
          action.execute(
            structuredClone(rejected.input),
            workspaceContext(async () => {
              throw new Error("Invalid inputs must not reach the network");
            }),
          ),
          workspaceFailure("invalid_input"),
        );
      });
    test(`exact granted scope required before any request: ${row.id}`, async () => {
      const context = workspaceContext(async () => {
        throw new Error("Scope failure must not call provider");
      });
      context.principal.scopes = ["https://www.googleapis.com/auth/calendar"];
      await assert.rejects(
        action.execute(structuredClone(fixture.input), context),
        workspaceFailure("insufficient_scope"),
      );
    });
    if (!row.readOnly) {
      test(`lost write ACK is unknown and recovery never dispatches again: ${row.id}`, async () => {
        let index = 0,
          writes = 0;
        let recovery: Obj | undefined;
        const context = workspaceContext(
          async (request) => {
            const step = fixture.upstream[index++];
            assert.ok(step);
            if (request.method !== "GET") {
              writes++;
              throw new Error("Synthetic lost ACK");
            }
            return workspaceResponse(step.response.body, step.response.status);
          },
          {
            checkpoint: async (state) => {
              recovery = structuredClone(state);
            },
          },
        );
        context.principal.scopes = fixture.scopes;
        await assert.rejects(
          action.execute(structuredClone(fixture.input), context),
          workspaceFailure("result_unknown"),
        );
        assert.equal(writes, 1);
        let repeatedRequests = 0;
        const retry = workspaceContext(
          async () => {
            repeatedRequests++;
            throw new Error("Unknown writes must not replay");
          },
          { recovery },
        );
        retry.principal.scopes = fixture.scopes;
        await assert.rejects(
          action.execute(structuredClone(fixture.input), retry),
          workspaceFailure("result_unknown"),
        );
        assert.equal(repeatedRequests, 0);
      });
      test(`recovery is fenced to approved input and subject: ${row.id}`, async () => {
        let recovery: Obj | undefined;
        const context = workspaceContext(
          async () => {
            throw new Error("Fixture checkpoint only");
          },
          {
            checkpoint: async (state) => {
              recovery = structuredClone(state);
              throw new Error("Stop before provider");
            },
          },
        );
        context.principal.scopes = fixture.scopes;
        await assert.rejects(action.execute(structuredClone(fixture.input), context));
        assert.ok(recovery);
        const retry = workspaceContext(
          async () => {
            throw new Error("Wrong subject must never call provider");
          },
          { recovery },
        );
        retry.principal.subject = "fixture-other-subject";
        retry.principal.scopes = fixture.scopes;
        await assert.rejects(
          action.execute(structuredClone(fixture.input), retry),
          workspaceFailure("version_conflict"),
        );
      });
    }
  }
}
