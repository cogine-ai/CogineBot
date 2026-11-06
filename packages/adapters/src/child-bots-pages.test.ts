import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { destroyBot } from "./child-bots.js";

describe("deleting a bot's pages", () => {
  it("ends page links and deletes their token rows before the page and bot commit", async () => {
    const order: string[] = [];
    const transaction = vi
      .fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const result = await callback({
          $queryRaw: vi.fn(async () => [{ id: "bot-1" }]),
          chatGroup: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
          artifact: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
          page: {
            updateMany: vi.fn(async () => {
              order.push("end links");
            }),
            deleteMany: vi.fn(async () => {
              order.push("delete pages");
            }),
          },
          secret: {
            findMany: vi.fn(async () => [{ id: "secret-1", ciphertext: "sealed-ref-1" }]),
            deleteMany: vi.fn(async () => {
              order.push("delete token rows");
            }),
          },
          computerExecutionLease: { deleteMany: vi.fn() },
          computer: { updateMany: vi.fn() },
          botDeletion: { create: vi.fn() },
          bot: {
            delete: vi.fn(async () => {
              order.push("delete bot");
            }),
          },
        });
        order.push("commit");
        return result;
      })
      .mockImplementationOnce(async (callback) => callback({}));
    const prisma = {
      computer: { findUnique: vi.fn(async () => null) },
      run: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    await destroyBot(
      {
        prisma,
        sandbox: {} as SandboxProvider,
        home: {} as AgentHomeStore,
        jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      },
      { id: "bot-1", userId: "owner-1", spaceId: "space-1", name: "Plan", archivedAt: null },
      { userId: "owner-1", spaceId: "space-1", operationId: "delete-bot" } as AdapterContext,
      { deleteMemories: true },
    );
    expect(order).toEqual([
      "end links",
      "delete token rows",
      "delete pages",
      "delete bot",
      "commit",
    ]);
  });
});
