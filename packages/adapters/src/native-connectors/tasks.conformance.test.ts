import { tasksActions } from "./tasks.js";
import fixtures from "./tasks.test-fixtures.json" with { type: "json" };
import type { FrozenWorkspaceRow } from "./workspace-google.test-support.js";
import {
  testFrozenWorkspace,
  workspaceContext,
  workspaceFailure,
  workspaceResponse,
} from "./workspace-google.test-support.js";

testFrozenWorkspace(tasksActions, fixtures.actions as unknown as FrozenWorkspaceRow[]);

import assert from "node:assert/strict";
import { it as test } from "vitest";

const execute = (
  id: string,
  input: Record<string, unknown>,
  context: Parameters<(typeof tasksActions)[number]["execute"]>[1],
) => tasksActions.find((action) => action.id === id)!.execute(input, context);
const fixture = fixtures.actions.find((action) => action.id === "tasks.tasks.update")!.fixtures[0]!;
const context = (request: Parameters<typeof workspaceContext>[0]) => {
  const ctx = workspaceContext(request);
  ctx.principal.scopes = ["https://www.googleapis.com/auth/tasks"];
  return ctx;
};
test("Task PATCH sends exact If-Match; upstream 412 remains a conflict without retry", async () => {
  let calls = 0;
  await assert.rejects(
    execute(
      "tasks.tasks.update",
      fixture.input,
      context(async (request) => {
        calls++;
        if (request.method === "GET") return workspaceResponse(fixture.upstream[0]!.response.body);
        assert.deepEqual(request.headers, { "If-Match": "task_v1" });
        return workspaceResponse({}, 412);
      }),
    ),
    workspaceFailure("version_conflict"),
  );
  assert.equal(calls, 2);
});
test("opaque default task list and date-only due values map to the real Tasks protocol", async () => {
  await execute(
    "tasks.tasks.create",
    { tasklistId: "@default", title: "Fixture", dueDate: "2026-10-20" },
    context(async (request) => {
      assert.equal(request.path, "/lists/%40default/tasks");
      assert.deepEqual(request.body, { title: "Fixture", due: "2026-10-20T00:00:00.000Z" });
      return workspaceResponse({ id: "opaque_task=", title: "Fixture" });
    }),
  );
  let writes = 0;
  await assert.rejects(
    execute(
      "tasks.tasks.create",
      { tasklistId: "@default", title: "Fixture", dueDate: "2026-10-20T12:00:00Z" },
      context(async () => {
        writes++;
        return workspaceResponse({});
      }),
    ),
    workspaceFailure("invalid_input"),
  );
  assert.equal(writes, 0);
});
test("assigned tasks cannot be deleted through the Tasks connector", async () => {
  const row = fixtures.actions.find((action) => action.id === "tasks.tasks.delete")!.fixtures[0]!;
  let writes = 0;
  await assert.rejects(
    execute(
      "tasks.tasks.delete",
      row.input,
      context(async (request) => {
        if (request.method !== "GET") writes++;
        return workspaceResponse({
          ...row.upstream[0]!.response.body,
          assignmentInfo: { surfaceType: "DOCUMENT" },
        });
      }),
    ),
    workspaceFailure("invalid_input"),
  );
  assert.equal(writes, 0);
});
test("subtask parent and previous sibling are read from the selected list", async () => {
  for (const parent of [
    { id: "parent_fixture", parent: "another_parent" },
    { id: "parent_fixture", assignmentInfo: { surfaceType: "SPACE" } },
  ]) {
    let writes = 0;
    await assert.rejects(
      execute(
        "tasks.tasks.create",
        { tasklistId: "list_fixture", title: "Fixture", parent: "parent_fixture" },
        context(async (request) => {
          if (request.method !== "GET") writes++;
          return workspaceResponse(parent);
        }),
      ),
      workspaceFailure("invalid_input"),
    );
    assert.equal(writes, 0);
  }
});
test("terminal page reached with an input cursor is not whole-query completeness", async () => {
  const output = (await execute(
    "tasks.tasks.list",
    { tasklistId: "list_fixture", pageToken: "page_two" },
    context(async () => workspaceResponse({ items: [] })),
  )) as Record<string, unknown>;
  assert.equal(output.hasMore, false);
  assert.equal(output.allPagesRead, false);
});
test("a repeated page cursor is rejected rather than looping", async () => {
  await assert.rejects(
    execute(
      "tasks.tasklists.list",
      { pageToken: "same_cursor" },
      context(async () => workspaceResponse({ nextPageToken: "same_cursor" })),
    ),
    workspaceFailure("incomplete_response"),
  );
});
