import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it as test } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { subset } from "../collaboration-conformance.js";
import { businessFilesApps } from "./index.js";
import { BUSINESS_FILES_APPS } from "./metadata.js";

interface Fixture {
  id: string;
  input: Data;
  upstream: {
    request: NativeRequest;
    response: { status: number; body: unknown; headers: Record<string, string> };
  }[];
  expectedOutput: Data;
}
const failure = (kind: string) => (error: unknown) =>
  error instanceof NativeActionError && error.kind === kind;
const decode = (value: unknown): unknown => {
  if (value && typeof value === "object" && "$bytes" in value)
    return new TextEncoder().encode(String((value as Data).$bytes));
  return value;
};
function clean(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, clean(value)]),
    );
  return value;
}
function businessContext(
  app: string,
  request: NativeActionContext["request"],
  extra: Partial<NativeActionContext> = {},
): NativeActionContext {
  const meta = BUSINESS_FILES_APPS[app as keyof typeof BUSINESS_FILES_APPS];
  return {
    operationId: "fixture-effect-001",
    signal: new AbortController().signal,
    principal: {
      subject: "user1",
      tenant: app === "hubspot" ? "hub1" : null,
      scopes: [...meta.scopes],
      capabilities: [],
      knowledgeBaseIds: [],
      context: {
        businessFilesApp: app,
        actorType: app === "hubspot" ? "app" : "user",
        credentialType: "oauth",
        configuredScopes: [...meta.scopes],
        workspaceIds: ["W1"],
        ...(app === "hubspot" ? { hubId: "hub1", hubspotAccessLevel: "account" } : {}),
      },
    },
    request,
    checkpoint: async () => {},
    callMcp: async () => {
      throw Error("Unexpected MCP");
    },
    readArtifact: async () => ({
      bytes: new TextEncoder().encode("fixture"),
      name: "fixture.txt",
      mimeType: "text/plain",
    }),
    writeArtifact: async ({ bytes, name, mimeType }) => ({
      id: "artifact-output",
      name,
      mimeType,
      size: bytes.byteLength,
    }),
    validateResourceUrl: async (url) => {
      assert.equal(new URL(url).protocol, "https:");
    },
    ...extra,
  };
}
function response(step: Fixture["upstream"][number]): NativeResponse {
  return {
    body: decode(step.response.body),
    status: step.response.status,
    headers: new Headers(step.response.headers),
  };
}
for (const app of businessFilesApps) {
  const raw = readFileSync(new URL(`./${app.slug}.contract.json`, import.meta.url));
  const contract = JSON.parse(raw.toString()) as {
    actions: { id: string; inputSchema: Data; readOnly: boolean }[];
  };
  const data = JSON.parse(
    readFileSync(new URL(`./${app.slug}.test-fixtures.json`, import.meta.url), "utf8"),
  ) as { contractSha256: string; fixtures: Fixture[] };
  test(`${app.slug} frozen contract and exact implemented action inventory`, () => {
    assert.equal(createHash("sha256").update(raw).digest("hex"), data.contractSha256);
    assert.equal(app.actions.length, contract.actions.length);
    assert.deepEqual(
      app.actions.map((x) => x.id),
      data.fixtures.map((x) => x.id),
    );
    assert.deepEqual(
      app.actions.map((x) => ({ id: x.id, readOnly: x.readOnly, inputSchema: x.inputSchema })),
      contract.actions.map((x) => ({ id: x.id, readOnly: x.readOnly, inputSchema: x.inputSchema })),
    );
  });
  for (const fixture of data.fixtures) {
    const action = app.actions.find((x) => x.id === fixture.id)!;
    test(`${fixture.id}: exact official-shaped protocol fixture`, async () => {
      let count = 0;
      const receipts: Data[] = [];
      const output = await action.execute(
        structuredClone(fixture.input),
        businessContext(
          app.slug,
          async (request) => {
            const step = fixture.upstream[count++];
            assert.ok(step, "Unexpected HTTP request");
            assert.deepEqual(
              clean(request),
              clean({
                ...step.request,
                ...(step.request.body === undefined ? {} : { body: decode(step.request.body) }),
              }),
            );
            return response(step);
          },
          {
            checkpoint: async (state) => {
              receipts.push(structuredClone(state));
            },
          },
        ),
      );
      assert.equal(count, fixture.upstream.length);
      subset(fixture.expectedOutput, output);
      if (!action.readOnly) {
        assert.ok(receipts.some((x) => x.dispatch_state === "in_flight"));
        assert.equal(receipts.at(-1)?.complete, true);
      }
    });
    test(`${fixture.id}: unknown parameters never reach HTTP`, async () => {
      for (const key of ["access_token", "accountId", "url", "apiBase", "headers", "service"]) {
        let count = 0;
        await assert.rejects(
          action.execute(
            { ...fixture.input, [key]: "forbidden" },
            businessContext(app.slug, async () => {
              count++;
              throw Error("Unexpected");
            }),
          ),
          failure("invalid_input"),
        );
        assert.equal(count, 0);
      }
    });
    test(`${fixture.id}: wrong application, actor and account fail closed`, async () => {
      const ctx = businessContext(app.slug, async () => {
        throw Error("Unexpected");
      });
      for (const context of [
        { ...ctx.principal.context, businessFilesApp: "another" },
        { ...ctx.principal.context, actorType: "bot" },
      ])
        await assert.rejects(
          action.execute(fixture.input, { ...ctx, principal: { ...ctx.principal, context } }),
          failure("authorization_required"),
        );
      await assert.rejects(
        action.execute(fixture.input, { ...ctx, principal: { ...ctx.principal, subject: "" } }),
        failure("authorization_required"),
      );
    });
    test(`${fixture.id}: HTTP failures retain their actual category`, async () => {
      const writes = !action.readOnly,
        writeIndex = fixture.upstream.findIndex(
          (x) =>
            ["POST", "PUT", "PATCH", "DELETE"].includes(x.request.method) &&
            (fixture.id !== "dropbox.files.upload" || x.request.path.endsWith("/upload")),
        );
      for (const [status, kind] of [
        [401, "authorization_expired"],
        [403, "insufficient_scope"],
        [404, "resource_unavailable"],
        [409, "version_conflict"],
        [412, "version_conflict"],
        [429, "rate_limited"],
        [503, writes ? "result_unknown" : "temporarily_unavailable"],
      ] as const) {
        let i = 0;
        const target = writes ? fixture.upstream.length - 1 : 0;
        await assert.rejects(
          action.execute(
            fixture.input,
            businessContext(app.slug, async () => {
              const step = fixture.upstream[i];
              const at = i++;
              return at === target
                ? { body: {}, status, headers: new Headers({ "retry-after": "7" }) }
                : response(step!);
            }),
          ),
          failure(kind),
        );
        assert.equal(i, target + 1);
      }
      void writeIndex;
    });
    if (!action.readOnly) {
      test(`${fixture.id}: lost write ACK cannot replay or cross account`, async () => {
        let i = 0,
          saved: Data | undefined;
        const ctx = businessContext(
          app.slug,
          async () => {
            const at = i++;
            if (at === fixture.upstream.length - 1) throw Error("Lost ACK");
            return response(fixture.upstream[at]!);
          },
          {
            checkpoint: async (state) => {
              saved = structuredClone(state);
            },
          },
        );
        await assert.rejects(action.execute(fixture.input, ctx), failure("result_unknown"));
        assert.ok(saved);
        const count = i;
        await assert.rejects(
          action.execute(fixture.input, { ...ctx, recovery: saved }),
          failure("result_unknown"),
        );
        assert.equal(i, count);
        await assert.rejects(
          action.execute(fixture.input, {
            ...ctx,
            recovery: saved,
            principal: { ...ctx.principal, subject: "other-user" },
          }),
          failure("invalid_input"),
        );
      });
      test(`${fixture.id}: exact acknowledged receipt returns identity without another write`, async () => {
        let i = 0,
          saved: Data | undefined;
        const ctx = businessContext(app.slug, async () => response(fixture.upstream[i++]!), {
          checkpoint: async (state) => {
            saved = structuredClone(state);
          },
        });
        await action.execute(fixture.input, ctx);
        assert.ok(saved);
        const restored = await action.execute(fixture.input, {
          ...ctx,
          recovery: saved,
          request: async () => {
            throw Error("Must not replay");
          },
        });
        subset({ write_outcome: "confirmed", recovered_from_exact_ack: true }, restored);
        assert.equal(i, fixture.upstream.length);
      });
    }
  }
}

