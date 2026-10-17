import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it as test } from "vitest";
import { createNotionActions } from "./notion.js";

type Data = Record<string, any>;
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const S = "33333333-3333-4333-8333-333333333333",
  D = "44444444-4444-4444-8444-444444444444",
  R = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const before = {
  object: "data_source",
  id: S,
  parent: { type: "database_id", database_id: D },
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Target: { id: "target", name: "Target", type: "checkbox", checkbox: {} },
  },
};
async function execute(module: Data, op: "add" | "change_type", wanted: Data, actual: Data) {
  const after = structuredClone(before) as Data;
  const propertyName = op === "add" ? "New" : "Target";
  after.properties[propertyName] = {
    id: op === "add" ? "new" : "target",
    name: propertyName,
    ...actual,
  };
  const mutation =
    op === "add"
      ? { op, definition: { name: propertyName, schema: wanted } }
      : { op, property_id: "target", target_schema: wanted };
  let sourceReads = 0;
  const calls: Data[] = [];
  const context = {
    operationId: "synthetic_schema_fix",
    signal: new AbortController().signal,
    principal: {
      subject: "synthetic_bot",
      tenant: "synthetic_workspace",
      capabilities: ["read_content", "update_content"],
      scopes: [],
      knowledgeBaseIds: [],
      context: {},
    },
    checkpoint: async () => {},
    readArtifact: async () => {
      throw Error("Not used");
    },
    callMcp: async () => {
      throw Error("Not used");
    },
    validateResourceUrl: async () => {},
    request: async (request: Data) => {
      calls.push(structuredClone(request));
      if (request.path === `/v1/data_sources/${R}`)
        return { status: 200, body: { ...before, id: R }, headers: new Headers() };
      if (request.path === `/v1/databases/${D}`)
        return {
          status: 200,
          body: { object: "database", id: D, data_sources: [{ id: R }] },
          headers: new Headers(),
        };
      assert.equal(request.path, `/v1/data_sources/${S}`);
      if (request.method === "PATCH") {
        const key = op === "add" ? "New" : "target";
        assert.deepEqual(Object.keys(request.body), ["properties"]);
        assert.deepEqual(Object.keys(request.body.properties), [key]);
        return { status: 200, body: after, headers: new Headers() };
      }
      assert.equal(request.method, "GET");
      return { status: 200, body: sourceReads++ === 0 ? before : after, headers: new Headers() };
    },
  };
  const action = module
    .createNotionActions()
    .find((entry: Data) => entry.id === "notion.data_sources.update_schema");
  const output = await action.execute(
    {
      data_source_id: S,
      expected_schema_sha256: hash(canonical(before.properties)),
      mutations: [mutation],
    },
    context,
  );
  assert.equal(calls.filter((request) => request.method === "PATCH").length, 1);
  return output;
}

for (const op of ["add", "change_type"] as const) {
  for (const [name, wanted, actual, matches] of [
    [
      "number format mismatch",
      { kind: "number", number_format: "dollar" },
      { type: "number", number: { format: "euro" } },
      false,
    ],
    [
      "number format exact",
      { kind: "number", number_format: "dollar" },
      { type: "number", number: { format: "dollar" } },
      true,
    ],
    [
      "select options mismatch",
      { kind: "select", options: [{ name: "Wanted" }] },
      {
        type: "select",
        select: { options: [{ id: "generated", name: "Different", color: "blue" }] },
      },
      false,
    ],
    [
      "multi-select options exact with generated IDs and colors",
      { kind: "multi_select", options: [{ name: "B" }, { name: "A" }] },
      {
        type: "multi_select",
        multi_select: {
          options: [
            { id: "a", name: "A", color: "blue" },
            { id: "b", name: "B", color: "red" },
          ],
        },
      },
      true,
    ],
    [
      "relation destination mismatch",
      { kind: "relation", relation_type: "single_property", data_source_id: R },
      {
        type: "relation",
        relation: { data_source_id: S, type: "single_property", single_property: {} },
      },
      false,
    ],
    [
      "relation shape mismatch",
      { kind: "relation", relation_type: "single_property", data_source_id: R },
      {
        type: "relation",
        relation: { data_source_id: R, type: "dual_property", dual_property: {} },
      },
      false,
    ],
    [
      "relation exact",
      { kind: "relation", relation_type: "single_property", data_source_id: R },
      {
        type: "relation",
        relation: { data_source_id: R, type: "single_property", single_property: {} },
      },
      true,
    ],
  ] as const)
    test(`${op}: ${name}`, async () => {
      const output = await execute({ createNotionActions }, op, wanted, actual);
      assert.equal(output.write_outcome, "confirmed");
      assert.equal(output.readback_verified, matches);
      assert.equal(output.complete, matches);
      assert.deepEqual(
        output.incomplete_reasons,
        matches ? [] : ["SCHEMA_READBACK_INCOMPLETE_OR_CHANGED"],
      );
    });
}
