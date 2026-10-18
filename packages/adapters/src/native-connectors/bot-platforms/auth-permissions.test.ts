import assert from "node:assert/strict";
import type { NativeAppConfig } from "@rakazo/db";
import { it as test, vi } from "vitest";
import type { NativeRequest, NativeResponse } from "../action.js";
import type { Data } from "../collaboration-action.js";
import { BotPlatformAuthorities } from "./auth.js";
import {
  discordPermissions,
  discordTarget,
  PERMISSIONS,
  requireDiscord,
  telegramPermission,
  telegramResult,
} from "./permissions.js";
import {
  ALL_PERMISSIONS,
  APP,
  application,
  BOT,
  bot,
  CHANNEL,
  CHAT,
  channel,
  failure,
  GUILD,
  member,
  roles,
  tgBot,
  tgChat,
  tgMember,
} from "./testing.js";

const config = (appId: "telegram-bot" | "discord", extra: Data = {}): NativeAppConfig =>
  ({
    id: "fixture-config",
    appId,
    ownership: "official",
    credentialKind: "bot_token",
    label: "Fixture",
    enabled: true,
    callbackUri: null,
    revision: 3,
    config: {
      actor: "bot",
      boundSpaceId: "fixture-space",
      targetIds: [appId === "discord" ? CHANNEL : CHAT],
      scopes: [],
      capabilities: ["read", "send"],
      knowledgeBaseIds: [],
      ...(appId === "discord" ? { tenantId: GUILD } : {}),
      ...extra,
    },
  }) as unknown as NativeAppConfig;
const telegramValues = () => [
  { ok: true, result: tgBot },
  { ok: true, result: tgChat },
  { ok: true, result: tgMember },
];
const discordValues = () => [bot, application, channel, member, roles];
function setup(values: unknown[]) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    assert.ok(values.length, "No extra identity requests");
    const value = values.shift();
    return value instanceof Response
      ? value
      : new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  });
  return {
    fetch,
    authority: new BotPlatformAuthorities({
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    }),
  };
}
for (const appId of ["telegram-bot", "discord"] as const) {
  test(`${appId}: verifies actual bot and every owner target, returns actual empty scopes and Space binding`, async () => {
    const { authority, fetch } = setup(appId === "discord" ? discordValues() : telegramValues());
    const result = await authority.verifyStatic(
      config(appId),
      appId === "discord" ? "fixture-token" : "100001:fixture-token",
      new AbortController().signal,
    );
    assert.deepEqual(result.scopes, []);
    assert.equal(result.expiresAt, null);
    assert.equal(result.identity.subject, BOT);
    assert.equal(result.identity.context.boundSpaceId, "fixture-space");
    assert.equal(result.identity.context.configRevision, 3);
    assert.equal(result.identity.context.scopeAuthority, "provider_enforced");
    assert.equal(result.identity.context.actorType, "bot");
    const targets = result.identity.context.verifiedTargets as Data[];
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.id, appId === "discord" ? CHANNEL : CHAT);
    if (appId === "discord") {
      assert.equal(result.identity.tenant, GUILD);
      assert.equal(result.identity.context.bindingNamespace, "guild");
      assert.equal(result.identity.context.applicationId, APP);
      assert.equal(result.identity.context.interactionPublicKey, application.verify_key);
    }
    for (const [url, init] of fetch.mock.calls) {
      const actual = new URL(String(url));
      assert.equal(
        actual.origin,
        appId === "discord" ? "https://discord.com" : "https://api.telegram.org",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        appId === "discord" ? "Bot fixture-token" : null,
      );
      assert.equal(actual.searchParams.has("access_token"), false);
      if (appId === "telegram-bot")
        assert.ok(actual.pathname.startsWith("/bot100001:fixture-token/"));
    }
    await authority.close();
  });
  for (const extra of [
    { boundSpaceId: undefined },
    { actor: "user" },
    { targetIds: [] },
    { targetIds: ["https://example.test"] },
    { targetIds: [appId === "discord" ? CHANNEL : CHAT, appId === "discord" ? CHANNEL : CHAT] },
  ])
    test(`${appId}: rejects invalid owner binding ${JSON.stringify(extra)}`, async () => {
      const { authority, fetch } = setup([]);
      await assert.rejects(
        authority.verifyStatic(config(appId, extra), "fixture-token", new AbortController().signal),
      );
      assert.equal(fetch.mock.calls.length, 0);
    });
  test(`${appId}: no partial grant if any configured target cannot be verified`, async () => {
    const values = appId === "discord" ? discordValues() : telegramValues();
    values.push(new Response("denied", { status: 403 }) as never);
    const { authority } = setup(values);
    await assert.rejects(
      authority.verifyStatic(
        config(appId, {
          targetIds: [
            appId === "discord" ? CHANNEL : CHAT,
            appId === "discord" ? "100099" : "-100099",
          ],
        }),
        appId === "discord" ? "fixture-token" : "100001:fixture-token",
        new AbortController().signal,
      ),
    );
  });
}
for (const [name, mutate] of [
  [
    "non-bot identity",
    (v: unknown[]) => {
      v[0] = { ...bot, bot: false };
    },
  ],
  [
    "application belongs to another bot",
    (v: unknown[]) => {
      v[1] = { ...application, bot: { id: "100099" } };
    },
  ],
  [
    "application omitted verification key",
    (v: unknown[]) => {
      v[1] = { ...application, verify_key: undefined };
    },
  ],
  [
    "channel belongs to another guild",
    (v: unknown[]) => {
      v[2] = { ...channel, guild_id: "100099" };
    },
  ],
  [
    "DM channel",
    (v: unknown[]) => {
      v[2] = { ...channel, type: 1, guild_id: undefined };
    },
  ],
  [
    "guild member changed",
    (v: unknown[]) => {
      v[3] = { ...member, user: { id: "100099" } };
    },
  ],
  [
    "view denied by overwrite",
    (v: unknown[]) => {
      v[2] = {
        ...channel,
        permission_overwrites: [{ id: GUILD, type: 0, deny: "1024", allow: "0" }],
      };
    },
  ],
  [
    "missing guild role proof",
    (v: unknown[]) => {
      v[4] = [];
    },
  ],
] as Array<[string, (values: unknown[]) => void]>)
  test(`Discord authorization closed: ${name}`, async () => {
    const values: unknown[] = discordValues();
    mutate(values);
    const { authority } = setup(values);
    await assert.rejects(
      authority.verifyStatic(config("discord"), "fixture-token", new AbortController().signal),
    );
  });
