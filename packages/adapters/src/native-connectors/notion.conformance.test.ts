import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it as test } from "vitest";
import { type NativeActionContext, NativeActionError, type NativeRequest } from "./action.js";
import { notionActions } from "./notion.js";
import { validateNativeInput } from "./validation.js";

type Data = Record<string, any>;
const frozen = JSON.parse(
  readFileSync(new URL("./notion.test-fixtures.json", import.meta.url), "utf8"),
) as Data;
const copy = <T>(value: T): T => structuredClone(value);
const json = (value: any) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const P = "11111111-1111-4111-8111-111111111111",
  S = "33333333-3333-4333-8333-333333333333",
  U = "99999999-9999-4999-8999-999999999999";
const definition = (id: string) => frozen.actions.find((item: Data) => item.id === id)!;
const fixture = (id: string, name?: string) =>
  copy(
    name
      ? definition(id).fixtures.find((item: Data) => item.id === name)!
      : definition(id).fixtures[0],
  );
const action = (id: string) => notionActions.find((item) => item.id === id)!;
const status = (body: any, code = 200) => ({
  status: code,
  body: copy(body),
  headers: new Headers(),
});
const baseline = frozen.actions
  .flatMap((item: Data) => item.fixtures[0].upstream)
  .filter((item: Data) => item.request.method === "GET");
const basePage = baseline.find((item: Data) => item.request.path === `/v1/pages/${P}`).response
  .body;
const baseSource = baseline.find((item: Data) => item.request.path === `/v1/data_sources/${S}`)
  .response.body;
const cap = [
  "read_content",
  "insert_content",
  "update_content",
  "read_comments",
  "insert_comments",
];
function context(
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
) {
  const checkpoints: Data[] = [];
  const context: NativeActionContext = {
    operationId: "effect_synthetic_test",
    signal: new AbortController().signal,
    principal: {
      subject: "bot_synthetic_test",
      tenant: "workspace_synthetic_test",
      capabilities: cap,
      scopes: [],
      knowledgeBaseIds: [],
      context: {},
    },
    request,
    checkpoint: async (receipt) => {
      checkpoints.push(copy(receipt));
    },
    readArtifact: async () => ({
      bytes: new TextEncoder().encode("Synthetic connector fixture.\n"),
      name: "synthetic-report.txt",
      mimeType: "text/plain",
    }),
    validateResourceUrl: async (url) => {
      assert.equal(new URL(url).protocol, "https:");
    },
    callMcp: async () => {
      throw Error("REST actions must not use MCP.");
    },
    ...extra,
  };
  return { context, checkpoints };
}
async function wireEquals(actual: NativeRequest, expected: Data) {
  assert.equal(actual.method, expected.method);
  assert.equal(actual.path, expected.path);
  assert.deepEqual(json(actual.query ?? {}), expected.query ?? {});
  assert.deepEqual(actual.headers, expected.headers);
  assert.ok(
    !Object.keys(actual.headers ?? {}).some(
      (key) => key.toLowerCase() === "authorization" || key.toLowerCase() === "if-match",
    ),
  );
  if (expected.bodyEncoding) {
    assert.ok(actual.body instanceof FormData);
    const form = actual.body as FormData;
    assert.equal(form.get("part_number"), expected.body.part_number ?? null);
    assert.deepEqual(
      [...form.keys()].sort(),
      expected.body.part_number ? ["file", "part_number"] : ["file"],
    );
    const file = form.get("file") as File;
    assert.equal(file.name, expected.body.file.filename);
    assert.equal(file.type, expected.body.file.content_type);
    const bytes = new Uint8Array(await file.arrayBuffer()),
      spec = expected.body.file;
    const intended =
      spec.synthetic_utf8_bytes !== undefined
        ? new TextEncoder().encode(spec.synthetic_utf8_bytes)
        : new Uint8Array(spec.synthetic_bytes.byte_length).fill(
            spec.synthetic_bytes.value.charCodeAt(0),
          );
    assert.equal(bytes.length, intended.length);
    assert.equal(digest(bytes), digest(intended));
  } else assert.deepEqual(json(actual.body), expected.body);
}
/** Frozen wire steps remain exact and ordered. Extra authority/preflight GETs are explicitly supplied separately. */
function player(
  id: string,
  name?: string,
  options: {
    recovery?: Data;
    intercept?: (request: NativeRequest, index: number) => any;
    principal?: NativeActionContext["principal"];
  } = {},
) {
  const f = fixture(id, name),
    calls: NativeRequest[] = [];
  let index = 0;
  // The recovery fixture omits the optional provider default; the adapter sends that same false value explicitly.
  if (name === "recover_committed_database") f.upstream[0].request.body.is_inline = false;
  const extraReads: NativeRequest[] = [];
  const configured = [
    ...f.upstream.filter((item: Data) => item.request.method === "GET"),
    ...baseline,
  ];
  const { context: ctx, checkpoints } = context(
    async (request) => {
      calls.push(request);
      if (options.intercept) {
        const result = await options.intercept(request, index);
        if (result !== undefined) return result;
      }
      const expected = f.upstream[index];
      if (
        expected &&
        request.method === expected.request.method &&
        request.path === expected.request.path
      ) {
        await wireEquals(request, expected.request);
        index++;
        return { ...copy(expected.response), headers: new Headers(expected.response.headers) };
      }
      assert.equal(
        request.method,
        "GET",
        `Unexpected write ${request.method} ${request.path}; next frozen step ${expected?.request.method} ${expected?.request.path}`,
      );
      extraReads.push(request);
      if (request.path === "/v1/users/me")
        return status({
          object: "user",
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "bot",
          bot: { workspace_limits: { max_file_upload_size_in_bytes: 5 * 1024 ** 3 } },
        });
      const known = configured.find((item: Data) => item.request.path === request.path);
      if (known) return { ...copy(known.response), headers: new Headers(known.response.headers) };
      throw Error(`No explicit authority fixture for ${request.path}`);
    },
    {
      ...(options.recovery ? { recovery: options.recovery } : {}),
      ...(options.principal ? { principal: options.principal } : {}),
      ...(f.context.artifact?.byte_generator
        ? {
            readArtifact: async () => ({
              bytes: new Uint8Array(f.context.artifact.byte_length).fill(65),
              name: f.input.filename,
              mimeType: f.input.content_type,
            }),
          }
        : {}),
    },
  );
  return {
    f,
    calls,
    extraReads,
    context: ctx,
    checkpoints,
    execute: () => action(id).execute(f.input, ctx),
    finished: () =>
      assert.equal(index, f.upstream.length, `Not all frozen wire steps used in ${id}/${f.id}`),
  };
}
const isKind = (kind: string) => (error: any) =>
  error instanceof NativeActionError && error.kind === kind;

