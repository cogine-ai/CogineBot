import { createRouterClient } from "@orpc/server";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

const actor: Actor = {
  spaceId: "space",
  userId: "user",
  email: "test@example.test",
  isDeploymentOwner: true,
};

function fixture() {
  const server = {
    id: "server",
    ...actor,
    slug: "demo",
    name: "Demo",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.example.test/mcp",
    command: null,
    args: [],
    env: {},
    headers: {},
    secretId: null,
    enabled: true,
    allowAllTools: false,
    allowedTools: [] as string[],
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const bots = ["bot-1", "bot-2", "future-bot"].map((id) => ({ id, ...actor, archivedAt: null }));
  const threads = bots.map((bot) => ({
    id: `thread-${bot.id}`,
    botId: bot.id,
    spaceId: actor.spaceId,
    userId: actor.userId,
  }));
  const messages = threads.map((thread) => ({
    id: `card-${thread.botId}`,
    botId: thread.botId,
    threadId: thread.id,
    thread,
    blocks: [
      {
        kind: "mcp_approval",
        serverId: server.id,
        serverRevision: 1,
        name: "Demo",
        transport: "streamable_http",
        endpoint: server.endpoint,
        needsOAuth: false,
        status: "pending",
      },
    ] as MessageBlock[],
  }));
  const owned = (where: Record<string, unknown>) =>
    where.spaceId === actor.spaceId && where.userId === actor.userId;
  const matchesServer = (where: Record<string, unknown>) =>
    owned(where) &&
    (where.id === undefined || where.id === server.id) &&
    (where.enabled === undefined || where.enabled === server.enabled) &&
    (where.revision === undefined || where.revision === server.revision);
  let markFirstTransaction!: () => void;
  const firstTransaction = new Promise<void>((resolve) => {
    markFirstTransaction = resolve;
  });
  const prisma = {
    mcpServer: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchesServer(where) ? { ...server } : null,
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!matchesServer(where)) throw new Error("not found");
        return { ...server };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) ? [{ ...server }] : [],
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: { allowAllTools: boolean; allowedTools: string[]; revision: { increment: number } };
        }) => {
          if (!matchesServer(where)) return { count: 0 };
          Object.assign(server, data, { revision: server.revision + data.revision.increment });
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async ({
          data,
        }: {
          data: { allowAllTools: boolean; allowedTools: string[]; revision: { increment: number } };
        }) => {
          Object.assign(server, data, { revision: server.revision + data.revision.increment });
          return { ...server };
        },
      ),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) ? (bots.find((bot) => bot.id === where.id) ?? null) : null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        owned(where) ? bots : [],
      ),
    },
    thread: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!owned(where)) return [];
        return where.id ? threads.filter((thread) => thread.id === where.id) : threads;
      }),
    },
    message: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            threadId?: string;
            botId?: string;
            thread: Record<string, unknown>;
            blocks: { array_contains: Array<{ serverId: string }> };
          };
        }) => {
          if (!owned(where.thread)) return [];
          return messages.filter(
            (message) =>
              (!where.threadId || message.threadId === where.threadId) &&
              (!where.botId || message.botId === where.botId) &&
              message.blocks.some(
                (block) =>
                  block.kind === "mcp_approval" &&
                  block.serverId === where.blocks.array_contains[0]?.serverId,
              ),
          );
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
          const message = messages.find((entry) => entry.id === where.id)!;
          message.blocks = data.blocks;
          return message;
        },
      ),
    },
    botMcpServer: { createMany: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    async $transaction<T>(effect: (tx: typeof prisma) => Promise<T>): Promise<T> {
      // Serialize commits and roll back snapshots to exercise either deterministic race winner.
      markFirstTransaction();
      const prior = transaction;
      let release!: () => void;
      transaction = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      const snapshot = structuredClone({
        server,
        blocks: messages.map((message) => message.blocks),
      });
      try {
        return await effect(prisma);
      } catch (error) {
        Object.assign(server, snapshot.server);
        messages.forEach((message, index) => {
          message.blocks = snapshot.blocks[index]!;
        });
        throw error;
      } finally {
        release();
      }
    },
  };
  let transaction = Promise.resolve();
  const deps = {
    prisma,
    events: { notify: vi.fn() },
    secrets: {},
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/mcp-sharing-test",
  } as unknown as RouterDeps;
  const clientFor = (currentActor = actor) =>
    createRouterClient(createRouter(deps), { context: { actor: currentActor } as never });
  return { server, messages, prisma, client: clientFor(), clientFor, firstTransaction };
}

function statuses(messages: ReturnType<typeof fixture>["messages"]) {
  return messages.map(
    (message) => (message.blocks[0] as Extract<MessageBlock, { kind: "mcp_approval" }>).status,
  );
}

