import { createHash } from "node:crypto";
import type { AdapterContext, ConnectedConnector, ConnectorCall } from "@rakazo/adapter-kit";
import { canonicalConnectionAppId } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Bind approvals to both the local row and its current upstream authorization. */
export function connectorAccountRevision(connection: ConnectedConnector): string {
  return createHash("sha256")
    .update(
      JSON.stringify([connection.id, connection.providerRef ?? null, connection.revision ?? null]),
    )
    .digest("hex");
}

export function connectorAccountSetRevision(connections: ConnectedConnector[]): string {
  return createHash("sha256")
    .update(JSON.stringify(connections.map(connectorAccountRevision).sort()))
    .digest("hex");
}

export function connectionAuthorizationRevision(row: {
  metadata?: unknown;
  updatedAt?: Date;
}): string | undefined {
  const metadata = row.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const revision = (metadata as Record<string, unknown>).authRevision;
    if (typeof revision === "string" && revision.length > 0) return revision;
  }
  return row.updatedAt?.toISOString();
}

/** A concrete grant generation cannot be inferred from an app-level live slug. */
export function allowsLegacyConnectorRecovery<T extends { provider?: string; metadata?: unknown }>(
  row: T,
  rows: readonly T[],
): boolean {
  if (connectionAuthorizationRevision({ metadata: row.metadata }) !== undefined) return false;
  return (
    !row.provider ||
    !rows.some(
      (sibling) =>
        sibling.provider?.trim().toLowerCase() === row.provider?.trim().toLowerCase() &&
        connectionAuthorizationRevision({ metadata: sibling.metadata }) !== undefined,
    )
  );
}

/** The context must be freshly scoped to the executing owner and Space. Never choose a sibling. */
export function assertBoundConnectorAccount(
  call: ConnectorCall,
  context: AdapterContext,
): ConnectedConnector | undefined {
  const connectionId = call.connectionId ?? call.route?.connectionId;
  if (!connectionId) return undefined;
  if (
    call.connectionId &&
    call.route?.connectionId &&
    call.connectionId !== call.route.connectionId
  ) {
    throw new Error("Connector account selection does not match its authorized route");
  }
  const connection = context.connectedConnections?.find(
    (candidate) => candidate.id === connectionId,
  );
  if (
    !connection ||
    connection.connectorId !== call.route?.connectorId ||
    connection.externalId !== call.route.resourceId ||
    connectorAccountRevision(connection) !== call.route.resourceRevision
  ) {
    throw new Error(
      "Selected connector account is unavailable or its authorization changed. Select it again.",
    );
  }
  return connection;
}

/** Candidates retain the executor's existing eligibility decision; this only constrains intent. */
export function selectExplicitConnectorAccounts<
  T extends {
    id: string;
    connectorId: string;
    provider: string;
    status: string;
  },
>(rows: T[], selectedIds: readonly string[]): T[] {
  const selected = new Set(selectedIds);
  const key = (row: T) => {
    const known = canonicalConnectionAppId(row.provider);
    return known
      ? `app:${known}`
      : `source:${row.connectorId}:${row.provider.trim().toLowerCase()}`;
  };
  const constrained = new Set<string>();
  for (const id of selected) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row?.status !== "connected") {
      throw new Error(
        "An explicitly selected connector account is unavailable. Reconnect or select it again.",
      );
    }
    constrained.add(key(row));
  }
  return rows.filter((row) => !constrained.has(key(row)) || selected.has(row.id));
}

/** Re-read the intent and authorizations immediately before resolving or executing a call. */
export async function refreshRunConnectorContext(
  prisma: PrismaClient,
  context: AdapterContext,
  taskId: string,
): Promise<AdapterContext> {
  const [task, rows] = await Promise.all([
    prisma.task.findUniqueOrThrow({
      where: { id: taskId, userId: context.userId, spaceId: context.spaceId },
      select: { connectionIds: true },
    }),
    prisma.connection.findMany({
      where: { userId: context.userId, spaceId: context.spaceId },
      select: {
        id: true,
        connectorId: true,
        provider: true,
        providerRef: true,
        displayName: true,
        status: true,
        metadata: true,
        updatedAt: true,
      },
    }),
  ]);
  const candidates = rows.filter((row) => {
    if (row.status === "connected") return true;
    if (row.connectorId !== "composio" || (row.status !== "pending" && row.status !== "error"))
      return false;
    if (
      !allowsLegacyConnectorRecovery(
        row,
        rows.filter((candidate) => candidate.connectorId === row.connectorId),
      )
    )
      return false;
    // Preserve the existing live-confirmed recovery when its local status write
    // failed. Only the same run-authorized identity may continue; a revoked row
    // or a newly created pending row can never enter through this compatibility path.
    const initial = context.connectedConnections?.find((connection) => connection.id === row.id);
    return Boolean(
      initial &&
        initial.providerRef === (row.providerRef ?? undefined) &&
        initial.revision === connectionAuthorizationRevision(row) &&
        !rows.some(
          (sibling) =>
            sibling.connectorId === row.connectorId &&
            sibling.provider.toLowerCase() === row.provider.toLowerCase() &&
            sibling.status === "connected",
        ),
    );
  });
  const selected = selectExplicitConnectorAccounts(candidates, task.connectionIds ?? []);
  return {
    ...context,
    connectedConnections: selected.map((row) => ({
      id: row.id,
      connectorId: row.connectorId,
      externalId: row.provider,
      providerRef: row.providerRef ?? undefined,
      displayName: row.displayName,
      revision: connectionAuthorizationRevision(row),
    })),
    connectedProviders: selected
      .filter((row) => row.connectorId === "composio")
      .map((row) => row.provider),
  };
}
