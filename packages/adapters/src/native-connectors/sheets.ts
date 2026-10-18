import type { NativeActionContext } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./sheets.contract.json" with { type: "json" };
import type { Obj, WorkspaceImplementation } from "./workspace-google.js";
import {
  enc,
  googleCall,
  identity,
  invalid,
  object,
  same,
  workspaceActions,
  workspaceFile,
  workspaceWrite,
} from "./workspace-google.js";

const READ_SCOPES = ["spreadsheets.readonly", "spreadsheets", "drive.readonly", "drive"];
const WRITE_SCOPES = ["spreadsheets", "drive"];
const bookPath = (args: Obj) => `/spreadsheets/${enc(args.spreadsheetId)}`;
const valuesPath = (args: Obj) => `${bookPath(args)}/values/${enc(args.range)}`;
function dimensions(args: Obj): { rows: number; columns: number } {
  const range = String(args.range).match(/!([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/)!;
  const column = (letters: string) =>
    [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  const first = column(range[1]!),
    last = column(range[3] ?? range[1]!);
  const start = Number(range[2]),
    end = Number(range[4] ?? range[2]);
  if (
    first > last ||
    start > end ||
    last > 18278 ||
    end > 10000000 ||
    end - start + 1 > 1000 ||
    last - first + 1 > 100
  )
    invalid("Use an ordered, bounded range of at most 1000 rows and 100 columns.");
  return { rows: end - start + 1, columns: last - first + 1 };
}
function validateValues(values: unknown, rows: number, columns: number): void {
  const matrix = values as unknown[][];
  if (matrix.length > rows || matrix.some((row) => row.length > columns))
    invalid("Values must fit inside the explicit range.");
}
async function readValues(
  args: Obj,
  context: NativeActionContext,
  render = "FORMULA",
): Promise<Obj> {
  const result = object(
    await googleCall(context, {
      method: "GET",
      path: valuesPath(args),
      query: {
        valueRenderOption: render,
        dateTimeRenderOption: "SERIAL_NUMBER",
        majorDimension: "ROWS",
      },
    }),
  );
  if (
    typeof result.range !== "string" ||
    result.majorDimension !== "ROWS" ||
    (result.values !== undefined &&
      (!Array.isArray(result.values) || result.values.some((row) => !Array.isArray(row))))
  )
    throw new NativeActionError(
      "incomplete_response",
      "Google omitted the bounded ROWS value range.",
    );
  return result;
}
async function spreadsheet(args: Obj, context: NativeActionContext): Promise<Obj> {
  const body = identity(
    await googleCall(context, {
      method: "GET",
      path: bookPath(args),
      query: { includeGridData: false },
    }),
    "spreadsheetId",
    args.spreadsheetId,
  );
  if (!Array.isArray(body.sheets))
    throw new NativeActionError("incomplete_response", "Google omitted worksheet metadata.");
  return body;
}
async function valuesWrite(
  kind: "update" | "append" | "clear",
  args: Obj,
  context: NativeActionContext,
): Promise<Obj> {
  const { rows, columns } = dimensions(args);
  if (kind !== "clear") {
    validateValues(args.values, rows, columns);
    if (
      !(args.values as unknown[][]).length ||
      (args.values as unknown[][]).every((row) => !row.length)
    )
      invalid("Provide at least one cell value.");
  }
  if (kind !== "append") validateValues(args.expectedValues, rows, columns);
  return workspaceWrite(
    `sheets.values.${kind}`,
    args,
    context,
    async () => {
      await workspaceFile(context, args.spreadsheetId, WRITE_SCOPES);
      if (kind !== "append") {
        const current = await readValues(args, context);
        if (!same(current.values ?? [], args.expectedValues))
          throw new NativeActionError(
            "version_conflict",
            "The cell values changed since the approved read.",
          );
      }
      return {
        method: kind === "update" ? "PUT" : "POST",
        path: valuesPath(args) + (kind === "update" ? "" : `:${kind}`),
        ...(kind === "clear"
          ? {}
          : {
              query: {
                valueInputOption: String(args.valueInputOption),
                ...(kind === "append" ? { insertDataOption: String(args.insertDataOption) } : {}),
                includeValuesInResponse: true,
                responseValueRenderOption: "FORMULA",
              },
            }),
        body:
          kind === "clear"
            ? {}
            : { range: args.range, majorDimension: "ROWS", values: args.values },
      };
    },
    (value) => {
      const result = identity(value, "spreadsheetId", args.spreadsheetId);
      if (kind === "clear" && typeof result.clearedRange !== "string")
        throw new Error("Missing cleared range acknowledgement");
      if (
        kind === "update" &&
        (typeof result.updatedRange !== "string" || typeof result.updatedCells !== "number")
      )
        throw new Error("Missing updated cell acknowledgement");
      let actualUpdatedRange: string | undefined;
      if (kind === "append") {
        const updates = identity(result.updates, "spreadsheetId", args.spreadsheetId);
        if (
          typeof result.tableRange !== "string" ||
          typeof updates.updatedRange !== "string" ||
          typeof updates.updatedRows !== "number" ||
          typeof updates.updatedColumns !== "number" ||
          typeof updates.updatedCells !== "number"
        )
          throw new Error("Missing appended cell acknowledgement");
        actualUpdatedRange = updates.updatedRange;
      }
      return {
        result,
        ...(actualUpdatedRange ? { actualUpdatedRange } : {}),
        outcome: "succeeded",
        atomicVersionPrecondition: false,
      };
    },
    (output) => ({
      spreadsheetId: args.spreadsheetId,
      range: args.range,
      atomicVersionPrecondition: false,
      ...(typeof output.actualUpdatedRange === "string"
        ? { actualUpdatedRange: output.actualUpdatedRange }
        : {}),
      ...Object.fromEntries(
        Object.entries(object(output.result)).filter(([key]) =>
          ["updatedRange", "clearedRange", "tableRange"].includes(key),
        ),
      ),
    }),
  );
}
const implementations: Record<string, WorkspaceImplementation> = {
  "sheets.spreadsheets.get": async (args, context) => {
    await workspaceFile(context, args.spreadsheetId, READ_SCOPES);
    return { spreadsheet: await spreadsheet(args, context) };
  },
  "sheets.spreadsheets.create": (args, context) =>
    workspaceWrite(
      "sheets.spreadsheets.create",
      args,
      context,
      async () => ({
        method: "POST",
        path: "/spreadsheets",
        body: { properties: { title: args.title } },
      }),
      (value) => ({ spreadsheet: identity(value, "spreadsheetId"), outcome: "succeeded" }),
      (output) => ({ spreadsheetId: object(output.spreadsheet).spreadsheetId }),
    ),
  "sheets.values.get": async (args, context) => {
    dimensions(args);
    await workspaceFile(context, args.spreadsheetId, READ_SCOPES);
    return {
      valueRange: await readValues(args, context, String(args.valueRenderOption ?? "FORMULA")),
    };
  },
  "sheets.values.update": (args, context) => valuesWrite("update", args, context),
  "sheets.values.append": (args, context) => valuesWrite("append", args, context),
  "sheets.values.clear": (args, context) => valuesWrite("clear", args, context),
  "sheets.worksheets.add": (args, context) =>
    workspaceWrite(
      "sheets.worksheets.add",
      args,
      context,
      async () => {
        if (Number(args.rowCount) * Number(args.columnCount) > 10000000)
          invalid("The worksheet exceeds the cell budget.");
        await workspaceFile(context, args.spreadsheetId, WRITE_SCOPES);
        return {
          method: "POST",
          path: `${bookPath(args)}:batchUpdate`,
          body: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: args.title,
                    gridProperties: { rowCount: args.rowCount, columnCount: args.columnCount },
                  },
                },
              },
            ],
          },
        };
      },
      (value) => {
        const result = identity(value, "spreadsheetId", args.spreadsheetId);
        const reply = Array.isArray(result.replies) ? object(result.replies[0]) : {};
        const properties = reply.addSheet ? object(object(reply.addSheet).properties) : {};
        if (typeof properties.sheetId !== "number" || properties.title !== args.title)
          throw new Error("Missing added worksheet acknowledgement");
        return {
          result,
          worksheet: properties,
          outcome: "succeeded",
          atomicVersionPrecondition: false,
        };
      },
      (output) => ({
        spreadsheetId: args.spreadsheetId,
        sheetId: object(output.worksheet).sheetId,
        atomicVersionPrecondition: false,
      }),
    ),
  "sheets.worksheets.update": (args, context) =>
    workspaceWrite(
      "sheets.worksheets.update",
      args,
      context,
      async () => {
        await workspaceFile(context, args.spreadsheetId, WRITE_SCOPES);
        const current = await spreadsheet(args, context);
        const found = (current.sheets as Obj[])
          .map((sheet) => object(sheet.properties))
          .find((sheet) => sheet.sheetId === args.sheetId);
        if (!found || found.title !== args.expectedTitle)
          throw new NativeActionError(
            "version_conflict",
            "The worksheet identity or title changed.",
          );
        return {
          method: "POST",
          path: `${bookPath(args)}:batchUpdate`,
          body: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: args.sheetId, title: args.title },
                  fields: "title",
                },
              },
            ],
          },
        };
      },
      (value) => {
        const result = identity(value, "spreadsheetId", args.spreadsheetId);
        if (!Array.isArray(result.replies) || result.replies.length !== 1)
          throw new Error("Missing worksheet update acknowledgement");
        return { result, outcome: "succeeded", atomicVersionPrecondition: false };
      },
      () => ({
        spreadsheetId: args.spreadsheetId,
        sheetId: args.sheetId,
        atomicVersionPrecondition: false,
      }),
    ),
};
export const sheetsActions = workspaceActions(contract, implementations);
export const SHEETS_ACTIONS = sheetsActions;
export const sheetsContractVersion = contract.frozenAt;