for (const def of frozen.actions)
  test(`${def.id}: exact frozen successful HTTP translation plus explicit authority reads`, async () => {
    const p = player(def.id);
    const result = (await p.execute()) as Data;
    p.finished();
    if (!def.readOnly) assert.equal(result.write_outcome, "confirmed");
    if (def.readOnly) assert.equal(typeof result.complete, "boolean");
    assert.ok(p.calls.length >= p.f.upstream.length);
    assert.ok(
      p.calls.every((request) => request.path.startsWith("/v1/") && !request.path.includes("://")),
    );
  });

test("all 18 schemas reject root and nested caller authentication fields before HTTP", async () => {
  assert.equal(notionActions.length, 18);
  assert.equal(new Set(notionActions.map((item) => item.id)).size, 18);
  for (const def of frozen.actions) {
    let requests = 0;
    const { context: ctx } = context(async () => {
      requests++;
      throw Error("must not dispatch");
    });
    await assert.rejects(
      action(def.id).execute(
        { ...def.fixtures[0].input, access_token: "synthetic-forbidden" },
        ctx,
      ),
      isKind("invalid_input"),
    );
    const first = copy(def.fixtures[0].input),
      nested = Object.values(first).find(
        (value) => value && typeof value === "object" && !Array.isArray(value),
      );
    if (nested) {
      (nested as Data).Authorization = "synthetic-forbidden";
      await assert.rejects(action(def.id).execute(first, ctx), isKind("invalid_input"));
    }
    assert.equal(requests, 0);
  }
});