test("Dropbox concrete FileMetadata/FolderMetadata succeeds without .tag; unions still require their discriminator", async () => {
  const app = businessFilesApps.find((x) => x.slug === "dropbox")!,
    fixtures = JSON.parse(
      readFileSync(new URL("./dropbox.test-fixtures.json", import.meta.url), "utf8"),
    ) as { fixtures: Fixture[] };
  for (const id of ["dropbox.files.download", "dropbox.files.upload", "dropbox.folders.create"]) {
    const fixture = fixtures.fixtures.find((x) => x.id === id)!;
    const ctx = businessContext("dropbox", async () => response(fixture.upstream[0]!));
    const result = await app.actions.find((x) => x.id === id)!.execute(fixture.input, ctx);
    assert.ok(result);
  }
  const get = app.actions.find((x) => x.id === "dropbox.files.get")!;
  await assert.rejects(
    get.execute(
      { path: "id:file1" },
      businessContext("dropbox", async () => ({
        body: { id: "id:file1", name: "Fixture" },
        status: 200,
        headers: new Headers(),
      })),
    ),
    failure("incomplete_response"),
  );
});
test("Dropbox download refuses size mismatch and upload ACK without revision stays unknown without replay", async () => {
  const app = businessFilesApps.find((x) => x.slug === "dropbox")!,
    download = app.actions.find((x) => x.id.endsWith(".download"))!,
    upload = app.actions.find((x) => x.id.endsWith(".upload"))!;
  let artifacts = 0;
  await assert.rejects(
    download.execute(
      { path: "id:file1" },
      businessContext(
        "dropbox",
        async () => ({
          status: 200,
          body: new Uint8Array([1]),
          headers: new Headers({
            "dropbox-api-result": JSON.stringify({
              id: "id:file1",
              name: "fixture",
              size: 2,
              rev: "rev1",
            }),
          }),
        }),
        {
          writeArtifact: async () => {
            artifacts++;
            throw Error("Must not persist incomplete bytes");
          },
        },
      ),
    ),
    failure("incomplete_response"),
  );
  assert.equal(artifacts, 0);
  let saved: Data | undefined,
    calls = 0;
  const ctx = businessContext(
    "dropbox",
    async () => {
      calls++;
      return {
        status: 200,
        body: { id: "id:file1", name: "fixture", size: 7 },
        headers: new Headers(),
      };
    },
    {
      checkpoint: async (state) => {
        saved = structuredClone(state);
      },
    },
  );
  await assert.rejects(
    upload.execute({ path: "/fixture.txt", artifactId: "fixture" }, ctx),
    failure("result_unknown"),
  );
  await assert.rejects(
    upload.execute({ path: "/fixture.txt", artifactId: "fixture" }, { ...ctx, recovery: saved }),
    failure("result_unknown"),
  );
  assert.equal(calls, 1);
});
test("Dropbox explicit continuation uses cursor endpoints and never mixes a new search body", async () => {
  const app = businessFilesApps.find((x) => x.slug === "dropbox")!;
  for (const [id, args, path] of [
    ["dropbox.files.list", { path: "", cursor: "cursor1" }, "/2/files/list_folder/continue"],
    [
      "dropbox.files.search",
      { query: "fixture", cursor: "cursor2" },
      "/2/files/search/continue_v2",
    ],
  ] as const) {
    const result = await app.actions
      .find((x) => x.id === id)!
      .execute(
        args,
        businessContext("dropbox", async (request) => {
          assert.equal(request.path, path);
          assert.deepEqual(request.body, { cursor: args.cursor });
          return {
            status: 200,
            body: { ...(id.endsWith("list") ? { entries: [] } : { matches: [] }), has_more: false },
            headers: new Headers(),
          };
        }),
      );
    subset({ allPagesRead: false, hasMore: false, nextCursor: null }, result);
  }
});
test("Airtable and Figma provider-enforced tokens keep configured scope ceiling", async () => {
  for (const [appId, actionId, args] of [
    [
      "airtable",
      "airtable.records.create",
      { baseId: "app1", tableId: "tbl1", fields: { Name: "New" } },
    ],
    ["figma", "figma.comments.create", { fileKey: "file", message: "Comment" }],
  ] as const) {
    const action = businessFilesApps
        .find((x) => x.slug === appId)!
        .actions.find((x) => x.id === actionId)!,
      ctx = businessContext(appId, async () => {
        throw Error("Must not request");
      });
    ctx.principal.context.scopeAuthority = "provider_enforced";
    ctx.principal.context.configuredScopes = [];
    assert.equal(action.available!(ctx.principal), false);
    await assert.rejects(action.execute(args, ctx), failure("insufficient_scope"));
  }
});
test("ClickUp stale date, Airtable stale fields and HubSpot stale timestamp cause zero remote writes", async () => {
  const cases = [
    {
      app: "clickup",
      id: "clickup.tasks.update",
      input: { taskId: "task", expectedDateUpdated: "old", changes: { name: "New" } },
      body: { id: "task", date_updated: "new" },
    },
    {
      app: "airtable",
      id: "airtable.records.update",
      input: {
        baseId: "base",
        tableId: "table",
        recordId: "record",
        expectedFields: { Name: "Old" },
        fields: { Name: "New" },
      },
      body: { id: "record", fields: { Name: "Already changed" } },
    },
    {
      app: "hubspot",
      id: "hubspot.contacts.update",
      input: { contactId: "contact", expectedUpdatedAt: "old", properties: { firstname: "New" } },
      body: { id: "contact", updatedAt: "new" },
    },
  ];
  for (const row of cases) {
    let reads = 0;
    const action = businessFilesApps
      .find((x) => x.slug === row.app)!
      .actions.find((x) => x.id === row.id)!;
    await assert.rejects(
      action.execute(
        row.input,
        businessContext(row.app, async (request) => {
          assert.equal(request.method, "GET");
          reads++;
          return { body: row.body, status: 200, headers: new Headers() };
        }),
      ),
      failure("version_conflict"),
    );
    assert.equal(reads, 1);
  }
});
test("Figma comment deletion verifies original author and scope before its DELETE", async () => {
  const action = businessFilesApps
    .find((x) => x.slug === "figma")!
    .actions.find((x) => x.id === "figma.comments.delete")!;
  let reads = 0;
  await assert.rejects(
    action.execute(
      { fileKey: "file", commentId: "comment" },
      businessContext("figma", async (request) => {
        reads++;
        assert.equal(request.method, "GET");
        return {
          body: { comments: [{ id: "comment", user: { id: "another" } }] },
          status: 200,
          headers: new Headers(),
        };
      }),
    ),
    failure("insufficient_scope"),
  );
  assert.equal(reads, 1);
});
test("Figma version cursor is data-only and cannot redirect the account bearer", async () => {
  const action = businessFilesApps
    .find((x) => x.slug === "figma")!
    .actions.find((x) => x.id === "figma.versions.list")!;
  for (const next_page of [
    "https://untrusted.example/steal?before=1",
    "https://api.figma.com/v1/files/another/versions?before=1",
    "https://api.figma.com/v1/files/file/versions?before=1&access_token=forbidden",
  ])
    await assert.rejects(
      action.execute(
        { fileKey: "file" },
        businessContext("figma", async () => ({
          body: { versions: [], pagination: { next_page } },
          status: 200,
          headers: new Headers(),
        })),
      ),
      failure("incomplete_response"),
    );
});
test("HubSpot account actor cannot claim user row permissions or cross portal metadata", async () => {
  const action = businessFilesApps.find((x) => x.slug === "hubspot")!.actions[0]!,
    ctx = businessContext("hubspot", async () => {
      throw Error("Must not request");
    });
  for (const update of [
    { hubId: "other" },
    { actorType: "user", hubspotAccessLevel: "account" },
    { actorType: "app", hubspotAccessLevel: "user" },
  ])
    await assert.rejects(
      action.execute(
        {},
        {
          ...ctx,
          principal: { ...ctx.principal, context: { ...ctx.principal.context, ...update } },
        },
      ),
      failure("authorization_required"),
    );
});
test("Write dispatch checkpoint failure prevents the request; acknowledged checkpoint failure stays unknown", async () => {
  const action = businessFilesApps
    .find((x) => x.slug === "clickup")!
    .actions.find((x) => x.id === "clickup.comments.create")!;
  let writes = 0;
  const ctx = businessContext(
    "clickup",
    async () => {
      writes++;
      return { body: { id: "comment" }, status: 200, headers: new Headers() };
    },
    {
      checkpoint: async () => {
        throw Error("Unavailable storage");
      },
    },
  );
  await assert.rejects(
    action.execute({ taskId: "task", text: "Comment" }, ctx),
    failure("temporarily_unavailable"),
  );
  assert.equal(writes, 0);
  let saved = 0;
  await assert.rejects(
    action.execute(
      { taskId: "task", text: "Comment" },
      {
        ...ctx,
        checkpoint: async () => {
          if (++saved > 1) throw Error("ACK receipt unavailable");
        },
      },
    ),
    failure("result_unknown"),
  );
  assert.equal(writes, 1);
});

