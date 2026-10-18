import assert from "node:assert/strict";
import type { NativeActionContext, NativeRequest, NativeResponse } from "../action.js";
import { NativeActionError } from "../action.js";
import type { Data } from "../collaboration-action.js";
import discord from "./discord.test-fixtures.json" with { type: "json" };
import telegram from "./telegram-bot.test-fixtures.json" with { type: "json" };
export const suites = { "telegram-bot": telegram, discord };
export interface Fixture {
  id: string;
  input: Data;
  steps: Step[];
  output: Data;
}
export interface Step {
  request: NativeRequest & {
    multipart?: {
      fields: Record<string, string>;
      files: Record<string, { name: string; text: string; type: string }>;
    };
  };
  response: { status: number; body: unknown };
}
export const BOT = "100001",
  APP = "100002",
  GUILD = "100003",
  CHANNEL = "100004",
  MESSAGE = "100005",
  CHAT = "-1001234567890";
export const ALL_PERMISSIONS = String(1024 + 2048 + 8192 + 32768 + 65536 + 64);
export const bot = { id: BOT, bot: true, username: "fixture_bot" };
export const application = { id: APP, bot, verify_key: "1".repeat(64) };
export const channel = {
  id: CHANNEL,
  guild_id: GUILD,
  type: 0,
  name: "fixture",
  permission_overwrites: [],
};
export const member = { user: bot, roles: [], pending: false, communication_disabled_until: null };
export const roles = [{ id: GUILD, permissions: ALL_PERMISSIONS }];
export const tgBot = { id: 100001, is_bot: true, username: "fixture_bot", first_name: "Fixture" };
export const tgChat = {
  id: Number(CHAT),
  type: "supergroup",
  title: "Fixture",
  permissions: { can_send_messages: true, can_send_documents: true },
};
export const tgMember = { user: tgBot, status: "administrator" };
export const failure = (kind: string) => (e: unknown) =>
  e instanceof NativeActionError && e.kind === kind;
export function principal(app: "telegram-bot" | "discord"): NativeActionContext["principal"] {
  return {
    subject: BOT,
    tenant: app === "discord" ? GUILD : null,
    scopes: [],
    capabilities: ["read", "send", "edit", "delete", "files", "reactions", "commands"],
    knowledgeBaseIds: [],
    context: {
      actorType: "bot",
      credentialType: "bot_token",
      scopeAuthority: "provider_enforced",
      botId: BOT,
      boundSpaceId: "fixture-space",
      configRevision: 1,
      verifiedTargets: [
        {
          id: app === "discord" ? CHANNEL : CHAT,
          ...(app === "discord" ? { guildId: GUILD } : {}),
        },
      ],
      ...(app === "discord"
        ? {
            bindingNamespace: "guild",
            applicationId: APP,
            interactionPublicKey: application.verify_key,
          }
        : {}),
    },
  };
}
export function context(
  app: "telegram-bot" | "discord",
  request: NativeActionContext["request"],
  receipts: Data[] = [],
): NativeActionContext {
  return {
    operationId: "fixture-operation",
    signal: new AbortController().signal,
    principal: principal(app),
    request,
    checkpoint: async (r) => {
      receipts.push(structuredClone(r));
    },
    callMcp: async () => {
      throw Error("No forwarding");
    },
    readArtifact: async (id) => {
      assert.equal(id, "fixture-artifact");
      return {
        name: "fixture.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("abc"),
      };
    },
    writeArtifact: async (i) => {
      assert.equal(new TextDecoder().decode(i.bytes), "abc");
      return { id: "new-artifact", name: i.name, mimeType: i.mimeType, size: i.bytes.byteLength };
    },
    downloadResource: async (i) => {
      assert.match(i.url, /^https:\/\/cdn\.discordapp\.com\/attachments\/100004\/100006\//);
      return { bytes: new TextEncoder().encode("abc"), mimeType: "text/plain" };
    },
    validateResourceUrl: async () => {
      throw Error("No arbitrary URL");
    },
  };
}
export const response = (step: Step): NativeResponse => ({
  status: step.response.status,
  body: structuredClone(step.response.body),
  headers: new Headers(),
});
export function subset(expected: unknown, actual: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((v, i) => {
      subset(v, actual[i]);
    });
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [k, v] of Object.entries(expected)) subset(v, (actual as Data)[k]);
  } else assert.deepEqual(actual, expected);
}
export async function assertRequest(actual: NativeRequest, step: Step): Promise<void> {
  const expected = step.request;
  if (expected.multipart) {
    const form = actual.body;
    assert.ok(form instanceof FormData);
    const { multipart, ...rest } = expected;
    assert.deepEqual({ ...actual, body: undefined }, { ...rest, body: undefined });
    assert.equal(
      [...form.keys()].length,
      Object.keys(multipart.fields).length + Object.keys(multipart.files).length,
    );
    for (const [k, v] of Object.entries(multipart.fields)) assert.equal(form.get(k), v);
    for (const [k, v] of Object.entries(multipart.files)) {
      const file = form.get(k);
      assert.ok(file instanceof Blob);
      assert.equal((file as File).name, v.name);
      assert.equal(file.type, v.type);
      assert.equal(await file.text(), v.text);
    }
  } else assert.deepEqual(actual, expected);
}