test("all 18 actions require their actual capabilities, including upload target branch", async () => {
  for (const def of frozen.actions) {
    const p = player(def.id);
    p.context.principal.capabilities = [];
    await assert.rejects(p.execute(), isKind("insufficient_scope"));
    assert.equal(p.calls.length, 0);
  }
  const p = player("notion.files.upload", "attach_to_files_property_preserves_existing");
  p.context.principal.capabilities = ["read_content", "insert_content"];
  await assert.rejects(p.execute(), isKind("insufficient_scope"));
  assert.equal(p.calls.length, 0);
});

for (const [id, name, kind] of [
  ["notion.pages.update_properties", "stale_local_precheck", "version_conflict"],
  ["notion.blocks.update", "reject_changed_block_type", "invalid_input"],
  ["notion.data_sources.query", "nested_leaf_schema_change_stops_query", "invalid_input"],
  ["notion.data_sources.update_schema", "reject_title_removal", "invalid_input"],
] as const)
  test(`${id}: ${name} refuses mutation`, async () => {
    const p = player(id, name);
    await assert.rejects(p.execute(), isKind(kind));
    assert.ok(p.calls.every((request) => request.method === "GET"));
    p.finished();
  });

for (const name of [
  "insert_into_empty_page_start",
  "insert_into_empty_page_end",
  "insert_after_verified_selection",
  "partial_match_warning_is_not_all_done",
])
  test(`Markdown ${name}: exact request and honest output`, async () => {
    const p = player("notion.pages.update_content", name);
    const result = (await p.execute()) as Data;
    p.finished();
    if (name.includes("warning")) {
      assert.equal(result.complete, false);
      assert.equal(result.all_edits_applied, false);
      assert.ok(result.warnings.length);
    } else assert.equal(result.complete, true);
  });

test("nested and/or filters preserve exact logical grouping; query cap stays incomplete", async () => {
  const p = player("notion.data_sources.query", "nested_typed_and_or_preserved");
  await p.execute();
  p.finished();
  const q = player("notion.data_sources.query", "native_query_cap_is_not_complete");
  const output = (await q.execute()) as Data;
  q.finished();
  assert.equal(output.complete, false);
});

test("property request budget exposes a cursor rather than claiming complete properties", async () => {
  const p = player("notion.pages.get", "property_budget_exhausted");
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.properties_complete, false);
  assert.ok(output.property_cursors.length);
});

test("block read recursively walks children with precise frozen cursors", async () => {
  const p = player("notion.pages.read_content", "recursive_blocks");
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.blocks.length, 2);
});

test("provider child-content protection is preserved with allow_deleting_content=false", async () => {
  const p = player("notion.pages.update_content", "protected_child_refuses_deletion");
  await assert.rejects(p.execute(), isKind("invalid_input"));
  p.finished();
  assert.equal(
    (p.calls.find((request) => request.method === "PATCH")!.body as Data).update_content
      .allow_deleting_content,
    false,
  );
});

test("database inaccessible child schema is reported as partial", async () => {
  const p = player("notion.databases.get", "source_access_failure_is_partial");
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.complete, false);
  assert.ok(output.schema_errors.length);
});

test("discussion reply verifies the exact discussion under its anchor", async () => {
  const p = player("notion.comments.create", "reply_verified_discussion");
  await p.execute();
  p.finished();
});

for (const [id, name] of [
  ["notion.blocks.append", "recover_committed_append_by_ids"],
  ["notion.databases.create", "recover_committed_database"],
] as const)
  test(`${id}: 503 exact committed IDs reconcile without duplicate write`, async () => {
    const p = player(id, name);
    const output = (await p.execute()) as Data;
    p.finished();
    assert.equal(output.write_outcome, "confirmed");
    assert.equal(p.calls.filter((request) => request.method !== "GET").length, 1);
  });

