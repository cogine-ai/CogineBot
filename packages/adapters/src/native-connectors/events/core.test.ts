import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type {
  NativeEventObservation,
  NativeEventScope,
  NativeRoutineEventSpec,
  PreparedNativeRoutineTrigger,
} from "@rakazo/contracts";
import {
  NativeEventObservationSchema,
  NativeRoutineTriggerInputSchema,
  NativeRoutineTriggersInputSchema,
  nativeEventResource,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { it as test } from "vitest";
import {
  calendarChannelTokenHash,
  notionSignalAccessible,
  notionSignalCandidate,
  verifyCalendarSignal,
  verifyNotionSignal,
} from "./signals.js";
import type { NativeEventConnectionSnapshot, NativeRoutineTriggerRow } from "./store.js";
import {
  checkpointNativeEventSource,
  claimNativeRoutineEvent,
  leaseNativeEventSource,
  listNativeRoutineTriggersBatch,
  nativeConnectionMatches,
  nativeEventRunNonce,
  nativeObservationMatches,
  replaceNativeRoutineTriggersTx,
  saveNativeRoutineTrigger,
} from "./store.js";
import { NativeSourceJobPayloadSchema, nativeSourceJob } from "./worker.js";

const scope: NativeEventScope = { userId: "synthetic-owner", spaceId: "synthetic-space" };
const PAGE = "11111111-1111-4111-8111-111111111111",
  BLOCK = "22222222-2222-4222-8222-222222222222",
  DS = "33333333-3333-4333-8333-333333333333",
  DISCUSSION = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-18T10:00:00.000Z"),
  ARM = new Date("2026-10-18T09:00:00.000Z");
function snapshot(
  overrides: Partial<NativeEventConnectionSnapshot> = {},
): NativeEventConnectionSnapshot {
  return {
    ...scope,
    connectionId: "connection-a",
    connectorId: "native",
    provider: "google-calendar",
    status: "connected",
    authorizationRevision: "auth-a",
    grantId: "grant-a",
    authGeneration: 1,
    configId: "config-a",
    configRevision: 1,
    currentConfigRevision: 1,
    grantConfigId: "config-a",
    grantConfigRevision: 1,
    grantUserId: scope.userId,
    grantSpaceId: scope.spaceId,
    configAppId: "google-calendar",
    configEnabled: true,
    revokedAt: null,
    hasCredential: true,
    ...overrides,
  };
}
function row(
  spec: NativeRoutineEventSpec = {
    kind: "calendar.event_changed",
    calendarId: "primary",
    target: { kind: "calendar" },
  },
): NativeRoutineTriggerRow {
  return {
    id: "trigger-a",
    routineId: "routine-a",
    connectionId: "connection-a",
    authorizationRevision: "auth-a",
    grantId: "grant-a",
    authGeneration: 1,
    configId: "config-a",
    configRevision: 1,
    kind: spec.kind,
    resourceType: nativeEventResource(spec).type,
    resourceId: nativeEventResource(spec).id,
    spec,
    version: 2,
    armedAt: ARM,
    state: { ready: true, syncToken: "original-cursor" },
    nextPollAt: NOW,
    leaseId: "lease-a",
    leaseUntil: new Date(NOW.getTime() + 60_000),
  };
}
function event(
  binding = row(),
  overrides: Partial<NativeEventObservation> = {},
): NativeEventObservation {
  return {
    triggerId: binding.id,
    triggerVersion: binding.version,
    connectionId: binding.connectionId,
    authorizationRevision: binding.authorizationRevision,
    kind: binding.kind as NativeEventObservation["kind"],
    resource: nativeEventResource(binding.spec as NativeRoutineEventSpec),
    eventIdentity: "provider-event-a",
    observedVersion: "etag-a",
    occurredAt: NOW.toISOString(),
    evidence: "visible_state_change",
    ...(binding.kind.startsWith("calendar.") ? { eventId: "event-a" } : {}),
    ...(binding.kind === "calendar.event_starting"
      ? { scheduledStart: new Date(NOW.getTime() + 5 * 60_000).toISOString() }
      : {}),
    ...overrides,
  };
}
interface Query {
  sql: string;
  values: unknown[];
}
function database(
  options: {
    binding?: NativeRoutineTriggerRow;
    current?: NativeEventConnectionSnapshot | null;
    second?: NativeEventConnectionSnapshot | null;
    active?: boolean;
    existingRun?: { id: string; taskId: string };
    hasOtherTrigger?: boolean;
    fail?: string;
  } = {},
) {
  const binding = options.binding ?? row();
  const queries: Query[] = [],
    writes: Array<{ table: string; args: Record<string, unknown> }> = [];
  let reads = 0;
  const api = {
    $queryRaw: async (query: Query) => {
      queries.push(query);
      if (options.fail && query.sql.includes(options.fail))
        throw new Error("synthetic SQL failure");
      if (query.sql.includes("native-event:connection")) {
        assert.ok(
          query.sql.includes('c."userId"=') &&
            query.sql.includes('c."spaceId"=') &&
            query.sql.includes("space_members"),
        );
        assert.ok(query.values.includes(scope.userId) && query.values.includes(scope.spaceId));
        const value =
          reads++ > 0 && options.second !== undefined
            ? options.second
            : options.current === undefined
              ? snapshot()
              : options.current;
        return value ? [value] : [];
      }
      if (query.sql.includes("native-event:lock-routine")) {
        assert.ok(
          query.sql.includes('b."userId"=') &&
            query.sql.includes('b."spaceId"=') &&
            query.sql.includes('"archivedAt" IS NULL'),
        );
        return options.active === false ? [] : [{ id: binding.routineId }];
      }
      if (query.sql.includes("native-event:row")) return [structuredClone(binding)];
      if (query.sql.includes("native-event:list-for-replace")) return [structuredClone(binding)];
      if (query.sql.includes("native-event:has-any-trigger"))
        return [{ allowed: options.hasOtherTrigger !== false }];
      if (query.sql.includes("native-event:lease"))
        return [{ ...binding, leaseId: "new-lease", leaseUntil: new Date(NOW.getTime() + 120000) }];
      if (query.sql.includes("native-event:update") || query.sql.includes("native-event:insert")) {
        writes.push({ table: "binding", args: { values: query.values } });
        return [{ ...binding, version: binding.version + 1 }];
      }
      return [];
    },
    $executeRaw: async (query: Query) => {
      queries.push(query);
      writes.push({ table: "sql", args: { sql: query.sql, values: query.values } });
      return 1;
    },
    routine: {
      findFirst: async () => ({
        id: "routine-a",
        ...scope,
        botId: "bot-a",
        active: true,
        threadId: null,
        prompt: "Original Routine prompt",
        crons: ["0 9 * * *"],
        nextRunAt: new Date("2026-10-19T09:00:00Z"),
        modelProvider: "synthetic-provider",
        modelId: "synthetic-model",
        thinkingLevel: "high",
        bot: { thread: { id: "thread-a" } },
      }),
      updateMany: async (args: Record<string, unknown>) => {
        writes.push({ table: "routine", args });
        return { count: 1 };
      },
    },
    thread: { findFirst: async () => null },
    task: {
      create: async (args: Record<string, unknown>) => {
        writes.push({ table: "task", args });
        return { id: "task-a" };
      },
    },
    run: {
      findFirst: async () => options.existingRun,
      create: async (args: Record<string, unknown>) => {
        writes.push({ table: "run", args });
        return { id: "run-a" };
      },
    },
  };
  const db = {
    ...api,
    $transaction: async (fn: (tx: typeof api) => Promise<unknown>) => fn(api),
  } as unknown as PrismaClient;
  return { db, queries, writes };
}
const SPECS: NativeRoutineEventSpec[] = [
  { kind: "calendar.event_changed", calendarId: "primary", target: { kind: "calendar" } },
  {
    kind: "calendar.event_starting",
    calendarId: "primary",
    target: { kind: "calendar" },
    leadMinutes: 10,
  },
  { kind: "notion.page_content_changed", target: { type: "page", pageId: PAGE } },
  {
    kind: "notion.page_properties_or_data_source_changed",
    target: { type: "data_source", dataSourceId: DS },
  },
  {
    kind: "notion.comment_changed",
    target: { type: "discussion", discussionId: DISCUSSION, anchorBlockId: BLOCK, pageId: PAGE },
  },
];
for (const spec of SPECS)
  test(`strict contract and resource matching: ${spec.kind}`, () => {
    const input = NativeRoutineTriggerInputSchema.parse({ connectionId: "connection-a", spec });
    assert.equal(input.spec.kind, spec.kind);
    assert.throws(() =>
      NativeRoutineTriggerInputSchema.parse({
        connectionId: "connection-a",
        spec,
        userId: "foreign",
        access_token: "synthetic",
      }),
    );
    const binding = row(spec),
      observed = NativeEventObservationSchema.parse(event(binding));
    assert.equal(nativeObservationMatches(binding, observed, NOW), true);
    assert.equal(
      nativeObservationMatches(
        binding,
        { ...observed, resource: { ...observed.resource, id: "sibling" } },
        NOW,
      ),
      false,
    );
  });
test("input existing IDs need CAS version, arrays reject duplicates and credentials nested in options", () => {
  assert.throws(() =>
    NativeRoutineTriggerInputSchema.parse({
      id: "trigger-a",
      connectionId: "connection-a",
      spec: SPECS[0]!,
    }),
  );
  assert.throws(() =>
    NativeRoutineTriggersInputSchema.parse([
      { connectionId: "connection-a", spec: SPECS[0]! },
      { connectionId: "connection-a", spec: SPECS[0]! },
    ]),
  );
  assert.throws(() =>
    NativeRoutineTriggerInputSchema.parse({
      connectionId: "connection-a",
      spec: { ...SPECS[0]!, token: "synthetic" },
    }),
  );
});
for (const [name, override] of Object.entries({
  owner: { userId: "foreign" },
  space: { spaceId: "foreign" },
  source: { connectorId: "composio" },
  pending: { status: "pending" },
  revoked: { revokedAt: NOW },
  missingCredential: { hasCredential: false },
  configDisabled: { configEnabled: false },
  configRevision: { currentConfigRevision: 2 },
  grantOwner: { grantUserId: "foreign" },
  grantSpace: { grantSpaceId: "foreign" },
  grantConfig: { grantConfigId: "sibling" },
  app: { configAppId: "notion" },
}))
  test(`account fence rejects ${name}`, () => {
    assert.equal(nativeConnectionMatches(snapshot(override), scope), false);
  });
test("old or unready observations never match; recurrence instances do not use title or sibling ID", () => {
  const binding = row({
    kind: "calendar.event_changed",
    calendarId: "primary",
    target: { kind: "series", eventId: "series-a" },
  });
  const good = event(binding, { recurringEventId: "series-a" });
  assert.equal(nativeObservationMatches(binding, good, NOW), true);
  for (const invalid of [
    { ...good, triggerVersion: 1 },
    { ...good, connectionId: "sibling" },
    { ...good, authorizationRevision: "old" },
    { ...good, recurringEventId: "other" },
    { ...good, occurredAt: "2026-10-17T00:00:00Z" },
  ])
    assert.equal(nativeObservationMatches(binding, invalid, NOW), false);
  assert.equal(nativeObservationMatches({ ...binding, state: { ready: false } }, good, NOW), false);
});
test("upcoming events require live window and use occurrence/start receipt, not etag", () => {
  const binding = row(SPECS[1]!),
    good = event(binding);
  assert.equal(nativeObservationMatches(binding, good, NOW), true);
  assert.equal(
    nativeObservationMatches(binding, good, new Date(NOW.getTime() + 6 * 60_000)),
    false,
  );
  assert.equal(
    nativeObservationMatches(binding, good, new Date(NOW.getTime() - 20 * 60_000)),
    false,
  );
  assert.equal(
    nativeEventRunNonce(binding, good),
    nativeEventRunNonce(binding, { ...good, observedVersion: "different-description-etag" }),
  );
  assert.notEqual(
    nativeEventRunNonce(binding, good),
    nativeEventRunNonce(binding, {
      ...good,
      scheduledStart: new Date(NOW.getTime() + 7 * 60_000).toISOString(),
    }),
  );
});
test("Notion retry receipt ignores readback drift and property selection requires exact ID", () => {
  const binding = row({
      kind: "notion.page_properties_or_data_source_changed",
      target: { type: "page", pageId: PAGE },
      propertyIds: ["title"],
    }),
    good = event(binding, { propertyIds: ["title"] });
  assert.equal(nativeObservationMatches(binding, good, NOW), true);
  assert.equal(nativeObservationMatches(binding, { ...good, propertyIds: ["other"] }, NOW), false);
  assert.equal(
    nativeEventRunNonce(binding, good),
    nativeEventRunNonce(binding, { ...good, observedVersion: "newer-read" }),
  );
  assert.notEqual(
    nativeEventRunNonce(binding, good),
    nativeEventRunNonce(binding, { ...good, eventIdentity: "another-provider-event" }),
  );
});
test("exact claim uses original Routine execution/model and account; cron is untouched", async () => {
  const { db, writes } = database();
  const result = await claimNativeRoutineEvent(
    db,
    scope,
    event(),
    "lease-a",
    (prompt) => prompt,
    NOW,
  );
  assert.deepEqual(result, {
    runId: "run-a",
    taskId: "task-a",
    routineId: "routine-a",
    created: true,
  });
  const task = writes.find((item) => item.table === "task")?.args.data as Record<string, unknown>,
    run = writes.find((item) => item.table === "run")?.args.data as Record<string, unknown>;
  assert.deepEqual(task.connectionIds, ["connection-a"]);
  assert.equal(task.threadId, "thread-a");
  assert.ok(String(task.prompt).startsWith("Original Routine prompt\n"));
  assert.equal(run.trigger, "routine");
  assert.equal(run.routineId, "routine-a");
  assert.equal(run.modelPinned, true);
  assert.equal(run.modelId, "synthetic-model");
  assert.deepEqual(writes.find((item) => item.table === "routine")?.args.data, { lastRunAt: NOW });
});
test("existing receipt does not create another Task or Run", async () => {
  const { db, writes } = database({ existingRun: { id: "existing-run", taskId: "existing-task" } });
  assert.equal(
    (await claimNativeRoutineEvent(db, scope, event(), "lease-a", undefined, NOW))?.created,
    false,
  );
  assert.equal(writes.length, 0);
});
for (const [name, options] of Object.entries({
  paused: { active: false },
  revoked: { current: snapshot({ status: "revoked" }) },
  missing: { current: null },
  changedAfterLock: { second: snapshot({ authorizationRevision: "new-auth" }) },
  expiredLease: { binding: { ...row(), leaseUntil: ARM } },
  oldGrantJob: { binding: { ...row(), grantId: "old-grant" } },
}))
  test(`worker ignores ${name} without creating a Task`, async () => {
    const { db, writes } = database(options);
    assert.equal(
      await claimNativeRoutineEvent(db, scope, event(), "lease-a", undefined, NOW),
      undefined,
    );
    assert.equal(writes.length, 0);
  });
test("database failures remain retryable instead of being reported as ignored", async () => {
  const { db } = database({ fail: "native-event:connection" });
  await assert.rejects(
    claimNativeRoutineEvent(db, scope, event(), "lease-a", undefined, NOW),
    /synthetic SQL failure/,
  );
});
test("revoked source cannot be leased or checkpointed", async () => {
  const { db, writes } = database({ current: snapshot({ status: "revoked" }) });
  assert.equal(await leaseNativeEventSource(db, scope, "trigger-a", 2, NOW), undefined);
  assert.equal(
    await checkpointNativeEventSource(
      db,
      scope,
      {
        triggerId: "trigger-a",
        triggerVersion: 2,
        leaseId: "lease-a",
        state: { ready: true, syncToken: "should-not-commit" },
        nextPollAt: NOW,
        release: true,
      },
      NOW,
    ),
    false,
  );
  assert.equal(writes.length, 0);
});
test("unchanged save preserves cursor, armedAt and generation; no update", async () => {
  const binding = row(),
    prepared: PreparedNativeRoutineTrigger = {
      input: {
        id: binding.id,
        expectedVersion: binding.version,
        connectionId: binding.connectionId,
        spec: binding.spec as NativeRoutineEventSpec,
      },
      proof: {
        ...scope,
        connectionId: binding.connectionId,
        authorizationRevision: binding.authorizationRevision,
        grantId: binding.grantId,
        authGeneration: binding.authGeneration,
        configId: binding.configId,
        configRevision: binding.configRevision,
        appId: "google-calendar",
        resource: nativeEventResource(binding.spec as NativeRoutineEventSpec),
        spec: binding.spec as NativeRoutineEventSpec,
      },
    };
  const single = database({
    binding: {
      ...binding,
      spec: { target: { kind: "calendar" }, calendarId: "primary", kind: "calendar.event_changed" },
    },
  });
  const saved = await saveNativeRoutineTrigger(single.db, scope, binding.routineId, prepared, NOW);
  assert.equal(saved.version, binding.version);
  assert.equal(saved.armedAt, ARM.toISOString());
  assert.equal(single.writes.length, 0);
  const batch = database();
  await batch.db.$transaction((tx) =>
    replaceNativeRoutineTriggersTx(tx, scope, binding.routineId, [prepared], NOW),
  );
  assert.equal(batch.writes.length, 0);
});
test("batch empty cannot remove the final Routine trigger", async () => {
  const { db } = database({ hasOtherTrigger: false });
  await assert.rejects(
    db.$transaction((tx) => replaceNativeRoutineTriggersTx(tx, scope, "routine-a", [], NOW)),
    /Add a schedule/,
  );
});
test("source job payload cannot override owner, target or cursor", () => {
  assert.throws(() =>
    NativeSourceJobPayloadSchema.parse({ triggerId: "a", triggerVersion: 1, userId: "foreign" }),
  );
  assert.equal(nativeSourceJob("a", 1).replaceKey, "native-source:a:1");
});

const hook = {
  verified: true,
  integrationId: PAGE,
  subscriptionId: BLOCK,
  verificationToken: "synthetic-hook-token",
};
function notionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: DISCUSSION,
    timestamp: "2026-10-18T09:55:00Z",
    workspace_id: DS,
    subscription_id: BLOCK,
    integration_id: PAGE,
    type: "page.content_updated",
    authors: [{ id: PAGE, type: "person" }],
    accessible_by: [{ id: BLOCK, type: "bot" }],
    attempt_number: 1,
    entity: { id: PAGE, type: "page" },
    data: { private_text: "not included in envelope" },
    ...overrides,
  };
}
function signed(payload: unknown) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  return {
    raw,
    signature: `sha256=${createHmac("sha256", hook.verificationToken).update(raw).digest("hex")}`,
  };
}
test("Notion validates raw bytes, strips body/authors, and accepts delayed retries", () => {
  const { raw, signature } = signed(notionPayload());
  const signal = verifyNotionSignal(raw, signature, hook);
  assert.ok(signal);
  assert.equal("authors" in signal, false);
  assert.equal("data" in signal, false);
  assert.equal(
    notionSignalAccessible(signal, {
      workspaceId: DS,
      botId: BLOCK,
      ownerUserId: PAGE,
      credentialKind: "oauth",
    }),
    true,
  );
  assert.equal(notionSignalCandidate(SPECS[2]!, signal), true);
  assert.ok(verifyNotionSignal(raw, signature, hook)); // No fabricated tiny timestamp window; ID receipt performs replay protection.
  assert.throws(() =>
    verifyNotionSignal(
      new TextEncoder().encode(` ${new TextDecoder().decode(raw)}`),
      signature,
      hook,
    ),
  );
});
for (const [name, override] of Object.entries({
  subscription: { subscription_id: DS },
  integration: { integration_id: BLOCK },
}))
  test(`Notion rejects wrong ${name}`, () => {
    const { raw, signature } = signed(notionPayload(override));
    assert.throws(() => verifyNotionSignal(raw, signature, hook));
  });
