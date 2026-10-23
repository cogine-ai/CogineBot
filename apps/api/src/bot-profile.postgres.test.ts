import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, ModelCredential } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { discardBotIntroFromCreate } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("independent bot profile HTTP acceptance", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let database: ReturnType<typeof createDb>;
  let dataDir: string;
  let beforeBotUpdate: ((args: Prisma.BotUpdateArgs) => Promise<void>) | undefined;
  let failEventForBot: string | undefined;
  const updateFailures: unknown[] = [];
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bot-profile-acceptance-"));
    database = createDb(process.env.DATABASE_URL!);
    const instrumented = database.prisma.$extends({
      query: {
        bot: {
          async update({ args, query }) {
            await beforeBotUpdate?.(args);
            try {
              return await query(args);
            } catch (error) {
              updateFailures.push(error);
              throw error;
            }
          },
        },
        event: {
          async create({ args, query }) {
            if (args.data.botId === failEventForBot && args.data.type === "bot.updated")
              throw Object.assign(new Error("Synthetic event write unavailable"), {
                code: "P2025",
              });
            return query(args);
          },
        },
      },
    });
    handles = await createApp({
      prisma: instrumented as unknown as PrismaClient,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-bot-profile-acceptance-key",
      webOrigin: origin,
      authUrl: origin,
    });
  });
  afterEach(() => {
    beforeBotUpdate = undefined;
    failEventForBot = undefined;
    updateFailures.length = 0;
  });
  afterAll(async () => {
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function account() {
    const email = `profile-${randomUUID()}@example.test`;
    const body = JSON.stringify({ email, password: "password12", name: "Profile tester" });
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body,
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const login = await handles.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body,
    });
    expect(login.ok).toBe(true);
    const otherCookie = sessionCookieHeader(login);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    return { cookie, otherCookie, me };
  }
  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await raw(cookie, procedure, input, spaceId);
    const text = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${text}`);
    const result = (JSON.parse(text) as { json: T }).json;
    return discardBotIntroFromCreate(handles, cookie, procedure, result);
  }
  function bot(cookie: string, extra: Record<string, unknown> = {}) {
    return rpc<Bot>(cookie, "bots/create", {
      name: "Profile bot",
      title: "Helper",
      description: "Public role",
      instructions: "Original rules",
      ...extra,
    });
  }
  function row(botId: string) {
    return database.prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  }
  function profileEvents(botId: string) {
    return database.prisma.event.findMany({
      where: { botId, type: "bot.updated" },
      orderBy: { seq: "asc" },
    });
  }

  it("preserves independent raw create fields, omitted legacy fallback, and explicit empty rules", async () => {
    const { cookie } = await account();
    const rawRules = " \nPrivate execution rules\n\n";
    const explicit = await bot(cookie, { instructions: rawRules });
    expect(await row(explicit.id)).toMatchObject({
      description: "Public role",
      instructions: rawRules,
    });
    const legacy = await rpc<Bot>(cookie, "bots/create", {
      name: "Legacy",
      description: "  Public fallback  ",
    });
    expect(await row(legacy.id)).toMatchObject({
      description: "Public fallback",
      instructions: "Public fallback",
    });
    const empty = await bot(cookie, { instructions: "" });
    expect((await row(empty.id)).instructions).toBe("");
    const whitespace = await bot(cookie, { instructions: " \n\n" });
    expect((await row(whitespace.id)).instructions).toBe(" \n\n");
  });

  it("keeps long rules when only public description changes and rejects oversized rules", async () => {
    const { cookie } = await account();
    const instructions = "R".repeat(20_000);
    const target = await bot(cookie, { instructions });
    const count = (await profileEvents(target.id)).length;
    await rpc(cookie, "bots/update", { botId: target.id, description: "New public role" });
    expect(await row(target.id)).toMatchObject({ description: "New public role", instructions });
    const tooLong = await raw(cookie, "bots/update", {
      botId: target.id,
      instructions: "R".repeat(20_001),
      expectedInstructions: instructions,
    });
    expect(tooLong.status).toBe(400);
    expect((await row(target.id)).instructions).toBe(instructions);
    expect(await profileEvents(target.id)).toHaveLength(count + 1);
  });

  it("rejects another session's stale mixed save without changing labels or adding an event", async () => {
    const { cookie, otherCookie } = await account();
    const target = await bot(cookie);
    const count = (await profileEvents(target.id)).length;
    await rpc(cookie, "bots/update", {
      botId: target.id,
      instructions: " \nWinner rules\n",
      expectedInstructions: "Original rules",
    });
    const losing = await raw(otherCookie, "bots/update", {
      botId: target.id,
      name: "Losing label",
      description: "Losing public role",
      instructions: "Losing rules",
      expectedInstructions: "Original rules",
    });
    expect(losing.status).toBe(409);
    const conflict = await losing.json();
    expect(conflict).toMatchObject({
      json: { code: "CONFLICT", data: { reason: "instructions_changed" } },
    });
    expect(JSON.stringify(conflict)).not.toContain("Winner rules");
    expect(JSON.stringify(conflict)).not.toContain("Original rules");
    expect(await row(target.id)).toMatchObject({
      name: "Profile bot",
      description: "Public role",
      instructions: " \nWinner rules\n",
    });
    const events = await profileEvents(target.id);
    expect(events).toHaveLength(count + 1);
    expect(events.at(-1)?.payload).toEqual({
      botId: target.id,
      name: "Profile bot",
      title: "Helper",
      description: "Public role",
    });
    expect(JSON.stringify(events)).not.toContain("Winner rules");
  });

  it("accepts exactly one concurrent rule writer with a single public invalidation", async () => {
    const { cookie, otherCookie } = await account();
    const target = await bot(cookie);
    const count = (await profileEvents(target.id)).length;
    const results = await Promise.all(
      [cookie, otherCookie].map((session, index) =>
        raw(session, "bots/update", {
          botId: target.id,
          instructions: `Candidate ${index}`,
          expectedInstructions: "Original rules",
        }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(["Candidate 0", "Candidate 1"]).toContain((await row(target.id)).instructions);
    expect(await profileEvents(target.id)).toHaveLength(count + 1);
  });

  it("distinguishes empty expected rules and keeps legacy writers compatible", async () => {
    const { cookie } = await account();
    const target = await bot(cookie, { instructions: "" });
    await rpc(cookie, "bots/update", {
      botId: target.id,
      instructions: " \nRules\n",
      expectedInstructions: "",
    });
    expect(
      (
        await raw(cookie, "bots/update", {
          botId: target.id,
          name: "Stale label",
          expectedInstructions: "",
        })
      ).status,
    ).toBe(409);
    expect((await row(target.id)).name).toBe("Profile bot");
    await rpc(cookie, "bots/update", { botId: target.id, instructions: "Legacy update" });
    expect((await row(target.id)).instructions).toBe("Legacy update");
  });

  it("does not let a foreign account or wrong Space use a matching rule guard", async () => {
    const owner = await account();
    const stranger = await account();
    const target = await bot(owner.cookie);
    const count = (await profileEvents(target.id)).length;
    const input = {
      botId: target.id,
      instructions: "Foreign rules",
      expectedInstructions: "Original rules",
    };
    // A foreign Space header fails membership before the bot endpoint gets an actor.
    expect((await raw(stranger.cookie, "bots/update", input, owner.me.spaceId)).status).toBe(401);
    // Existing bot-scope failures reach the generic opaque-error boundary.
    const foreignBot = await raw(stranger.cookie, "bots/update", input);
    expect(foreignBot.status).toBe(500);
    expect(await foreignBot.text()).not.toContain("Original rules");
    const space = await rpc<{ id: string }>(owner.cookie, "spaces/create", { name: "Other Space" });
    const wrongSpace = await raw(owner.cookie, "bots/update", input, space.id);
    expect(wrongSpace.status).toBe(500);
    expect(await wrongSpace.text()).not.toContain("Original rules");
    expect((await row(target.id)).instructions).toBe("Original rules");
    expect(await profileEvents(target.id)).toHaveLength(count);
  });

  it("rolls back rules, public fields, and event sequence if the durable event fails", async () => {
    const { cookie } = await account();
    const target = await bot(cookie);
    const thread = await database.prisma.thread.findUniqueOrThrow({ where: { botId: target.id } });
    const count = (await profileEvents(target.id)).length;
    failEventForBot = target.id;
    const response = await raw(cookie, "bots/update", {
      botId: target.id,
      name: "Rolled back",
      instructions: "Rolled back rules",
      expectedInstructions: "Original rules",
    });
    expect(response.status).toBe(500);
    expect(await row(target.id)).toMatchObject({
      name: "Profile bot",
      instructions: "Original rules",
    });
    expect(
      (await database.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).nextEventSeq,
    ).toBe(thread.nextEventSeq);
    expect(await profileEvents(target.id)).toHaveLength(count);
  });

  it("does not commit a rule edit or event when model validation rejects the same save", async () => {
    const { cookie } = await account();
    const target = await bot(cookie);
    const count = (await profileEvents(target.id)).length;
    const response = await raw(cookie, "bots/update", {
      botId: target.id,
      name: "Invalid binding",
      instructions: "Rejected rules",
      expectedInstructions: "Original rules",
      modelProvider: "openai-compatible",
      modelId: "model",
      modelCredentialId: "missing-credential",
      expectedRevision: 1,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await row(target.id)).toMatchObject({
      name: "Profile bot",
      instructions: "Original rules",
      modelCredentialId: null,
    });
    expect(await profileEvents(target.id)).toHaveLength(count);
  });

  it("keeps stale model conflicts distinct from a rules conflict in a mixed save", async () => {
    const { cookie } = await account();
    const target = await bot(cookie);
    const credential = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "offline-model",
      enabledModelIds: ["offline-model"],
      apiKey: "fake-model-key",
    });
    const count = (await profileEvents(target.id)).length;
    const response = await raw(cookie, "bots/update", {
      botId: target.id,
      name: "Stale binding",
      instructions: "Pending rules",
      expectedInstructions: "Original rules",
      modelProvider: credential.provider,
      modelId: "offline-model",
      modelCredentialId: credential.id,
      expectedRevision: credential.connectionRevision! + 1,
    });
    expect(response.status).toBe(409);
    const conflict = (await response.json()) as { json: { code: string; data?: unknown } };
    expect(conflict.json.code).toBe("CONFLICT");
    expect(conflict.json.data).toBeUndefined();
    expect(await row(target.id)).toMatchObject({
      name: "Profile bot",
      instructions: "Original rules",
      modelCredentialId: null,
    });
    expect(await profileEvents(target.id)).toHaveLength(count);
  });

  it("keeps the original rule expectation through a real serializable retry", async () => {
    const { cookie, otherCookie } = await account();
    const target = await bot(cookie);
    const credential = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "offline-model",
      enabledModelIds: ["offline-model"],
      apiKey: "fake-model-key",
    });
    const count = (await profileEvents(target.id)).length;
    const entered = deferred();
    const resume = deferred();
    const expectations: unknown[] = [];
    beforeBotUpdate = async (args) => {
      if (args.where.id !== target.id || args.data.name !== "Losing mixed save") return;
      expectations.push(args.where.instructions);
      if (expectations.length === 1) {
        entered.resolve();
        await resume.promise;
      }
    };
    const losing = raw(cookie, "bots/update", {
      botId: target.id,
      name: "Losing mixed save",
      instructions: "Losing rules",
      expectedInstructions: "Original rules",
      modelProvider: credential.provider,
      modelId: "offline-model",
      modelCredentialId: credential.id,
      expectedRevision: credential.connectionRevision!,
    });
    try {
      await Promise.race([
        entered.promise,
        losing.then((response) => {
          throw new Error(`Mixed save exited before its barrier (${response.status})`);
        }),
      ]);
      await rpc(otherCookie, "bots/update", {
        botId: target.id,
        instructions: "Winner after snapshot",
        expectedInstructions: "Original rules",
      });
    } finally {
      resume.resolve();
    }
    expect((await losing).status).toBe(409);
    expect(expectations).toEqual(["Original rules", "Original rules"]);
    expect(
      updateFailures.some((error) => {
        const failure = error as {
          code?: unknown;
          meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
        };
        return (
          failure.code === "P2034" ||
          failure.meta?.driverAdapterError?.cause?.originalCode === "40001"
        );
      }),
    ).toBe(true);
    expect(await row(target.id)).toMatchObject({
      name: "Profile bot",
      instructions: "Winner after snapshot",
      modelCredentialId: null,
    });
    expect(await profileEvents(target.id)).toHaveLength(count + 1);
  }, 30_000);
});