test("multipart sends deterministic 10/10/1 MiB parts as real FormData and checkpoints every exact ACK", async () => {
  const p = player("notion.files.upload", "multipart_create_send_complete_attach");
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.upload_mode, "multi_part");
  assert.equal(output.number_of_parts, 3);
  assert.deepEqual(output.acknowledged_part_numbers, [1, 2, 3]);
  assert.equal(p.calls.filter((request) => request.path.endsWith("/complete")).length, 1);
  assert.equal(p.calls.find((request) => request.path.endsWith("/complete"))!.body, undefined);
  for (const number of [1, 2, 3]) {
    const before = p.checkpoints.find(
      (receipt) =>
        receipt.stage === `send_part_${number}` &&
        receipt.upload.parts[number - 1].dispatch_state === "in_flight",
    );
    const ack = p.checkpoints.find(
      (receipt) =>
        receipt.stage === `send_part_${number}` &&
        receipt.upload.parts[number - 1].dispatch_state === "acknowledged",
    );
    assert.ok(before);
    assert.ok(ack);
    assert.equal(before.upload_id, U);
    assert.equal(ack.upload_id, U);
    assert.equal(ack.upload.parts[number - 1].part_number, number);
  }
  assert.ok(
    p.checkpoints.some((receipt) => receipt.upload_id === U && receipt.stage === "create_upload"),
  );
  assert.ok(p.checkpoints.some((receipt) => receipt.complete_state === "acknowledged"));
  assert.ok(p.checkpoints.some((receipt) => receipt.attachment_state === "confirmed"));
});

async function checkpointAfterPart2() {
  const p = player("notion.files.upload", "multipart_create_send_complete_attach");
  p.f.input.transfer_mode = "auto";
  await p.execute();
  return copy(
    p.checkpoints.find(
      (receipt) =>
        receipt.stage === "send_part_2" &&
        receipt.upload.parts[1].dispatch_state === "acknowledged",
    )!,
  );
}

test("multipart resumes only a definitely never-dispatched tail from its immutable receipt", async () => {
  const receipt = await checkpointAfterPart2();
  const p = player("notion.files.upload", "multipart_resume_only_definitely_unsent_tail", {
    recovery: receipt,
  });
  const output = (await p.execute()) as Data;
  p.finished();
  assert.deepEqual(output.acknowledged_part_numbers, [1, 2, 3]);
  assert.equal(p.calls.filter((request) => request.path === "/v1/file_uploads").length, 0);
  assert.deepEqual(
    p.calls
      .filter((request) => request.path.endsWith("/send"))
      .map((request) => (request.body as FormData).get("part_number")),
    ["3"],
  );
});

test("aggregate sent count cannot resolve an unknown exact part; no resend, complete or replacement", async () => {
  const receipt = await checkpointAfterPart2();
  receipt.upload.parts[1].dispatch_state = "outcome_unknown";
  const p = player("notion.files.upload", "multipart_uncertain_part_no_guess_or_resend", {
    recovery: receipt,
  });
  await assert.rejects(
    p.execute(),
    (error: any) =>
      isKind("result_unknown")(error) &&
      error.options.recovery.reason === "UPLOAD_PART_OUTCOME_UNKNOWN",
  );
  p.finished();
  assert.ok(p.calls.every((request) => request.method === "GET"));
});

test("lost complete response resumes via uploaded lifecycle proof without replaying complete", async () => {
  const receipt = await checkpointAfterPart2();
  receipt.upload.parts[2].dispatch_state = "acknowledged";
  receipt.stage = "complete_upload";
  receipt.complete_state = "in_flight";
  const p = player("notion.files.upload", "multipart_complete_response_lost_uploaded_recovery", {
    recovery: receipt,
  });
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.attached, true);
  assert.equal(
    p.calls.filter(
      (request) =>
        request.path.endsWith("/send") ||
        request.path.endsWith("/complete") ||
        request.path === "/v1/file_uploads",
    ).length,
    0,
  );
});

test("pending lifecycle cannot resolve a lost complete response; do not repeat complete", async () => {
  const receipt = await checkpointAfterPart2();
  receipt.upload.parts[2].dispatch_state = "acknowledged";
  receipt.stage = "complete_upload";
  receipt.complete_state = "in_flight";
  const p = player("notion.files.upload", "multipart_complete_pending_remains_unknown", {
    recovery: receipt,
  });
  await assert.rejects(
    p.execute(),
    (error: any) =>
      isKind("result_unknown")(error) &&
      error.options.recovery.reason === "UPLOAD_COMPLETION_OUTCOME_UNKNOWN",
  );
  p.finished();
  assert.ok(p.calls.every((request) => request.method === "GET"));
});

test("provider complete rechecks actual workspace size; no attachment on rejection", async () => {
  const p = player("notion.files.upload", "multipart_complete_rechecks_workspace_limit");
  await assert.rejects(p.execute(), isKind("invalid_input"));
  p.finished();
  assert.equal(p.calls.filter((request) => request.path.endsWith("/children")).length, 0);
});