test("Dropbox sharing requires explicit visibility and never retries team-only as public", async () => {
  const action = businessFilesApps
    .find((x) => x.slug === "dropbox")!
    .actions.find((x) => x.id === "dropbox.shared_links.create")!;
  let calls = 0;
  const ctx = businessContext("dropbox", async (request) => {
    calls++;
    assert.equal(
      objectForTest(request.body).settings &&
        objectForTest(objectForTest(request.body).settings).requested_visibility &&
        objectForTest(objectForTest(objectForTest(request.body).settings).requested_visibility)[
          ".tag"
        ],
      "team_only",
    );
    return { status: 409, body: { error: { ".tag": "settings_error" } }, headers: new Headers() };
  });
  await assert.rejects(action.execute({ path: "/fixture" }, ctx), failure("invalid_input"));
  assert.equal(calls, 0);
  await assert.rejects(
    action.execute({ path: "/fixture", visibility: "team_only" }, ctx),
    failure("version_conflict"),
  );
  assert.equal(calls, 1);
});
function objectForTest(value: unknown): Data {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Data;
}
test("HubSpot deal stage must belong to the real selected pipeline before any write", async () => {
  const action = businessFilesApps
    .find((x) => x.slug === "hubspot")!
    .actions.find((x) => x.id === "hubspot.deals.create")!;
  let reads = 0;
  await assert.rejects(
    action.execute(
      { properties: { dealname: "Fixture", pipeline: "pipeline1", dealstage: "invented-stage" } },
      businessContext("hubspot", async (request) => {
        reads++;
        assert.equal(request.method, "GET");
        assert.equal(request.path, "/crm/pipelines/2026-09/deals/pipeline1");
        return {
          status: 200,
          body: { id: "pipeline1", stages: [{ id: "real-stage" }] },
          headers: new Headers(),
        };
      }),
    ),
    failure("invalid_input"),
  );
  assert.equal(reads, 1);
});
test("HubSpot association requires both object write scopes and exact completed receipt", async () => {
  const action = businessFilesApps
      .find((x) => x.slug === "hubspot")!
      .actions.find((x) => x.id === "hubspot.associations.create")!,
    args = { fromType: "contacts", fromId: "contact1", toType: "companies", toId: "company1" };
  const ctx = businessContext("hubspot", async () => {
    throw Error("Must not request");
  });
  await assert.rejects(
    action.execute(args, {
      ...ctx,
      principal: { ...ctx.principal, scopes: ["crm.objects.contacts.write"] },
    }),
    failure("insufficient_scope"),
  );
  for (const result of [
    { status: "PENDING", results: [] },
    { status: "COMPLETE", numErrors: 1, results: [] },
    { status: "COMPLETE", results: [{ from: { id: "other" }, to: { id: "company1" } }] },
  ]) {
    let receipt: Data | undefined,
      calls = 0;
    const pending = businessContext(
      "hubspot",
      async () => {
        calls++;
        return { status: 200, body: result, headers: new Headers() };
      },
      {
        checkpoint: async (value) => {
          receipt = structuredClone(value);
        },
      },
    );
    await assert.rejects(action.execute(args, pending), failure("result_unknown"));
    await assert.rejects(
      action.execute(args, { ...pending, recovery: receipt }),
      failure("result_unknown"),
    );
    assert.equal(calls, 1);
  }
});
