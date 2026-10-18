import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it as test } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "./action.js";
import { NativeActionError } from "./action.js";
import contract from "./drive.contract.json" with { type: "json" };
import { driveActions } from "./drive.js";
import fixtures from "./drive.test-fixtures.json" with { type: "json" };
import { NativeHttpClient } from "./http.js";

type Obj = Record<string, unknown>;
const actions = new Map(driveActions.map((action) => [action.id, action]));
const scopes = (values: string[]) =>
  values.map((value) => `https://www.googleapis.com/auth/${value}`);
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): NativeResponse => ({ body: structuredClone(body), status, headers: new Headers(headers) });
const scopeContext = (context: NativeActionContext, values: string[]) => ({
  ...context,
  principal: { ...context.principal, scopes: scopes(values) },
});
function context(
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  return {
    operationId: "fixture-operation-001",
    signal: new AbortController().signal,
    principal: {
      subject: "fixture-google-sub",
      tenant: null,
      scopes: scopes(["drive.file"]),
      capabilities: [],
      knowledgeBaseIds: [],
      context: {},
    },
    checkpoint: async () => {},
    request,
    readArtifact: async () => ({
      bytes: Buffer.from("Hello"),
      name: "fixture.txt",
      mimeType: "text/plain",
    }),
    writeArtifact: async ({ bytes, name, mimeType }) => ({
      id: "artifact-fixture",
      name,
      mimeType,
      size: bytes.length,
    }),
    callMcp: async () => {
      throw new Error("Unexpected MCP");
    },
    validateResourceUrl: async () => {
      throw new Error("Unexpected URL");
    },
    ...extra,
  };
}
function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
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
const failure = (kind: string) => (error: unknown) =>
  error instanceof NativeActionError && error.kind === kind;
const row = (id: string) => fixtures.actions.find((value) => value.id === id)!;
const execute = (id: string, args: Obj, ctx: NativeActionContext) =>
  actions.get(id)!.execute(args, ctx);
