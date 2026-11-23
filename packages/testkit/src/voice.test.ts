import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SCRIPTED_MPEG,
  SCRIPTED_TRANSCRIPT,
  SCRIPTED_VOICE_ID,
  ScriptedVoiceProvider,
} from "@rakazo/adapters";
import type {
  UpdateVoiceDefaultsInput,
  UpdateVoiceDefaultsResult,
  VoiceDefaults,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeVoice = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeVoice("voice credentials and speech HTTP", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-voice-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = handles.prisma;
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("connects a scripted key, speaks, and transcribes without leaking the secret", async () => {
    const cookie = await signup(app, `voice-${stamp}@rakazo.test`, "Voice User");
    const other = await signup(app, `voice-other-${stamp}@rakazo.test`, "Other Voice");

    const before = await rpc<{ ready: boolean; utterances: string[] }>(
      app,
      cookie,
      "voice/prepare",
      { text: "Hello there." },
    );
    expect(before).toEqual({ ready: false, utterances: [] });

    const catalog = await rpc<Array<{ id: string }>>(app, cookie, "voice/catalog");
    expect(catalog.map((entry) => entry.id)).toContain("scripted");

    const connected = await rpc<{ hasKey: boolean; provider: string; voiceId: string }>(
      app,
      cookie,
      "voice/connect",
      { provider: "scripted", apiKey: "fake-scripted-voice-key" },
    );
    expect(connected.hasKey).toBe(true);
    expect(connected.provider).toBe("scripted");
    expect(connected.voiceId).toBe(SCRIPTED_VOICE_ID);
    expect(JSON.stringify(connected)).not.toContain("fake-scripted-voice-key");

    const credentials = await rpc<Array<{ hasKey: boolean; voiceId: string }>>(
      app,
      cookie,
      "voice/credentials",
    );
    expect(credentials).toEqual([
      expect.objectContaining({ hasKey: true, voiceId: SCRIPTED_VOICE_ID }),
    ]);
    expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

    const prepared = await rpc<{ ready: boolean; utterances: string[] }>(
      app,
      cookie,
      "voice/prepare",
      { text: "Hello there. How are you?" },
    );
    expect(prepared.ready).toBe(true);
    expect(prepared.utterances.length).toBeGreaterThan(0);

    const spoken = await app.request("/api/voice/speak", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ text: "Hello there." }),
    });
    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toContain("audio/mpeg");
    expect(Buffer.from(await spoken.arrayBuffer())).toEqual(Buffer.from(SCRIPTED_MPEG));

    const transcribed = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({
        audioBase64: Buffer.from("noise").toString("base64"),
        mimeType: "audio/webm",
      }),
    });
    expect(transcribed.status).toBe(200);
    expect(await transcribed.json()).toEqual({ text: SCRIPTED_TRANSCRIPT });

    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Speaker",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const stolen = await raw(app, other, "voice/prepare", {
      text: "stolen",
      botId: bot.id,
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);

    const unauth = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(unauth.status).toBe(401);
  });

  it("disconnects the actor credential and leaves another user's key in place", async () => {
    const cookie = await signup(app, `voice-disconnect-${stamp}@rakazo.test`, "Voice Disconnect");
    const other = await signup(
      app,
      `voice-disconnect-other-${stamp}@rakazo.test`,
      "Other Voice Disconnect",
    );
    const me = await rpc<{ userId: string }>(app, cookie, "me");

    await rpc(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "fake-scripted-voice-key",
    });
    const stored = await prisma.userVoiceCredential.findFirstOrThrow({
      where: { userId: me.userId, provider: "scripted" },
    });

    await expect(rpc(app, other, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
    await expect(
      prisma.userVoiceCredential.findUnique({ where: { id: stored.id } }),
    ).resolves.toMatchObject({ id: stored.id });
    await expect(
      prisma.secret.findUnique({ where: { id: stored.secretId } }),
    ).resolves.toMatchObject({ id: stored.secretId });

    await expect(rpc(app, cookie, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
    await expect(
      rpc<Array<{ provider: string }>>(app, cookie, "voice/credentials"),
    ).resolves.toEqual([]);
    await expect(
      prisma.userVoiceCredential.findUnique({ where: { id: stored.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.spaceVoicePreference.count({ where: { credentialId: stored.id } }),
    ).resolves.toBe(0);
    await expect(prisma.secret.findUnique({ where: { id: stored.secretId } })).resolves.toBeNull();

    const prepared = await rpc<{ ready: boolean }>(app, cookie, "voice/prepare", {
      text: "Hello there.",
    });
    expect(prepared.ready).toBe(false);

    await expect(rpc(app, cookie, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
  });

  it("serializes voice defaults with Space overrides and reuses the local connection only", async () => {
    const cookie = await signup(
      app,
      `voice-preferences-${stamp}@example.test`,
      "Voice Preferences",
    );
    const other = await signup(app, `voice-preferences-other-${stamp}@example.test`, "Other User");
    const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
    const second = await rpc<{ id: string }>(app, cookie, "spaces/create", { name: "Second" });
    const connected = await rpc<{ id: string }>(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "offline-voice-key",
    });
    const read = () => rpc<VoiceDefaults>(app, cookie, "voice/defaults");
    const write = (request: UpdateVoiceDefaultsInput) =>
      rpc<UpdateVoiceDefaultsResult>(app, cookie, "voice/updateDefaults", request);
    const initial = await read();
    const account = {
      scope: "account",
      value: { provider: "scripted", voiceId: "ember-test" },
      followingSpaceIds: initial.followingSpaces.map(({ id }) => id),
      expectedRevision: 0,
      clientNonce: "first-voice-default",
    } as const;
    const override = {
      scope: "space",
      enabled: true,
      expectedProvider: "scripted",
      expectedAccountRevision: 0,
      expectedRevision: 0,
      clientNonce: "copy-voice-default",
    } as const;
    const [edited, copied] = await Promise.all([write(account), write(override)]);
    expect([edited.status, copied.status].sort()).toEqual(["conflict", "updated"]);
    let committedRequest = account;
    if (edited.status === "conflict") {
      expect((await read()).effective).toEqual({
        source: "space",
        choice: { provider: "scripted", voiceId: SCRIPTED_VOICE_ID },
      });
      const current = await read();
      committedRequest = {
        ...account,
        followingSpaceIds: current.followingSpaces.map(({ id }) => id),
      };
      expect((await write(committedRequest)).status).toBe("updated");
    } else {
      expect((await write(account)).settings.account.revision).toBe(1);
      expect((await write({ ...override, expectedAccountRevision: 1 })).settings.effective).toEqual(
        { source: "space", choice: account.value },
      );
    }
    const current = await read();
    expect(
      (
        await write({
          ...override,
          enabled: false,
          expectedAccountRevision: 1,
          expectedRevision: current.space.revision,
          clientNonce: "resume-voice-default",
        })
      ).settings.effective,
    ).toEqual({ source: "account", choice: account.value });
    expect(
      (
        await write({
          ...account,
          value: { ...account.value, voiceId: "voice-outside-catalog" },
          followingSpaceIds: initial.followingSpaces.map(({ id }) => id),
          expectedRevision: 1,
          clientNonce: "unknown-voice",
        })
      ).status,
    ).toBe("unavailable");
    const listVoices = vi
      .spyOn(ScriptedVoiceProvider.prototype, "listVoices")
      .mockRejectedValue(new Error("Temporary catalog outage"));
    try {
      expect(await write(committedRequest)).toMatchObject({
        status: "updated",
        settings: { account: { revision: 1 } },
      });
      listVoices.mockResolvedValue([]);
      expect(await rpc(app, cookie, "voice/status")).toMatchObject({
        configured: true,
        ready: false,
        source: "account",
      });
      expect(
        await rpc(app, cookie, "voice/prepare", { text: "Voice removed from the catalog" }),
      ).toMatchObject({ ready: false });
    } finally {
      listVoices.mockRestore();
    }
    expect(await rpc<VoiceDefaults>(app, other, "voice/defaults")).toMatchObject({
      account: { value: null },
      effective: { source: "system", choice: null },
    });
    expect((await raw(app, other, "voice/defaults", {}, me.spaceId)).ok).toBe(false);
    const noBinding = await raw(app, cookie, "voice/prepare", { text: "Offline only" }, second.id);
    expect(await noBinding.json()).toMatchObject({ json: { ready: false } });

    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Explicit Speaker",
      title: "",
      description: "",
      instructions: "",
    });
    await prisma.bot.update({ where: { id: bot.id }, data: { voiceId: "local-voice" } });
    // Simulate a different active provider in the target Space without any network requests.
    await prisma.userVoiceCredential.update({
      where: { id: connected.id },
      data: { provider: "openai" },
    });
    expect(await rpc(app, cookie, "voice/status")).toMatchObject({
      configured: true,
      ready: false,
    });
    expect((await read()).effective).toEqual({ source: "account", choice: null });
    expect(await rpc(app, cookie, "voice/prepare", { text: "Missing compatible voice" })).toEqual({
      ready: false,
      utterances: [],
    });
    expect(
      await rpc(app, cookie, "voice/prepare", { text: "Explicit voice", botId: bot.id }),
    ).toMatchObject({ ready: true, voice: { provider: "openai", voiceId: "local-voice" } });
    const stale = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        text: "Pinned chunk",
        voiceId: "ember-test",
        voiceProvider: "scripted",
      }),
    });
    expect(stale.status).toBe(409);
    await prisma.userVoiceCredential.update({
      where: { id: connected.id },
      data: { provider: "scripted" },
    });
    await expect(
      write({
        ...account,
        value: null,
        expectedRevision: 1,
        clientNonce: "clear-voice-default",
      }),
    ).resolves.toMatchObject({ status: "updated" });
  });

  it("freezes only a verified inherited choice before a downgrade", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      ["host", "port", "dbname", "database"].some((key) => url.searchParams.has(key)) ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE
    ) {
      throw new Error("Voice preference freeze requires an isolated integration database");
    }
    const cookie = await signup(app, `voice-freeze-${stamp}@example.test`, "Voice Freeze");
    const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
    const local = await rpc<{ id: string }>(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "offline-voice-key",
    });
    const settings = await rpc<VoiceDefaults>(app, cookie, "voice/defaults");
    await expect(
      rpc(app, cookie, "voice/updateDefaults", {
        scope: "account",
        value: { provider: "scripted", voiceId: "ember-test" },
        followingSpaceIds: settings.followingSpaces.map(({ id }) => id),
        expectedRevision: 0,
        clientNonce: "verified-voice-choice",
      }),
    ).resolves.toMatchObject({ status: "updated" });
    await expect(
      rpc(app, cookie, "voice/prepare", { text: "Verify the inherited voice" }),
    ).resolves.toMatchObject({
      ready: true,
      voice: { provider: "scripted", voiceId: "ember-test" },
    });
    const key = {
      spaceId_userId_credentialId: {
        spaceId: me.spaceId,
        userId: me.userId,
        credentialId: local.id,
      },
    };
    const freeze = await readFile(
      new URL("../../db/prisma/operations/freeze-voice-defaults.sql", import.meta.url),
      "utf8",
    );
    const db = createDb(process.env.DATABASE_URL!);
    const session = await db.pool.connect();
    try {
      expect((await session.query("SELECT current_database() AS name")).rows[0]?.name).toBe(
        database,
      );
      await session.query(`
        CREATE TEMP TABLE voice_freeze_verified (
          space_id text, user_id text, provider text, voice_id text,
          credential_id text, credential_updated_at timestamp(3)
        )`);
      await expect(session.query(freeze)).rejects.toThrow("Resolve or verify");
      await session.query("ROLLBACK");
      expect(await prisma.spaceVoicePreference.findUniqueOrThrow({ where: key })).toMatchObject({
        voiceId: SCRIPTED_VOICE_ID,
      });
      const active = await prisma.userVoiceCredential.findUniqueOrThrow({
        where: { id: local.id },
      });
      // This database is shared by the file's tests. Only this case's rows should follow at freeze time.
      await session.query(
        `INSERT INTO voice_freeze_verified
         SELECT preference."spaceId", preference."userId", credential.provider,
           owner."voiceDefaultHistory" -> 0 -> 'value' ->> 'voiceId', credential.id, credential."updatedAt"
         FROM public.space_voice_preferences AS preference
         JOIN public.user_voice_credentials AS credential ON credential.id = preference."credentialId"
         JOIN public."user" AS owner ON owner.id = preference."userId"
         WHERE preference."isDefault" AND preference."userId" = $1 AND preference."spaceId" = $2`,
        [me.userId, me.spaceId],
      );
      await session.query(`UPDATE voice_freeze_verified SET credential_updated_at =
        credential_updated_at - interval '1 second'`);
      await expect(session.query(freeze)).rejects.toThrow("Resolve or verify");
      await session.query("ROLLBACK");
      expect(await prisma.spaceVoicePreference.findUniqueOrThrow({ where: key })).toMatchObject({
        voiceId: SCRIPTED_VOICE_ID,
      });
      await session.query(`UPDATE voice_freeze_verified SET credential_updated_at =
        credential_updated_at + interval '1 second'`);
      await session.query(freeze);
      await session.query(freeze);
      expect(await prisma.spaceVoicePreference.findUniqueOrThrow({ where: key })).toMatchObject({
        voiceId: "ember-test",
      });
      expect(
        await prisma.userVoiceCredential.findUniqueOrThrow({ where: { id: local.id } }),
      ).toEqual(active);
      expect(await rpc<VoiceDefaults>(app, cookie, "voice/defaults")).toMatchObject({
        account: { revision: 1 },
        effective: { source: "account" },
      });
    } finally {
      await session.query("ROLLBACK");
      session.release();
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}

async function raw(app: App, cookie: string, proc: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
}
