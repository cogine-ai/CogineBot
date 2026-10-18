import assert from "node:assert/strict";
import type { NativeEventObservation, NativeRoutineEventSpec } from "@rakazo/contracts";
import { NativeEventObservationSchema, nativeEventResource } from "@rakazo/contracts";
import { it as test } from "vitest";
import { NativeActionError } from "../action.js";
import { readDriveChanges, readGmailChanges } from "./google-readers.js";
import type { NativeEventReadApi } from "./readers.js";
import type { NativeSourceReadContext } from "./worker.js";

type Obj = Record<string, unknown>;
const NOW = new Date("2026-10-18T10:00:00Z");
const MAIL: NativeRoutineEventSpec = { kind: "gmail.message_received", labelIds: ["INBOX"] };
const LABEL: NativeRoutineEventSpec = {
  kind: "gmail.thread_or_label_changed",
  labelIds: ["Label_fixture"],
};
const FILE: NativeRoutineEventSpec = { kind: "drive.file_changed", fileId: "file_fixture" };
const TRASH: NativeRoutineEventSpec = { kind: "drive.file_trashed", fileId: "file_fixture" };
function source(spec: NativeRoutineEventSpec, state: Obj = {}) {
  const resource = nativeEventResource(spec),
    events: NativeEventObservation[] = [];
  let heartbeats = 0;
  const context: NativeSourceReadContext = {
    scope: { userId: "fixture-owner", spaceId: "fixture-space" },
    row: {
      id: "fixture-trigger",
      routineId: "fixture-routine",
      connectionId: "fixture-connection",
      authorizationRevision: "fixture-auth",
      grantId: "fixture-grant",
      authGeneration: 1,
      configId: "fixture-config",
      configRevision: 1,
      kind: spec.kind,
      resourceType: resource.type,
      resourceId: resource.id,
      spec,
      version: 1,
      armedAt: new Date(NOW.getTime() - 3600000),
      state,
      nextPollAt: NOW,
      leaseId: "fixture-lease",
      leaseUntil: new Date(NOW.getTime() + 120000),
    },
    signal: new AbortController().signal,
    emit: async (event) => {
      NativeEventObservationSchema.parse(event);
      events.push(event);
      return true;
    },
    heartbeat: async () => {
      heartbeats++;
    },
  };
  return { context, events, heartbeats: () => heartbeats };
}
function api(responses: unknown[]) {
  const calls: { path: string; query: Obj }[] = [];
  const read: NativeEventReadApi = {
    get: async (path, query = {}) => {
      calls.push({ path, query });
      assert.ok(responses.length, `Unexpected GET ${path}`);
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
    queryNotionDataSource: async () => {
      throw new Error("Unexpected Notion query");
    },
  };
  return { api: read, calls, remaining: () => responses.length };
}
const message = (patch: Obj = {}) => ({
  id: "message_fixture",
  threadId: "thread_fixture",
  historyId: "102",
  labelIds: ["INBOX"],
  internalDate: String(NOW.getTime() - 1000),
  ...patch,
});
const added = (historyId = "101", patch: Obj = {}) => ({
  id: historyId,
  messagesAdded: [{ message: { id: "message_fixture", threadId: "thread_fixture" } }],
  ...patch,
});
const changed = (patch: Obj = {}) => ({
  fileId: "file_fixture",
  time: new Date(NOW.getTime() - 1000).toISOString(),
  removed: false,
  changeType: "file",
  ...patch,
});
const file = (patch: Obj = {}) => ({
  id: "file_fixture",
  version: "1",
  trashed: false,
  isAppAuthorized: true,
  ...patch,
});
async function gmailState(spec: NativeRoutineEventSpec = MAIL) {
  return (await readGmailChanges(source(spec).context, api([{ historyId: "100" }]).api, NOW)).state;
}
async function driveState(spec: NativeRoutineEventSpec = FILE, trashed = false) {
  return (
    await readDriveChanges(
      source(spec).context,
      api([
        { startPageToken: "start_fixture" },
        file({ trashed }),
        { changes: [], newStartPageToken: "saved_fixture" },
      ]).api,
      NOW,
    )
  ).state;
}
function failure(kind: string) {
  return (error: unknown) => error instanceof NativeActionError && error.kind === kind;
}

test("Gmail installation captures profile historyId and emits no old message", async () => {
  const s = source(MAIL),
    f = api([{ historyId: "100" }]);
  const result = await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(result.state.ready, true);
  assert.equal((result.state.gmailChanged as Obj).historyId, "100");
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ["/users/me/profile"],
  );
});
test("Gmail every history page uses original startHistoryId, terminal cursor only, and repeated new-message delta emits once", async () => {
  const state = await gmailState(),
    s = source(MAIL, state),
    f = api([
      { history: [added()], nextPageToken: "page_two" },
      message(),
      { history: [added("102")], historyId: "103" },
      message(),
    ]);
  const result = await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.messageId, "message_fixture");
  assert.equal(s.events[0]!.resource.type, "mailbox");
  assert.equal(s.events[0]!.resource.id, "me");
  const history = f.calls.filter((call) => call.path === "/users/me/history");
  assert.equal(history.length, 2);
  assert.ok(history.every((call) => call.query.startHistoryId === "100"));
  assert.equal(history[1]!.query.pageToken, "page_two");
  assert.equal((state.gmailChanged as Obj).historyId, "100");
  assert.equal((result.state.gmailChanged as Obj).historyId, "103");
});
test("Gmail specific history fields avoid duplicate generic messages; current read is authoritative", async () => {
  const state = await gmailState(),
    s = source(MAIL, state),
    f = api([
      {
        history: [{ ...added(), messages: [{ id: "other_message", threadId: "other_thread" }] }],
        historyId: "103",
      },
      message(),
    ]);
  await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1]!.query, {
    format: "metadata",
    fields: "id,threadId,labelIds,historyId,internalDate",
  });
});
test("Gmail old, sent, draft and wrong thread mail cannot fire received events", async () => {
  for (const patch of [
    { internalDate: String(NOW.getTime() - 7200000) },
    { labelIds: ["INBOX", "SENT"] },
    { labelIds: ["INBOX", "DRAFT"] },
  ]) {
    const s = source(MAIL, await gmailState());
    await readGmailChanges(
      s.context,
      api([{ history: [added()], historyId: "103" }, message(patch)]).api,
      NOW,
    );
    assert.equal(s.events.length, 0);
  }
  const spec: NativeRoutineEventSpec = { kind: "gmail.message_received", threadId: "other_thread" };
  const s = source(spec, await gmailState(spec));
  await readGmailChanges(s.context, api([{ history: [added()], historyId: "103" }]).api, NOW);
  assert.equal(s.events.length, 0);
});
test("Gmail selected label removal still matches after current label disappeared", async () => {
  const state = await gmailState(LABEL),
    s = source(LABEL, state),
    f = api([
      {
        history: [
          {
            id: "101",
            labelsRemoved: [
              {
                message: { id: "message_fixture", threadId: "thread_fixture" },
                labelIds: ["Label_fixture"],
              },
            ],
          },
        ],
        historyId: "103",
      },
      message({ labelIds: ["INBOX"] }),
    ]);
  await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0]!.labelIds, ["Label_fixture"]);
  assert.equal(s.events[0]!.eventIdentity, "gmail:history:101:message_fixture");
});
test("Gmail history404 rebaselines without replay;403 never clears the cursor", async () => {
  const state = await gmailState(),
    s = source(MAIL, state),
    f = api([
      new NativeActionError("resource_unavailable", "fixture expired history", {
        recovery: { status: 404 },
      }),
      { historyId: "200" },
    ]);
  const result = await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal((result.state.gmailChanged as Obj).historyId, "200");
  const denied = source(MAIL, state),
    errors = api([
      new NativeActionError("resource_unavailable", "fixture forbidden", {
        recovery: { status: 403 },
      }),
    ]);
  await assert.rejects(
    readGmailChanges(denied.context, errors.api, NOW),
    failure("resource_unavailable"),
  );
  assert.equal(errors.calls.length, 1);
  assert.equal((state.gmailChanged as Obj).historyId, "100");
});
test("Gmail vanished candidate404 does not rebaseline the whole mailbox", async () => {
  const s = source(MAIL, await gmailState()),
    f = api([
      { history: [added()], historyId: "103" },
      new NativeActionError("resource_unavailable", "fixture vanished message", {
        recovery: { status: 404 },
      }),
    ]);
  const result = await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(f.calls.length, 2);
  assert.equal((result.state.gmailChanged as Obj).historyId, "103");
});
test("Gmail deleted message only fires for its explicitly selected still-readable thread", async () => {
  const spec: NativeRoutineEventSpec = {
    kind: "gmail.thread_or_label_changed",
    threadId: "thread_fixture",
  };
  const s = source(spec, await gmailState(spec)),
    f = api([
      {
        history: [
          {
            id: "101",
            messagesDeleted: [{ message: { id: "message_fixture", threadId: "thread_fixture" } }],
          },
        ],
        historyId: "103",
      },
      {
        id: "thread_fixture",
        historyId: "103",
        messages: [{ id: "remaining", threadId: "thread_fixture", labelIds: ["INBOX"] }],
      },
    ]);
  await readGmailChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(f.calls[1]!.path, "/users/me/threads/thread_fixture");
});
test("Gmail missing terminal token or later page failure never mutates original durable cursor", async () => {
  for (const responses of [
    [{ history: [] }],
    [{ history: [], nextPageToken: "page_two" }, new Error("fixture page failure")],
    [
      { history: [], nextPageToken: "same" },
      { history: [], nextPageToken: "same" },
    ],
  ]) {
    const state = await gmailState(),
      s = source(MAIL, state);
    await assert.rejects(readGmailChanges(s.context, api(responses).api, NOW));
    assert.equal((state.gmailChanged as Obj).historyId, "100");
  }
});
test("Gmail filter and authorization changes force a clean no-fire baseline", async () => {
  const state = await gmailState(),
    s = source(LABEL, state),
    f = api([{ historyId: "200" }]);
  await readGmailChanges(s.context, f.api, NOW);
  assert.equal(f.calls[0]!.path, "/users/me/profile");
  const changed = source(MAIL, state);
  changed.context.row.authGeneration = 2;
  const retry = api([{ historyId: "300" }]);
  await readGmailChanges(changed.context, retry.api, NOW);
  assert.equal(retry.calls[0]!.path, "/users/me/profile");
  assert.equal(changed.events.length, 0);
});
test("Drive baseline drains installation race pages and suppresses preexisting trash and version changes", async () => {
  const s = source(TRASH),
    f = api([
      { startPageToken: "start_fixture" },
      file(),
      { changes: [changed()], nextPageToken: "page_two" },
      file({ version: "2", trashed: true }),
      { changes: [], newStartPageToken: "terminal_fixture" },
    ]);
  const result = await readDriveChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 0);
  assert.equal(s.heartbeats(), 2);
  assert.equal((result.state.driveChanged as Obj).pageToken, "terminal_fixture");
  assert.equal((result.state.driveChanged as Obj).lastTrashed, true);
});
test("Drive only selected file authoritative version changes emit; duplicate changes do not create duplicate observations", async () => {
  const state = await driveState(),
    s = source(FILE, state),
    f = api([
      {
        changes: [changed({ fileId: "other_file" }), changed(), changed()],
        newStartPageToken: "next_fixture",
      },
      file({ version: "2" }),
      file({ version: "2" }),
    ]);
  const result = await readDriveChanges(s.context, f.api, NOW);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0]!.observedVersion, "2");
  assert.equal(s.events[0]!.fileId, "file_fixture");
  assert.equal((state.driveChanged as Obj).pageToken, "saved_fixture");
  assert.equal((result.state.driveChanged as Obj).pageToken, "next_fixture");
  assert.ok(
    f.calls
      .filter((call) => call.path.startsWith("/files/"))
      .every((call) => call.path === "/files/file_fixture"),
  );
});
test("Drive trashed requires false-to-true authority transition; removed alone is not trash", async () => {
  const state = await driveState(TRASH),
    s = source(TRASH, state);
  await readDriveChanges(
    s.context,
    api([
      { changes: [changed({ removed: true })], newStartPageToken: "next_fixture" },
      file({ version: "2", trashed: false }),
    ]).api,
    NOW,
  );
  assert.equal(s.events.length, 0);
  const actual = source(TRASH, state);
  await readDriveChanges(
    actual.context,
    api([
      { changes: [changed()], newStartPageToken: "next_fixture" },
      file({ version: "2", trashed: true }),
    ]).api,
    NOW,
  );
  assert.equal(actual.events.length, 1);
  assert.equal(actual.events[0]!.trashed, true);
  const already = source(TRASH, await driveState(TRASH, true));
  await readDriveChanges(
    already.context,
    api([
      { changes: [changed()], newStartPageToken: "next_fixture" },
      file({ version: "2", trashed: true }),
    ]).api,
    NOW,
  );
  assert.equal(already.events.length, 0);
});
test("Drive removed403/404 never becomes deletion or advances durable cursor", async () => {
  for (const code of [403, 404]) {
    const state = await driveState(TRASH),
      s = source(TRASH, state);
    await assert.rejects(
      readDriveChanges(
        s.context,
        api([
          { changes: [changed({ removed: true })], newStartPageToken: "next_fixture" },
          new NativeActionError("resource_unavailable", "fixture inaccessible", {
            recovery: { status: code },
          }),
        ]).api,
        NOW,
      ),
      failure("resource_unavailable"),
    );
    assert.equal(s.events.length, 0);
    assert.equal((state.driveChanged as Obj).pageToken, "saved_fixture");
  }
});
test("Drive file-only grants check isAppAuthorized on baseline and each changed read", async () => {
  const s = source(FILE);
  await assert.rejects(
    readDriveChanges(
      s.context,
      api([{ startPageToken: "start_fixture" }, file({ isAppAuthorized: false })]).api,
      NOW,
      { driveFileOnly: true },
    ),
    failure("resource_unavailable"),
  );
  const ready = source(FILE, await driveState());
  await assert.rejects(
    readDriveChanges(
      ready.context,
      api([
        { changes: [changed()], newStartPageToken: "next_fixture" },
        file({ version: "2", isAppAuthorized: false }),
      ]).api,
      NOW,
      { driveFileOnly: true },
    ),
    failure("resource_unavailable"),
  );
  assert.equal(ready.events.length, 0);
});
test("Drive410 does not use Calendar token-reset semantics", async () => {
  const state = await driveState(),
    s = source(FILE, state),
    f = api([
      new NativeActionError("resource_unavailable", "fixture410", { recovery: { status: 410 } }),
    ]);
  await assert.rejects(readDriveChanges(s.context, f.api, NOW), failure("resource_unavailable"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.path, "/changes");
  assert.equal((state.driveChanged as Obj).pageToken, "saved_fixture");
});
test("Drive missing terminal token/repeated page or mid-page failure cannot commit a prefix", async () => {
  for (const responses of [
    [{ changes: [] }],
    [{ changes: [], nextPageToken: "saved_fixture" }],
    [{ changes: [], nextPageToken: "page_two" }, new Error("fixture page failure")],
  ]) {
    const state = await driveState(),
      s = source(FILE, state);
    await assert.rejects(readDriveChanges(s.context, api(responses).api, NOW));
    assert.equal((state.driveChanged as Obj).pageToken, "saved_fixture");
  }
});
test("Drive pre-arm provider changes are not emitted and failed durable emit cannot advance cursor", async () => {
  const state = await driveState(),
    s = source(FILE, state);
  await readDriveChanges(
    s.context,
    api([
      {
        changes: [changed({ time: new Date(NOW.getTime() - 7200000).toISOString() })],
        newStartPageToken: "next_fixture",
      },
      file({ version: "2" }),
    ]).api,
    NOW,
  );
  assert.equal(s.events.length, 0);
  const fail = source(FILE, state);
  fail.context.emit = async () => {
    throw new Error("fixture durable receipt failure");
  };
  await assert.rejects(
    readDriveChanges(
      fail.context,
      api([{ changes: [changed()], newStartPageToken: "next_fixture" }, file({ version: "2" })])
        .api,
      NOW,
    ),
  );
  assert.equal((state.driveChanged as Obj).pageToken, "saved_fixture");
});
