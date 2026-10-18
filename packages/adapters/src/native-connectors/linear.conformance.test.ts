import assert from "node:assert/strict";
import { it as test } from "vitest";
import { conformance, context, failure, response } from "./collaboration-conformance.js";
import { linearActions } from "./linear.js";
import fixtures from "./linear.test-fixtures.json" with { type: "json" };

conformance("linear", linearActions, fixtures);
const action = (id: string) => linearActions.find((action) => action.id === id)!;
const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "FIX-1",
  updatedAt: "2026-10-18T00:00:00.000Z",
};
test("Linear HTTP 200 partial query is not a complete result", async () => {
  await assert.rejects(
    action("linear.issues.get").execute(
      { id: "FIX-1" },
      context("linear", async () =>
        response({ data: { issue }, errors: [{ message: "Fixture partial error" }] }),
      ),
    ),
    failure("incomplete_response"),
  );
});
test("Linear partial mutation is unknown even if resource identity is present", async () => {
  await assert.rejects(
    action("linear.comments.create").execute(
      { issueId: "FIX-1", body: "Fixture" },
      context("linear", async () =>
        response({
          data: { commentCreate: { success: true, comment: { id: issue.id } } },
          errors: [{ message: "Fixture partial mutation" }],
        }),
      ),
    ),
    failure("result_unknown"),
  );
});
test("Linear version precheck blocks changed issue without mutation", async () => {
  let calls = 0;
  const ctx = context("linear", async () => {
    calls++;
    return response({ data: { issue: { ...issue, updatedAt: "2026-10-18T00:01:00.000Z" } } });
  });
  await assert.rejects(
    action("linear.issues.update").execute(
      { id: "FIX-1", expectedUpdatedAt: issue.updatedAt, changes: { title: "Fixture" } },
      ctx,
    ),
    failure("version_conflict"),
  );
  assert.equal(calls, 1);
});
test("Linear actor/workspace mismatch and missing OAuth scopes are rejected", async () => {
  const ctx = context("linear", async () => {
    throw Error("No dispatch");
  });
  ctx.principal.context.organizationId = "another-workspace";
  await assert.rejects(
    action("linear.issues.get").execute({ id: "FIX-1" }, ctx),
    failure("authorization_required"),
  );
  ctx.principal.context.organizationId = ctx.principal.tenant;
  ctx.principal.scopes = ["read"];
  await assert.rejects(
    action("linear.comments.create").execute({ issueId: "FIX-1", body: "Fixture" }, ctx),
    failure("insufficient_scope"),
  );
});
test("Linear API key relies on remote ACL without invented OAuth scope", async () => {
  const ctx = context("linear", async () => response({ data: { issue } }));
  ctx.principal.context.credentialType = "api_key";
  ctx.principal.scopes = [];
  await action("linear.issues.get").execute({ id: "FIX-1" }, ctx);
});