test("Notion wrong workspace/bot and missing accessible_by cannot route public grant", () => {
  for (const override of [
    { workspace_id: PAGE },
    { accessible_by: [{ id: PAGE, type: "bot" }] },
    { accessible_by: undefined },
  ]) {
    const { raw, signature } = signed(notionPayload(override));
    const signal = verifyNotionSignal(raw, signature, hook);
    assert.ok(signal);
    assert.equal(
      notionSignalAccessible(signal, {
        workspaceId: DS,
        botId: BLOCK,
        ownerUserId: PAGE,
        credentialKind: "oauth",
      }),
      false,
    );
  }
});
test("Notion verification POST cannot replace active secret; unknown database type is not renamed", () => {
  const setup = signed({ verification_token: "synthetic-replacement" });
  assert.throws(() => verifyNotionSignal(setup.raw, setup.signature, hook));
  const old = signed(
    notionPayload({ type: "database.content_updated", entity: { id: DS, type: "database" } }),
  );
  assert.equal(verifyNotionSignal(old.raw, old.signature, hook), undefined);
});
test("Notion comment candidate is exact page/anchor and does not invent discussion ID", () => {
  const message = signed(
    notionPayload({
      type: "comment.deleted",
      entity: { id: DS, type: "comment" },
      data: { page_id: PAGE, parent: { id: BLOCK, type: "block" } },
    }),
  );
  const signal = verifyNotionSignal(message.raw, message.signature, hook);
  assert.ok(signal);
  assert.equal(notionSignalCandidate(SPECS[4]!, signal), true);
  assert.equal("discussionId" in signal, false);
  assert.equal(
    notionSignalCandidate(
      { kind: "notion.comment_changed", target: { type: "block", blockId: DS, pageId: PAGE } },
      signal,
    ),
    false,
  );
});
function channelHeaders(overrides: Record<string, string> = {}) {
  return new Headers({
    "X-Goog-Channel-ID": "channel-a",
    "X-Goog-Channel-Token": "synthetic-channel-token",
    "X-Goog-Resource-ID": "resource-a",
    "X-Goog-Resource-URI": "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    "X-Goog-Resource-State": "exists",
    "X-Goog-Message-Number": "99999999999999999999999999999",
    ...overrides,
  });
}
const channel = {
  id: "channel-a",
  tokenHash: calendarChannelTokenHash("synthetic-channel-token"),
  phase: "active" as const,
  resourceId: "resource-a",
  resourceUri: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  expiration: NOW.getTime() + 60_000,
};
test("Calendar verifies fixed channel and big nonsequential message number", () => {
  const signal = verifyCalendarSignal(channelHeaders(), channel, NOW.getTime());
  assert.equal(signal.phase, "wake");
  assert.equal(signal.messageNumber, "99999999999999999999999999999");
});
for (const [name, override] of Object.entries<Record<string, string>>({
  token: { "X-Goog-Channel-Token": "wrong" },
  channel: { "X-Goog-Channel-ID": "sibling" },
  resource: { "X-Goog-Resource-ID": "other" },
  arbitraryUri: { "X-Goog-Resource-URI": "https://untrusted.example.test" },
  state: { "X-Goog-Resource-State": "unknown" },
  sequence: { "X-Goog-Message-Number": "0" },
}))
  test(`Calendar rejects wrong ${name}`, () => {
    assert.throws(() => verifyCalendarSignal(channelHeaders(override), channel, NOW.getTime()));
  });
