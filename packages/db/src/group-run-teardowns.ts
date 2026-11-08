import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { withTransactionRetry } from "./transaction-retry.js";

export type GroupRunTeardownKey = {
  computerId: string;
  runId: string;
  spaceId: string;
  userId: string;
};

type LegacyExecution = { botId: string | null; fence: number };

type GroupRunTeardownMarker = {
  userId: string;
  botId: string;
  canonicalFence: number | null;
  legacy: LegacyExecution | null;
  providerRef: string | null;
  screenGeneration: number;
  providerDone: boolean;
};

type TeardownComputer = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
};

export type PendingGroupRunTeardown = {
  marker: GroupRunTeardownMarker;
  computer: TeardownComputer;
  providerCleanup: boolean;
};

type ComputerOwner = {
  id: string;
  providerRef: string | null;
  screenGeneration: number;
  executionRunId: string | null;
  executionBotId: string | null;
  executionFence: number;
};

type TeardownLease = {
  computerId: string;
  runId: string;
  botId: string;
  fence: number;
};

/** Record the old ownership in the same transaction as the group and Run cascade. */
export async function recordGroupRunTeardowns(
  tx: Prisma.TransactionClient,
  actor: Pick<GroupRunTeardownKey, "spaceId" | "userId">,
  activeRuns: { id: string; botId: string }[],
  priorCancelledRuns: { id: string; botId: string }[],
): Promise<{ keys: GroupRunTeardownKey[]; leasedRunIds: string[] }> {
  const runIds = [...activeRuns, ...priorCancelledRuns].map((run) => run.id);
  if (!runIds.length) return { keys: [], leasedRunIds: [] };
  // Two group deletions can touch the same Team computers. Take their row locks in ID order.
  const computers = await tx.$queryRaw<ComputerOwner[]>`
    SELECT c.id, c."providerRef", c."screenGeneration",
      c."executionRunId", c."executionBotId", c."executionFence"
    FROM public.computers c
    WHERE c."spaceId" = ${actor.spaceId}
      AND (c."executionRunId" = ANY(${runIds}::text[]) OR EXISTS (
        SELECT 1 FROM public.computer_execution_leases l
        WHERE l."computerId" = c.id AND l."runId" = ANY(${runIds}::text[])
      ))
    ORDER BY c.id FOR UPDATE OF c
  `;
  if (!computers.length) return { keys: [], leasedRunIds: [] };
  const activeRunIds = activeRuns.map((run) => run.id);
  const priorCancelledRunIds = priorCancelledRuns.map((run) => run.id);
  const leases = await tx.computerExecutionLease.findMany({
    where: {
      computerId: { in: computers.map(({ id }) => id) },
      OR: [
        { runId: { in: activeRunIds } },
        { runId: { in: priorCancelledRunIds }, expiresAt: { gt: new Date(0) } },
      ],
    },
    select: { computerId: true, runId: true, botId: true, fence: true },
  });
  const leasesByComputer = new Map<string, TeardownLease[]>();
  for (const lease of leases) {
    const local = leasesByComputer.get(lease.computerId) ?? [];
    local.push(lease);
    leasesByComputer.set(lease.computerId, local);
  }
  const leasedRunIds = [...new Set(leases.map((lease) => lease.runId))];
  // As with archive recovery, an old legacy pointer alone cannot recover a prior cancellation.
  const legacyRunIds = new Set([...activeRunIds, ...leasedRunIds]);
  const runBots = new Map(
    [...activeRuns, ...priorCancelledRuns].map(({ id, botId }) => [id, botId]),
  );
  const keys: GroupRunTeardownKey[] = [];
  for (const computer of computers) {
    const markers = new Map<string, GroupRunTeardownMarker>();
    const marker = (botId: string, canonicalFence: number | null): GroupRunTeardownMarker => ({
      userId: actor.userId,
      botId,
      canonicalFence,
      legacy: null,
      providerRef: computer.providerRef,
      screenGeneration: computer.screenGeneration,
      providerDone: false,
    });
    for (const lease of leasesByComputer.get(computer.id) ?? []) {
      markers.set(lease.runId, marker(lease.botId, lease.fence));
    }
    const { executionRunId, executionBotId, executionFence } = computer;
    if (executionRunId && legacyRunIds.has(executionRunId)) {
      const legacyBot = executionBotId ?? runBots.get(executionRunId);
      if (legacyBot) {
        const entry = markers.get(executionRunId) ?? marker(legacyBot, null);
        entry.legacy = { botId: executionBotId, fence: executionFence };
        markers.set(executionRunId, entry);
      }
    }
    if (!markers.size) continue;
    const changed = await tx.$executeRaw`
      UPDATE public.computers
      SET "pendingGroupRunTeardowns" =
        COALESCE("pendingGroupRunTeardowns", '{}'::jsonb) || ${JSON.stringify(Object.fromEntries(markers))}::jsonb
      WHERE id = ${computer.id} AND "spaceId" = ${actor.spaceId}
    `;
    if (changed !== 1) throw new Error("Could not record the cancelled Run's computer teardown");
    for (const runId of markers.keys()) keys.push({ computerId: computer.id, runId, ...actor });
  }
  return { keys, leasedRunIds };
}

