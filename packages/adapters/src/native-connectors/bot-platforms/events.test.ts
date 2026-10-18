import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it as test } from "vitest";
import type { NativeRequest, NativeResponse } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { verifyDiscordInteraction } from "./interactions.js";
import { pollDiscordMessages, pollTelegramPinned } from "./readers.js";
import {
  APP,
  BOT,
  bot,
  CHANNEL,
  CHAT,
  channel,
  failure,
  GUILD,
  member,
  principal,
  roles,
  tgBot,
  tgChat,
  tgMember,
} from "./testing.js";

const now = new Date("2026-10-18T00:00:00Z");
const keys = generateKeyPairSync("ed25519"),
  key = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const authority = { key, applicationId: APP };
const ping = { id: "100010", application_id: APP, type: 1 };
const command = {
  ...ping,
  type: 2,
  guild_id: GUILD,
  channel_id: CHANNEL,
  member: { user: { id: "100011" } },
  token: "must-not-be-returned",
  data: {
    id: "100012",
    type: 1,
    name: "summary",
    options: [
      { name: "topic", type: 3, value: "Fixture" },
      { name: "count", type: 4, value: 3 },
      { name: "private", type: 5, value: true },
    ],
  },
};
function signed(body: unknown, timestamp = String(now.getTime() / 1000)) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]),
    keys.privateKey,
  ).toString("hex");
  return { raw, headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp } };
}
test("Discord Ed25519 validates exact raw bytes plus timestamp and trusted application identity", () => {
  const p = signed(ping);
  assert.deepEqual(verifyDiscordInteraction(p.raw, p.headers, authority, now.getTime()), {
    kind: "ping",
    id: ping.id,
    applicationId: APP,
  });
  const c = signed(command),
    verified = verifyDiscordInteraction(c.raw, new Headers(c.headers), authority, now.getTime());
  assert.deepEqual(verified, {
    kind: "command",
    id: command.id,
    applicationId: APP,
    guildId: GUILD,
    channelId: CHANNEL,
    commandId: "100012",
    commandName: "summary",
    userId: "100011",
    options: command.data.options,
  });
  assert.equal("token" in verified, false);
});
for (const [name, body] of [
  ["wrong application", { ...command, application_id: "100099" }],
  ["missing guild", { ...command, guild_id: undefined }],
  ["DM command", { ...command, guild_id: undefined, member: undefined, user: { id: "100011" } }],
  ["button callback type", { ...command, type: 3 }],
  ["context menu command", { ...command, data: { ...command.data, type: 2 } }],
  ["malformed command name", { ...command, data: { ...command.data, name: "Uppercase" } }],
  ["unproved user", { ...command, member: {} }],
  [
    "unsupported nested option",
    { ...command, data: { ...command.data, options: [{ name: "nested", type: 1, options: [] }] } },
  ],
  [
    "string type coercion",
    { ...command, data: { ...command.data, options: [{ name: "topic", type: "3", value: 42 }] } },
  ],
  [
    "wrong string value",
    { ...command, data: { ...command.data, options: [{ name: "topic", type: 3, value: 42 }] } },
  ],
  [
    "unsafe integer",
    {
      ...command,
      data: { ...command.data, options: [{ name: "count", type: 4, value: 9007199254740992 }] },
    },
  ],
  [
    "duplicate option",
    {
      ...command,
      data: {
        ...command.data,
        options: [
          { name: "x", type: 5, value: true },
          { name: "x", type: 5, value: false },
        ],
      },
    },
  ],
  ["non JSON", "not json"],
  ["oversized body", " ".repeat(262145)],
] as const)
  test(`Discord signed but invalid interaction rejects: ${name}`, () => {
    const s = signed(body);
    assert.throws(() => verifyDiscordInteraction(s.raw, s.headers, authority, now.getTime()));
  });
