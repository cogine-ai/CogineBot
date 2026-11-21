import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { UpdateReadAloudInput } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  botSettingsSelect,
  botSettingsVersions,
  lockOwnedBotSettings,
  prepareBotSettingsVersion,
  writeBotSettingsVersion,
} from "./bot-settings.js";
import { createDb } from "./client.js";
import { readAloudForBot, readAloudSettings, updateReadAloud } from "./read-aloud.js";
import { runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

postgres("personal read-aloud settings", () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const spaceId = randomUUID();
  const secondSpaceId = randomUUID();
  const actor = { spaceId, userId };
  const other = { spaceId, userId: otherUserId };
  const second = { spaceId: secondSpaceId, userId };
  let db: ReturnType<typeof createDb>;
  let inherited: string;
  let legacyOff: string;
  let legacyOn: string;
  const read = (scope = actor) => runAsTenant(scope, () => readAloudSettings(db.prisma, scope));
  const decide = (botId: string, scope = actor) =>
    runAsTenant(scope, () => readAloudForBot(db.prisma, scope, botId));
  const write = (input: UpdateReadAloudInput, scope = actor) =>
    runAsTenant(scope, () => updateReadAloud(db.prisma, scope, input));

  beforeEach(async () => {
    db = createDb(databaseUrl!);
    await db.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    for (const id of [userId, otherUserId]) {
      await db.prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.test` } });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    for (const [id, name] of [
      [spaceId, "First"],
      [secondSpaceId, "Second"],
    ] as const) {
      await db.prisma.space.create({ data: { id, name, organizationId } });
    }
    for (const { spaceId: id, userId: owner } of [actor, second, other]) {
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId,
          spaceId: id,
          userId: owner,
          createdAt: new Date(),
        },
      });
    }
    const data = { ...actor, name: "Fixture", color: "blue" };
    inherited = (await db.prisma.bot.create({ data: { ...data, autoSpeakInherited: true } })).id;
    legacyOff = (await db.prisma.bot.create({ data })).id;
    legacyOn = (await db.prisma.bot.create({ data: { ...data, autoSpeak: true } })).id;
  });

  afterEach(async () => {
    if (!db) return;
    await db.prisma.organization.deleteMany({ where: { id: organizationId } });
    await db.prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps legacy Bot choices and serializes account edits with enabling an override", async () => {
    const view = await read();
    expect(view.account).toEqual({ value: null, revision: 0 });
    expect(view.followingSpaces.map(({ id }) => id)).toEqual([spaceId, secondSpaceId]);
    expect(await decide(inherited)).toEqual({ enabled: false, source: "system" });
    expect(await decide(legacyOn)).toEqual({ enabled: true, source: "bot" });

    const account = {
      scope: "account",
      value: true,
      expectedRevision: 0,
      followingSpaceIds: [spaceId, secondSpaceId],
      clientNonce: randomUUID(),
    } as const satisfies UpdateReadAloudInput;
    const copy = {
      scope: "space",
      value: "copy",
      expectedRevision: 0,
      expectedAccountRevision: 0,
      clientNonce: randomUUID(),
    } as const satisfies UpdateReadAloudInput;
    // Either lock winner is valid. The other request must ask for confirmation again.
    const [changed, copied] = await Promise.all([write(account, second), write(copy)]);
    expect([changed.status, copied.status].sort()).toEqual(["conflict", "updated"]);
    let snapshot = await read();
    if (copied.status === "conflict") {
      expect(snapshot.account.value).toBe(true);
      const next = await write({ ...copy, expectedAccountRevision: snapshot.account.revision });
      expect(next.settings.space.value).toBe(true);
      expect(await write({ ...copy, expectedAccountRevision: snapshot.account.revision })).toEqual(
        next,
      );
    } else {
      expect(snapshot.space.value).toBe(false);
      expect(snapshot.account.value).toBeNull();
      expect(await write(copy)).toEqual(copied);
      const next = await write({ ...account, followingSpaceIds: [secondSpaceId] }, second);
      expect(next.status).toBe("updated");
    }

    expect(await decide(legacyOff)).toEqual({ enabled: false, source: "bot" });
    expect(await decide(legacyOn)).toEqual({ enabled: true, source: "bot" });
    expect((await decide(inherited)).source).toBe("space");
    expect((await read(second)).effective).toEqual({ enabled: true, source: "account" });
    expect((await read(other)).effective).toEqual({ enabled: false, source: "system" });
    await expect(decide(inherited, other)).rejects.toBeInstanceOf(IsolationError);
    await expect(decide(inherited, second)).rejects.toBeInstanceOf(IsolationError);
    await expect(read({ ...other, spaceId: secondSpaceId })).rejects.toBeInstanceOf(IsolationError);

    snapshot = await read();
    const clear = {
      scope: "space",
      value: null,
      expectedRevision: snapshot.space.revision,
      expectedAccountRevision: snapshot.account.revision,
      clientNonce: randomUUID(),
    } as const satisfies UpdateReadAloudInput;
    const cleared = await write(clear);
    expect(cleared.settings.effective).toEqual({ enabled: true, source: "account" });
    expect((await write(clear)).settings.space.revision).toBe(snapshot.space.revision + 1);
    expect((await write({ ...clear, value: "copy" })).status).toBe("conflict");
    expect((await write({ ...clear, expectedAccountRevision: 0 })).status).toBe("conflict");
    expect(
      (
        await db.prisma.spaceMember.findUniqueOrThrow({
          where: { spaceId_userId: actor },
        })
      ).readAloudHistory,
    ).toMatchObject([
      { value: null, revision: 2 },
      { value: snapshot.space.value, revision: 1 },
    ]);
  });

  it("freezes the effective value for the older application without changing preference history", async () => {
    const initial = await read();
    await write({
      scope: "account",
      value: true,
      expectedRevision: initial.account.revision,
      followingSpaceIds: initial.followingSpaces.map(({ id }) => id),
      clientNonce: randomUUID(),
    });
    const history = await read();
    expect(history.account.value).toBe(true);
    expect(await decide(inherited)).toEqual({ enabled: true, source: "account" });
    const explicit = await db.prisma.bot.create({
      data: { ...actor, name: "Override fixture", color: "blue", autoSpeakInherited: true },
    });
    await db.prisma.$transaction(async (tx) => {
      const bot = await lockOwnedBotSettings(tx, actor, explicit.id);
      if (!bot) throw new Error("Missing fixture Bot");
      const version = prepareBotSettingsVersion(bot, {
        autoSpeak: true,
        autoSpeakInherited: false,
      });
      if (!version) throw new Error("Missing override version");
      return writeBotSettingsVersion(tx, bot, version);
    });
    const stored = await db.prisma.bot.findUniqueOrThrow({
      where: { id: explicit.id },
      select: { ...botSettingsSelect, autoSpeakInherited: true },
    });
    expect(stored.settingsHistory).toMatchObject([
      { before: { autoSpeak: false }, after: { autoSpeak: true }, revision: 1 },
    ]);
    expect(botSettingsVersions(stored)[0]?.before.autoSpeakInherited).toBe(true);
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      ["host", "port", "dbname", "database"].some((key) => url.searchParams.has(key)) ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE
    )
      throw new Error("Read-aloud freeze requires an isolated integration database");
    const identity = await db.pool.query<{ name: string }>("SELECT current_database() AS name");
    expect(identity.rows[0]?.name).toBe(database);
    const freeze = await readFile(
      new URL("../prisma/operations/freeze-read-aloud.sql", import.meta.url),
      "utf8",
    );
    await db.pool.query(freeze);
    expect(await decide(inherited)).toEqual({ enabled: true, source: "bot" });
    expect(await decide(legacyOff)).toEqual({ enabled: false, source: "bot" });
    expect(await decide(legacyOn)).toEqual({ enabled: true, source: "bot" });
    expect(await read()).toEqual(history);
    const frozen = await db.prisma.bot.findUniqueOrThrow({
      where: { id: explicit.id },
      select: { ...botSettingsSelect, autoSpeakInherited: true },
    });
    expect(frozen).toMatchObject({
      autoSpeak: true,
      autoSpeakInherited: false,
      settingsRevision: 2,
    });
    expect(frozen.settingsHistory).toEqual(stored.settingsHistory);
    await db.pool.query(freeze);
    expect(
      (
        await db.prisma.bot.findUniqueOrThrow({
          where: { id: explicit.id },
          select: { ...botSettingsSelect, autoSpeakInherited: true },
        })
      ).settingsRevision,
    ).toBe(2);
  });
});
