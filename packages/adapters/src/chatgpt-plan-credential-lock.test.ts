import type { Prisma, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { withChatGPTPlanCredentialLock } from "./chatgpt-plan-credential-lock.js";

const pending = vi.hoisted(() => new Error("rotation verification pending"));
vi.mock("./chatgpt-plan-auth.js", () => ({
  isChatGPTPlanRotationPendingError: (error: unknown) => error === pending,
}));

describe("ChatGPT plan database credential lock", () => {
  it("acquires the credential advisory lock before reading or rotating and bounds the transaction", async () => {
    const order: string[] = [];
    const transaction = {
      $executeRaw: vi.fn(async () => {
        order.push("deadline");
        return 0;
      }),
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        expect(query.sql).toContain("pg_advisory_xact_lock");
        expect(query.sql).toContain("coginebot-chatgpt-plan");
        expect(query.values).toEqual(["secret-fixture"]);
        order.push("lock");
        return [];
      }),
    };
    const $transaction = vi.fn(
      async (operation: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        try {
          return await operation(transaction as unknown as Prisma.TransactionClient);
        } finally {
          order.push("release");
        }
      },
    );
    const prisma = { $transaction } as unknown as Pick<PrismaClient, "$transaction">;
    await expect(
      withChatGPTPlanCredentialLock(prisma, "secret-fixture", async (tx) => {
        expect(tx).toBe(transaction);
        order.push("rotate-and-persist");
        return "complete";
      }),
    ).resolves.toBe("complete");
    expect(order).toEqual(["deadline", "lock", "rotate-and-persist", "release"]);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15000,
      timeout: 75000,
    });
  });

  it("does not enter a secret operation after lock failure or retry a failed rotation", async () => {
    const operation = vi.fn(async () => {
      throw new Error("rotation failed");
    });
    let failLock = true;
    const prisma = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          $executeRaw: async () => 0,
          $queryRaw: async () => {
            if (failLock) throw new Error("lock unavailable");
            return [];
          },
        }),
    } as unknown as Pick<PrismaClient, "$transaction">;
    await expect(
      withChatGPTPlanCredentialLock(prisma, "secret-fixture", operation),
    ).rejects.toThrow("lock unavailable");
    expect(operation).not.toHaveBeenCalled();
    failLock = false;
    await expect(
      withChatGPTPlanCredentialLock(prisma, "secret-fixture", operation),
    ).rejects.toThrow("rotation failed");
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it("commits a pending rotation checkpoint before rethrowing, but rolls ordinary failures back", async () => {
    const outcomes: string[] = [];
    const prisma = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        try {
          const value = await run({ $executeRaw: async () => 0, $queryRaw: async () => [] });
          outcomes.push("commit");
          return value;
        } catch (error) {
          outcomes.push("rollback");
          throw error;
        }
      },
    } as unknown as Pick<PrismaClient, "$transaction">;
    await expect(
      withChatGPTPlanCredentialLock(prisma, "secret-fixture", async () => {
        outcomes.push("checkpoint-written");
        throw pending;
      }),
    ).rejects.toBe(pending);
    expect(outcomes).toEqual(["checkpoint-written", "commit"]);
    outcomes.length = 0;
    await expect(
      withChatGPTPlanCredentialLock(prisma, "secret-fixture", async () => {
        throw new Error("ordinary failure");
      }),
    ).rejects.toThrow("ordinary failure");
    expect(outcomes).toEqual(["rollback"]);
  });
});