function envelope(request: NativeRequest): Obj {
  if (request.body instanceof Uint8Array) {
    const { body, ...rest } = request;
    return { ...rest, bodyBase64: Buffer.from(body).toString("base64") };
  }
  return request as unknown as Obj;
}
function queue(values: (NativeResponse | Error | ((request: NativeRequest) => NativeResponse))[]) {
  const calls: NativeRequest[] = [];
  return {
    calls,
    request: async (request: NativeRequest): Promise<NativeResponse> => {
      calls.push(structuredClone(request));
      const next = values.shift();
      assert.notEqual(next, undefined, `Unexpected ${request.method} ${request.path}`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(request) : next!;
    },
  };
}
function uploadResponse(bytes: Uint8Array, id = "new-file"): NativeResponse {
  return response({
    ...fixtures.file,
    id,
    size: String(bytes.length),
    md5Checksum: createHash("md5").update(bytes).digest("hex"),
  });
}
const location = (suffix = "") =>
  response({}, 200, {
    location: `https://www.googleapis.com/upload/drive/v3/files${suffix}?uploadType=resumable&upload_id=fixture-session`,
  });

test("Drive exposes the frozen 16 IDs, scopes, schemas and effects", () => {
  assert.equal(actions.size, 16);
  assert.deepEqual(
    [...actions.keys()],
    contract.actions.map((value) => value.id),
  );
  for (const row of contract.actions) {
    const actual = actions.get(row.id)!;
    assert.deepEqual(actual.inputSchema, row.inputSchema);
    assert.deepEqual(actual.scopesAnyOf, row.authorization.acceptedAnyOfScopes);
    assert.equal(actual.readOnly, row.readOnly);
  }
});
for (const value of fixtures.actions) {
  test(`Drive frozen protocol: ${value.id}`, async () => {
    const f = value as unknown as {
      input: Obj;
      requests: Obj[];
      responses: {
        status: number;
        body?: unknown;
        headers?: Record<string, string>;
        bodyBase64?: string;
      }[];
      expectedOutput: unknown;
    };
    let at = 0;
    const checkpoints: Obj[] = [];
    const result = await execute(
      value.id,
      structuredClone(f.input),
      context(
        async (request) => {
          assert.deepEqual(envelope(request), f.requests[at]);
          const reply = f.responses[at++];
          assert.ok(reply);
          return response(
            reply.bodyBase64 === undefined ? reply.body : Buffer.from(reply.bodyBase64, "base64"),
            reply.status,
            reply.headers,
          );
        },
        {
          checkpoint: async (state) => {
            checkpoints.push(structuredClone(state));
          },
        },
      ),
    );
    assert.equal(at, f.responses.length);
    subset(f.expectedOutput, result);
    if (!actions.get(value.id)!.readOnly) {
      assert.equal(checkpoints[0]!.stage, "prepared");
      assert.equal(checkpoints.at(-1)!.stage, "committed");
    }
    assert.ok(!JSON.stringify(result).includes("fixture-session"));
  });
  test(`Drive rejects credentials in business input: ${value.id}`, async () => {
    await assert.rejects(
      execute(
        value.id,
        value.rejectedInput as Obj,
        context(async () => {
          throw new Error("Must not request");
        }),
      ),
      failure("invalid_input"),
    );
  });
}
test("Drive metadata permission does not authorize downloading content", async () => {
  await assert.rejects(
    execute(
      "drive.files.download",
      { fileId: "f1" },
      scopeContext(
        context(async () => {
          throw new Error("Must not request");
        }),
        ["drive.metadata.readonly"],
      ),
    ),
    failure("insufficient_scope"),
  );
});
test("Drive fileId alone never grants drive.file access", async () => {
  for (const grant of [["drive.file"], ["drive.file", "drive.metadata.readonly"]]) {
    const q = queue([response({ ...fixtures.file, isAppAuthorized: false })]);
    await assert.rejects(
      execute("drive.files.download", { fileId: "f1" }, scopeContext(context(q.request), grant)),
      failure("resource_unavailable"),
    );
    assert.equal(q.calls.length, 1);
  }
});
test("Drive read-wide plus drive.file cannot write an unselected file", async () => {
  const q = queue([response({ ...fixtures.file, isAppAuthorized: false })]);
  await assert.rejects(
    execute(
      "drive.files.trash",
      { fileId: "f1", expectedVersion: "7" },
      scopeContext(context(q.request), ["drive.file", "drive.readonly"]),
    ),
    failure("resource_unavailable"),
  );
  assert.equal(q.calls.length, 1);
});
test("Drive metadata-wide may read unselected metadata without claiming content access", async () => {
  const result = (await execute(
    "drive.files.get",
    { fileId: "f1" },
    scopeContext(
      context(async () => response({ ...fixtures.file, isAppAuthorized: false })),
      ["drive.metadata.readonly"],
    ),
  )) as Obj;
  assert.equal(result.id, "f1");
});
test("Drive app-authorized search keeps cursor after filtering and incompleteSearch never means complete", async () => {
  const result = (await execute(
    "drive.files.search",
    {},
    context(async () =>
      response({
        files: [{ ...fixtures.file, isAppAuthorized: false }],
        nextPageToken: "next",
        incompleteSearch: true,
      }),
    ),
  )) as Obj;
  assert.deepEqual(result.files, []);
  assert.equal(result.nextPageToken, "next");
  assert.equal(result.hasMore, true);
  assert.equal(result.allPagesRead, false);
  const incomplete = (await execute(
    "drive.files.search",
    {},
    context(async () => response({ incompleteSearch: true })),
  )) as Obj;
  assert.equal(incomplete.allPagesRead, false);
});
test("Drive refuses stale versions before any file write", async () => {
  const q = queue([response({ ...fixtures.file, version: "8" })]);
  await assert.rejects(
    execute(
      "drive.files.update_metadata",
      row("drive.files.update_metadata").input as Obj,
      context(q.request),
    ),
    failure("version_conflict"),
  );
  assert.equal(q.calls.length, 1);
});
test("Drive metadata allowlist rejects ACL/MIME/parent writes", async () => {
  for (const metadata of [
    { owners: ["other"] },
    { mimeType: "application/vnd.google-apps.document" },
    { parents: ["p2"] },
  ])
    await assert.rejects(
      execute(
        "drive.files.update_metadata",
        { fileId: "f1", expectedVersion: "7", metadata },
        context(async () => {
          throw new Error("Must not request");
        }),
      ),
      failure("invalid_input"),
    );
});
test("Drive lost copy acknowledgement cannot create a second copy", async () => {
  let receipt: Obj = {};
  const q = queue([response(fixtures.file), new Error("fixture lost acknowledgement")]);
  const ctx = context(q.request, {
    checkpoint: async (state) => {
      receipt = structuredClone(state);
    },
  });
  const args = row("drive.files.copy").input as Obj;
  await assert.rejects(execute("drive.files.copy", args, ctx), failure("result_unknown"));
  await assert.rejects(
    execute("drive.files.copy", args, { ...ctx, recovery: receipt }),
    failure("result_unknown"),
  );
  assert.equal(q.calls.length, 2);
});
test("Drive lost initiation acknowledgement never creates another upload session", async () => {
  let receipt: Obj = {};
  const q = queue([
    response({ ids: ["new-file"] }),
    new Error("fixture lost session acknowledgement"),
  ]);
  const ctx = context(q.request, {
    checkpoint: async (state) => {
      receipt = structuredClone(state);
    },
  });
  const args = row("drive.files.upload").input as Obj;
  await assert.rejects(execute("drive.files.upload", args, ctx), failure("result_unknown"));
  assert.equal(receipt.stage, "init-dispatching");
  await assert.rejects(
    execute("drive.files.upload", args, { ...ctx, recovery: receipt }),
    failure("result_unknown"),
  );
  assert.equal(q.calls.length, 2);
});
test("Drive resumes only after the same session reports confirmed bytes", async () => {
  let receipt: Obj = {};
  const first = queue([
    response({ ids: ["new-file"] }),
    location(),
    new Error("fixture lost chunk acknowledgement"),
    new Error("fixture status unavailable"),
  ]);
  const args = row("drive.files.upload").input as Obj;
  const ctx = context(first.request, {
    checkpoint: async (state) => {
      receipt = structuredClone(state);
    },
  });
  await assert.rejects(execute("drive.files.upload", args, ctx), (error) => {
    assert.ok(error instanceof NativeActionError);
    assert.equal(error.kind, "result_unknown");
    assert.ok(!JSON.stringify(error.options.recovery).includes("fixture-session"));
    return true;
  });
  const retry = queue([
    response(null, 308, { range: "bytes=0-1" }),
    (request) => {
      assert.equal(request.service, "drive-upload");
      assert.equal(request.method, "PUT");
      assert.equal(request.headers?.["Content-Range"], "bytes 2-4/5");
      assert.equal(Buffer.from(request.body as Uint8Array).toString(), "llo");
      return uploadResponse(Buffer.from("Hello"));
    },
  ]);
  const result = (await execute("drive.files.upload", args, {
    ...ctx,
    request: retry.request,
    recovery: receipt,
  })) as Obj;
  assert.equal(retry.calls.length, 2);
  assert.equal(retry.calls[0]!.headers?.["Content-Range"], "bytes */5");
  assert.equal(result.outcome, "succeeded");
});
test("Drive lost final chunk acknowledgement can reconcile a completed file without replay", async () => {
  const q = queue([
    response({ ids: ["new-file"] }),
    location(),
    new Error("fixture lost final acknowledgement"),
    uploadResponse(Buffer.from("Hello")),
  ]);
  const result = (await execute(
    "drive.files.upload",
    row("drive.files.upload").input as Obj,
    context(q.request),
  )) as Obj;
  assert.equal(result.outcome, "succeeded");
  assert.equal(q.calls.length, 4);
  assert.equal(q.calls[3]!.headers?.["Content-Range"], "bytes */5");
});
test("Drive large upload uses bounded 256KiB-multiple chunks and confirmed Range", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 7).fill(65);
  const q = queue([
    response({ ids: ["new-file"] }),
    location(),
    (request) => {
      assert.equal((request.body as Uint8Array).length, 1024 * 1024);
      assert.equal(request.headers?.["Content-Range"], `bytes 0-1048575/${bytes.length}`);
      return response(null, 308, { range: "bytes=0-1048575" });
    },
    (request) => {
      assert.equal(request.headers?.["Content-Range"], `bytes 1048576-2097151/${bytes.length}`);
      return response(null, 308, { range: "bytes=0-2097151" });
    },
    (request) => {
      assert.equal((request.body as Uint8Array).length, 7);
      assert.equal(request.headers?.["Content-Range"], `bytes 2097152-2097158/${bytes.length}`);
      return uploadResponse(bytes);
    },
  ]);
  const result = (await execute(
    "drive.files.upload",
    row("drive.files.upload").input as Obj,
    context(q.request, {
      readArtifact: async () => ({ bytes, name: "fixture.txt", mimeType: "text/plain" }),
    }),
  )) as Obj;
  assert.equal(result.outcome, "succeeded");
  assert.equal(q.calls.length, 5);
});
test("Drive expired resumable session never silently restarts", async () => {
  let receipt: Obj = {};
  const q = queue([
    response({ ids: ["new-file"] }),
    location(),
    new Error("fixture lost ACK"),
    response({}, 404),
  ]);
  await assert.rejects(
    execute(
      "drive.files.upload",
      row("drive.files.upload").input as Obj,
      context(q.request, {
        checkpoint: async (state) => {
          receipt = structuredClone(state);
        },
      }),
    ),
    failure("result_unknown"),
  );
  assert.equal(receipt.stage, "chunk-dispatching");
  assert.equal(q.calls.length, 4);
});
test("Drive rejects upload authority/path/query injection before uploading bytes", async () => {
  for (const url of [
    "https://unexpected.example.test/upload/drive/v3/files?upload_id=x",
    "http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
    "https://www.googleapis.com/upload/drive/v3/files/other?upload_id=x",
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=x&url=https://unexpected.example.test/",
    "https://www.googleapis.com/upload/drive/v3/files?upload_id=x&upload_id=y",
  ]) {
    const q = queue([response({ ids: ["new-file"] }), response({}, 200, { location: url })]);
    await assert.rejects(
      execute("drive.files.upload", row("drive.files.upload").input as Obj, context(q.request)),
      failure("result_unknown"),
    );
    assert.equal(q.calls.length, 2);
  }
});
test("Drive upload does not accept success without exact content checksum", async () => {
  const q = queue([
    response({ ids: ["new-file"] }),
    location(),
    response({ ...fixtures.file, id: "new-file", md5Checksum: "wrong" }),
  ]);
  await assert.rejects(
    execute("drive.files.upload", row("drive.files.upload").input as Obj, context(q.request)),
    failure("result_unknown"),
  );
});
test("Drive artifact changes are rejected before resuming a saved session", async () => {
  let receipt: Obj = {};
  const q = queue([
    response({ ids: ["new-file"] }),
    location(),
    new Error("lost ACK"),
    new Error("offline"),
  ]);
  const args = row("drive.files.upload").input as Obj;
  const ctx = context(q.request, {
    checkpoint: async (state) => {
      receipt = structuredClone(state);
    },
  });
  await assert.rejects(execute("drive.files.upload", args, ctx), failure("result_unknown"));
  await assert.rejects(
    execute("drive.files.upload", args, {
      ...ctx,
      recovery: receipt,
      request: async () => {
        throw new Error("Must not request");
      },
      readArtifact: async () => ({
        bytes: Buffer.from("Changed"),
        name: "fixture.txt",
        mimeType: "text/plain",
      }),
    }),
    failure("version_conflict"),
  );
});
test("Drive download/export return owner artifacts without private URLs or base64", async () => {
  const q = queue([response(fixtures.file), response(Buffer.from("Hello"))]);
  const output = await execute("drive.files.download", { fileId: "f1" }, context(q.request));
  assert.ok(!JSON.stringify(output).includes("SGVsbG8"));
  assert.ok(!JSON.stringify(output).includes("webContentLink"));
});
test("Drive oversized or corrupt binary data never becomes an artifact", async () => {
  const q = queue([response({ ...fixtures.file, size: String(11 * 1024 * 1024) })]);
  await assert.rejects(
    execute("drive.files.download", { fileId: "f1" }, context(q.request)),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 1);
  const corrupt = queue([response(fixtures.file), response(Buffer.from("Wrong"))]);
  await assert.rejects(
    execute("drive.files.download", { fileId: "f1" }, context(corrupt.request)),
    failure("incomplete_response"),
  );
});
test("Drive native document binary replacement and implicit shortcut download are rejected", async () => {
  const q = queue([
    response({ ...fixtures.file, mimeType: "application/vnd.google-apps.document" }),
  ]);
  await assert.rejects(
    execute(
      "drive.files.update_content",
      row("drive.files.update_content").input as Obj,
      context(q.request),
    ),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 1);
  await assert.rejects(
    execute(
      "drive.files.download",
      { fileId: "f1" },
      context(async () =>
        response({
          ...fixtures.file,
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutDetails: { targetId: "other" },
        }),
      ),
    ),
    failure("invalid_input"),
  );
});
test("Drive unsupported export pair fails before exporting bytes", async () => {
  const q = queue([
    response({ ...fixtures.file, mimeType: "application/vnd.google-apps.document" }),
    response({ exportFormats: { "application/vnd.google-apps.document": ["text/plain"] } }),
  ]);
  await assert.rejects(
    execute(
      "drive.files.export",
      { fileId: "f1", mimeType: "application/pdf" },
      context(q.request),
    ),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 2);
});
test("Drive public sharing requires explicit choice and never defaults to public", async () => {
  const args = {
    fileId: "f1",
    expectedVersion: "7",
    permission: { type: "anyone", role: "reader" },
    sendNotificationEmail: false,
  };
  const q = queue([response(fixtures.file)]);
  await assert.rejects(
    execute("drive.permissions.create", args, context(q.request)),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 1);
  const allowed = queue([
    response(fixtures.file),
    (request) => {
      assert.equal((request.body as Obj).type, "anyone");
      assert.equal(request.query?.sendNotificationEmail, undefined);
      return response({ id: "anyoneWithLink", type: "anyone", role: "reader" });
    },
  ]);
  const output = (await execute(
    "drive.permissions.create",
    { ...args, allowPublic: true },
    context(allowed.request),
  )) as Obj;
  assert.equal(output.outcome, "succeeded");
});
test("Drive cannot remove inherited, owner, pending owner, or own sharing", async () => {
  for (const selected of [
    { id: "permission1", type: "user", role: "owner", permissionDetails: [{ inherited: false }] },
    { id: "permission1", type: "user", role: "reader", permissionDetails: [{ inherited: true }] },
    {
      id: "permission1",
      type: "user",
      role: "reader",
      pendingOwner: true,
      permissionDetails: [{ inherited: false }],
    },
  ]) {
    const q = queue([response(fixtures.file), response(selected)]);
    await assert.rejects(
      execute(
        "drive.permissions.delete",
        row("drive.permissions.delete").input as Obj,
        context(q.request),
      ),
      failure("invalid_input"),
    );
    assert.equal(q.calls.length, 2);
  }
  const own = queue([
    response(fixtures.file),
    response({
      id: "permission1",
      type: "user",
      role: "reader",
      permissionDetails: [{ inherited: false }],
    }),
    response({ user: { permissionId: "permission1" } }),
  ]);
  await assert.rejects(
    execute(
      "drive.permissions.delete",
      row("drive.permissions.delete").input as Obj,
      context(own.request),
    ),
    failure("invalid_input"),
  );
  assert.equal(own.calls.length, 3);
});
test("Drive does not remove a sharing permission with missing inheritance evidence", async () => {
  const q = queue([
    response(fixtures.file),
    response({ id: "permission1", type: "user", role: "reader" }),
  ]);
  await assert.rejects(
    execute(
      "drive.permissions.delete",
      row("drive.permissions.delete").input as Obj,
      context(q.request),
    ),
    failure("incomplete_response"),
  );
  assert.equal(q.calls.length, 2);
});
test("Drive cross-drive moves and changed parent lists cannot dispatch", async () => {
  const q = queue([
    response(fixtures.file),
    response({ ...fixtures.parent, id: "p2", driveId: "another-drive" }),
  ]);
  await assert.rejects(
    execute("drive.files.move", row("drive.files.move").input as Obj, context(q.request)),
    failure("invalid_input"),
  );
  assert.equal(q.calls.length, 2);
  const changed = queue([response({ ...fixtures.file, parents: ["different-parent"] })]);
  await assert.rejects(
    execute("drive.files.move", row("drive.files.move").input as Obj, context(changed.request)),
    failure("version_conflict"),
  );
  assert.equal(changed.calls.length, 1);
});
test("Drive new zero-byte binary files use their pre-generated identity without an empty resumable loop", async () => {
  const q = queue([
    response({ ids: ["new-file"] }),
    (request) => {
      assert.equal(request.service, "drive");
      assert.equal(request.method, "POST");
      return uploadResponse(new Uint8Array());
    },
  ]);
  const output = (await execute(
    "drive.files.upload",
    row("drive.files.upload").input as Obj,
    context(q.request, {
      readArtifact: async () => ({
        bytes: new Uint8Array(),
        name: "fixture.txt",
        mimeType: "text/plain",
      }),
    }),
  )) as Obj;
  assert.equal(output.outcome, "succeeded");
  assert.equal(q.calls.length, 2);
});

