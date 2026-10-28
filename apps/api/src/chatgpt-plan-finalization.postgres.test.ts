import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EncryptedSecretStore } from "@rakazo/adapters";
import { createDb, Prisma } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectChatGPTPlan, lockChatGPTPlanConnection } from "./chatgpt-plan.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!enabled)("ChatGPT first finalization and empty disconnect (PostgreSQL)", () => {
  let writer: ReturnType<typeof createDb>;
  let remover: ReturnType<typeof createDb>;
  const users: string[] = [];

  beforeAll(() => {
    writer = createDb(databaseUrl!, { poolMax: 2, applicationName: "plan-first-finalization" });
    remover = createDb(databaseUrl!, { poolMax: 1, applicationName: "plan-empty-disconnect" });
  });
  afterAll(async () => {
    try {
      await writer?.prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      for (const client of [writer, remover]) {
        await client?.prisma.$disconnect();
        await client?.pool.end();
      }
    }
  });

  async function fixture() {
    const userId = randomUUID();
    users.push(userId);
    await writer.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    const actor = { userId, spaceId: "unused-fixture-space" };
    return {
      actor,
      deps: {
        prisma: remover.prisma,
        secrets: new EncryptedSecretStore("offline-finalization-fixture"),
        dataDir: "unused-offline-fixture",
      },
      data: {
        userId,
        provider: "chatgpt-plan",
        label: "Fixture",
        secretId: `unused-${randomUUID()}`,
      },
    };
  }

  async function waitForLock(applicationName: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await writer.pool.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS waiting",
        [applicationName],
      );
      if (result.rows[0]?.waiting) return;
      await delay(10);
    }
    throw new Error("Expected finalization and disconnect to contend on the same connection lock");
  }

  it("reproduces the absent-row insert gap when the disconnect has no connection lock", async () => {
    const f = await fixture();
    const checkedEmpty = gate();
    const release = gate();
    const unguarded = remover.prisma.$transaction(async (tx) => {
      const prepared = await tx.userModelCredential.findMany({
        where: { userId: f.actor.userId, provider: "chatgpt-plan" },
      });
      expect(prepared).toEqual([]);
      expect(
        await tx.userModelCredential.findFirst({
          where: { userId: f.actor.userId, provider: "chatgpt-plan" },
        }),
      ).toBeNull();
      checkedEmpty.release();
      await release.promise;
      await tx.userModelCredential.deleteMany({
        where: { id: { in: prepared.map((row) => row.id) } },
      });
    });
    await checkedEmpty.promise;
    try {
      await writer.prisma.$transaction(
        async (tx) => {
          await lockChatGPTPlanConnection(tx, f.actor.userId);
          await tx.userModelCredential.create({ data: f.data });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      expect(
        await writer.prisma.userModelCredential.count({ where: { userId: f.actor.userId } }),
      ).toBe(1);
    } finally {
      release.release();
    }
    await unguarded;
    expect(
      await writer.prisma.userModelCredential.count({ where: { userId: f.actor.userId } }),
    ).toBe(1);
  });

  it("blocks an empty disconnect behind first finalization, then detects the newly committed connection", async () => {
    const f = await fixture();
    const inserted = gate();
    const release = gate();
    const finalization = writer.prisma.$transaction(
      async (tx) => {
        await lockChatGPTPlanConnection(tx, f.actor.userId);
        await tx.userModelCredential.create({ data: f.data });
        inserted.release();
        await release.promise;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await inserted.promise;
    let removalCalled = false;
    const disconnect = disconnectChatGPTPlan(f.deps, f.actor, async () => {
      removalCalled = true;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitForLock("plan-empty-disconnect");
      expect(removalCalled).toBe(false);
    } finally {
      release.release();
    }
    await finalization;
    expect(await disconnect).toMatchObject({ code: "CONFLICT" });
    expect(removalCalled).toBe(false);
    expect(
      await writer.prisma.userModelCredential.count({ where: { userId: f.actor.userId } }),
    ).toBe(1);
  });

  it("blocks first finalization after the empty-disconnect check until its prepared removal commits", async () => {
    const f = await fixture();
    const checkedEmpty = gate();
    const release = gate();
    let preparedIds: string[] = [];
    let inserted = false;
    const disconnect = disconnectChatGPTPlan(
      f.deps,
      f.actor,
      async (tx) => {
        // This is the original gap: `appeared` was already read and the router's
        // prepared list is empty, but the disconnect transaction has not committed.
        checkedEmpty.release();
        await release.promise;
        await tx.userModelCredential.deleteMany({ where: { id: { in: preparedIds } } });
      },
      {
        validateRemoval: async (tx) => {
          const rows = await tx.userModelCredential.findMany({
            where: { userId: f.actor.userId, provider: "chatgpt-plan" },
          });
          preparedIds = rows.map((row) => row.id);
        },
      },
    );
    await checkedEmpty.promise;
    const finalization = writer.prisma.$transaction(
      async (tx) => {
        await lockChatGPTPlanConnection(tx, f.actor.userId);
        inserted = true;
        await tx.userModelCredential.create({ data: f.data });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    try {
      await waitForLock("plan-first-finalization");
      expect(inserted).toBe(false);
      expect(preparedIds).toEqual([]);
    } finally {
      release.release();
    }
    await expect(disconnect).resolves.toEqual({ confirmed: true });
    await finalization;
    // Across processes the operations linearize as disconnect, then login.
    // Same-process pending logins are canceled by the router before disconnect.
    expect(inserted).toBe(true);
    expect(
      await writer.prisma.userModelCredential.count({ where: { userId: f.actor.userId } }),
    ).toBe(1);
  });
});