test("Calendar early sync remains pending and expired channels cannot wake", () => {
  const early = { ...channel, phase: "pending" as const, resourceId: null, resourceUri: null };
  assert.equal(
    verifyCalendarSignal(
      channelHeaders({ "X-Goog-Resource-State": "sync", "X-Goog-Message-Number": "1" }),
      early,
      NOW.getTime(),
    ).phase,
    "early_sync",
  );
  assert.throws(() => verifyCalendarSignal(channelHeaders(), early, NOW.getTime()));
  assert.throws(() => verifyCalendarSignal(channelHeaders(), channel, channel.expiration));
});

test("Notion official page.properties_updated space parent normalizes only the wire spelling", () => {
  const message = signed(
    notionPayload({
      type: "page.properties_updated",
      data: { parent: { id: DS, type: "space" }, updated_properties: ["XGe%40"] },
    }),
  );
  const signal = verifyNotionSignal(message.raw, message.signature, hook);
  assert.ok(signal);
  assert.deepEqual(signal.parent, { id: DS, type: "workspace" });
  assert.deepEqual(signal.propertyIds, ["XGe%40"]);
  assert.equal(
    notionSignalAccessible(signal, {
      workspaceId: PAGE,
      botId: BLOCK,
      ownerUserId: PAGE,
      credentialKind: "oauth",
    }),
    false,
  );
});

