import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};

describe("routine test run model capture", () => {
  it.each(["connection-a", "connection-b"])(
    "captures the transaction's selected connection through its actual projection: %s",
    async (modelCredentialId) => {
      const routine = {
        id: "routine-1",
        botId: "bot-1",
        userId: actor.userId,
        spaceId: actor.spaceId,
        prompt: "Review this fixture",
        modelProvider: "openai-compatible",
        modelId: "same-model",
        modelCredentialId: "previous-connection",
        thinkingLevel: "low",
      };
      const currentModel = { ...routine, modelCredentialId, thinkingLevel: "high" };
      const findCurrent = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        Object.fromEntries(Object.entries(currentModel).filter(([key]) => select[key])),
      );
      const createRun = vi.fn(async () => ({ id: "test-run" }));
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: routine.id }])
          .mockResolvedValueOnce([{ id: modelCredentialId }]),
        task: { create: vi.fn(async () => ({ id: "test-task" })) },
        routine: { findUnique: findCurrent },
        run: { create: createRun },
      };
      const prisma = {
        routine: { findFirst: vi.fn(async () => routine) },
        bot: {
          findFirst: vi.fn(async () => ({
            id: "bot-1",
            thread: { id: "thread-1" },
            modelProvider: "openai-compatible",
            modelId: "other-model",
            modelCredentialId: "bot-connection",
          })),
        },
        spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
        agentSkill: { findMany: vi.fn(async () => []) },
        $queryRaw: vi.fn(async () => []),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      };
      const enqueue = vi.fn(async () => undefined);
      const client = createRouterClient(
        createRouter({ prisma, jobs: { enqueue }, env: {} } as unknown as RouterDeps),
        { context: { actor } },
      );

      await expect(client.routines.testRun({ routineId: routine.id })).resolves.toEqual({
        runId: "test-run",
      });
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            modelProvider: "openai-compatible",
            modelId: "same-model",
            modelCredentialId,
            thinkingLevel: "high",
            modelPinned: true,
          }),
        }),
      );
      expect(enqueue).toHaveBeenCalledOnce();
    },
  );
});
