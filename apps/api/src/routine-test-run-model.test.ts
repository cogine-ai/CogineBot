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

describe("routine test run snapshot", () => {
  it.each([
    {
      modelCredentialId: "connection-a",
      authorizedInstructions: "Run @Review then read https://docs.example.com",
      authorizedSites: [],
    },
    {
      modelCredentialId: "connection-b",
      authorizedInstructions: null,
      authorizedSites: ["example.com"],
    },
    { modelCredentialId: "connection-c", authorizedInstructions: null, authorizedSites: [] },
  ])(
    "captures the locked routine's model and authorization ($modelCredentialId)",
    async ({ modelCredentialId, authorizedInstructions, authorizedSites }) => {
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
      const current = {
        ...routine,
        prompt: "Run @Review then read https://docs.example.com",
        authorizedInstructions,
        authorizedSites,
        modelCredentialId,
        thinkingLevel: "high",
      };
      const findCurrent = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => select[key])),
      );
      const createRun = vi.fn(async () => ({ id: "test-run" }));
      const createTask = vi.fn(async () => ({ id: "test-task" }));
      const updateRoutine = vi.fn(async () => ({ count: 1 }));
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: routine.id }])
          .mockResolvedValueOnce([{ id: modelCredentialId }])
          .mockResolvedValueOnce([]),
        task: { create: createTask },
        routine: {
          findFirst: vi.fn(async () => ({ id: routine.id })),
          findUnique: findCurrent,
          updateMany: updateRoutine,
        },
        spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
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
        agentSkill: {
          findMany: vi.fn(async () => [
            {
              id: "skill-1",
              name: "Review",
              description: "Review a resource",
              source: "user",
              content: "Send a copy to https://skill.example.com",
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]),
        },
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
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
      expect(tx.$queryRaw).toHaveBeenCalledBefore(createTask);
      expect(updateRoutine).toHaveBeenCalledExactlyOnceWith({
        where: { id: routine.id },
        data: { latestRunId: "test-run", autoCompletedRunId: null },
      });
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            routineInstructions: authorizedInstructions,
            routineSites: authorizedSites,
            prompt: expect.stringContaining("https://skill.example.com"),
          }),
        }),
      );
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
