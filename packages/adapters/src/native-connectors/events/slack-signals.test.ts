import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { NativeRoutineEventSpec, NativeSlackEventSignal } from "@rakazo/contracts";
import { it as test } from "vitest";
import type { SlackEventPrincipal, SlackVerifiedHook } from "./slack-signals.js";
import {
  InvalidNativeSlackSignal,
  slackSignalAccessible,
  slackSignalCandidate,
  verifySlackEnvelope,
} from "./slack-signals.js";

const secret = "fixture-signing-secret-never-real";
const now = new Date("2026-10-18T00:00:00.000Z"),
  timestamp = String(now.getTime() / 1000);
const hook: SlackVerifiedHook = {
  id: "fixture-hook",
  configId: "fixture-config",
  configRevision: 1,
  revision: 1,
  appId: "A123FIXTURE",
  teamId: "T123FIXTURE",
  botEvents: ["app_mention", "message.im", "message.channels", "message.groups"],
  verified: true,
};
const principal: SlackEventPrincipal = {
  tokenType: "bot",
  subject: "UBOTFIXTURE",
  teamId: "T123FIXTURE",
  enterpriseId: null,
  scopes: [],
};
function envelope(event = {}, outer = {}) {
  return {
    type: "event_callback",
    team_id: "T123FIXTURE",
    api_app_id: "A123FIXTURE",
    event_id: "Ev123FIXTURE",
    event_time: Number(timestamp),
    event: {
      type: "message",
      channel: "C123FIXTURE",
      channel_type: "channel",
      user: "UUSERFIXTURE",
      ts: `${timestamp}.000001`,
      text: "Fixture private text must not persist",
      ...event,
    },
    authorizations: [
      {
        enterprise_id: null,
        team_id: "T123FIXTURE",
        user_id: "UBOTFIXTURE",
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    ...outer,
  };
}
function signed(value: unknown, at = timestamp) {
  const raw = Buffer.from(JSON.stringify(value));
  return {
    raw,
    signature: `v0=${createHmac("sha256", secret).update(`v0:${at}:`).update(raw).digest("hex")}`,
    at,
  };
}
function parse(value: unknown, at = timestamp) {
  const s = signed(value, at);
  return verifySlackEnvelope(s.raw, s.signature, s.at, secret, hook, now);
}
function signal(event = {}, outer = {}): NativeSlackEventSignal {
  const parsed = parse(envelope(event, outer));
  assert.equal(parsed.kind, "event");
  return parsed.kind === "event" ? parsed.signal : assert.fail("Expected event");
}
test("Slack raw-body HMAC sanitizes a bot-scoped envelope to IDs only", () => {
  const out = signal();
  assert.equal(out.eventId, "Ev123FIXTURE");
  assert.equal(out.messageTs, `${timestamp}.000001`);
  assert.equal(JSON.stringify(out).includes("private text"), false);
  assert.equal(slackSignalAccessible(out, principal), true);
});
test("Slack signature rejects mutations, missing headers, old/future timestamp and malformed hex", () => {
  const s = signed(envelope());
  for (const [raw, signature, at] of [
    [Buffer.concat([s.raw, Buffer.from(" ")]), s.signature, s.at],
    [s.raw, null, s.at],
    [s.raw, s.signature, null],
    [s.raw, "v0=".padEnd(67, "x"), s.at],
    [s.raw, s.signature, "1,2"],
  ] as const)
    assert.throws(
      () => verifySlackEnvelope(raw, signature, at, secret, hook, now),
      InvalidNativeSlackSignal,
    );
  for (const offset of [-301, 301])
    assert.throws(
      () => parse(envelope(), String(Number(timestamp) + offset)),
      InvalidNativeSlackSignal,
    );
  assert.equal(parse(envelope(), String(Number(timestamp) - 300)).kind, "event");
});
test("Slack signed challenge is accepted, unsigned or wrong app challenge is rejected", () => {
  assert.deepEqual(parse({ type: "url_verification", challenge: "fixture-challenge" }), {
    kind: "challenge",
    challenge: "fixture-challenge",
  });
  assert.throws(
    () => parse({ type: "url_verification", challenge: "fixture", api_app_id: "AOTHER" }),
    InvalidNativeSlackSignal,
  );
  const s = signed({ type: "url_verification", challenge: "fixture" });
  assert.throws(
    () => verifySlackEnvelope(s.raw, null, s.at, secret, hook, now),
    InvalidNativeSlackSignal,
  );
});
test("Slack app/team checks cannot be satisfied with a legacy verification token", () => {
  assert.throws(
    () => parse(envelope({}, { api_app_id: "AOTHER", token: secret })),
    InvalidNativeSlackSignal,
  );
  assert.throws(() => parse(envelope({}, { team_id: "TOTHER" })), InvalidNativeSlackSignal);
});
test("Slack user-only, wrong bot/team/enterprise visibility cannot fire a source", () => {
  for (const authorization of [
    { is_bot: false },
    { user_id: "UOTHER" },
    { team_id: "TOTHER" },
    { enterprise_id: "EOTHER" },
    { is_enterprise_install: true },
  ]) {
    const base = envelope().authorizations[0]!;
    const event = signal({}, { authorizations: [{ ...base, ...authorization }] });
    assert.equal(slackSignalAccessible(event, principal), false);
  }
  assert.equal(slackSignalAccessible(signal({ user: "UBOTFIXTURE" }), principal), false);
});
test("Slack ignores bot echoes, edits/deletes/system subtypes and unsupported subscription", () => {
  for (const event of [
    { bot_id: "B123FIXTURE" },
    { app_id: "A123FIXTURE" },
    { subtype: "message_changed" },
    { subtype: "message_deleted" },
    { subtype: "channel_join" },
    { type: "reaction_added" },
  ])
    assert.equal(parse(envelope(event)).kind, "ignored");
  const s = signed(envelope());
  assert.equal(
    verifySlackEnvelope(
      s.raw,
      s.signature,
      s.at,
      secret,
      { ...hook, botEvents: ["app_mention"] },
      now,
    ).kind,
    "ignored",
  );
  assert.equal(parse(envelope({ subtype: "file_share" })).kind, "event");
});
test("Slack three exact trigger classes and thread boundaries", () => {
  const channelSpec: NativeRoutineEventSpec = {
    kind: "slack.channel_message",
    channelId: "C123FIXTURE",
    threadTs: `${timestamp}.000001`,
  };
  assert.equal(slackSignalCandidate(channelSpec, signal()), true);
  assert.equal(
    slackSignalCandidate(channelSpec, signal({ thread_ts: `${timestamp}.000002` })),
    false,
  );
  assert.equal(
    slackSignalCandidate(
      { kind: "slack.app_dm", channelId: "D123FIXTURE" },
      signal({ channel: "D123FIXTURE", channel_type: "im" }),
    ),
    true,
  );
  assert.equal(
    slackSignalCandidate(
      { kind: "slack.app_mention", channelId: "C123FIXTURE" },
      signal({ type: "app_mention", channel_type: undefined }),
    ),
    true,
  );
  assert.equal(
    slackSignalCandidate({ kind: "slack.channel_message", channelId: "COTHER" }, signal()),
    false,
  );
});
test("Slack rejects invalid timestamps/IDs and bounded invalid UTF8 before any persistence", () => {
  assert.throws(() => parse(envelope({ ts: "1792281600,000001" })), InvalidNativeSlackSignal);
  assert.throws(() => parse(envelope({}, { event_id: "not-an-event" })), InvalidNativeSlackSignal);
  const raw = Buffer.from([255, 255]),
    sig = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
  assert.throws(
    () => verifySlackEnvelope(raw, sig, timestamp, secret, hook, now),
    InvalidNativeSlackSignal,
  );
});