for (const count of [1, 20, 100])
  test(`batch Native listing uses one query for ${count} empty Routines`, async () => {
    const ids = Array.from({ length: count }, (_, index) => `routine-${index}`);
    let queries = 0;
    const db = {
      $queryRaw: async (query: Query) => {
        queries++;
        assert.ok(query.sql.includes("/*native-event:list-batch*/"));
        return ids.map((ownedRoutineId) => ({ ownedRoutineId, id: null }));
      },
    } as unknown as PrismaClient;
    const result = await listNativeRoutineTriggersBatch(db, scope, ids);
    assert.equal(queries, 1);
    assert.equal(result.size, count);
    for (const id of ids) assert.deepEqual(result.get(id), []);
  });
test("batch Native listing groups safe DTOs, fails closed for a missing owned Routine, and skips an empty set", async () => {
  let queries = 0;
  const binding = row();
  const db = {
    $queryRaw: async () => {
      queries++;
      return [
        { ownedRoutineId: "routine-a", ...binding },
        { ownedRoutineId: "routine-b", id: null },
      ];
    },
  } as unknown as PrismaClient;
  const result = await listNativeRoutineTriggersBatch(db, scope, [
    "routine-a",
    "routine-b",
    "routine-a",
  ]);
  assert.equal(result.get("routine-a")?.[0]?.id, binding.id);
  assert.deepEqual(result.get("routine-b"), []);
  assert.deepEqual(Object.keys(result.get("routine-a")![0]!).sort(), [
    "armedAt",
    "connectionId",
    "id",
    "routineId",
    "spec",
    "version",
  ]);
  await assert.rejects(
    listNativeRoutineTriggersBatch(db, scope, ["routine-a", "routine-b", "missing"]),
    /Routine not found/,
  );
  const before = queries;
  assert.equal((await listNativeRoutineTriggersBatch(db, scope, [])).size, 0);
  assert.equal(queries, before);
});