test("files-property upload preserves every existing entry and updates only that property", async () => {
  const p = player("notion.files.upload", "attach_to_files_property_preserves_existing");
  const output = (await p.execute()) as Data;
  p.finished();
  assert.equal(output.attached, true);
  assert.equal(output.readback_verified, true);
  const patch = p.calls.find((request) => request.method === "PATCH")!.body as Data;
  assert.deepEqual(Object.keys(patch.properties), ["files"]);
  assert.equal(patch.properties.files.files[0].name, "existing-fixture.txt");
  assert.equal(patch.properties.files.files[1].file_upload.id, U);
});

test("files-property lost response with a matching filename remains unknown and cannot replay", async () => {
  const success = player("notion.files.upload", "attach_to_files_property_preserves_existing");
  await success.execute();
  const receipt = copy(
    success.checkpoints.find(
      (item) => item.stage === "attach_files" && item.attachment_state === "in_flight",
    )!,
  );
  const p = player("notion.files.upload", "files_property_lost_response_same_name_not_proof", {
    recovery: receipt,
  });
  await assert.rejects(
    p.execute(),
    (error: any) =>
      isKind("result_unknown")(error) && error.options.recovery.filename_match_is_proof === false,
  );
  p.finished();
  assert.ok(p.calls.every((request) => request.method === "GET"));
});

test("upload rejects an inaccessible artifact before remote calls and actual workspace/MIME mismatch before create", async () => {
  const input = fixture("notion.files.upload").input;
  let remote = 0;
  const blocked = context(
    async () => {
      remote++;
      return status({});
    },
    {
      readArtifact: async () => {
        throw new NativeActionError("resource_unavailable", "Synthetic inaccessible artifact");
      },
    },
  );
  await assert.rejects(
    action("notion.files.upload").execute(input, blocked.context),
    isKind("resource_unavailable"),
  );
  assert.equal(remote, 0);
  const mismatch = context(
    async () => {
      remote++;
      return status({});
    },
    {
      readArtifact: async () => ({
        bytes: new Uint8Array([1]),
        name: input.filename,
        mimeType: "application/pdf",
      }),
    },
  );
  await assert.rejects(
    action("notion.files.upload").execute(input, mismatch.context),
    isKind("invalid_input"),
  );
  assert.equal(remote, 0);
  const over = context(async (request) => {
    remote++;
    assert.equal(request.path, "/v1/users/me");
    return status({ bot: { workspace_limits: { max_file_upload_size_in_bytes: 1 } } });
  });
  await assert.rejects(
    action("notion.files.upload").execute(input, over.context),
    isKind("invalid_input"),
  );
  assert.equal(remote, 1);
});

test("immutable upload recovery binds input, principal, artifact bytes and segment hashes", async () => {
  const receipt = await checkpointAfterPart2();
  const p = player("notion.files.upload", "multipart_resume_only_definitely_unsent_tail", {
    recovery: receipt,
  });
  p.f.input.filename = "changed.txt";
  await assert.rejects(p.execute(), isKind("invalid_input"));
  assert.equal(p.calls.length, 0);
  const p2 = player("notion.files.upload", "multipart_resume_only_definitely_unsent_tail", {
    recovery: receipt,
  });
  p2.context.principal.subject = "different-bot";
  await assert.rejects(p2.execute(), isKind("invalid_input"));
  assert.equal(p2.calls.length, 0);
  const p3 = player("notion.files.upload", "multipart_resume_only_definitely_unsent_tail", {
    recovery: receipt,
  });
  p3.context.readArtifact = async () => ({
    bytes: new Uint8Array(21 * 1024 ** 2).fill(66),
    name: "synthetic-large.txt",
    mimeType: "text/plain",
  });
  await assert.rejects(p3.execute(), isKind("invalid_input"));
  assert.equal(p3.calls.length, 0);
});

test("a checkpoint failure before dispatch sends no write", async () => {
  const p = player("notion.pages.create");
  p.context.checkpoint = async () => {
    throw Error("synthetic fence lost");
  };
  await assert.rejects(p.execute(), isKind("temporarily_unavailable"));
  assert.equal(p.calls.filter((request) => request.method !== "GET").length, 0);
});