export async function listPendingGroupRunTeardowns(
  prisma: Pick<PrismaClient, "$queryRaw">,
  { after, limit }: { after?: Pick<GroupRunTeardownKey, "computerId" | "runId">; limit: number },
): Promise<GroupRunTeardownKey[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("Invalid group teardown batch size");
  // Limit Computer rows before expanding their entries. A shared Computer can hold
  // several deletions, so the cursor also advances within that row.
  return prisma.$queryRaw<GroupRunTeardownKey[]>(Prisma.sql`
    WITH due AS MATERIALIZED (
      SELECT c.id, c."spaceId", c."pendingGroupRunTeardowns" AS pending
      FROM public.computers c
      WHERE c."pendingGroupRunTeardowns" IS NOT NULL
        ${
          after
            ? Prisma.sql`AND c.id >= ${after.computerId}
          AND (c.id > ${after.computerId} OR EXISTS (
            SELECT 1 FROM jsonb_object_keys(c."pendingGroupRunTeardowns") run(id)
            WHERE run.id > ${after.runId}
          ))`
            : Prisma.empty
        }
      ORDER BY c.id LIMIT ${limit}
    )
    SELECT c.id AS "computerId", entry.key AS "runId", c."spaceId",
      entry.value->>'userId' AS "userId"
    FROM due c CROSS JOIN LATERAL jsonb_each(c.pending) entry
    ${after ? Prisma.sql`WHERE (c.id, entry.key) > (${after.computerId}, ${after.runId})` : Prisma.empty}
    ORDER BY c.id, entry.key LIMIT ${limit}
  `);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMarker(value: unknown): value is GroupRunTeardownMarker {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.botId === "string" &&
    (value.canonicalFence === null || isFence(value.canonicalFence)) &&
    (value.legacy === null ||
      (isRecord(value.legacy) &&
        (value.legacy.botId === null || typeof value.legacy.botId === "string") &&
        isFence(value.legacy.fence))) &&
    (value.providerRef === null || typeof value.providerRef === "string") &&
    isFence(value.screenGeneration) &&
    typeof value.providerDone === "boolean"
  );
}

export async function loadPendingGroupRunTeardown(
  prisma: Pick<PrismaClient, "$queryRaw">,
  key: GroupRunTeardownKey,
): Promise<PendingGroupRunTeardown | null> {
  const [row] = await prisma.$queryRaw<
    Array<
      TeardownComputer &
        Pick<
          ComputerOwner,
          "executionRunId" | "executionBotId" | "executionFence" | "screenGeneration"
        > & {
          state: string;
          maintenanceId: string | null;
          currentRunId: string | null;
          currentFence: number | null;
          marker: unknown;
        }
    >
  >`
    SELECT c.id, c."homeKey", c.kind, c."providerRef", c.state, c."maintenanceId",
      c."screenGeneration", c."executionRunId", c."executionBotId", c."executionFence",
      c."pendingGroupRunTeardowns" -> ${key.runId}::text AS marker,
      l."runId" AS "currentRunId", l.fence AS "currentFence"
    FROM public.computers c
    LEFT JOIN public.computer_execution_leases l ON l."computerId" = c.id
      AND l."botId" = (c."pendingGroupRunTeardowns" -> ${key.runId}::text ->> 'botId')
    WHERE c.id = ${key.computerId} AND c."spaceId" = ${key.spaceId}
      AND (c."pendingGroupRunTeardowns" -> ${key.runId}::text ->> 'userId') = ${key.userId}
  `;
  if (!row || !isMarker(row.marker)) return null;
  const { marker, id, homeKey, kind, providerRef } = row;
  const stillOwns =
    marker.canonicalFence === null
      ? row.currentRunId === null &&
        marker.legacy !== null &&
        marker.legacy.botId !== null &&
        row.executionRunId === key.runId &&
        row.executionBotId === marker.legacy.botId &&
        row.executionFence === marker.legacy.fence
      : row.currentRunId === key.runId && row.currentFence === marker.canonicalFence;
  return {
    marker,
    computer: { id, homeKey, kind, providerRef },
    providerCleanup:
      stillOwns &&
      providerRef !== null &&
      providerRef === marker.providerRef &&
      row.screenGeneration === marker.screenGeneration &&
      row.state === "running" &&
      row.maintenanceId === null,
  };
}

