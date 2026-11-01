import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  canUsePlatformModel,
  platformModelAuthorization,
  serializeModelSecret,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, Prisma } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listModelConnectionReferences,
  refuseModelReferences,
  validateModelBinding,
} from "./model-bindings.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!enabled)("ChatGPT model binding removal lock (PostgreSQL)", () => {
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  const users: string[] = [];
  const organizations: string[] = [];

  beforeAll(() => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "plan-binding-writer" });
    second = createDb(databaseUrl!, { poolMax: 1, applicationName: "plan-binding-remover" });
  });
  afterAll(async () => {
    try {
      await first?.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await first?.prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      for (const client of [first, second]) {
        await client?.prisma.$disconnect();
        await client?.pool.end();
      }
    }
  });

  async function fixture() {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    users.push(userId);
    organizations.push(organizationId);
    await first.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await first.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await first.prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    const secret = await first.prisma.secret.create({
      data: { userId, kind: "model", ciphertext: "encrypted-fixture" },
    });
    const credential = await first.prisma.userModelCredential.create({
      data: { userId, provider: "chatgpt-plan", label: "Fixture", secretId: secret.id },
    });
    const plaintext = serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 3600_000,
        clientId: "oaiapp_fixture",
        issuer: "https://auth.openai.com",
        subject: "fixture-subject",
        hostId: "urn:uuid:8d497bea-75d5-4b56-9bed-401ec51007a3",
        idToken: "fake-id-token",
        scopes: ["chatgpt.tokens.use.direct"],
        chatgptPlanModels: [{ id: "account-model", name: "Account model" }],
      },
    });
    return {
      actor: { userId, spaceId },
      credential,
      secrets: { load: async () => plaintext },
      binding: {
        modelProvider: "chatgpt-plan",
        modelId: "account-model",
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      },
      write: (tx: Pick<PrismaClient, "bot">) =>
        tx.bot.create({
          data: {
            spaceId,
            userId,
            name: "Bound bot",
            color: "slate",
            modelProvider: "chatgpt-plan",
            modelId: "account-model",
            modelCredentialId: credential.id,
          },
        }),
    };
  }

  async function waitForLock(applicationName: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await first.pool.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS waiting",
        [applicationName],
      );
      if (result.rows[0]?.waiting) return;
      await delay(10);
    }
    throw new Error("Expected the competing transaction to wait for the credential row lock");
  }

  async function lockRemoval(tx: Prisma.TransactionClient, f: Awaited<ReturnType<typeof fixture>>) {
    return tx.$queryRaw(Prisma.sql`SELECT id FROM user_model_credentials
      WHERE id=${f.credential.id} AND "userId"=${f.actor.userId} AND provider='chatgpt-plan' FOR UPDATE`);
  }

  it("makes removal see a scalar bot pin committed by an earlier binding transaction", async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const writer = first.prisma.$transaction(async (tx) => {
      await validateModelBinding(tx, f.secrets, f.actor, f.binding);
      entered.release();
      await release.promise;
      return f.write(tx);
    });
    await entered.promise;
    const removal = second.prisma
      .$transaction(async (tx) => {
        await lockRemoval(tx, f);
        refuseModelReferences(
          await listModelConnectionReferences(tx, f.actor.userId, f.credential.id),
        );
        await tx.userModelCredential.delete({ where: { id: f.credential.id } });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await waitForLock("plan-binding-remover");
    } finally {
      release.release();
    }
    await writer;
    expect(await removal).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Bound bot"),
    });
    expect(
      await first.prisma.userModelCredential.findUnique({ where: { id: f.credential.id } }),
    ).not.toBeNull();
  });

  it("rejects a binding that waits behind a successful removal without inserting a dangling pin", async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const removal = second.prisma.$transaction(async (tx) => {
      await lockRemoval(tx, f);
      refuseModelReferences(
        await listModelConnectionReferences(tx, f.actor.userId, f.credential.id),
      );
      entered.release();
      await release.promise;
      await tx.userModelCredential.delete({ where: { id: f.credential.id } });
    });
    await entered.promise;
    const writer = first.prisma
      .$transaction(async (tx) => {
        await validateModelBinding(tx, f.secrets, f.actor, f.binding);
        await f.write(tx);
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await waitForLock("plan-binding-writer");
    } finally {
      release.release();
    }
    await removal;
    expect(await writer).toMatchObject({ code: "NOT_FOUND" });
    expect(await first.prisma.bot.count({ where: { modelCredentialId: f.credential.id } })).toBe(0);
  });

  it("fails a Serializable binding with an old snapshot after removal commits", async () => {
    const f = await fixture();
    const snapshotted = gate();
    const removed = gate();
    const writer = first.prisma
      .$transaction(
        async (tx) => {
          await tx.userModelCredential.findUniqueOrThrow({ where: { id: f.credential.id } });
          snapshotted.release();
          await removed.promise;
          await validateModelBinding(tx, f.secrets, f.actor, f.binding);
          await f.write(tx);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await snapshotted.promise;
    try {
      await second.prisma.$transaction(async (tx) => {
        await lockRemoval(tx, f);
        await tx.userModelCredential.delete({ where: { id: f.credential.id } });
      });
    } finally {
      removed.release();
    }
    expect(await writer).toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    });
    expect(await first.prisma.bot.count({ where: { modelCredentialId: f.credential.id } })).toBe(0);
  });
});

describe.skipIf(!enabled)("platform model funding authority (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let userId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!, { poolMax: 2, applicationName: "model-policy-fixture" });
    userId = randomUUID();
    await db.prisma.user.create({
      data: {
        id: userId,
        name: "Policy fixture",
        email: `${userId}@example.test`,
        emailVerified: false,
      },
    });
  });

  afterAll(async () => {
    try {
      await db?.prisma.deploymentSettings.updateMany({
        where: { id: "default", ownerUserId: userId },
        data: { ownerUserId: null },
      });
      await db?.prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }
  });

  it("rechecks current mailbox proof instead of retaining an earlier authorization", async () => {
    const authorize = platformModelAuthorization(db.prisma, ["@example.test"], userId)!;
    await expect(authorize()).rejects.toMatchObject({ code: "platform_model_forbidden" });
    await db.prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    await expect(authorize()).resolves.toBeUndefined();
    await db.prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });
    await expect(authorize()).rejects.toMatchObject({ code: "platform_model_forbidden" });
    expect(await canUsePlatformModel(db.prisma, ["@example.test"], "missing-fixture-user")).toBe(
      false,
    );
  });

  it("uses current deployment ownership independently of mailbox grants", async () => {
    const authorize = platformModelAuthorization(db.prisma, "owner_only", userId)!;
    await expect(authorize()).rejects.toMatchObject({ code: "platform_model_forbidden" });
    await db.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: userId },
      update: { ownerUserId: userId },
    });
    await expect(authorize()).resolves.toBeUndefined();
    await db.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: null },
    });
    await expect(authorize()).rejects.toMatchObject({ code: "platform_model_forbidden" });
  });
});
