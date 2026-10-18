import { docsActions } from "./docs.js";
import fixtures from "./docs.test-fixtures.json" with { type: "json" };
import type { FrozenWorkspaceRow } from "./workspace-google.test-support.js";
import {
  testFrozenWorkspace,
  workspaceContext,
  workspaceFailure,
  workspaceResponse,
} from "./workspace-google.test-support.js";

testFrozenWorkspace(docsActions, fixtures.actions as unknown as FrozenWorkspaceRow[]);

import assert from "node:assert/strict";
import { it as test } from "vitest";

const execute = (
  id: string,
  input: Record<string, unknown>,
  context: Parameters<(typeof docsActions)[number]["execute"]>[1],
) => docsActions.find((action) => action.id === id)!.execute(input, context);
const fixture = fixtures.actions.find((action) => action.id === "docs.text.insert")!.fixtures[0]!;
test("drive.file is verified with the exact token; spoofed principal file lists do not authorize a file", async () => {
  for (const authorized of [false, undefined]) {
    let calls = 0;
    const context = workspaceContext(async (request) => {
      calls++;
      assert.equal(request.service, "drive");
      assert.equal(request.path, "/files/doc_fixture");
      return workspaceResponse({ id: "doc_fixture", isAppAuthorized: authorized });
    });
    context.principal.scopes = ["https://www.googleapis.com/auth/drive.file"];
    context.principal.context = { driveFileIds: ["doc_fixture"] };
    await assert.rejects(
      execute("docs.documents.get", { documentId: "doc_fixture" }, context),
      workspaceFailure("resource_unavailable"),
    );
    assert.equal(calls, 1);
  }
});
test("drive.file authority preflight precedes document read", async () => {
  const paths: string[] = [];
  const context = workspaceContext(async (request) => {
    paths.push(request.path);
    return workspaceResponse(
      request.service
        ? { id: "doc_fixture", isAppAuthorized: true }
        : { documentId: "doc_fixture", tabs: [] },
    );
  });
  context.principal.scopes = ["https://www.googleapis.com/auth/drive.file"];
  await execute("docs.documents.get", { documentId: "doc_fixture" }, context);
  assert.deepEqual(paths, ["/files/doc_fixture", "/documents/doc_fixture"]);
});
test("stale revision and missing explicit tab never dispatch a document write", async () => {
  for (const patch of [{ revisionId: "rev_other" }, { tabs: [] }]) {
    let writes = 0;
    await assert.rejects(
      execute(
        "docs.text.insert",
        fixture.input,
        workspaceContext(async (request) => {
          if (request.method !== "GET") writes++;
          return workspaceResponse({ ...fixture.upstream[0]!.response.body, ...patch });
        }),
      ),
      workspaceFailure("revisionId" in patch ? "version_conflict" : "invalid_input"),
    );
    assert.equal(writes, 0);
  }
});
test("opaque tab IDs and nested tabs are retained; UTF-16 insert index is not recomputed", async () => {
  const input = { ...fixture.input, tabId: "t.opaque_1", index: 3, text: "😀" };
  const context = workspaceContext(async (request) => {
    if (request.method === "GET")
      return workspaceResponse({
        documentId: "doc_fixture",
        revisionId: "rev_1",
        tabs: [{ childTabs: [{ tabProperties: { tabId: "t.opaque_1" } }] }],
      });
    assert.deepEqual(request.body, {
      requests: [{ insertText: { location: { index: 3, tabId: "t.opaque_1" }, text: "😀" } }],
      writeControl: { requiredRevisionId: "rev_1" },
    });
    return workspaceResponse({ documentId: "doc_fixture", replies: [{}] });
  });
  await execute("docs.text.insert", input, context);
});
test("invalid UTF-16 ranges and arbitrary nested batch operations fail before dispatch", async () => {
  for (const input of [
    {
      documentId: "doc_fixture",
      expectedRevisionId: "rev_1",
      operations: [{ kind: "delete", tabId: "tab_fixture", startIndex: 5, endIndex: 2 }],
    },
    {
      documentId: "doc_fixture",
      expectedRevisionId: "rev_1",
      operations: [
        {
          kind: "insert",
          tabId: "tab_fixture",
          index: 1,
          text: "Hi",
          url: "https://unexpected.example.test",
        },
      ],
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      execute(
        "docs.text.batch",
        input,
        workspaceContext(async () => {
          calls++;
          return workspaceResponse({});
        }),
      ),
      workspaceFailure("invalid_input"),
    );
    assert.equal(calls, 0);
  }
});
test("template fill lost ACK retains copied ID and does not copy or fill again", async () => {
  const template = fixtures.actions.find((action) => action.id === "docs.templates.create")!
    .fixtures[0]!;
  let index = 0,
    recovery: Record<string, unknown> | undefined;
  const context = workspaceContext(
    async () => {
      const step = template.upstream[index++]!;
      if (index === template.upstream.length) throw new Error("Synthetic lost fill ACK");
      return workspaceResponse(step.response.body);
    },
    {
      checkpoint: async (state) => {
        recovery = structuredClone(state);
      },
    },
  );
  await assert.rejects(
    execute("docs.templates.create", template.input, context),
    workspaceFailure("result_unknown"),
  );
  assert.equal(recovery!.destinationId, "new_doc");
  assert.equal(recovery!.stage, "fill-dispatching");
  let retries = 0;
  await assert.rejects(
    execute(
      "docs.templates.create",
      template.input,
      workspaceContext(
        async () => {
          retries++;
          return workspaceResponse({});
        },
        { recovery },
      ),
    ),
    workspaceFailure("result_unknown"),
  );
  assert.equal(retries, 0);
});
