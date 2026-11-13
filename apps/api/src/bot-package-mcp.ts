import { ORPCError } from "@orpc/server";
import type { Actor, AgentBackupMcp, MessageBlock } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";

async function savePendingServer(
  tx: Prisma.TransactionClient,
  actor: Actor,
  connection: AgentBackupMcp,
) {
  const base = /^[a-z0-9]/.test(connection.name.toLowerCase())
    ? deriveMcpSlug(connection.name)
    : deriveMcpSlug(`mcp-${connection.name}`);
  for (let number = 1; number <= 100; number++) {
    const suffix = number === 1 ? "" : `-${number}`;
    const [server] = await tx.mcpServer.createManyAndReturn({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: number === 1 ? connection.name : `${connection.name} (${number})`,
        slug: base.slice(0, 64 - suffix.length) + suffix,
        transport: connection.transport,
        endpoint: connection.endpoint,
        enabled: true,
        allowAllTools: false,
        allowedTools: [],
      },
      select: { id: true, name: true },
      skipDuplicates: true,
    });
    if (server) return server;
  }
  throw new ORPCError("CONFLICT", { message: "Could not reserve a name for this connection." });
}

export async function importPendingMcpServers(
  tx: Prisma.TransactionClient,
  actor: Actor,
  target: { botId: string; threadId: string; importId: string },
  connections: readonly AgentBackupMcp[],
): Promise<Prisma.BotPackageComponentCreateManyInput[]> {
  const blocks: MessageBlock[] = [];
  const components: Prisma.BotPackageComponentCreateManyInput[] = [];
  for (const connection of connections) {
    const server = await savePendingServer(tx, actor, connection);
    blocks.push({
      kind: "mcp_approval",
      name: server.name,
      serverId: server.id,
      // No revision: the card opens individual tool settings instead of approving all tools.
      transport: connection.transport,
      endpoint: connection.endpoint,
      needsOAuth: false,
      status: "pending",
    });
    components.push({
      importId: target.importId,
      botId: target.botId,
      key: `connection:${connection.path}`,
      kind: "mcp",
      name: server.name,
      description: "",
    });
  }
  const { botId, threadId } = target;
  const message = await createThreadMessageInTransaction(tx, {
    threadId,
    botId,
    role: "bot",
    blocks,
    markUnread: false,
  });
  await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId,
    botId,
    type: "thread.message.created",
    payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks },
  });
  return components;
}