test("Drive empty content replacement uses the official media upload endpoint and exact zero-byte acknowledgement", async () => {
  const q = queue([
    response(fixtures.file),
    (request) => {
      assert.equal(request.service, "drive-upload");
      assert.equal(request.method, "PATCH");
      assert.equal(request.path, "/files/f1");
      assert.equal(request.query?.uploadType, "media");
      assert.equal(request.headers?.["Content-Type"], "text/plain");
      assert.ok(request.body instanceof Uint8Array);
      assert.equal(request.body.length, 0);
      return uploadResponse(new Uint8Array(), "f1");
    },
  ]);
  const output = (await execute(
    "drive.files.update_content",
    row("drive.files.update_content").input as Obj,
    context(q.request, {
      readArtifact: async () => ({
        bytes: new Uint8Array(),
        name: "fixture.txt",
        mimeType: "text/plain",
      }),
    }),
  )) as Obj;
  assert.equal(output.outcome, "succeeded");
  assert.equal(q.calls.length, 2);
});
test("Drive empty media replacement with lost acknowledgement is not resent", async () => {
  let receipt: Obj = {};
  const q = queue([response(fixtures.file), new Error("lost media acknowledgement")]);
  const args = row("drive.files.update_content").input as Obj;
  const ctx = context(q.request, {
    checkpoint: async (state) => {
      receipt = structuredClone(state);
    },
    readArtifact: async () => ({
      bytes: new Uint8Array(),
      name: "fixture.txt",
      mimeType: "text/plain",
    }),
  });
  await assert.rejects(execute("drive.files.update_content", args, ctx), failure("result_unknown"));
  await assert.rejects(
    execute("drive.files.update_content", args, { ...ctx, recovery: receipt }),
    failure("result_unknown"),
  );
  assert.equal(q.calls.length, 2);
});