for (const [name, change] of [
  [
    "tampered raw bytes",
    (s: ReturnType<typeof signed>) => {
      s.raw += " ";
    },
  ],
  [
    "bad signature",
    (s: ReturnType<typeof signed>) => {
      s.headers["x-signature-ed25519"] = "0".repeat(128);
    },
  ],
  [
    "missing timestamp",
    (s: ReturnType<typeof signed>) => {
      s.headers["x-signature-timestamp"] = "";
    },
  ],
] as const)
  test(`Discord rejects ${name}`, () => {
    const s = signed(command);
    change(s);
    assert.throws(
      () => verifyDiscordInteraction(s.raw, s.headers, authority, now.getTime()),
      failure("authorization_required"),
    );
  });
for (const delta of [-301000, 301000])
  test(`Discord rejects old/future signed timestamp ${delta}`, () => {
    const s = signed(command, String((now.getTime() + delta) / 1000));
    assert.throws(
      () => verifyDiscordInteraction(s.raw, s.headers, authority, now.getTime()),
      failure("authorization_required"),
    );
  });
test("Discord key trusted pair mismatch and invalid UTF8 do not produce facts", () => {
  const s = signed(command);
  assert.throws(
    () =>
      verifyDiscordInteraction(
        s.raw,
        s.headers,
        { ...authority, applicationId: "100099" },
        now.getTime(),
      ),
    failure("authorization_required"),
  );
  const raw = Buffer.from([255, 255]),
    timestamp = String(now.getTime() / 1000),
    signature = sign(null, Buffer.concat([Buffer.from(timestamp), raw]), keys.privateKey).toString(
      "hex",
    );
  assert.throws(
    () =>
      verifyDiscordInteraction(
        raw,
        { "x-signature-timestamp": timestamp, "x-signature-ed25519": signature },
        authority,
        now.getTime(),
      ),
    failure("authorization_required"),
  );
});
function tgRequest(pinned: unknown, calls: NativeRequest[] = []) {
  return async (r: NativeRequest): Promise<NativeResponse> => {
    calls.push(r);
    let result: unknown;
    if (r.path === "/getMe") result = tgBot;
    else if (r.path === "/getChat")
      result = { ...tgChat, ...(pinned === undefined ? {} : { pinned_message: pinned }) };
    else if (r.path === "/getChatMember") result = tgMember;
    else throw Error("No second inbound consumer");
    return { status: 200, headers: new Headers(), body: { ok: true, result } };
  };
}
const pinned = (message_id: number, text = "Fixture") => ({
  message_id,
  date: 1792281600,
  chat: { id: Number(CHAT), type: "supergroup" },
  text,
});
test("Telegram pinned reader baselines without historic event, detects edit/unpin and retries deterministically", async () => {
  const p = principal("telegram-bot"),
    calls: NativeRequest[] = [];
  const baseline = await pollTelegramPinned(tgRequest(pinned(1), calls), p, CHAT, {}, now);
  assert.deepEqual(baseline.observations, []);
  assert.equal(baseline.nextPollAt.getTime() - now.getTime(), 60000);
  const same = await pollTelegramPinned(tgRequest(pinned(1)), p, CHAT, baseline.state, now);
  assert.deepEqual(same.observations, []);
  const edited = await pollTelegramPinned(tgRequest(pinned(1, "Edited")), p, CHAT, same.state, now);
  assert.equal(edited.observations.length, 1);
  assert.equal(edited.observations[0]!.messageId, "1");
  const retry = await pollTelegramPinned(tgRequest(pinned(1, "Edited")), p, CHAT, same.state, now);
  assert.deepEqual(retry, edited);
  const unpin = await pollTelegramPinned(tgRequest(undefined), p, CHAT, edited.state, now);
  assert.equal(unpin.observations[0]!.messageId, null);
  const repin = await pollTelegramPinned(tgRequest(pinned(1, "Edited")), p, CHAT, unpin.state, now);
  assert.notEqual(repin.observations[0]!.eventIdentity, edited.observations[0]!.eventIdentity);
  assert.ok(calls.every((r) => !r.path.includes("getUpdates") && !r.path.includes("Webhook")));
  assert.equal("text" in repin.observations[0]!, false);
});
test("Telegram changed config resets baseline; foreign pinned identity fails closed", async () => {
  const p = principal("telegram-bot"),
    old = await pollTelegramPinned(tgRequest(pinned(1)), p, CHAT, {}, now);
  p.context.configRevision = 2;
  const reset = await pollTelegramPinned(tgRequest(pinned(2)), p, CHAT, old.state, now);
  assert.deepEqual(reset.observations, []);
  await assert.rejects(
    pollTelegramPinned(
      tgRequest({ ...pinned(2), chat: { id: 100099 } }),
      p,
      CHAT,
      reset.state,
      now,
    ),
    failure("incomplete_response"),
  );
});
function dRequest(
  messages: (r: NativeRequest) => unknown[],
  calls: NativeRequest[] = [],
  overrides: Data = {},
) {
  return async (r: NativeRequest): Promise<NativeResponse> => {
    calls.push(r);
    const value =
      r.path === "/users/@me"
        ? bot
        : r.path === `/channels/${CHANNEL}`
          ? { ...channel, ...overrides }
          : r.path === `/guilds/${GUILD}/members/${BOT}`
            ? member
            : r.path === `/guilds/${GUILD}/roles`
              ? roles
              : r.path === `/channels/${CHANNEL}/messages`
                ? messages(r)
                : (() => {
                    throw Error("No gateway/unknown API");
                  })();
    return { status: 200, headers: new Headers(), body: value };
  };
}
const dm = (id: number, extra: Data = {}) => ({
  id: String(id),
  channel_id: CHANNEL,
  author: { id: "100011" },
  type: 0,
  timestamp: now.toISOString(),
  content: "private",
  ...extra,
});
async function baselineDiscord() {
  const p = principal("discord"),
    baseline = await pollDiscordMessages(
      dRequest(() => [dm(100100)]),
      p,
      CHANNEL,
      {},
      new Date(0),
      now,
    );
  return { p, baseline };
}
test("Discord reader baselines without history; reads full paged interval before cursor and excludes self/system", async () => {
  const { p, baseline } = await baselineDiscord();
  assert.deepEqual(baseline.observations, []);
  const calls: NativeRequest[] = [];
  const rows = Array.from({ length: 300 }, (_, i) =>
    dm(100350 - i, i === 10 ? { author: { id: BOT } } : i === 11 ? { type: 7 } : {}),
  );
  const next = await pollDiscordMessages(
    dRequest((r) => {
      const before = r.query?.before;
      return rows.filter((row) => !before || BigInt(row.id) < BigInt(String(before))).slice(0, 100);
    }, calls),
    p,
    CHANNEL,
    baseline.state,
    new Date(0),
    now,
  );
  assert.equal(next.state.lastMessageId, "100350");
  assert.equal(next.observations.length, 248);
  assert.equal(next.observations[0]!.messageId, "100101");
  assert.equal(next.observations.at(-1)!.messageId, "100350");
  assert.equal(calls.filter((r) => r.path.endsWith("/messages")).length, 3);
  assert.ok(next.observations.every((row) => !("content" in row)));
  const retry = await pollDiscordMessages(
    dRequest((r) =>
      rows
        .filter((row) => !r.query?.before || BigInt(row.id) < BigInt(String(r.query.before)))
        .slice(0, 100),
    ),
    p,
    CHANNEL,
    baseline.state,
    new Date(0),
    now,
  );
  assert.deepEqual(next, retry);
});
test("Discord reader empty page leaves cursor; armedAt suppresses old messages but advances examined interval", async () => {
  const { p, baseline } = await baselineDiscord();
  const same = await pollDiscordMessages(
    dRequest(() => []),
    p,
    CHANNEL,
    baseline.state,
    new Date(0),
    now,
  );
  assert.equal(same.state.lastMessageId, "100100");
  const older = await pollDiscordMessages(
    dRequest(() => [dm(100101, { timestamp: "2026-10-17T00:00:00Z" })]),
    p,
    CHANNEL,
    baseline.state,
    now,
    now,
  );
  assert.deepEqual(older.observations, []);
  assert.equal(older.state.lastMessageId, "100101");
});
for (const [name, rows] of [
  ["foreign channel", [dm(100101, { channel_id: "100099" })]],
  ["duplicate ID", [dm(100101), dm(100101)]],
  ["invalid timestamp", [dm(100101, { timestamp: "invalid" })]],
  ["missing author", [dm(100101, { author: undefined })]],
] as const)
  test(`Discord reader incomplete interval retains original cursor: ${name}`, async () => {
    const { p, baseline } = await baselineDiscord(),
      before = structuredClone(baseline.state);
    await assert.rejects(
      pollDiscordMessages(
        dRequest(() => [...rows]),
        p,
        CHANNEL,
        baseline.state,
        new Date(0),
        now,
      ),
      failure("incomplete_response"),
    );
    assert.deepEqual(baseline.state, before);
  });
