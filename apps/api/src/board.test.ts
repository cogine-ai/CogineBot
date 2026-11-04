import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("disabled ticket board", () => {
  it.each([undefined, false])(
    "refuses every route and stream before accessing the database (%s)",
    async (enabled) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const follow = vi.fn();
      const prisma = new Proxy({}, { get: () => query });
      const client = createRouterClient(
        createRouter({
          prisma,
          env: { ticketBoardEnabled: enabled },
          boardEvents: { follow },
        } as unknown as RouterDeps),
        { context: { actor } },
      );
      const calls = [
        () => client.boards.list(),
        () => client.boards.get(),
        () => client.boards.rename({ name: "Launch" }),
        () => client.boards.subscribe(),
        () => client.tickets.list({}),
        () => client.tickets.get({ id: "ticket-1" }),
        () => client.tickets.create({ title: "Launch", assigneeBotId: "bot-1" }),
        () => client.tickets.update({ id: "ticket-1", assigneeBotId: "bot-1" }),
        () => client.tickets.move({ id: "ticket-1", status: "doing" }),
        () => client.tickets.comment({ ticketId: "ticket-1", body: "Ready" }),
        () => client.tickets.comments({ ticketId: "ticket-1" }),
      ];
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(query).not.toHaveBeenCalled();
      expect(follow).not.toHaveBeenCalled();
    },
  );
});

it.each([false, true])("includes the board capability in me (%s)", async (ticketBoardEnabled) => {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        email: "user@rakazo.test",
        name: "Test",
        avatarStyle: "robot",
      })),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
  };
  const deps = {
    prisma,
    env: {
      ticketBoardEnabled,
      defaultProvider: "fake",
      defaultModel: "fake-model",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  await expect(client.me()).resolves.toHaveProperty("ticketBoardEnabled", ticketBoardEnabled);
});

describe("ticket caller identity", () => {
  function fixture() {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const board = {
      id: "board-1",
      spaceId: actor.spaceId,
      name: "Work",
      ticketPrefix: "WORK",
      nextNumber: 2,
      createdAt: now,
      updatedAt: now,
    };
    const ticket = {
      id: "ticket-1",
      boardId: board.id,
      spaceId: actor.spaceId,
      number: 1,
      title: "Original",
      description: null,
      status: "todo",
      priority: "normal",
      assigneeBotId: "old-bot",
      createdByBotId: null,
      createdByUserId: "another-member",
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const bots = [
      { id: "own-bot", spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      { id: "foreign-bot", spaceId: actor.spaceId, userId: "another-member", archivedAt: null },
    ];
    const changes: unknown[] = [];
    const prisma = {
      board: { findUnique: vi.fn(async () => board) },
      bot: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            bots.find((bot) =>
              Object.entries(where).every(
                ([key, value]) => value === undefined || bot[key as keyof typeof bot] === value,
              ),
            ) ?? null,
        ),
      },
      ticket: {
        findFirst: vi.fn(async () => ({ ...ticket })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(ticket, data);
          return { ...ticket };
        }),
      },
      $queryRaw: vi.fn(async () => []),
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
        callback(prisma),
    };
    const client = createRouterClient(
      createRouter({
        prisma,
        env: { ticketBoardEnabled: true },
        ticketChanges: async (change: unknown) => {
          changes.push(change);
        },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    return { client, changes, ticket };
  }

  it("moves an existing shared ticket using the authenticated caller", async () => {
    const f = fixture();
    await expect(f.client.tickets.move({ id: "ticket-1", status: "doing" })).resolves.toMatchObject(
      {
        id: "ticket-1",
        status: "doing",
      },
    );
    expect(f.changes).toEqual([
      expect.objectContaining({ ticketId: "ticket-1", wakeAssignee: false }),
    ]);
  });

  it("assigns to the authenticated caller's bot despite a forged input user", async () => {
    const f = fixture();
    await expect(
      f.client.tickets.update({
        id: "ticket-1",
        assigneeBotId: "own-bot",
        userId: "another-member",
      } as never),
    ).resolves.toMatchObject({ assigneeBotId: "own-bot" });
    expect(f.changes).toEqual([
      expect.objectContaining({ ticketId: "ticket-1", wakeAssignee: true }),
    ]);
  });

  it("refuses another member's bot without changing or notifying the ticket", async () => {
    const f = fixture();
    await expect(
      f.client.tickets.update({
        id: "ticket-1",
        assigneeBotId: "foreign-bot",
        userId: "another-member",
      } as never),
    ).rejects.toBeDefined();
    expect(f.ticket.assigneeBotId).toBe("old-bot");
    expect(f.changes).toEqual([]);
  });
});
