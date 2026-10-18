import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeHttpClient } from "../http.js";
import fixtures from "./action-fixtures.json" with { type: "json" };
import { microsoftApps } from "./index.js";

const all = microsoftApps.flatMap((app) => app.actions);
const action = (id: string) => {
  const found = all.find((row) => row.id === id);
  assert.ok(found, id);
  return found;
};
function setup(values: Array<NativeResponse | Error>, extra: Partial<NativeActionContext> = {}) {
  const requests: NativeRequest[] = [],
    checkpoints: Record<string, unknown>[] = [];
  const context: NativeActionContext = {
    operationId: "fixture-operation",
    signal: AbortSignal.timeout(10000),
    principal: {
      subject: "fixture-user",
      tenant: "fixture-tenant",
      scopes: [
        ...new Set(all.flatMap((a) => a.scopesAnyOf ?? [])),
        "Files.ReadWrite",
        "Tasks.ReadWrite",
        "Calendars.ReadWrite",
        "Mail.ReadWrite",
        "Mail.Send",
        "Team.ReadBasic.All",
        "Channel.ReadBasic.All",
        "ChannelMessage.Read.All",
        "ChannelMessage.Send",
        "Chat.Read",
        "ChatMessage.Send",
        "Sites.ReadWrite.All",
      ],
      capabilities: [],
      knowledgeBaseIds: [],
      context: { actorType: "user", credentialType: "oauth", tenantId: "fixture-tenant" },
    },
    async checkpoint(state) {
      checkpoints.push(structuredClone(state));
    },
    async request(request) {
      requests.push(structuredClone(request));
      assert.ok(values.length, `Unexpected request ${request.method} ${request.path}`);
      const next = values.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    async callMcp() {
      throw new Error("No MCP");
    },
    async readArtifact() {
      return {
        bytes: new Uint8Array([1, 2, 3]),
        name: "fixture.bin",
        mimeType: "application/octet-stream",
      };
    },
    async writeArtifact(file) {
      return {
        id: "artifact-fixture",
        name: file.name,
        mimeType: file.mimeType,
        size: file.bytes.byteLength,
      };
    },
    async validateResourceUrl() {},
    ...extra,
  };
  return { context, requests, checkpoints, values };
}
const ok = (body: unknown, status = 200): NativeResponse => ({
  status,
  body,
  headers: new Headers(),
});
const args = { driveId: "drive-fixture", itemId: "book-fixture" };
describe("Microsoft protocol regression", () => {
  it("executes workbook GET and closes the same session without recursive request wrapping", async () => {
    const s = setup([
      ok({ id: "session-fixture" }, 201),
      ok({ value: [{ id: "sheet-fixture", name: "Sheet1" }] }),
      ok(null, 204),
    ]);
    const result = await action("excel.worksheets.list").execute(args, s.context);
    assert.equal((result as { items: unknown[] }).items.length, 1);
    assert.deepEqual(
      s.requests.map((r) => r.path),
      [
        "/drives/drive-fixture/items/book-fixture/workbook/createSession",
        "/drives/drive-fixture/items/book-fixture/workbook/worksheets",
        "/drives/drive-fixture/items/book-fixture/workbook/closeSession",
      ],
    );
    assert.equal(s.requests[1]?.headers?.["workbook-session-id"], "session-fixture");
    assert.equal(s.requests[2]?.headers?.["workbook-session-id"], "session-fixture");
  });
  it("validates workbook rows by index and values rather than an invented id", async () => {
    const s = setup([
      ok({ id: "session-fixture" }, 201),
      ok({ value: [{ index: 0, values: [["one", 1]] }] }),
      ok(null, 204),
    ]);
    const result = (await action("excel.rows.list").execute(
      { ...args, tableId: "table-fixture" },
      s.context,
    )) as { items: unknown[] };
    assert.deepEqual(result.items, [{ index: 0, values: [["one", 1]] }]);
  });
  for (const [id, input] of [
    ["outlook.drafts.send", { messageId: "draft-fixture" }],
    ["outlook.messages.reply", { messageId: "mail-fixture", comment: "Fixture reply" }],
    ["outlook_calendar.events.cancel", { eventId: "event-fixture" }],
  ] as const) {
    it(`${id} preserves a 202 accepted receipt and never resends the same effect`, async () => {
      const s = setup([ok(null, 202)]);
      const result = (await action(id).execute(input, s.context)) as Record<string, unknown>;
      assert.equal(result.accepted, true);
      assert.equal(result.deliveryVerified, false);
      assert.equal(result.terminalStateVerified, false);
      assert.equal(s.checkpoints.at(-1)?.complete, true);
      const replay = setup([], { recovery: s.checkpoints.at(-1) });
      const recovered = (await action(id).execute(input, replay.context)) as Record<
        string,
        unknown
      >;
      assert.equal(recovered.accepted, true);
      assert.equal(recovered.deliveryVerified, false);
      assert.equal(replay.requests.length, 0);
    });
  }
});

describe("Every frozen Microsoft provider method", () => {
  for (const fixture of fixtures) {
    it(`${fixture.id} maps the exact action to its provider method and response`, async () => {
      const s = setup(
        fixture.steps.map((step) =>
          ok(
            "bodyBytes" in step ? new Uint8Array(step.bodyBytes as number[]) : step.body,
            step.status,
          ),
        ),
        {
          downloadResource: async (input) => {
            assert.equal(input.url, "https://fixture.sharepoint.com/download?sig=fixture");
            return { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream" };
          },
        },
      );
      const result = await action(fixture.id).execute(fixture.input, s.context);
      assert.ok(result && typeof result === "object");
      assert.deepEqual(
        s.requests.map(({ method, path }) => ({ method, path })),
        fixture.steps.map(({ method, path }) => ({ method, path })),
      );
      assert.equal(s.values.length, 0);
      if (!fixture.readOnly) {
        assert.equal(s.checkpoints.at(-1)?.complete, true);
        const replay = setup([], { recovery: s.checkpoints.at(-1) });
        const recovered = (await action(fixture.id).execute(
          fixture.input,
          replay.context,
        )) as Record<string, unknown>;
        assert.equal(recovered.recovered_from_exact_ack, true);
        assert.equal(replay.requests.length, 0);
      }
    });
  }
});

describe("Microsoft action boundaries", () => {
  it("exposes exactly eight concrete action implementations for every app", () => {
    assert.equal(microsoftApps.length, 8);
    assert.equal(all.length, 64);
    assert.equal(new Set(all.map((a) => a.id)).size, 64);
    for (const app of microsoftApps) assert.equal(app.actions.length, 8);
  });
  for (const fixture of fixtures) {
    it(`${fixture.id} rejects a different actor before sending HTTP`, async () => {
      const s = setup([]);
      s.context.principal.context.actorType = "app";
      assert.equal(action(fixture.id).available?.(s.context.principal), false);
      await assert.rejects(action(fixture.id).execute(fixture.input, s.context), {
        kind: "authorization_required",
      });
      assert.equal(s.requests.length, 0);
    });
  }
  it("does not confuse Mail.ReadWrite with Mail.Send", async () => {
    const s = setup([]);
    s.context.principal.scopes = ["Mail.ReadWrite"];
    assert.equal(action("outlook.messages.get").available?.(s.context.principal), true);
    assert.equal(action("outlook.drafts.send").available?.(s.context.principal), false);
    await assert.rejects(
      action("outlook.drafts.send").execute({ messageId: "draft-fixture" }, s.context),
      { kind: "insufficient_scope" },
    );
  });
  for (const id of [
    "planner.tasks.update",
    "sharepoint.items.update",
    "onedrive.items.move",
    "outlook_calendar.events.update",
    "microsoft_todo.tasks.update",
  ]) {
    it(`${id} rejects wildcard overwrite before dispatch`, async () => {
      const fixture = fixtures.find((f) => f.id === id)!;
      const s = setup([]);
      await assert.rejects(action(id).execute({ ...fixture.input, expectedEtag: "*" }, s.context), {
        kind: "invalid_input",
      });
      assert.equal(s.requests.length, 0);
    });
  }
  it("maps Planner precondition failure to version conflict without an acknowledged receipt", async () => {
    const s = setup([ok(null, 412)]);
    await assert.rejects(
      action("planner.tasks.update").execute(
        { taskId: "task-fixture", expectedEtag: 'W/"fixture-etag"', percentComplete: 100 },
        s.context,
      ),
      { kind: "version_conflict" },
    );
    assert.notEqual(s.checkpoints.at(-1)?.complete, true);
  });
  it("refuses replay after an unacknowledged write", async () => {
    const s = setup([new Error("fixture connection reset")]);
    const input = { displayName: "Fixture" };
    await assert.rejects(action("microsoft_todo.lists.create").execute(input, s.context), {
      kind: "result_unknown",
    });
    const replay = setup([], { recovery: s.checkpoints.at(-1) });
    await assert.rejects(action("microsoft_todo.lists.create").execute(input, replay.context), {
      kind: "result_unknown",
    });
    assert.equal(replay.requests.length, 0);
  });
  for (const status of [408, 500, 503])
    it(`preserves unknown write on ${status} for mail send`, async () => {
      const s = setup([ok(null, status)]);
      await assert.rejects(
        action("outlook.drafts.send").execute({ messageId: "draft-fixture" }, s.context),
        { kind: "result_unknown" },
      );
      assert.notEqual(s.checkpoints.at(-1)?.complete, true);
    });
  it("discovers the exact current user's own drive root without guessed drive identifiers", async () => {
    const s = setup([
      ok({ value: [{ id: "root-child", parentReference: { driveId: "verified-drive-id" } }] }),
    ]);
    await action("onedrive.children.list").execute({}, s.context);
    assert.equal(s.requests[0]?.path, "/me/drive/items/root/children");
  });
  it("keeps Graph capability URLs out of metadata output", async () => {
    const s = setup([
      ok({
        id: "item-fixture",
        "@microsoft.graph.downloadUrl": "https://fixture.sharepoint.com/private?sig=fixture",
      }),
    ]);
    const output = await action("onedrive.items.get").execute(
      { itemId: "item-fixture" },
      s.context,
    );
    assert.equal(JSON.stringify(output).includes("sig="), false);
  });
  it("binds paging to the same selected collection, never an arbitrary URL", async () => {
    const s = setup([]);
    const cursor = Buffer.from("https://example.test/steal?$skiptoken=fixture").toString(
      "base64url",
    );
    await assert.rejects(action("teams.chats.list").execute({ cursor }, s.context), {
      kind: "invalid_input",
    });
    assert.equal(s.requests.length, 0);
  });
  it("retains the same account and input binding when recovering a committed receipt", async () => {
    const s = setup([ok({ id: "created-fixture" }, 201)]);
    await action("microsoft_todo.lists.create").execute({ displayName: "Fixture" }, s.context);
    const replay = setup([], { recovery: s.checkpoints.at(-1) });
    await assert.rejects(
      action("microsoft_todo.lists.create").execute({ displayName: "Changed" }, replay.context),
      { kind: "invalid_input" },
    );
    assert.equal(replay.requests.length, 0);
  });
});

describe("Microsoft attachment byte transport", () => {
  for (const size of [7, 8, 10].map((m) => m * 1024 * 1024))
    it(`downloads a ${size}-byte Outlook attachment using bounded raw bytes`, async () => {
      const calls: Array<{ url: string; authorization: string | null }> = [],
        bytes = new Uint8Array(size);
      bytes[0] = 0;
      bytes[size - 1] = 255;
      const client = new NativeHttpClient(
        "https://graph.microsoft.com/v1.0",
        async () => ({ kind: "bearer", value: "fixture-opaque-token" }),
        {
          signal: AbortSignal.timeout(10000),
          readOnly: true,
          network: {
            resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
            fetch: async (url, init) => {
              calls.push({
                url: String(url),
                authorization: new Headers(init?.headers).get("authorization"),
              });
              return String(url).endsWith("/$value")
                ? new Response(bytes, {
                    headers: {
                      "content-type": "application/octet-stream",
                      "content-length": String(size),
                    },
                  })
                : new Response(
                    JSON.stringify({
                      id: "attachment-fixture",
                      "@odata.type": "#microsoft.graph.fileAttachment",
                      size,
                      name: "fixture.bin",
                      contentType: "application/octet-stream",
                    }),
                  );
            },
          },
        },
      );
      const s = setup([], { request: (r) => client.request(r) });
      try {
        const output = (await action("outlook.attachments.download").execute(
          { messageId: "message-fixture", attachmentId: "attachment-fixture" },
          s.context,
        )) as { artifact: { size: number } };
        assert.equal(output.artifact.size, size);
        assert.equal(calls.length, 2);
        assert.ok(calls[0]!.url.includes("%24select="));
        assert.ok(calls[1]!.url.endsWith("/$value"));
        assert.ok(calls.every((c) => c.authorization === "Bearer fixture-opaque-token"));
      } finally {
        await client.close();
      }
    });
  it("rejects an over-limit attachment from metadata without downloading", async () => {
    const s = setup([
      ok({
        id: "attachment-fixture",
        "@odata.type": "#microsoft.graph.fileAttachment",
        size: 10 * 1024 * 1024 + 1,
        name: "fixture.bin",
        contentType: "application/octet-stream",
      }),
    ]);
    await assert.rejects(
      action("outlook.attachments.download").execute(
        { messageId: "message-fixture", attachmentId: "attachment-fixture" },
        s.context,
      ),
      { kind: "invalid_input" },
    );
    assert.equal(s.requests.length, 1);
  });
  it("rejects a truncated attachment instead of storing partial bytes", async () => {
    const s = setup([
      ok({
        id: "attachment-fixture",
        "@odata.type": "#microsoft.graph.fileAttachment",
        size: 4,
        name: "fixture.bin",
        contentType: "application/octet-stream",
      }),
      ok(new Uint8Array([1, 2, 3])),
    ]);
    await assert.rejects(
      action("outlook.attachments.download").execute(
        { messageId: "message-fixture", attachmentId: "attachment-fixture" },
        s.context,
      ),
      { kind: "incomplete_response" },
    );
  });
});