function pendingMarkerMatch(key: GroupRunTeardownKey, marker: GroupRunTeardownMarker) {
  return Prisma.sql`id = ${key.computerId} AND "spaceId" = ${key.spaceId}
    AND "pendingGroupRunTeardowns" -> ${key.runId}::text = ${JSON.stringify(marker)}::jsonb`;
}

/** Serialize the provider phase without holding the shared Computer row during remote IO. */
export async function completeGroupRunTeardownProviderPhase(
  prisma: Pick<PrismaClient, "$transaction">,
  key: GroupRunTeardownKey,
  perform: (pending: PendingGroupRunTeardown) => Promise<void>,
): Promise<PendingGroupRunTeardown | null> {
  const advisoryKey = JSON.stringify(["group-run-teardown", key.computerId, key.runId]);
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended(${advisoryKey}::text, 0)
        ) AS acquired
      `;
      if (!lock?.acquired) return null;
      const pending = await loadPendingGroupRunTeardown(tx, key);
      if (!pending || pending.marker.providerDone) return pending;
      if (pending.providerCleanup) await perform(pending);
      const marker = { ...pending.marker, providerDone: true };
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE public.computers SET "pendingGroupRunTeardowns" = jsonb_set(
          "pendingGroupRunTeardowns", ARRAY[${key.runId}::text], ${JSON.stringify(marker)}::jsonb, false
        )
        WHERE ${pendingMarkerMatch(key, pending.marker)}
      `);
      return changed === 1 ? { ...pending, marker } : null;
    },
    // A lost connection leaves the phase pending so recovery can attempt the
    // fenced screen release again.
    { timeout: 45_000 },
  );
}

export async function finishPendingGroupRunTeardown(
  prisma: Pick<PrismaClient, "$transaction">,
  key: GroupRunTeardownKey,
  { marker }: PendingGroupRunTeardown,
): Promise<boolean> {
  if (!marker.providerDone || marker.userId !== key.userId) return false;
  const exactMarker = pendingMarkerMatch(key, marker);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM public.computers WHERE ${exactMarker} FOR UPDATE
      `);
      if (!locked) return false;
      if (marker.canonicalFence !== null) {
        const exactLease = {
          computerId: key.computerId,
          botId: marker.botId,
          runId: key.runId,
          fence: marker.canonicalFence,
        };
        // Some cancellation paths hold the lease before the Computer. Leave the
        // marker for the next pass if their transaction still holds this lease.
        const [lease] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM public.computer_execution_leases
          WHERE "computerId" = ${exactLease.computerId} AND "botId" = ${exactLease.botId}
            AND "runId" = ${exactLease.runId} AND fence = ${exactLease.fence}
          FOR UPDATE SKIP LOCKED
        `;
        if (lease) await expireComputerExecutionLeases(tx, exactLease);
        else if (
          await tx.computerExecutionLease.findFirst({ where: exactLease, select: { id: true } })
        )
          return false;
      }
      const legacyOwner = marker.legacy
        ? Prisma.sql`"executionRunId" = ${key.runId}
          AND "executionBotId" IS NOT DISTINCT FROM ${marker.legacy.botId}::text
          AND "executionFence" = ${marker.legacy.fence}`
        : undefined;
      const clearLegacy = legacyOwner
        ? Prisma.sql`
          "executionRunId" = CASE WHEN ${legacyOwner} THEN NULL ELSE "executionRunId" END,
          "executionBotId" = CASE WHEN ${legacyOwner} THEN NULL ELSE "executionBotId" END,
          "executionLeaseExpiresAt" = CASE WHEN ${legacyOwner} THEN NULL ELSE "executionLeaseExpiresAt" END,`
        : Prisma.empty;
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE public.computers SET ${clearLegacy}
          "pendingGroupRunTeardowns" = NULLIF("pendingGroupRunTeardowns" - ${key.runId}::text, '{}'::jsonb)
        WHERE ${exactMarker}
      `);
      if (updated !== 1) throw new Error("Could not settle the cancelled Run's computer teardown");
      return true;
    }),
  );
}
