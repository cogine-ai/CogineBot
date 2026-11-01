import { ORPCError } from "@orpc/server";
import type { JobPublisher, SecretStore } from "@rakazo/adapter-kit";
import type { McpOAuthBroker } from "@rakazo/adapters";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "@rakazo/adapters";
import type { Actor, MessageBlock, PluginUninstallInput } from "@rakazo/contracts";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  IsolationError,
  isPluginSecretReferenced,
  lockPluginInstall,
  readPluginCleanupRefs,
} from "@rakazo/db";
import { dismissMcpServerApprovals } from "./mcp-approval.js";
import { pluginInstallReceipt } from "./plugin-install-receipt.js";

type Tx = Prisma.TransactionClient;
type Scope = Pick<Actor, "spaceId" | "userId">;
type Seq = { threadId: string; seq: number };
type Deps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  events: Pick<ThreadEvents, "notify">;
  jobs?: Pick<JobPublisher, "enqueue">;
  mcpOAuth?: Pick<McpOAuthBroker, "discardPluginPending">;
};
const includeChildren = { agentSkills: true, mcpServers: true } as const;
const removedResult = {
  error: "This plugin was removed before the tool ran.",
  code: "plugin_removed",
};

async function authorized(tx: Tx, actor: Actor, id: string) {
  const row = await tx.capabilityInstall.findFirst({
    where: { id, spaceId: actor.spaceId, kind: "plugin", clientNonce: { not: null } },
    include: includeChildren,
  });
  const member = await tx.spaceMember.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    select: { role: true },
  });
  if (!row || !member || (row.userId !== actor.userId && member.role !== "owner")) {
    throw new IsolationError();
  }
  return row;
}

/** Close exact, never-dispatched tool asks without inventing a user approval decision. */
async function closeToolApprovals(tx: Tx, owner: Scope, serverIds: string[]) {
  const effects = await tx.externalEffect.findMany({
    where: {
      spaceId: owner.spaceId,
      run: { userId: owner.userId, spaceId: owner.spaceId },
      status: { in: ["intended", "approved"] },
    },
    include: { run: { select: { id: true, threadId: true } } },
  });
  const targets = effects.filter((effect) => {
    const route =
      boundDirectApprovalDetails(effect.request, "__rakazoCatalogTool")?.route ??
      catalogApprovalDetails(effect.request, "__rakazoCatalogTool")?.route;
    return route?.connectorId === "mcp" && serverIds.includes(route.resourceId);
  });
  for (const threadId of [...new Set(targets.map((effect) => effect.run.threadId))].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  }
  const closed: string[] = [];
  for (const effect of targets) {
    const changed = await tx.externalEffect.updateMany({
      where: { id: effect.id, status: { in: ["intended", "approved"] } },
      data: { status: "completed", result: removedResult },
    });
    if (changed.count === 1) closed.push(effect.id);
  }
  const runIds = [
    ...new Set(
      targets.filter((effect) => closed.includes(effect.id)).map((effect) => effect.runId),
    ),
  ];
  const messages = runIds.length
    ? await tx.message.findMany({
        where: {
          runId: { in: runIds },
          role: "bot",
          thread: { spaceId: owner.spaceId, userId: owner.userId },
        },
        select: { id: true, seq: true, botId: true, threadId: true, runId: true, blocks: true },
      })
    : [];
  const seqs: Seq[] = [];
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (!Array.isArray(blocks)) continue;
    let changed = false;
    const next = blocks.map((block) => {
      if (
        block.kind !== "ask" ||
        block.status === "answered" ||
        !closed.includes(block.approvalEffectId ?? "")
      )
        return block;
      changed = true;
      const { answer: _answer, ...rest } = block;
      return { ...rest, status: "answered" as const, detail: removedResult.error };
    });
    if (!changed || !message.botId) continue;
    await tx.message.update({
      where: { id: message.id },
      data: { blocks: next as Prisma.InputJsonValue },
    });
    const event = await appendEventInTransaction(tx, {
      ...owner,
      threadId: message.threadId,
      botId: message.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, messageSeq: message.seq, role: "bot", blocks: next },
    });
    seqs.push({ threadId: message.threadId, seq: event.seq });
  }
  const resumes: string[] = [];
  for (const runId of runIds) {
    const pending = messages.some(
      (message) =>
        message.runId === runId &&
        Array.isArray(message.blocks) &&
        (message.blocks as MessageBlock[]).some(
          (block) =>
            block.kind === "ask" &&
            block.status !== "answered" &&
            !closed.includes(block.approvalEffectId ?? ""),
        ),
    );
    if (!pending) {
      const changed = await tx.run.updateMany({
        where: { id: runId, ...owner, status: "waiting_input" },
        data: { status: "queued" },
      });
      if (changed.count === 1) resumes.push(runId);
    }
  }
  return { seqs, resumes };
}

