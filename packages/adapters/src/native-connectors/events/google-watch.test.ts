import assert from "node:assert/strict";
import { beforeEach, it as test, vi } from "vitest";
import type { NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { DriveWatchChannel, GoogleWatchContext } from "./google-watch.js";
import {
  driveChannelTokenHash,
  driveWatchChannels,
  ensureDriveChangesWatch,
  ensureGmailWatch,
  verifyDriveWatchSignal,
} from "./google-watch.js";
import { InvalidNativeEventSignal } from "./signals.js";

const entropy = vi.hoisted(() => ({ uuid: 0, token: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  randomUUID: () => `00000000-0000-4000-8000-${String(++entropy.uuid).padStart(12, "0")}`,
  randomBytes: (size: number) => Buffer.alloc(size, ++entropy.token),
}));
beforeEach(() => {
  entropy.uuid = 0;
  entropy.token = 0;
});
type Obj = Record<string, unknown>;
const NOW = Date.parse("2026-10-18T00:00:00Z"),
  DAY = 86_400_000,
  WEEK = 7 * DAY,
  FIVE_MINUTES = 300_000;
const BINDING = "fixture-trigger:fixture-grant:fixture-auth-generation:fixture-config-revision";
const GMAIL = {
  projectId: "fixture-project",
  topicName: "projects/fixture-project/topics/mail-updates",
  callbackAudience: "https://api.example.test/api/connectors/events/gmail",
  pushServiceAccountEmail: "fixture-push@fixture-project.iam.gserviceaccount.com",
};
const DRIVE = { apiUrl: "https://api.example.test/base", pageToken: "durable-page-token" };
const URI = "https://www.googleapis.com/drive/v3/changes";
const response = (body: unknown, status = 200): NativeResponse => ({
  body: structuredClone(body),
  status,
  headers: new Headers(),
});
function fixture(handler: GoogleWatchContext["request"], state: Obj = {}) {
  const saved: Obj[] = [],
    calls: NativeRequest[] = [];
  const context: GoogleWatchContext = {
    bindingKey: BINDING,
    state: structuredClone(state),
    request: async (request) => {
      calls.push(structuredClone(request));
      return handler(request);
    },
    persistState: async (state) => {
      saved.push(structuredClone(state));
    },
  };
  return { context, saved, calls };
}
function driveAck(request: NativeRequest, expiration = NOW + DAY, extra: Obj = {}): NativeResponse {
  return response({
    kind: "api#channel",
    id: (request.body as Obj).id,
    resourceId: "fixture-resource",
    resourceUri: URI,
    expiration: String(expiration),
    token: (request.body as Obj).token,
    ...extra,
  });
}
function signal(
  channel: DriveWatchChannel,
  token: string,
  extra: Record<string, string> = {},
): Headers {
  return new Headers({
    "x-goog-channel-id": channel.id,
    "x-goog-channel-token": token,
    "x-goog-resource-id": channel.resourceId ?? "fixture-resource",
    "x-goog-resource-uri": channel.resourceUri ?? URI,
    "x-goog-resource-state": "change",
    "x-goog-message-number": "23",
    ...extra,
  });
}
const failure = (kind: string) => (error: unknown) =>
  error instanceof NativeActionError && error.kind === kind;

test("Gmail watch persists pending before POST, records actual expiration and never advances the history reader", async () => {
  const f = fixture(
    async (request) => {
      assert.equal(f.saved.length, 1);
      assert.equal(
        (f.saved[0]!.gmailWatch as Obj).attempt &&
          ((f.saved[0]!.gmailWatch as Obj).attempt as Obj).phase,
        "pending",
      );
      assert.deepEqual(request, {
        method: "POST",
        path: "/users/me/watch",
        body: { topicName: GMAIL.topicName },
      });
      return response({ historyId: "150", expiration: String(NOW + WEEK) });
    },
    { gmailChanged: { historyId: "100" }, marker: "preserved" },
  );
  const result = await ensureGmailWatch(f.context, GMAIL, NOW);
  assert.equal(result.registered, true);
  assert.equal(result.compensationRequired, true);
  assert.equal(result.nextAttemptAt, NOW + DAY);
  assert.deepEqual(result.state.gmailChanged, { historyId: "100" });
  assert.equal(result.state.marker, "preserved");
  assert.equal(((result.state.gmailWatch as Obj).active as Obj).expiration, NOW + WEEK);
  assert.equal((result.state.gmailWatch as Obj).delivery, "registered_unverified");
});
test("Gmail whole-mailbox watch never forwards per-Routine label filters", async () => {
  const f = fixture(async (request) => {
    assert.deepEqual(request.body, { topicName: GMAIL.topicName });
    return response({ historyId: "100", expiration: String(NOW + WEEK) });
  });
  await ensureGmailWatch(
    f.context,
    { ...GMAIL, labelIds: ["INBOX"], labelFilterBehavior: "include" } as typeof GMAIL,
    NOW,
  );
});
test("Gmail uses earlier actual expiration and renews daily without re-registering every poll", async () => {
  const f = fixture(async () =>
    response({ historyId: "100", expiration: String(NOW + 3_600_000) }),
  );
  const first = await ensureGmailWatch(f.context, GMAIL, NOW);
  assert.equal(first.nextAttemptAt, NOW + 3_300_000);
  await ensureGmailWatch(f.context, GMAIL, NOW + 60_000);
  assert.equal(f.calls.length, 1);
  await ensureGmailWatch(f.context, GMAIL, NOW + 3_300_000);
  assert.equal(f.calls.length, 2);
});
test("Gmail topic project, audience and push identity are deployment validated", async () => {
  for (const config of [
    { ...GMAIL, projectId: "another-project" },
    { ...GMAIL, topicName: "https://unexpected.example.test/topic" },
    { ...GMAIL, callbackAudience: "http://127.0.0.1/callback" },
    { ...GMAIL, pushServiceAccountEmail: "owner@example.test" },
  ]) {
    const f = fixture(async () => {
      throw new Error("Must not request");
    });
    await assert.rejects(ensureGmailWatch(f.context, config, NOW), failure("invalid_input"));
    assert.equal(f.saved.length, 0);
  }
});
test("Gmail missing actual history/expiration remains unconfirmed and preserves old cursor", async () => {
  for (const body of [
    { historyId: "100" },
    { expiration: String(NOW + WEEK) },
    { historyId: "bad", expiration: String(NOW + WEEK) },
    { historyId: "100", expiration: String(NOW) },
  ]) {
    const f = fixture(async () => response(body), { gmailChanged: { historyId: "90" } });
    const result = await ensureGmailWatch(f.context, GMAIL, NOW);
    assert.equal(result.registered, false);
    assert.deepEqual(result.state.gmailChanged, { historyId: "90" });
    assert.equal(((result.state.gmailWatch as Obj).attempt as Obj).phase, "unconfirmed");
  }
});
test("Gmail lost acknowledgement backs off and uses a fresh attempt rather than claiming real-time delivery", async () => {
  const f = fixture(async () => {
    throw new Error("private-provider-body");
  });
  await ensureGmailWatch(f.context, GMAIL, NOW);
  const attempt = ((f.context.state.gmailWatch as Obj).attempt as Obj).id;
  await ensureGmailWatch(f.context, GMAIL, NOW + 1000);
  assert.equal(f.calls.length, 1);
  await ensureGmailWatch(f.context, GMAIL, NOW + FIVE_MINUTES);
  assert.equal(f.calls.length, 2);
  assert.notEqual(((f.context.state.gmailWatch as Obj).attempt as Obj).id, attempt);
  assert.ok(!JSON.stringify(f.saved).includes("private-provider-body"));
});
test("Gmail pending persistence failure prevents POST and ACK persistence failure does not attempt a fallback write", async () => {
  const before = fixture(async () => {
    throw new Error("Must not request");
  });
  before.context.persistState = async () => {
    throw new Error("lease lost");
  };
  await assert.rejects(ensureGmailWatch(before.context, GMAIL, NOW), /lease lost/);
  assert.equal(before.calls.length, 0);
  const after = fixture(async () => response({ historyId: "100", expiration: String(NOW + WEEK) }));
  let writes = 0;
  after.context.persistState = async () => {
    if (++writes === 2) throw new Error("lease lost");
  };
  await assert.rejects(ensureGmailWatch(after.context, GMAIL, NOW), /lease lost/);
  assert.equal(after.calls.length, 1);
  assert.equal(writes, 2);
});
test("Gmail watch authorization failure remains a grant error after durable non-secret receipt", async () => {
  const f = fixture(async () => response({}, 401));
  await assert.rejects(ensureGmailWatch(f.context, GMAIL, NOW), failure("authorization_expired"));
  assert.equal((f.context.state.gmailWatch as Obj).lastErrorCode, "authorization_expired");
});
test("Drive pending ID/hash is durable before POST and raw token is never persisted or returned", async () => {
  let token = "";
  const f = fixture(
    async (request) => {
      token = String((request.body as Obj).token);
      const pending = driveWatchChannels(f.saved[0]!, BINDING)[0]!;
      assert.equal(pending.phase, "pending");
      assert.equal(pending.id, (request.body as Obj).id);
      assert.equal(pending.tokenHash, driveChannelTokenHash(token));
      assert.deepEqual(request.query, {
        pageToken: DRIVE.pageToken,
        spaces: "drive",
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      assert.equal(request.service, undefined);
      assert.equal(request.path, "/changes/watch");
      assert.equal(
        (request.body as Obj).address,
        "https://api.example.test/api/connectors/events/drive",
      );
      assert.equal((request.body as Obj).expiration, String(NOW + WEEK));
      return driveAck(request, NOW + 3_600_000);
    },
    { driveChanged: { pageToken: "existing-reader-cursor" } },
  );
  const result = await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  assert.equal(result.registered, true);
  assert.equal(result.nextAttemptAt, NOW + 3_300_000);
  assert.equal(result.compensationRequired, true);
  assert.equal(driveWatchChannels(result.state, BINDING)[0]!.expiration, NOW + 3_600_000);
  assert.deepEqual(result.state.driveChanged, { pageToken: "existing-reader-cursor" });
  assert.ok(!JSON.stringify(f.saved).includes(token));
  assert.ok(!JSON.stringify(result).includes(token));
});
test("Drive ordinary local HTTP/private HTTPS deployments remain polling only", async () => {
  for (const apiUrl of [
    "http://127.0.0.1:3100",
    "https://127.0.0.1:3100",
    "https://localhost:3100",
    "https://10.0.0.5",
    "https://[::1]:3100",
  ]) {
    const f = fixture(async () => {
      throw new Error("Must not request");
    });
    const result = await ensureDriveChangesWatch(f.context, { ...DRIVE, apiUrl }, NOW);
    assert.equal(result.registered, false);
    assert.equal(result.nextAttemptAt, null);
    assert.equal((result.state.driveWatch as Obj).delivery, "polling_only_no_public_https");
    assert.equal(f.calls.length, 0);
  }
});
test("Drive advancing changes cursor does not re-register a valid channel", async () => {
  const f = fixture(async (request) => driveAck(request));
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  await ensureDriveChangesWatch(
    f.context,
    { ...DRIVE, pageToken: "next-durable-cursor" },
    NOW + 60_000,
  );
  assert.equal(f.calls.length, 1);
});
test("Drive shared-drive watch pins server selected drive and cursor", async () => {
  const f = fixture(async (request) => {
    assert.equal(request.query?.driveId, "shared-drive");
    assert.equal(request.query?.pageToken, "shared-cursor");
    return driveAck(request);
  });
  await ensureDriveChangesWatch(
    f.context,
    { ...DRIVE, pageToken: "shared-cursor", driveId: "shared-drive" },
    NOW,
  );
});
test("Drive renewal persists a confirmed overlap before stopping old channels", async () => {
  let registered = 0;
  const ids: string[] = [];
  const f = fixture(async (request) => {
    if (request.path === "/changes/watch") {
      registered++;
      ids.push(String((request.body as Obj).id));
      return driveAck(request, NOW + (registered === 1 ? 3_600_000 : DAY), {
        resourceId: `resource-${registered}`,
      });
    }
    assert.equal(request.path, "/channels/stop");
    assert.deepEqual(request.body, { id: ids[0], resourceId: "resource-1" });
    const durable = driveWatchChannels(f.saved.at(-1)!, BINDING);
    assert.equal(durable.find((row) => row.id === ids[0])!.phase, "retiring");
    assert.equal(durable.find((row) => row.id === ids[1])!.phase, "active");
    return response(null, 204);
  });
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  const result = await ensureDriveChangesWatch(
    f.context,
    { ...DRIVE, pageToken: "new-cursor" },
    NOW + 3_300_000,
  );
  assert.notEqual(ids[0], ids[1]);
  assert.equal(driveWatchChannels(result.state, BINDING).length, 1);
  assert.equal(f.calls.length, 3);
});
test("Drive failed old-channel stop retains retiring overlap", async () => {
  let count = 0;
  const f = fixture(async (request) => {
    if (request.path === "/channels/stop") throw new Error("private-stop-error");
    return driveAck(request, NOW + (++count === 1 ? 3_600_000 : DAY));
  });
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  const result = await ensureDriveChangesWatch(f.context, DRIVE, NOW + 3_300_000);
  assert.deepEqual(
    driveWatchChannels(result.state, BINDING).map((row) => row.phase),
    ["retiring", "active"],
  );
  assert.ok(!JSON.stringify(result).includes("private-stop-error"));
});
test("Drive pending sync is verifiable before watch response but never active", async () => {
  const f = fixture(async (request) => {
    const pending = driveWatchChannels(f.context.state, BINDING)[0]!,
      token = String((request.body as Obj).token);
    const hint = verifyDriveWatchSignal(
      signal(pending, token, { "x-goog-resource-state": "sync", "x-goog-message-number": "1" }),
      pending,
      NOW,
    );
    assert.equal(hint!.phase, "early_sync");
    assert.equal(pending.phase, "pending");
    return driveAck(request);
  });
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
});
test("Drive ambiguous watch keeps pending hash for late sync and does not stop the old active channel", async () => {
  let attempts = 0,
    pendingToken = "";
  const f = fixture(async (request) => {
    if (++attempts === 1) return driveAck(request, NOW + 3_600_000);
    pendingToken = String((request.body as Obj).token);
    throw new Error("private-watch-error");
  });
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  const result = await ensureDriveChangesWatch(f.context, DRIVE, NOW + 3_300_000);
  const rows = driveWatchChannels(result.state, BINDING);
  assert.deepEqual(
    rows.map((row) => row.phase),
    ["active", "pending"],
  );
  assert.equal(result.registered, true);
  assert.equal(
    verifyDriveWatchSignal(
      signal(rows[1]!, pendingToken, {
        "x-goog-resource-state": "sync",
        "x-goog-message-number": "1",
      }),
      rows[1]!,
      NOW + 3_300_000,
    )!.phase,
    "early_sync",
  );
  await ensureDriveChangesWatch(f.context, DRIVE, NOW + 3_301_000);
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(result).includes(pendingToken));
});
test("Drive absent expiration, wrong target, mismatched token and future-over-limit expiration never become active", async () => {
  for (const patch of [
    { expiration: undefined },
    { resourceUri: "https://unexpected.example.test/drive/v3/changes" },
    { resourceUri: "https://www.googleapis.com/drive/v3/files/other" },
    { token: "wrong-token" },
    { expiration: String(NOW + WEEK + 1) },
  ]) {
    const f = fixture(async (request) => driveAck(request, NOW + DAY, patch));
    const result = await ensureDriveChangesWatch(f.context, DRIVE, NOW);
    assert.equal(result.registered, false);
    assert.equal(driveWatchChannels(result.state, BINDING)[0]!.phase, "pending");
  }
});
test("Drive pending persist failure prevents remote registration and confirmed persist failure prevents old stop", async () => {
  const before = fixture(async () => {
    throw new Error("Must not request");
  });
  before.context.persistState = async () => {
    throw new Error("lease lost");
  };
  await assert.rejects(ensureDriveChangesWatch(before.context, DRIVE, NOW), /lease lost/);
  assert.equal(before.calls.length, 0);
  const after = fixture(async (request) => driveAck(request));
  let writes = 0;
  after.context.persistState = async () => {
    if (++writes === 2) throw new Error("lease lost");
  };
  await assert.rejects(ensureDriveChangesWatch(after.context, DRIVE, NOW), /lease lost/);
  assert.equal(after.calls.length, 1);
  assert.equal(writes, 2);
});
test("Drive unknown registration budget is bounded without discarding live pending hashes", async () => {
  const f = fixture(async () => {
    throw new Error("unknown");
  });
  for (let i = 0; i < 32; i++)
    await ensureDriveChangesWatch(f.context, DRIVE, NOW + i * FIVE_MINUTES);
  assert.equal(f.calls.length, 32);
  const result = await ensureDriveChangesWatch(f.context, DRIVE, NOW + 33 * FIVE_MINUTES);
  assert.equal(f.calls.length, 32);
  assert.equal(driveWatchChannels(result.state, BINDING).length, 32);
  assert.equal((result.state.driveWatch as Obj).delivery, "polling_channel_budget");
});
test("Drive callbacks reject a stale authorization-generation binding", async () => {
  const f = fixture(async (request) => driveAck(request));
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  assert.equal(driveWatchChannels(f.context.state, "another-generation").length, 0);
});
test("Drive active/retiring hints authenticate secret and resource, accept change/changed and ignore other bodyless states", async () => {
  let token = "";
  const f = fixture(async (request) => {
    token = String((request.body as Obj).token);
    return driveAck(request);
  });
  await ensureDriveChangesWatch(f.context, DRIVE, NOW);
  const row = driveWatchChannels(f.context.state, BINDING)[0]!;
  for (const phase of ["active", "retiring"] as const)
    for (const state of ["change", "changed"])
      assert.equal(
        verifyDriveWatchSignal(
          signal(row, token, { "x-goog-resource-state": state }),
          { ...row, phase },
          NOW,
        )!.phase,
        "wake",
      );
  assert.equal(
    verifyDriveWatchSignal(signal(row, token, { "x-goog-resource-state": "trash" }), row, NOW),
    null,
  );
  const invalidHeaders: Record<string, string>[] = [
    { "x-goog-channel-id": "another" },
    { "x-goog-channel-token": "wrong" },
    { "x-goog-resource-id": "another" },
    { "x-goog-resource-uri": "https://unexpected.example.test/drive/v3/changes" },
    { "x-goog-message-number": "0" },
    { "x-goog-message-number": "-1" },
    { "x-goog-resource-state": "sync", "x-goog-message-number": "2" },
  ];
  for (const extra of invalidHeaders)
    assert.throws(
      () => verifyDriveWatchSignal(signal(row, token, extra), row, NOW),
      InvalidNativeEventSignal,
    );
  assert.throws(
    () => verifyDriveWatchSignal(signal(row, token), row, row.expiration),
    InvalidNativeEventSignal,
  );
});