for (const [name, proof] of [
  ["not a bot", { ...tgBot, is_bot: false }],
  ["missing stable ID", { ...tgBot, id: undefined }],
] as const)
  test(`Telegram authorization closed: ${name}`, async () => {
    const values: unknown[] = telegramValues();
    values[0] = { ok: true, result: proof };
    const { authority } = setup(values);
    await assert.rejects(
      authority.verifyStatic(
        config("telegram-bot"),
        "100001:fixture-token",
        new AbortController().signal,
      ),
    );
  });
for (const status of ["left", "kicked", "restricted"])
  test(`Telegram rejects nonmember ${status}`, async () => {
    const values: unknown[] = telegramValues();
    values[2] = { ok: true, result: { ...tgMember, status, is_member: false } };
    const { authority } = setup(values);
    await assert.rejects(
      authority.verifyStatic(
        config("telegram-bot"),
        "100001:fixture-token",
        new AbortController().signal,
      ),
      failure("insufficient_scope"),
    );
  });
test("Telegram private chats require exact getChat identity without invented membership lookup", async () => {
  const { authority, fetch } = setup([
    { ok: true, result: tgBot },
    { ok: true, result: { id: 100090, type: "private", first_name: "Fixture" } },
  ]);
  const grant = await authority.verifyStatic(
    config("telegram-bot", { targetIds: ["100090"] }),
    "100001:fixture-token",
    new AbortController().signal,
  );
  assert.equal(fetch.mock.calls.length, 2);
  assert.equal((grant.identity.context.verifiedTargets as Data[])[0]!.id, "100090");
});
test("Discord ordered overwrites combine roles, then member allow; administrator bypasses overwrites", () => {
  const r = [
      { id: GUILD, permissions: String(PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES) },
      { id: "100007", permissions: "0" },
      { id: "100009", permissions: "0" },
    ],
    m = { ...member, roles: ["100007", "100009"] };
  const p = discordPermissions(GUILD, BOT, m, r, [
    { id: GUILD, type: 0, deny: "2048", allow: "0" },
    { id: "100007", type: 0, deny: "1024", allow: "2048" },
    { id: "100009", type: 0, deny: "2048", allow: "1024" },
    { id: BOT, type: 1, deny: "2048", allow: "0" },
  ]);
  assert.equal(p, 1024n);
  const admin = discordPermissions(
    GUILD,
    BOT,
    member,
    [{ id: GUILD, permissions: "8" }],
    [{ id: GUILD, type: 0, deny: ALL_PERMISSIONS, allow: "0" }],
  );
  assert.ok(admin & PERMISSIONS.VIEW_CHANNEL);
  assert.ok(admin & PERMISSIONS.SEND_MESSAGES);
});
test("Discord active timeout permits read only and expired timeout does not revoke writes", () => {
  const timed = discordPermissions(
    GUILD,
    BOT,
    { ...member, communication_disabled_until: new Date(Date.now() + 60000).toISOString() },
    roles,
    [],
  );
  assert.equal(timed, PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.READ_MESSAGE_HISTORY);
  const expired = discordPermissions(
    GUILD,
    BOT,
    { ...member, communication_disabled_until: new Date(0).toISOString() },
    roles,
    [],
  );
  assert.ok(expired & PERMISSIONS.SEND_MESSAGES);
});
for (const malformed of [
  [],
  [{ id: GUILD, permissions: "not-decimal" }],
  [{ id: GUILD, permissions: 1024 }],
])
  test(`Discord malformed role evidence rejects ${JSON.stringify(malformed)}`, () => {
    assert.throws(
      () => discordPermissions(GUILD, BOT, member, malformed, []),
      failure("incomplete_response"),
    );
  });
