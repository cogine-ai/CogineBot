import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, Prisma } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isChatGPTPlanRotationPendingError,
  refreshChatGPTPlanCredential,
} from "./chatgpt-plan-auth.js";
import { withChatGPTPlanCredentialLock } from "./chatgpt-plan-credential-lock.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("ChatGPT plan credential lock (PostgreSQL)", () => {
  const table = `chatgpt_plan_lock_${randomUUID().replaceAll("-", "")}`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;

  beforeAll(async () => {
    first = createDb(databaseUrl!, { poolMax: 2, applicationName: "chatgpt-plan-lock-first" });
    second = createDb(databaseUrl!, { poolMax: 1, applicationName: "chatgpt-plan-lock-second" });
    await first.prisma.$executeRaw(
      Prisma.sql`CREATE TABLE ${Prisma.raw(table)} (kind text NOT NULL)`,
    );
  });

  afterAll(async () => {
    try {
      await first?.prisma.$executeRaw(Prisma.sql`DROP TABLE IF EXISTS ${Prisma.raw(table)}`);
    } finally {
      for (const client of [first, second]) {
        if (!client) continue;
        await client.prisma.$disconnect();
        await client.pool.end();
      }
    }
  });

  it("blocks an independent client until the first credential transaction commits", async () => {
    const secretId = `fixture-secret-${randomUUID()}`;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const firstOperation = withChatGPTPlanCredentialLock(first.prisma, secretId, async () => {
      order.push("first-enter");
      entered();
      await gate;
      order.push("first-exit");
    });
    await firstEntered;
    // poolMax=1 keeps this backend attached to the waiting transaction below.
    const backend = await second.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const secondPid = backend.rows[0]!.pid;
    const isWaitingFor = async (lockSecretId: string) => {
      const result = await first.pool.query<{ waiting: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND pid = $1
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = (hashtext('coginebot-chatgpt-plan')::bigint & 4294967295)::oid
            AND objid = (hashtext($2)::bigint & 4294967295)::oid
            AND objsubid = 2
        ) AS waiting`,
        [secondPid, lockSecretId],
      );
      return result.rows[0]?.waiting === true;
    };
    const secondOperation = withChatGPTPlanCredentialLock(second.prisma, secretId, async () => {
      order.push("second-enter");
    });
    try {
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        waiting = await isWaitingFor(secretId);
        if (!waiting) await delay(10);
      }
      expect(waiting).toBe(true);
      expect(await isWaitingFor(`${secretId}-unrelated`)).toBe(false);
      expect(order).toEqual(["first-enter"]);
    } finally {
      release();
    }
    await Promise.all([firstOperation, secondOperation]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("commits a recognized encrypted checkpoint on failure while ordinary errors roll back", async () => {
    let pending: unknown;
    try {
      await refreshChatGPTPlanCredential(
        {
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: 0,
          clientId: "oaiapp_fixture",
          issuer: "https://auth.openai.com",
          subject: "fixture-subject",
          hostId: "urn:uuid:8d497bea-75d5-4b56-9bed-401ec51007a3",
          idToken: "fake-id-token",
          scopes: ["chatgpt.tokens.use.direct"],
        },
        undefined,
        {
          fetch: async (input) =>
            String(input).endsWith("/oauth/token")
              ? Response.json({
                  access_token: "fake-successor",
                  refresh_token: "fake-successor-refresh",
                  id_token: "fake-unverified-id-token",
                  expires_in: 3600,
                  scope: "chatgpt.tokens.use.direct",
                })
              : Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
        },
      );
    } catch (error) {
      pending = error;
    }
    expect(isChatGPTPlanRotationPendingError(pending)).toBe(true);
    await expect(
      withChatGPTPlanCredentialLock(
        first.prisma,
        "checkpoint-fixture-secret",
        async (transaction) => {
          await transaction.$executeRaw(
            Prisma.sql`INSERT INTO ${Prisma.raw(table)} (kind) VALUES ('encrypted-checkpoint-fixture')`,
          );
          throw pending;
        },
      ),
    ).rejects.toBe(pending);
    await expect(
      withChatGPTPlanCredentialLock(
        second.prisma,
        "checkpoint-fixture-secret",
        async (transaction) => {
          await transaction.$executeRaw(
            Prisma.sql`INSERT INTO ${Prisma.raw(table)} (kind) VALUES ('ordinary-failure')`,
          );
          throw new Error("ordinary failure");
        },
      ),
    ).rejects.toThrow("ordinary failure");
    const rows = await first.prisma.$queryRaw<Array<{ kind: string }>>(
      Prisma.sql`SELECT kind FROM ${Prisma.raw(table)}`,
    );
    expect(rows).toEqual([{ kind: "encrypted-checkpoint-fixture" }]);
  });
});