test("Drive resumable action traverses the real pinned HTTP boundary and receives 308 without redirecting", async () => {
  const bytes = new Uint8Array(1024 * 1024 + 5).fill(65);
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input)),
      headers = new Headers(init?.headers);
    assert.equal(init?.redirect, "manual");
    assert.equal(headers.get("authorization"), "Bearer fixture-access");
    if (calls === 1) {
      assert.equal(url.pathname, "/drive/v3/files/generateIds");
      return Response.json({ ids: ["new-file"] });
    }
    if (calls === 2) {
      assert.equal(url.pathname, "/upload/drive/v3/files");
      assert.equal(init?.method, "POST");
      return Response.json(
        {},
        {
          headers: {
            location:
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-session",
          },
        },
      );
    }
    assert.equal(url.pathname, "/upload/drive/v3/files");
    assert.equal(init?.method, "PUT");
    assert.ok(init.body instanceof Uint8Array);
    if (calls === 3) {
      assert.equal(init.body.length, 1024 * 1024);
      assert.equal(headers.get("content-range"), `bytes 0-1048575/${bytes.length}`);
      return new Response(null, {
        status: 308,
        headers: {
          range: "bytes=0-1048575",
          location: "https://unexpected.example.test/must-not-follow",
        },
      });
    }
    assert.equal(calls, 4);
    assert.equal(init.body.length, 5);
    return Response.json(uploadResponse(bytes).body);
  };
  const options = {
    readOnly: false,
    signal: new AbortController().signal,
    network: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
  };
  const credentials = async () => ({ kind: "bearer" as const, value: "fixture-access" });
  const api = new NativeHttpClient("https://www.googleapis.com/drive/v3", credentials, options);
  const upload = new NativeHttpClient("https://www.googleapis.com/upload/drive/v3", credentials, {
    ...options,
    resumableUpload: true,
  });
  try {
    const output = (await execute(
      "drive.files.upload",
      row("drive.files.upload").input as Obj,
      context((request) => (request.service === "drive-upload" ? upload : api).request(request), {
        readArtifact: async () => ({ bytes, name: "fixture.txt", mimeType: "text/plain" }),
      }),
    )) as Obj;
    assert.equal(output.outcome, "succeeded");
    assert.equal(calls, 4);
    assert.ok(!JSON.stringify(output).includes("fixture-access"));
  } finally {
    await Promise.all([api.close(), upload.close()]);
  }
});
test("Drive opaque domain sharing IDs remain opaque and are safely encoded", async () => {
  const q = queue([
    response(fixtures.file),
    response({
      id: "domain:example.test",
      type: "domain",
      role: "reader",
      permissionDetails: [{ inherited: false }],
    }),
    response({ user: { permissionId: "self-permission" } }),
    (request) => {
      assert.equal(request.path, "/files/f1/permissions/domain%3Aexample.test");
      return response(null, 204);
    },
  ]);
  const output = (await execute(
    "drive.permissions.delete",
    { fileId: "f1", expectedVersion: "7", permissionId: "domain:example.test" },
    context(q.request),
  )) as Obj;
  assert.equal(output.deleted, true);
});