describe("shared registered MCP settings", () => {
  it("saves one explicit allowlist for existing and future bots and paints their pending cards", async () => {
    const { client, server, messages, prisma } = fixture();
    const saved = await client.mcp.servers.setTools({
      id: "server",
      revision: 1,
      allowAllTools: false,
      allowedTools: ["read", "read"],
    });
    expect(saved).toMatchObject({ allowAllTools: false, allowedTools: ["read"], revision: 2 });
    expect(server.allowedTools).toEqual(["read"]);
    expect(statuses(messages)).toEqual(["connected", "connected", "connected"]);
    for (const botId of ["bot-1", "bot-2", "future-bot"]) {
      expect(await client.mcp.assignments.list({ botId })).toMatchObject([
        { botId, serverId: "server", allowAllTools: false, allowedTools: ["read"] },
      ]);
    }
    expect(prisma.botMcpServer.createMany).not.toHaveBeenCalled();
    expect(prisma.botMcpServer.upsert).not.toHaveBeenCalled();
    expect(prisma.botMcpServer.findMany).not.toHaveBeenCalled();
  });

  it("rejects stale settings and old per-Bot replacement without changing the shared policy", async () => {
    const { client, server } = fixture();
    await client.mcp.servers.setTools({
      id: "server",
      revision: 1,
      allowAllTools: false,
      allowedTools: ["read"],
    });
    await expect(
      client.mcp.servers.setTools({
        id: "server",
        revision: 1,
        allowAllTools: true,
        allowedTools: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.mcp.assignments.replace({ botId: "bot-1", assignments: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(server).toMatchObject({ revision: 2, allowAllTools: false, allowedTools: ["read"] });
  });

  it("requires the original card revision and rejects missing, dismissed, or superseded cards", async () => {
    const { client, server, messages } = fixture();
    const approve = { botId: "bot-1", serverId: "server", threadId: "thread-bot-1" };
    await expect(client.mcp.assignments.approve(approve)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(client.mcp.assignments.approve({ ...approve, revision: 2 })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    await client.mcp.assignments.dismiss(approve);
    await expect(client.mcp.assignments.approve({ ...approve, revision: 1 })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    expect(server).toMatchObject({ allowAllTools: false, allowedTools: [], revision: 1 });
    expect(statuses(messages)).toEqual(["dismissed", "pending", "pending"]);
  });

  it("does not widen an existing restricted policy through another Bot's old approval card", async () => {
    const { client, server, messages } = fixture();
    await client.mcp.servers.setTools({
      id: "server",
      revision: 1,
      allowAllTools: false,
      allowedTools: ["read"],
    });
    const card = messages[1]!.blocks[0] as Extract<MessageBlock, { kind: "mcp_approval" }>;
    card.status = "pending";
    card.serverRevision = 2;
    await client.mcp.assignments.approve({
      botId: "bot-2",
      serverId: "server",
      threadId: "thread-bot-2",
      revision: 2,
    });
    expect(server).toMatchObject({ allowAllTools: false, allowedTools: ["read"], revision: 2 });
    expect(statuses(messages)).toEqual(["connected", "connected", "connected"]);
  });

  it("enables all tools only after an explicit current card approval and rejects its replay", async () => {
    const { client, server, messages } = fixture();
    const approve = { botId: "bot-1", serverId: "server", threadId: "thread-bot-1", revision: 1 };
    await client.mcp.assignments.approve(approve);
    expect(server).toMatchObject({ allowAllTools: true, allowedTools: [], revision: 2 });
    expect(statuses(messages)).toEqual(["connected", "connected", "connected"]);
    await expect(client.mcp.assignments.approve(approve)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await client.mcp.assignments.dismiss(approve);
    expect(server).toMatchObject({ allowAllTools: true, revision: 2 });
  });

  it.each(["settings", "card"])(
    "keeps policy, revision and all Bot cards consistent when %s wins",
    async (winner) => {
      const { client, server, messages, firstTransaction } = fixture();
      const settings = () =>
        client.mcp.servers.setTools({
          id: "server",
          revision: 1,
          allowAllTools: false,
          allowedTools: ["read"],
        });
      const card = () =>
        client.mcp.assignments.approve({
          botId: "bot-1",
          serverId: "server",
          threadId: "thread-bot-1",
          revision: 1,
        });
      const leading = winner === "settings" ? settings() : card();
      await firstTransaction;
      const trailing = winner === "settings" ? card() : settings();
      const outcomes = await Promise.allSettled([leading, trailing]);
      expect(outcomes[0]?.status).toBe("fulfilled");
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
      expect(server).toMatchObject({
        revision: 2,
        allowAllTools: winner === "card",
        allowedTools: winner === "card" ? [] : ["read"],
      });
      expect(statuses(messages)).toEqual(["connected", "connected", "connected"]);
    },
  );

  it("keeps server policy changes isolated by both user and Space", async () => {
    const { clientFor, server } = fixture();
    for (const foreign of [
      { ...actor, userId: "other-user" },
      { ...actor, spaceId: "other-space" },
    ]) {
      const client = clientFor(foreign);
      await expect(
        client.mcp.servers.setTools({
          id: "server",
          revision: 1,
          allowAllTools: true,
          allowedTools: [],
        }),
      ).rejects.toThrow();
      await expect(
        client.mcp.assignments.approve({ botId: "bot-1", serverId: "server", revision: 1 }),
      ).rejects.toThrow();
    }
    expect(server).toMatchObject({ revision: 1, allowAllTools: false });
  });
});
