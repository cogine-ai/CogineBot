import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  DefaultModelChoice,
  ThinkingLevel,
  UpdateModelDefaultsInput,
} from "@rakazo/contracts";
import { ModelDefaultsSchema } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  findAuthorizedSpaceModelCredential,
  findEffectiveModelDefault,
  readModelDefaults,
  recordSpaceModelChoice,
  updateModelDefaults,
} from "./model-defaults.js";
import { runAsTenant } from "./row-security.js";

import {
  readThinkingDefaults,
  thinkingModelBinding,
  updateThinkingDefaults,
} from "./thinking-defaults.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const model = { provider: "openai-compatible", modelId: "shared-model" };
const alternate = { provider: "openai-compatible", modelId: "alternate-model" };

postgres("personal model defaults", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const organizationId = randomUUID();
  const actor = { userId, spaceId: randomUUID() };
  const follower = { userId, spaceId: randomUUID() };
  const other = { ...actor, userId: otherUserId };
  let db: ReturnType<typeof createDb>;
  const read = (scope = actor) => runAsTenant(scope, () => readModelDefaults(db.prisma, scope));
  const resolve = (scope = actor) =>
    runAsTenant(scope, () => findEffectiveModelDefault(db.prisma, scope));
  const write = (input: UpdateModelDefaultsInput, scope = actor) =>
    runAsTenant(scope, () => updateModelDefaults(db.prisma, scope, input));

  beforeEach(async () => {
    db = createDb(databaseUrl!);
    const { prisma } = db;
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    for (const id of [userId, otherUserId]) {
      await prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.test` } });
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
    }
    await prisma.space.createMany({
      data: [
        { id: actor.spaceId, organizationId, name: "First Space" },
        { id: follower.spaceId, organizationId, name: "Second Space" },
      ],
    });
    await prisma.spaceMember.createMany({
      data: [actor, follower, other].map((scope) => ({
        ...scope,
        id: randomUUID(),
        organizationId,
        createdAt: new Date(),
      })),
    });
  });

  afterEach(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function connect(scope: typeof actor, choice: DefaultModelChoice, isDefault = false) {
    const secret = await db.prisma.secret.create({
      data: { userId: scope.userId, kind: "model", ciphertext: "fixture-ciphertext" },
    });
    const connection = await db.prisma.userModelCredential.create({
      data: {
        userId: scope.userId,
        provider: choice.provider,
        label: "Fixture",
        secretId: secret.id,
      },
    });
    await db.prisma.spaceModelPreference.create({
      data: { ...scope, credentialId: connection.id, modelId: choice.modelId, isDefault },
    });
    return connection;
  }

  function account(value = model, expectedRevision = 0, following = [actor, follower]) {
    return {
      scope: "account",
      value,
      expectedRevision,
      followingSpaceIds: following.map(({ spaceId }) => spaceId),
      clientNonce: randomUUID(),
    } as const;
  }

  function override(enabled: boolean, expectedAccountRevision = 1, expectedRevision = 0) {
    return {
      scope: "space",
      enabled,
      expectedRevision,
      expectedAccountRevision,
      expectedChoice: model,
      clientNonce: randomUUID(),
    } as const;
  }

  it("resolves one exact local model and cannot borrow the same model from another Space", async () => {
    const source = await connect(actor, model, true);
    await connect(other, model);
    const request = account();
    const update = await write(request);
    expect(update.status).toBe("updated");
    expect(await write(request)).toEqual(update);
    expect(await write({ ...request, value: alternate })).toMatchObject({ status: "conflict" });
    expect(await resolve()).toMatchObject({ source: "account", credential: { id: source.id } });
    expect(await read(follower)).toMatchObject({
      choices: [],
      effective: { choice: model, source: "account", unavailable: "missing" },
    });
    expect(await read(other)).toMatchObject({
      account: { value: null, revision: 0 },
      effective: { source: "system" },
    });
    const pinned = (id: string) =>
      runAsTenant(follower, () =>
        findAuthorizedSpaceModelCredential(db.prisma, follower, model.provider, id),
      );
    expect(await pinned(source.id)).toBeNull();
    const local = await connect(follower, model);
    expect(await resolve(follower)).toMatchObject({
      credential: { id: local.id, defaultModel: model.modelId },
      unavailable: null,
    });
    expect(await pinned(local.id)).toMatchObject({ id: local.id });
    await connect(follower, model);
    expect(await read(follower)).toMatchObject({
      choices: [],
      effective: { unavailable: "ambiguous" },
    });
    expect(await write(override(true), follower)).toMatchObject({ status: "unavailable" });
    // A prepared Run may still use its exact local binding while new Runs need a choice.
    expect(await pinned(local.id)).toMatchObject({ id: local.id });
    await db.prisma.spaceModelPreference.deleteMany({
      where: { ...follower, credentialId: local.id },
    });
    expect(await pinned(local.id)).toBeNull();
    expect(
      await db.prisma.userModelCredential.findUnique({ where: { id: local.id } }),
    ).toBeTruthy();
  });

  it("ignores a local connection with no owner-scoped model secret", async () => {
    const source = await connect(actor, model);
    const stale = await connect(follower, model);
    expect(await write(account())).toMatchObject({ status: "updated" });
    await db.prisma.secret.delete({ where: { id: stale.secretId } });
    expect(await read(follower)).toMatchObject({
      choices: [],
      effective: { unavailable: "missing", source: "account" },
    });
    expect(await resolve(follower)).toMatchObject({ unavailable: "missing", credential: null });
    expect(await write(account(model, 1), follower)).toMatchObject({ status: "unavailable" });
    expect(await resolve()).toMatchObject({ credential: { id: source.id } });
  });

  it("round-trips existing long model identifiers through preferences and history", async () => {
    const long = { ...model, modelId: "model-".repeat(100) };
    const connection = await connect(actor, long, true);
    await db.prisma.$transaction((tx) => recordSpaceModelChoice(tx, actor, long));
    const explicit = ModelDefaultsSchema.parse(await read());
    expect(explicit.effective).toMatchObject({ source: "space", choice: long });
    expect(await write(account(long, 0, [follower]))).toMatchObject({ status: "updated" });
    expect(await resolve()).toMatchObject({ choice: long, credential: { id: connection.id } });
    expect((await read(follower)).effective).toMatchObject({
      choice: long,
      unavailable: "missing",
    });
  });

  it("preserves a legacy override and keeps the captured value while following Spaces change", async () => {
    const legacy = await connect(actor, alternate, true);
    await connect(actor, model);
    const local = await connect(follower, model);
    const newLocal = await connect(follower, alternate);
    await db.prisma.spaceMember.update({
      where: { spaceId_userId: actor },
      data: { modelOverrideHistory: [{ revision: 0, value: true }] },
    });
    expect(await write(account())).toMatchObject({ status: "conflict" });
    expect(await write(account(model, 0, [follower]))).toMatchObject({ status: "updated" });
    expect(await resolve()).toMatchObject({ source: "space", credential: { id: legacy.id } });
    const copy = override(true);
    expect(await write(copy, follower)).toMatchObject({
      status: "updated",
      settings: {
        space: { revision: 1, value: true },
        effective: { source: "space", choice: model },
      },
    });
    expect(await write(copy, follower)).toMatchObject({ status: "updated" });
    expect(await write(account(alternate, 1, []))).toMatchObject({ status: "updated" });
    expect(await resolve(follower)).toMatchObject({
      source: "space",
      credential: { id: local.id },
    });
    expect(await write(override(false, 2, 1), follower)).toMatchObject({ status: "updated" });
    expect(await resolve(follower)).toMatchObject({
      source: "account",
      credential: { id: newLocal.id },
    });
    expect(await db.prisma.spaceModelPreference.count({ where: follower })).toBe(2);
  });

  it("serializes account updates against copying the effective Space model", async () => {
    await connect(actor, model);
    await connect(actor, alternate);
    await connect(follower, model);
    await connect(follower, alternate);
    expect(await write(account())).toMatchObject({ status: "updated" });
    const [changed, copied] = await Promise.all([
      write(account(alternate, 1)),
      write(override(true), follower),
    ]);
    expect([changed.status, copied.status].sort()).toEqual(["conflict", "updated"]);
    expect((await read(follower)).effective).toEqual({
      choice: changed.status === "updated" ? alternate : model,
      unavailable: null,
      source: changed.status === "updated" ? "account" : "space",
    });
    const saved = await db.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(saved.modelDefaultHistory).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: model, revision: 1 })]),
    );
    for (const entry of saved.modelDefaultHistory as Array<{ value: unknown }>) {
      expect(entry.value).toEqual({ provider: model.provider, modelId: expect.any(String) });
    }
  });
  it("inherits thinking only for a supported local model, keeps legacy and explicit values, and rejects stale writes", async () => {
    await connect(actor, model, true);
    const local = await connect(follower, model, true);
    await db.prisma.spaceModelPreference.updateMany({
      where: follower,
      data: { thinkingLevel: "low" },
    });
    const prepare = async (scope: typeof actor, levels: ThinkingLevel[] = ["low", "high"]) => {
      const selection = await resolve(scope);
      return {
        binding: thinkingModelBinding(selection)!,
        secretId: selection.credential!.secretId,
        ciphertext: "fixture-ciphertext",
        levels,
        connectionLevel: null,
      };
    };
    const view = async (scope: typeof actor, levels?: ThinkingLevel[]) => {
      const prepared = await prepare(scope, levels);
      return runAsTenant(scope, () => readThinkingDefaults(db.prisma, scope, prepared));
    };
    const source = await prepare(actor);
    const target = await prepare(follower);
    const accountWrite = async (level: ThinkingLevel, expectedRevision: number) => {
      const current = await view(actor);
      const input = {
        scope: "account" as const,
        level,
        expectedRevision,
        binding: current.binding,
        followingSpaceIds: current.followingSpaces.map(({ id }) => id),
        clientNonce: randomUUID(),
      };
      const write = () =>
        runAsTenant(actor, () => updateThinkingDefaults(db.prisma, actor, input, source));
      const result = await write();
      expect(result.status).toBe("updated");
      expect(await write()).toEqual(result);
      return result;
    };
    const spaceWrite = async (value: "inherit" | "copy" | "modelDefault") => {
      const current = await view(follower);
      return runAsTenant(follower, () =>
        updateThinkingDefaults(
          db.prisma,
          follower,
          {
            scope: "space",
            value,
            binding: current.binding,
            expectedRevision: current.space.revision,
            expectedAccountRevision: current.account.revision,
            expectedLevel: current.effective.level,
            clientNonce: randomUUID(),
          },
          target,
        ),
      );
    };
    await accountWrite("high", 0);
    expect((await view(actor)).effective).toMatchObject({ level: "high", source: "account" });
    expect((await view(follower)).effective).toMatchObject({ level: "low", source: "space" });
    expect((await spaceWrite("inherit")).settings.effective).toMatchObject({
      level: "high",
      source: "account",
    });
    expect((await view(follower, ["low"])).effective).toEqual({
      level: null,
      source: "system",
      unsupported: true,
    });
    expect((await spaceWrite("copy")).status).toBe("updated");
    await accountWrite("low", 1);
    expect((await view(follower)).effective).toMatchObject({ level: "high", source: "space" });
    expect((await spaceWrite("modelDefault")).settings.effective).toEqual({
      level: null,
      source: "space",
      unsupported: false,
    });
    expect(
      await db.prisma.spaceModelPreference.findFirst({
        where: { ...follower, credentialId: local.id },
      }),
    ).toMatchObject({ thinkingLevel: "low" });
    const current = await view(actor);
    await db.prisma.secret.update({
      where: { id: source.secretId },
      data: { ciphertext: "changed-ciphertext" },
    });
    expect(
      await runAsTenant(actor, () =>
        updateThinkingDefaults(
          db.prisma,
          actor,
          {
            scope: "account",
            level: "high",
            expectedRevision: current.account.revision,
            binding: current.binding,
            followingSpaceIds: current.followingSpaces.map(({ id }) => id),
            clientNonce: randomUUID(),
          },
          source,
        ),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("serializes changing account effort against copying the Space's visible value", async () => {
    await connect(actor, model, true);
    await connect(follower, model, true);
    const setup = async (scope: typeof actor) => {
      const selection = await resolve(scope);
      const prepared = {
        binding: thinkingModelBinding(selection)!,
        secretId: selection.credential!.secretId,
        ciphertext: "fixture-ciphertext",
        levels: ["low", "high"] as ThinkingLevel[],
        connectionLevel: null,
      };
      const settings = await runAsTenant(scope, () =>
        readThinkingDefaults(db.prisma, scope, prepared),
      );
      return { prepared, settings };
    };
    const [first, second] = await Promise.all([setup(actor), setup(follower)]);
    const [changed, copied] = await Promise.all([
      runAsTenant(actor, () =>
        updateThinkingDefaults(
          db.prisma,
          actor,
          {
            scope: "account",
            expectedRevision: 0,
            level: "high",
            binding: first.settings.binding,
            followingSpaceIds: first.settings.followingSpaces.map(({ id }) => id),
            clientNonce: randomUUID(),
          },
          first.prepared,
        ),
      ),
      runAsTenant(follower, () =>
        updateThinkingDefaults(
          db.prisma,
          follower,
          {
            scope: "space",
            value: "copy",
            expectedRevision: 0,
            expectedAccountRevision: 0,
            expectedLevel: null,
            binding: second.settings.binding,
            clientNonce: randomUUID(),
          },
          second.prepared,
        ),
      ),
    ]);
    expect([changed.status, copied.status].sort()).toEqual(["conflict", "updated"]);
    expect((await setup(follower)).settings.effective).toEqual(
      changed.status === "updated"
        ? { level: "high", source: "account", unsupported: false }
        : { level: null, source: "space", unsupported: false },
    );
  });

  it("freezes exact verified connections for downgrade and aborts on ambiguity before any writes", async () => {
    const previous = await connect(actor, alternate, true);
    const source = await connect(actor, model);
    const target = await connect(follower, model);
    const duplicate = await connect(follower, model);
    expect(await write(account())).toMatchObject({ status: "updated" });
    const freeze = await readFile(
      new URL("../prisma/operations/freeze-model-defaults.sql", import.meta.url),
      "utf8",
    );
    const session = await db.pool.connect();
    const active = (scope: typeof actor) =>
      db.prisma.spaceModelPreference.findFirst({ where: { ...scope, isDefault: true } });
    try {
      await session.query(`
        CREATE TEMPORARY TABLE model_freeze_verified (
          space_id text, user_id text, provider text, model_id text,
          credential_id text, connection_revision integer
        )
      `);
      for (const [spaceId, connection] of [
        [actor.spaceId, source],
        [follower.spaceId, target],
      ] as const) {
        await session.query("INSERT INTO model_freeze_verified VALUES ($1, $2, $3, $4, $5, $6)", [
          spaceId,
          userId,
          model.provider,
          model.modelId,
          connection.id,
          connection.connectionRevision,
        ]);
      }
      await expect(session.query(freeze)).rejects.toThrow(
        "Resolve and verify each following Space",
      );
      await session.query("ROLLBACK");
      expect(await active(actor)).toMatchObject({ credentialId: previous.id });
      expect(await active(follower)).toBeNull();
      await db.prisma.spaceModelPreference.deleteMany({
        where: { ...follower, credentialId: duplicate.id },
      });
      await session.query(freeze);
      expect(await active(actor)).toMatchObject({ credentialId: source.id });
      expect(await active(follower)).toMatchObject({ credentialId: target.id });
      expect((await read()).account).toEqual({ revision: 1, value: model });
      expect(await db.prisma.userModelCredential.count({ where: { userId } })).toBe(4);
    } finally {
      await session.query("ROLLBACK");
      await session.query("DROP TABLE IF EXISTS pg_temp.model_freeze_verified");
      session.release();
    }
  });
});