test("lost create/comment result is never replayed by the same persisted effect", async () => {
  for (const id of ["notion.pages.create", "notion.comments.create"]) {
    const p = player(id, undefined, {
      intercept: async (request) => {
        if (request.method === "POST") throw Error("synthetic response lost");
      },
    });
    let unknown: any;
    try {
      await p.execute();
    } catch (error) {
      unknown = error;
    }
    assert.ok(isKind("result_unknown")(unknown));
    const last = p.checkpoints.at(-1)!;
    assert.equal(last.write_state, "in_flight");
    const retried = player(id, undefined, { recovery: last });
    await assert.rejects(retried.execute(), isKind("result_unknown"));
    assert.equal(retried.calls.length, 0);
  }
});

test("trash readback 404 is never proof of deletion after a lost DELETE response", async () => {
  const p = player("notion.blocks.set_trash", undefined, {
    intercept: async (request) => {
      if (request.method === "DELETE") throw Error("synthetic response lost");
      if (request.method === "GET" && p.calls.some((item) => item.method === "DELETE"))
        return status({ code: "object_not_found", message: "Synthetic hidden resource" }, 404);
    },
  });
  await assert.rejects(
    p.execute(),
    (error: any) => isKind("resource_unavailable")(error) || isKind("result_unknown")(error),
  );
  assert.equal(p.calls.filter((request) => request.method === "DELETE").length, 1);
});

test("malformed pagination metadata fails rather than claiming cursor exhaustion", async () => {
  const { context: ctx } = context(async () =>
    status({ object: "list", results: [], has_more: true, next_cursor: null }),
  );
  await assert.rejects(action("notion.search").execute({}, ctx), isKind("incomplete_response"));
});

test("unknown property type fails authority validation before PATCH", async () => {
  const input = fixture("notion.pages.update_properties").input;
  const { context: ctx } = context(async (request) => {
    assert.equal(request.method, "GET");
    if (request.path === `/v1/pages/${P}`) return status(basePage);
    const changed = copy(baseSource);
    changed.properties.Done.type = "formula";
    return status(changed);
  });
  await assert.rejects(
    action("notion.pages.update_properties").execute(input, ctx),
    isKind("invalid_input"),
  );
});

for (const def of frozen.actions)
  test(`${def.id}: upstream unauthorized maps to expired authorization`, async () => {
    const p = player(def.id, "unauthorized");
    await assert.rejects(p.execute(), isKind("authorization_expired"));
    p.finished();
  });

test("an actual lost multipart send persists its exact unknown part and refuses all replay", async () => {
  const uncertain = fixture("notion.files.upload", "multipart_uncertain_part_no_guess_or_resend")
    .upstream[0].response.body;
  const p = player("notion.files.upload", "multipart_create_send_complete_attach", {
    intercept: async (request) => {
      if (request.path.endsWith("/send") && (request.body as FormData).get("part_number") === "2")
        throw Error("Synthetic lost part 2 response");
      if (request.method === "GET" && request.path === `/v1/file_uploads/${U}`)
        return status(uncertain);
    },
  });
  let caught: any;
  try {
    await p.execute();
  } catch (error) {
    caught = error;
  }
  assert.ok(isKind("result_unknown")(caught));
  assert.deepEqual(caught.options.recovery.unknown_part_numbers, [2]);
  assert.equal(p.checkpoints.at(-1)!.upload.parts[1].dispatch_state, "outcome_unknown");
  assert.equal(p.calls.filter((request) => request.path.endsWith("/send")).length, 2);
  assert.equal(p.calls.filter((request) => request.path.endsWith("/complete")).length, 0);
  const retry = player("notion.files.upload", "multipart_create_send_complete_attach", {
    recovery: p.checkpoints.at(-1),
    intercept: async (request) =>
      request.method === "GET" && request.path === `/v1/file_uploads/${U}`
        ? status(uncertain)
        : undefined,
  });
  await assert.rejects(retry.execute(), isKind("result_unknown"));
  assert.ok(retry.calls.every((request) => request.method === "GET"));
});