test("Discord pagination nonprogress and 100-page bound never return partial observations or advance saved state", async () => {
  const { p, baseline } = await baselineDiscord(),
    saved = structuredClone(baseline.state);
  const duplicatePage = Array.from({ length: 100 }, (_, i) => dm(100300 - i));
  await assert.rejects(
    pollDiscordMessages(
      dRequest(() => duplicatePage),
      p,
      CHANNEL,
      baseline.state,
      new Date(0),
      now,
    ),
    failure("incomplete_response"),
  );
  assert.deepEqual(baseline.state, saved);
  let page = 0;
  const request = dRequest(() => {
    const result = Array.from({ length: 100 }, (_, i) => dm(110100 - 100 * page - i));
    page++;
    return result;
  });
  await assert.rejects(
    pollDiscordMessages(request, p, CHANNEL, baseline.state, new Date(0), now),
    failure("incomplete_response"),
  );
  assert.equal(page, 100);
  assert.deepEqual(baseline.state, saved);
});
test("Discord corrupted cursor and changed config are handled explicitly", async () => {
  const { p, baseline } = await baselineDiscord();
  await assert.rejects(
    pollDiscordMessages(
      dRequest(() => {
        throw Error("Must not read a corrupted cursor");
      }),
      p,
      CHANNEL,
      { ...baseline.state, lastMessageId: "invalid" },
      new Date(0),
      now,
    ),
    failure("incomplete_response"),
  );
  p.context.configRevision = 2;
  const reset = await pollDiscordMessages(
    dRequest(() => [dm(100102)]),
    p,
    CHANNEL,
    baseline.state,
    new Date(0),
    now,
  );
  assert.deepEqual(reset.observations, []);
  assert.equal(reset.state.lastMessageId, "100102");
});
for (const platform of ["telegram-bot", "discord"] as const)
  test(`${platform}: poll requires current owner read policy and exact bound target`, async () => {
    const p = principal(platform);
    let calls = 0;
    const request = async (): Promise<NativeResponse> => {
      calls++;
      throw Error("No unauthorized poll");
    };
    p.capabilities = [];
    await assert.rejects(
      platform === "discord"
        ? pollDiscordMessages(request, p, CHANNEL)
        : pollTelegramPinned(request, p, CHAT),
      failure("insufficient_scope"),
    );
    p.capabilities = ["read"];
    await assert.rejects(
      platform === "discord"
        ? pollDiscordMessages(request, p, "100099")
        : pollTelegramPinned(request, p, "-100099"),
      failure("insufficient_scope"),
    );
    assert.equal(calls, 0);
  });
test("Discord polling rechecks current overwrite access every time", async () => {
  const { p, baseline } = await baselineDiscord();
  await assert.rejects(
    pollDiscordMessages(
      dRequest(() => [], [], {
        permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: "65536" }],
      }),
      p,
      CHANNEL,
      baseline.state,
      new Date(0),
      now,
    ),
    failure("insufficient_scope"),
  );
});