test("Discord private thread inherits parent overwrites and requires actual thread membership", async () => {
  const calls: NativeRequest[] = [];
  let values: unknown[] = [
    {
      ...channel,
      type: 12,
      parent_id: "100010",
      thread_metadata: { archived: false, locked: false },
    },
    {
      ...channel,
      id: "100010",
      permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: "2048" }],
    },
    member,
    roles,
    { id: CHANNEL, user_id: BOT },
  ];
  const request = async (r: NativeRequest): Promise<NativeResponse> => {
    calls.push(r);
    return { status: 200, body: values.shift(), headers: new Headers() };
  };
  const proof = await discordTarget(request, BOT, GUILD, CHANNEL);
  assert.equal(proof.permissions & PERMISSIONS.SEND_MESSAGES, 0n);
  assert.equal(calls.at(-1)?.path, `/channels/${CHANNEL}/thread-members/@me`);
  values = [
    { ...channel, type: 12, parent_id: "100010" },
    { ...channel, id: "100010" },
    member,
    roles,
    { user_id: "100099" },
  ];
  await assert.rejects(discordTarget(request, BOT, GUILD, CHANNEL), failure("insufficient_scope"));
});
for (const [name, change] of [
  ["missing SEND permission", { permissions: 1024n }],
  ["pending membership", { member: { ...member, pending: true } }],
  ["archived thread", { channel: { ...channel, type: 11, thread_metadata: { archived: true } } }],
  ["locked thread", { channel: { ...channel, type: 11, thread_metadata: { locked: true } } }],
] as const)
  test(`Discord write guard ${name}`, () => {
    assert.throws(
      () =>
        requireDiscord(
          { channel, member, permissions: BigInt(ALL_PERMISSIONS), ...change },
          PERMISSIONS.SEND_MESSAGES,
          true,
        ),
      failure("insufficient_scope"),
    );
  });
for (const [name, proof, op] of [
  [
    "channel post",
    { chat: { type: "channel" }, member: { status: "administrator", can_post_messages: false } },
    "send",
  ],
  [
    "restricted send",
    { chat: { type: "supergroup" }, member: { status: "restricted", can_send_messages: false } },
    "send",
  ],
  [
    "restricted files",
    {
      chat: { type: "supergroup" },
      member: { status: "restricted", can_send_messages: true, can_send_documents: false },
    },
    "files",
  ],
] as const)
  test(`Telegram live permissions ${name}`, () => {
    assert.throws(() => telegramPermission(proof, op), failure("insufficient_scope"));
  });
for (const [code, kind] of [
  [401, "authorization_expired"],
  [403, "insufficient_scope"],
  [429, "rate_limited"],
  [500, "temporarily_unavailable"],
] as const)
  test(`Telegram envelope translates ${code}`, () => {
    assert.throws(
      () =>
        telegramResult({
          status: 200,
          headers: new Headers(),
          body: { ok: false, error_code: code, parameters: { retry_after: 7 } },
        }),
      (e) =>
        e instanceof Error &&
        "kind" in e &&
        e.kind === kind &&
        (code !== 429 || ("options" in e && (e.options as Data).retryAfterSeconds === 7)),
    );
  });