test("lost block attachment without committed child IDs remains unknown after upload and never appends again", async () => {
  const p = player("notion.files.upload", undefined, {
    intercept: async (request) => {
      if (request.method === "PATCH") throw Error("Synthetic attachment response lost");
    },
  });
  await assert.rejects(p.execute(), isKind("result_unknown"));
  assert.equal(p.calls.filter((request) => request.method === "PATCH").length, 1);
  const retry = player("notion.files.upload", undefined, { recovery: p.checkpoints.at(-1) });
  await assert.rejects(retry.execute(), isKind("result_unknown"));
  assert.ok(retry.calls.every((request) => request.method === "GET"));
});

test("schema mutation readback mismatch stays partial instead of declaring verification", async () => {
  const p = player("notion.data_sources.update_schema");
  p.f.upstream.at(-1).response.body = copy(baseSource);
  const result = (await p.execute()) as Data;
  p.finished();
  assert.equal(result.write_outcome, "confirmed");
  assert.equal(result.readback_verified, false);
  assert.equal(result.complete, false);
});

test("typed relation refuses a page from a different authoritative destination", async () => {
  const input = fixture("notion.pages.update_properties").input;
  input.mutations = [
    {
      property_id: "rel",
      kind: "relation",
      page_ids: ["22222222-2222-4222-8222-222222222222"],
      mode: "replace",
    },
  ];
  const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const source = copy(baseSource);
  source.properties.Related = {
    id: "rel",
    name: "Related",
    type: "relation",
    relation: { data_source_id: target },
  };
  const { context: ctx } = context(async (request) => {
    assert.equal(request.method, "GET");
    if (request.path === `/v1/pages/${P}`) return status(basePage);
    if (request.path === `/v1/data_sources/${S}`) return status(source);
    if (request.path === `/v1/data_sources/${target}`) return status({ ...baseSource, id: target });
    if (request.path.startsWith("/v1/databases/"))
      return status(fixture("notion.databases.get").upstream[0].response.body);
    return status({ ...basePage, id: "22222222-2222-4222-8222-222222222222" });
  });
  await assert.rejects(
    action("notion.pages.update_properties").execute(input, ctx),
    isKind("invalid_input"),
  );
});

test("durable completed write ACKs survive later resource changes without replay or false latest snapshot claims", async () => {
  for (const id of [
    "notion.pages.create",
    "notion.blocks.append",
    "notion.comments.create",
    "notion.files.upload",
  ]) {
    const p = player(id);
    await p.execute();
    const receipt = p.checkpoints.at(-1)!;
    assert.equal(receipt.action_complete, true);
    const retry = player(id, undefined, { recovery: receipt });
    retry.context.request = async () => {
      throw Error("Must not need a fresh remote snapshot to preserve a committed ACK");
    };
    retry.context.readArtifact = async () => {
      throw Error("Committed upload must not require the old artifact again");
    };
    const output = (await retry.execute()) as Data;
    assert.equal(output.write_outcome, "confirmed");
    assert.equal(output.acknowledged, true);
    assert.equal(output.resource_snapshot_current, false);
    assert.equal(output.complete, false);
  }
});

test("durable Markdown partial ACK stays partial on replay", async () => {
  const p = player("notion.pages.update_content", "partial_match_warning_is_not_all_done");
  const original = (await p.execute()) as Data;
  assert.equal(original.write_outcome, "partial");
  const retry = player("notion.pages.update_content", "partial_match_warning_is_not_all_done", {
    recovery: p.checkpoints.at(-1),
  });
  const output = (await retry.execute()) as Data;
  assert.equal(output.write_outcome, "partial");
  assert.equal(output.complete, false);
  assert.equal(retry.calls.length, 0);
});

test("empty continuation and non-null terminal cursors never claim complete pagination", async () => {
  for (const page of [
    { object: "list", results: [], has_more: true, next_cursor: "" },
    { object: "list", results: [], has_more: false, next_cursor: "dangling" },
  ]) {
    const { context: ctx } = context(async () => status(page));
    await assert.rejects(action("notion.search").execute({}, ctx), isKind("incomplete_response"));
  }
});

test("every persisted multipart manifest conforms to the frozen receipt schema", async () => {
  const p = player("notion.files.upload", "multipart_create_send_complete_attach");
  await p.execute();
  const schema = definition("notion.files.upload").multipartProtocol.receiptSchema;
  for (const receipt of p.checkpoints) {
    validateNativeInput(schema, receipt.upload);
    assert.equal(receipt.upload.upload_id, receipt.upload_id ?? null);
  }
});
