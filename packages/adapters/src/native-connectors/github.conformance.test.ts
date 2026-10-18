import assert from "node:assert/strict";
import { it as test } from "vitest";
import { conformance, context, failure, response } from "./collaboration-conformance.js";
import { githubActions } from "./github.js";
import fixtures from "./github.test-fixtures.json" with { type: "json" };

conformance("github", githubActions, fixtures);
const action = (id: string) => githubActions.find((action) => action.id === id)!;
const repo = { owner: "fixture-owner", repo: "fixture-repo" };
test("GitHub PAT never fabricates permissions or leaks repository clone tokens", async () => {
  const ctx = context("github", async () =>
    response([
      { id: 1, full_name: "fixture-owner/fixture-repo", temp_clone_token: "fixture-secret" },
    ]),
  );
  ctx.principal.scopes = [];
  const result = await action("github.repositories.list").execute({}, ctx);
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
});
test("GitHub installation actual permission gates and repository allowlist", async () => {
  let calls = 0;
  const ctx = context("github", async () => {
    calls++;
    return response({});
  });
  ctx.principal.context = {
    actorType: "installation",
    installationId: "123",
    githubPermissions: { metadata: "read", issues: "read" },
    repositoryAllowlist: ["fixture-owner/fixture-repo"],
  };
  await assert.rejects(
    action("github.issues.create").execute({ ...repo, title: "Fixture" }, ctx),
    failure("insufficient_scope"),
  );
  await assert.rejects(
    action("github.ci.status").execute({ ...repo, ref: "main" }, ctx),
    failure("insufficient_scope"),
  );
  await assert.rejects(
    action("github.issues.get").execute({ ...repo, repo: "other-repo", issue_number: 1 }, ctx),
    failure("resource_unavailable"),
  );
  assert.equal(calls, 0);
});
test("GitHub installation repository discovery uses installation endpoint", async () => {
  const ctx = context("github", async (request) => {
    assert.equal(request.path, "/installation/repositories");
    return response({
      total_count: 1,
      repositories: [{ id: 1, full_name: "fixture-owner/fixture-repo" }],
    });
  });
  ctx.principal.context = {
    actorType: "installation",
    installationId: "123",
    githubPermissions: {},
  };
  await action("github.repositories.list").execute({}, ctx);
});
test("GitHub comments retain bounded pagination without following untrusted Link URL", async () => {
  const paths: string[] = [];
  const ctx = context("github", async (request) => {
    paths.push(request.path);
    return request.path.endsWith("/comments")
      ? response(
          [{ id: 4, body: "Fixture" }],
          200,
          new Headers({ link: '<https://untrusted.example.test/>; rel="next"' }),
        )
      : response({ id: 1, number: 2 });
  });
  const out = (await action("github.issues.get").execute(
    { ...repo, issue_number: 2, includeComments: true },
    ctx,
  )) as { comments: { hasMore: boolean; nextPage: number } };
  assert.equal(out.comments.hasMore, true);
  assert.equal(out.comments.nextPage, 2);
  assert.equal(paths.length, 2);
});
test("GitHub successful HTTP create missing resource identity is unknown", async () => {
  await assert.rejects(
    action("github.issues.create").execute(
      { ...repo, title: "Fixture" },
      context("github", async () => response({ title: "Fixture" }, 201)),
    ),
    failure("result_unknown"),
  );
});
