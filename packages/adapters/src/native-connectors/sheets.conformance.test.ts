import { sheetsActions } from "./sheets.js";
import fixtures from "./sheets.test-fixtures.json" with { type: "json" };
import type { FrozenWorkspaceRow } from "./workspace-google.test-support.js";
import {
  testFrozenWorkspace,
  workspaceContext,
  workspaceFailure,
  workspaceResponse,
} from "./workspace-google.test-support.js";

testFrozenWorkspace(sheetsActions, fixtures.actions as unknown as FrozenWorkspaceRow[]);

test("append location comes from real nested updates, not the table search range", async () => {
  const row = fixtures.actions.find((action) => action.id === "sheets.values.append")!.fixtures[0]!;
  const output = (await sheetsActions
    .find((action) => action.id === "sheets.values.append")!
    .execute(
      row.input,
      workspaceContext(async (request) => {
        assert.equal(request.query!.includeValuesInResponse, true);
        return workspaceResponse(row.upstream[0]!.response.body);
      }),
    )) as Record<string, unknown>;
  assert.equal(output.actualUpdatedRange, "Data!A2:B2");
  assert.notEqual(output.actualUpdatedRange, (row.input as Record<string, unknown>).range);
  await assert.rejects(
    sheetsActions
      .find((action) => action.id === "sheets.values.append")!
      .execute(
        row.input,
        workspaceContext(async () =>
          workspaceResponse({
            spreadsheetId: "sheet_fixture",
            updatedRange: "Data!A1:B1",
            updatedCells: 2,
          }),
        ),
      ),
    workspaceFailure("result_unknown"),
  );
});

import assert from "node:assert/strict";
import { it as test } from "vitest";

const execute = (
  id: string,
  input: Record<string, unknown>,
  context: Parameters<(typeof sheetsActions)[number]["execute"]>[1],
) => sheetsActions.find((action) => action.id === id)!.execute(input, context);
const fixture = fixtures.actions.find((action) => action.id === "sheets.values.update")!
  .fixtures[0]!;
test("preflight compares FORMULA values and rejects changed cells without writing", async () => {
  let writes = 0;
  await assert.rejects(
    execute(
      "sheets.values.update",
      fixture.input,
      workspaceContext(async (request) => {
        if (request.method !== "GET") writes++;
        assert.equal(request.query!.valueRenderOption, "FORMULA");
        return workspaceResponse({
          range: "Data!A1:B1",
          majorDimension: "ROWS",
          values: [["=SUM(A2:A4)", 1]],
        });
      }),
    ),
    workspaceFailure("version_conflict"),
  );
  assert.equal(writes, 0);
});
test("RAW and USER_ENTERED formula interpretation are explicit; no fabricated revision header", async () => {
  let writes = 0;
  const output = (await execute(
    "sheets.values.update",
    { ...fixture.input, values: [["=SUM(A2:A4)", 1]], valueInputOption: "USER_ENTERED" },
    workspaceContext(async (request) => {
      if (request.method === "GET") return workspaceResponse(fixture.upstream[0]!.response.body);
      writes++;
      assert.equal(request.query!.valueInputOption, "USER_ENTERED");
      assert.equal(request.headers, undefined);
      return workspaceResponse(fixture.upstream[1]!.response.body);
    }),
  )) as Record<string, unknown>;
  assert.equal(writes, 1);
  assert.equal(output.atomicVersionPrecondition, false);
});
test("A1 ranges and matrix sizes are bounded before provider calls", async () => {
  for (const input of [
    { ...fixture.input, range: "Data!B1:A1" },
    { ...fixture.input, range: "Data!A1:ZZ10000" },
    { ...fixture.input, range: "Data!A1:B1", values: [[1, 2, 3]] },
    { ...fixture.input, range: "Data!A1:B1", values: [] },
  ]) {
    let calls = 0;
    await assert.rejects(
      execute(
        "sheets.values.update",
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
test("drive.file-only Sheets grant cannot use an arbitrary file ID", async () => {
  let reads = 0;
  const context = workspaceContext(async (request) => {
    reads++;
    assert.equal(request.service, "drive");
    return workspaceResponse({ id: "sheet_fixture", isAppAuthorized: false });
  });
  context.principal.scopes = ["https://www.googleapis.com/auth/drive.file"];
  await assert.rejects(
    execute("sheets.spreadsheets.get", { spreadsheetId: "sheet_fixture" }, context),
    workspaceFailure("resource_unavailable"),
  );
  assert.equal(reads, 1);
});
test("worksheet rename binds the actual sheetId and title", async () => {
  const row = fixtures.actions.find((action) => action.id === "sheets.worksheets.update")!
    .fixtures[0]!;
  let writes = 0;
  await assert.rejects(
    execute(
      "sheets.worksheets.update",
      { ...row.input, expectedTitle: "Wrong" },
      workspaceContext(async (request) => {
        if (request.method !== "GET") writes++;
        return workspaceResponse(row.upstream[0]!.response.body);
      }),
    ),
    workspaceFailure("version_conflict"),
  );
  assert.equal(writes, 0);
});
