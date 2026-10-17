import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

describe("typed connector mentions", () => {
  function fixture(trigger?: "user" | "routine", group = false) {
    let seq = 0;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
          data.nextMessageSeq ? { nextMessageSeq: ++seq } : { nextEventSeq: ++seq },
        ),
      },
      connection: {
        findMany: vi.fn().mockResolvedValue([{ id: "account-work", displayName: "Work" }]),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          id: "message-1",
          seq: 1,
          blocks: [{ kind: "text", text: "check" }],
        }),
        update: vi.fn(),
      },
      task: { create: vi.fn().mockResolvedValue({ id: "task-new" }), updateMany: vi.fn() },
      run: {
        findUnique: vi.fn().mockResolvedValue({ status: "running", startedAt: new Date(0) }),
        findMany: vi
          .fn()
          .mockResolvedValueOnce(
            trigger
              ? [
                  {
                    id: "run-existing",
                    taskId: "task-existing",
                    botId: "bot-a",
                    status: "running",
                    trigger,
                  },
                ]
              : [],
          )
          .mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: "run-new",
          taskId: "task-new",
          botId: "bot-a",
          status: "queued",
        }),
      },
      steeringMessage: { create: vi.fn() },
      event: { create: vi.fn().mockResolvedValue({ seq: 2 }) },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          id: "group-1",
          members: [
            { bot: { id: "bot-a", name: "Alpha", color: null } },
            { bot: { id: "bot-b", name: "Beta", color: null } },
          ],
        }),
        update: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const actor = { spaceId: "space-1", userId: "user-1" } as Actor;
    const target: ThreadTarget = group
      ? {
          kind: "group",
          groupId: "group-1",
          groupName: "Team",
          threadId: "thread-1",
          members: [],
          memberBotIds: ["bot-a", "bot-b"],
        }
      : ({
          kind: "bot",
          botId: "bot-a",
          threadId: "thread-1",
          bot: { computer: null },
        } as ThreadTarget);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const send = () =>
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue } as never,
        },
        actor,
        target,
        {
          text: "check",
          mentions: [
            { kind: "connector", id: "account-work" },
            ...(group ? [{ kind: "bot" as const, id: "bot-a" }] : []),
          ],
        },
      );
    return { tx, send, enqueue };
  }

  it.each([false, true])(
    "persists the exact target on a new task without changing prompt behavior (group %s)",
    async (group) => {
      const f = fixture(undefined, group);
      await f.send();
      expect(f.tx.connection.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["account-work"] },
          spaceId: "space-1",
          userId: "user-1",
          status: "connected",
        },
        select: { id: true, displayName: true },
      });
      expect(f.tx.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          connectionIds: ["account-work"],
          prompt: "check\n\nUse these connectors if relevant: Work.",
        }),
      });
      expect(f.tx.steeringMessage.create).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "persists steering intent for later consumption without changing the active task (group %s)",
    async (group) => {
      const f = fixture("user", group);
      await f.send();
      expect(f.tx.steeringMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          runId: "run-existing",
          connectionIds: ["account-work"],
        }),
      });
      expect(f.tx.task.updateMany).not.toHaveBeenCalled();
      expect(f.tx.task.create).not.toHaveBeenCalled();
    },
  );

  it("keeps background work unchanged and retains the target for its normal continuation", async () => {
    const f = fixture("routine");
    await f.send();
    expect(f.tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: null,
        connectionIds: ["account-work"],
      }),
    });
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("rejects unowned, cross-Space, or unavailable references before creating work", async () => {
    const f = fixture();
    f.tx.connection.findMany.mockResolvedValue([]);
    await expect(f.send()).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.task.create).not.toHaveBeenCalled();
  });
});
