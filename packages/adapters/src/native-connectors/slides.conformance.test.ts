import { slidesActions } from "./slides.js";
import fixtures from "./slides.test-fixtures.json" with { type: "json" };
import type { FrozenWorkspaceRow } from "./workspace-google.test-support.js";
import {
  testFrozenWorkspace,
  workspaceContext,
  workspaceFailure,
  workspaceResponse,
} from "./workspace-google.test-support.js";

testFrozenWorkspace(slidesActions, fixtures.actions as unknown as FrozenWorkspaceRow[]);

import assert from "node:assert/strict";
import { it as test } from "vitest";

const execute = (
  id: string,
  input: Record<string, unknown>,
  context: Parameters<(typeof slidesActions)[number]["execute"]>[1],
) => slidesActions.find((action) => action.id === id)!.execute(input, context);
const fixture = fixtures.actions.find((action) => action.id === "slides.images.create")!
  .fixtures[0]!;
test("image fetch URL policy rejects credential, signed, and private URLs without a mutation", async () => {
  for (const url of [
    "https://user:password@images.example.test/a.png",
    "https://images.example.test/a.png?token=private",
    "https://127.0.0.1/a.png",
  ]) {
    let writes = 0;
    const context = workspaceContext(
      async (request) => {
        if (request.method !== "GET") writes++;
        return workspaceResponse(fixture.upstream[0]!.response.body);
      },
      {
        validateResourceUrl: async () => {
          throw new Error("Synthetic private URL policy rejection");
        },
      },
    );
    await assert.rejects(execute("slides.images.create", { ...fixture.input, url }, context));
    assert.equal(writes, 0);
  }
});
test("requiredRevisionId and actual slide identity fence a duplicate", async () => {
  const row = fixtures.actions.find((action) => action.id === "slides.slides.duplicate")!
    .fixtures[0]!;
  let writes = 0;
  await assert.rejects(
    execute(
      "slides.slides.duplicate",
      { ...row.input, expectedRevisionId: "old" },
      workspaceContext(async (request) => {
        if (request.method !== "GET") writes++;
        return workspaceResponse(row.upstream[0]!.response.body);
      }),
    ),
    workspaceFailure("version_conflict"),
  );
  assert.equal(writes, 0);
});
test("drive.file-only Slides grant checks app resource authorization", async () => {
  const context = workspaceContext(async (request) => {
    assert.equal(request.service, "drive");
    return workspaceResponse({ id: "deck_fixture", isAppAuthorized: false });
  });
  context.principal.scopes = ["https://www.googleapis.com/auth/drive.file"];
  await assert.rejects(
    execute("slides.presentations.get", { presentationId: "deck_fixture" }, context),
    workspaceFailure("resource_unavailable"),
  );
});
test("template copy type mismatch retains destination without filling or replaying", async () => {
  const row = fixtures.actions.find((action) => action.id === "slides.templates.create")!
    .fixtures[0]!;
  let calls = 0,
    recovery: Record<string, unknown> | undefined;
  await assert.rejects(
    execute(
      "slides.templates.create",
      row.input,
      workspaceContext(
        async () => {
          calls++;
          return workspaceResponse(
            calls === 1
              ? row.upstream[0]!.response.body
              : { id: "copied_wrong_type", mimeType: "application/pdf" },
          );
        },
        {
          checkpoint: async (state) => {
            recovery = structuredClone(state);
          },
        },
      ),
    ),
    workspaceFailure("result_unknown"),
  );
  assert.equal(calls, 2);
  assert.equal(recovery!.destinationId, "copied_wrong_type");
  assert.equal(recovery!.stage, "copy-invalid");
});