/** Detach only explicitly linked accounts; keep grants still used by another account. */
async function detachConnections(tx: Tx, owner: Scope, serverIds: string[]) {
  const rows = await tx.connection.findMany({
    where: { ...owner, mcpServerId: { in: serverIds } },
  });
  const ids = rows.map((row) => row.id);
  const sessions = ids.length
    ? await tx.nativeOAuthSession.findMany({ where: { ...owner, connectionId: { in: ids } } })
    : [];
  const secrets = [
    ...sessions.flatMap((session) => (session.secretId ? [session.secretId] : [])),
    ...rows.flatMap((row) => (row.secretId ? [row.secretId] : [])),
  ];
  if (ids.length) {
    await tx.nativeOAuthSession.updateMany({
      where: { ...owner, connectionId: { in: ids } },
      data: { cancelledAt: new Date(), secretId: null },
    });
    await tx.connection.updateMany({
      where: { ...owner, id: { in: ids } },
      data: { status: "revoked", secretId: null },
    });
  }
  for (const id of new Set(rows.flatMap((row) => (row.oauthGrantId ? [row.oauthGrantId] : [])))) {
    if (
      await tx.connection.count({
        where: {
          oauthGrantId: id,
          id: { notIn: ids },
          status: { in: ["connected", "pending", "error"] },
        },
      })
    )
      continue;
    const grant = await tx.nativeOAuthGrant.findFirst({ where: { id, ...owner } });
    if (!grant) continue;
    if (grant.secretId) secrets.push(grant.secretId);
    await tx.nativeOAuthGrant.updateMany({
      where: { id, ...owner },
      data: {
        revokedAt: new Date(),
        secretId: null,
        authGeneration: { increment: 1 },
        refreshLeaseId: null,
        refreshLeaseUntil: null,
        refreshRecoveryUntil: null,
      },
    });
  }
  return secrets;
}

export { isPluginSecretReferenced } from "@rakazo/db";

