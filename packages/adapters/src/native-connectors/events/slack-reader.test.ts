import assert from "node:assert/strict";
import type {
  NativeEventObservation,
  NativeRoutineEventSpec,
  NativeSlackEventSignal,
} from "@rakazo/contracts";
import { it as test } from "vitest";
import { NativeActionError } from "../action.js";
import type { NativeEventReadApi } from "./readers.js";
import { readSlackWebhook } from "./slack-reader.js";
import type { SlackEventPrincipal, SlackVerifiedHook } from "./slack-signals.js";
import type { NativeSourceReadContext } from "./worker.js";

const time = "1792281600.000001";
const hook: SlackVerifiedHook = {
  id: "hook",
  configId: "config",
  configRevision: 1,
  revision: 2,
  appId: "A123FIXTURE",
  teamId: null,
  verified: true,
  botEvents: ["app_mention", "message.im", "message.channels", "message.groups"],
};
const event: NativeSlackEventSignal = {
  eventId: "Ev123FIXTURE",
  appId: hook.appId,
  teamId: "T123FIXTURE",
  enterpriseId: null,
  type: "message",
  channelType: "channel",
  channelId: "C123FIXTURE",
  messageTs: time,
  userId: "UUSERFIXTURE",
  eventTime: 1792281600,
  authorizations: [
    {
      userId: "UBOTFIXTURE",
      teamId: "T123FIXTURE",
      enterpriseId: null,
      isBot: true,
      isEnterpriseInstall: false,
    },
  ],
};
const principal: SlackEventPrincipal = {
  tokenType: "bot",
  subject: "UBOTFIXTURE",
  teamId: event.teamId,
  enterpriseId: null,
  scopes: [
    "channels:read",
    "channels:history",
    "groups:read",
    "groups:history",
    "im:read",
    "im:history",
    "app_mentions:read",
  ],
};
function fixture(
  spec: NativeRoutineEventSpec = { kind: "slack.channel_message", channelId: event.channelId },
) {
  const emitted: NativeEventObservation[] = [];
  let reads = 0;
  let heartbeats = 0;
  const context: NativeSourceReadContext = {
    scope: { userId: "owner", spaceId: "space" },
    row: {
      id: "trigger",
      routineId: "routine",
      connectionId: "connection",
      authorizationRevision: "auth-revision",
      grantId: "grant",
      authGeneration: 1,
      configId: "config",
      configRevision: 1,
      kind: spec.kind,
      resourceType: "slack_channel",
      resourceId: "channelId" in spec ? spec.channelId : "unused",
      spec,
      version: 1,
      armedAt: new Date(1792281500000),
      state: {},
      nextPollAt: null,
      leaseId: "lease",
      leaseUntil: new Date(1792281700000),
    },
    signal: new AbortController().signal,
    emit: async (observation) => {
      emitted.push(observation);
      return true;
    },
    heartbeat: async () => {
      heartbeats++;
    },
  };
  const api: NativeEventReadApi = {
    get: async (path, args) => {
      reads++;
      assert.equal(path, "/conversations.info");
      assert.equal(args!.channel, event.channelId);
      return { ok: true, channel: { id: event.channelId, is_member: true, is_private: false } };
    },
    queryNotionDataSource: async () => {
      throw Error("No Notion call");
    },
  };
  return { context, api, emitted, counts: () => ({ reads, heartbeats }) };
}
test("Slack reader emits provider evidence via existing source context after current membership read", async () => {
  const f = fixture();
  await readSlackWebhook(f.context, f.api, event, principal, hook);
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0]!.evidence, "slack_events");
  assert.equal(f.emitted[0]!.slackEventId, event.eventId);
  assert.equal(f.emitted[0]!.messageTs, time);
  assert.deepEqual(f.counts(), { reads: 1, heartbeats: 1 });
});
test("Slack disabled/unverified/stale hook/actor/target never reads or emits", async () => {
  for (const changed of [
    { ...hook, verified: false },
    { ...hook, configRevision: 2 },
    { ...hook, appId: "AOTHER" },
    { ...hook, teamId: "TOTHER" },
  ]) {
    const f = fixture();
    await readSlackWebhook(f.context, f.api, event, principal, changed);
    assert.deepEqual(f.counts(), { reads: 0, heartbeats: 0 });
    assert.equal(f.emitted.length, 0);
  }
  const f = fixture();
  await readSlackWebhook(f.context, f.api, event, { ...principal, subject: "UOTHER" }, hook);
  assert.equal(f.emitted.length, 0);
});
test("Slack current nonmembership, missing exact history scope or channel mismatch cannot emit", async () => {
  for (const channel of [
    { id: event.channelId, is_member: false },
    { id: "COTHER", is_member: true },
    { id: event.channelId, is_member: true, is_archived: true },
  ]) {
    const f = fixture();
    f.api.get = async () => ({ ok: true, channel });
    await assert.rejects(
      readSlackWebhook(f.context, f.api, event, principal, hook),
      NativeActionError,
    );
    assert.equal(f.emitted.length, 0);
  }
  const f = fixture();
  await assert.rejects(
    readSlackWebhook(f.context, f.api, event, { ...principal, scopes: ["channels:read"] }, hook),
    (e) => e instanceof NativeActionError && e.kind === "insufficient_scope",
  );
});
test("Slack DM validates current bot DM read without assuming is_member exists", async () => {
  const dmEvent = { ...event, channelId: "D123FIXTURE", channelType: "im" as const };
  const f = fixture({ kind: "slack.app_dm", channelId: dmEvent.channelId });
  f.api.get = async () => ({
    ok: true,
    channel: { id: dmEvent.channelId, is_im: true, user: event.userId },
  });
  await readSlackWebhook(f.context, f.api, dmEvent, principal, hook);
  assert.equal(f.emitted.length, 1);
});
test("Slack app mention needs app scope and current channel membership; history not required", async () => {
  const mention = { ...event, type: "app_mention" as const };
  const f = fixture({ kind: "slack.app_mention", channelId: event.channelId });
  await readSlackWebhook(
    f.context,
    f.api,
    mention,
    { ...principal, scopes: ["app_mentions:read", "channels:read"] },
    hook,
  );
  assert.equal(f.emitted.length, 1);
});
test("Slack pre-arm events and source heartbeat loss never emit", async () => {
  const f = fixture();
  f.context.row.armedAt = new Date(1792281700000);
  await readSlackWebhook(f.context, f.api, event, principal, hook);
  assert.equal(f.emitted.length, 0);
  const lost = fixture();
  lost.context.heartbeat = async () => {
    throw Error("Fixture lease lost");
  };
  await assert.rejects(readSlackWebhook(lost.context, lost.api, event, principal, hook));
  assert.equal(lost.emitted.length, 0);
});