/** Durable disable precedes fallible remote cleanup. Removed rows retain their nonce receipt. */
export function createPluginUninstaller(deps: Deps) {
  return {
    async uninstall(actor: Actor, input: PluginUninstallInput) {
      const phase = await deps.prisma.$transaction(async (tx) => {
        await lockPluginInstall(tx, input.installId);
        const row = await authorized(tx, actor, input.installId);
        const owner = { userId: row.userId, spaceId: row.spaceId };
        if (row.status === "removed")
          return {
            row,
            owner,
            seqs: [] as Seq[],
            resumes: [] as string[],
            serverIds: [] as string[],
          };
        if (row.revision !== input.expectedRevision)
          throw new ORPCError("CONFLICT", { message: "Plugin changed; reload its status." });
        const prior = readPluginCleanupRefs(row.cleanupRefs);
        const ownedServers = row.mcpServers.filter(
          (server) => server.userId === owner.userId && server.spaceId === owner.spaceId,
        );
        const serverIds = ownedServers.map((server) => server.id);
        const ids = [
          ...ownedServers.flatMap((server) => (server.secretId ? [server.secretId] : [])),
          ...(await detachConnections(tx, owner, serverIds)),
        ];
        if (row.secretId) ids.push(row.secretId);
        const records = ids.length
          ? await tx.secret.findMany({
              where: { ...owner, id: { in: ids } },
              select: { id: true, ciphertext: true },
            })
          : [];
        const refs = [
          ...new Map(
            [...prior, ...records.map((record) => ({ id: record.id, ref: record.ciphertext }))].map(
              (record) => [record.id, record],
            ),
          ).values(),
        ];
        await tx.mcpServer.updateMany({
          where: { ...owner, installId: row.id },
          data: { enabled: false, secretId: null, revision: { increment: 1 } },
        });
        await tx.agentSkill.deleteMany({ where: { ...owner, installId: row.id } });
        const approval = await closeToolApprovals(tx, owner, serverIds);
        const seqs = [...approval.seqs];
        for (const id of serverIds)
          seqs.push(
            ...(await dismissMcpServerApprovals(
              { prisma: deps.prisma, events: deps.events as ThreadEvents },
              { ...actor, ...owner },
              id,
              tx,
            )),
          );
        await tx.mcpOAuthSession.deleteMany({ where: { ...owner, serverId: { in: serverIds } } });
        const updated = await tx.capabilityInstall.update({
          where: { id: row.id },
          data: {
            status: "uninstalling",
            revision: { increment: 1 },
            secretId: null,
            cleanupRefs: refs,
          },
          include: includeChildren,
        });
        return { row: updated, owner, serverIds, seqs, resumes: approval.resumes };
      });
      deps.mcpOAuth?.discardPluginPending(phase.serverIds, phase.owner);
      for (const event of phase.seqs)
        await deps.events.notify(event.threadId, event.seq).catch(() => undefined);
      for (const runId of phase.resumes)
        await deps.jobs
          ?.enqueue({ name: "run.continue", payload: { runId } })
          .catch(() => undefined);
      if (phase.row.status === "removed") return pluginInstallReceipt(phase.row);
      try {
        // Each item is committed separately. An unknown acknowledgement is safe to retry:
        // SecretStore.delete treats already-absent resources as an idempotent success.
        while (true) {
          const remaining = await deps.prisma.$transaction(
            async (tx) => {
              await lockPluginInstall(tx, input.installId);
              const row = await authorized(tx, actor, input.installId);
              if (row.status === "removed") return false;
              const refs = readPluginCleanupRefs(row.cleanupRefs);
              const item = refs.find((entry) => !entry.pending);
              if (!item) {
                if (refs.length) throw new Error("A credential write has not settled");
                return false;
              }
              if (item.pending) throw new Error("A credential write has not settled");
              if (!(await isPluginSecretReferenced(tx, item.id, item.ref))) {
                await deps.secrets.delete(item.ref, {
                  recordId: item.id,
                  signal: AbortSignal.timeout(10_000),
                });
                await tx.secret.deleteMany({
                  where: { id: item.id, ...phase.owner, ciphertext: item.ref },
                });
              }
              await tx.capabilityInstall.update({
                where: { id: row.id },
                data: {
                  cleanupRefs: refs.filter((entry) => entry.id !== item.id),
                  revision: { increment: 1 },
                },
              });
              return true;
            },
            { timeout: 20_000 },
          );
          if (!remaining) break;
        }
        return await deps.prisma.$transaction(async (tx) => {
          await lockPluginInstall(tx, input.installId);
          const row = await authorized(tx, actor, input.installId);
          if (row.status === "removed") return pluginInstallReceipt(row);
          if (readPluginCleanupRefs(row.cleanupRefs).length)
            throw new Error("Cleanup is incomplete");
          const ids = row.mcpServers.map((server) => server.id);
          const foreign = await tx.connection.count({
            where: { mcpServerId: { in: ids }, NOT: phase.owner },
          });
          if (foreign) throw new Error("A linked account is outside this installation");
          await tx.connection.deleteMany({ where: { ...phase.owner, mcpServerId: { in: ids } } });
          await tx.mcpServer.deleteMany({ where: { ...phase.owner, installId: row.id } });
          return pluginInstallReceipt(
            await tx.capabilityInstall.update({
              where: { id: row.id },
              data: { status: "removed", revision: { increment: 1 } },
              include: includeChildren,
            }),
          );
        });
      } catch {
        return deps.prisma.$transaction(async (tx) => {
          await lockPluginInstall(tx, input.installId);
          const row = await authorized(tx, actor, input.installId);
          if (row.status === "removed") return pluginInstallReceipt(row);
          return pluginInstallReceipt(
            await tx.capabilityInstall.update({
              where: { id: row.id },
              data: { status: "cleanup_failed", revision: { increment: 1 } },
              include: includeChildren,
            }),
          );
        });
      }
    },
  };
}
