import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  ComputerCleanupEntries,
  ComputerCleanupPlan,
  ConfirmComputerCleanupInput,
  PlanComputerCleanupInput,
  UpdateComputerCleanupInput,
} from "@rakazo/contracts";
import { ComputerCleanupEntriesSchema, ComputerCleanupPlanSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { lockActiveMembership } from "./active-membership.js";
import {
  computerStorageTarget,
  ownedWorkspace,
  readComputerDiskUsage,
} from "./computer-storage.js";

type StorageContext = Parameters<typeof readComputerDiskUsage>[1] & { sessionId?: string };
type CleanupDeps = Parameters<typeof readComputerDiskUsage>[2] & { prisma: PrismaClient };
type PlanRow = NonNullable<Awaited<ReturnType<PrismaClient["computerCleanupPlan"]["findFirst"]>>>;

function requireSession(context: StorageContext) {
  context.signal?.throwIfAborted();
  if (!context.sessionId) throw new ORPCError("UNAUTHORIZED");
  return context.sessionId;
}

function scope(context: StorageContext) {
  return { userId: context.actor.userId, spaceId: context.actor.spaceId };
}

function planDto(row: PlanRow): ComputerCleanupPlan {
  return ComputerCleanupPlanSchema.parse({
    id: row.id,
    botId: row.botId,
    revision: row.revision,
    status:
      row.status === "awaiting_confirmation" && row.expiresAt.getTime() <= Date.now()
        ? "expired"
        : row.status,
    expiresAt: row.expiresAt.toISOString(),
    selected: row.selected,
  });
}

function reviewChanged() {
  return new ORPCError("CONFLICT", { data: { reason: "cleanup_selection_changed" } });
}

function sameSelection(
  expected: PlanComputerCleanupInput["selected"],
  observed: ComputerCleanupEntries,
) {
  const versions = new Map(observed.map(({ path, version }) => [path, version]));
  return (
    expected.length === observed.length &&
    expected.every(({ path, version }) => versions.get(path) === version)
  );
}

async function checkSelection(
  input: Pick<PlanComputerCleanupInput, "botId" | "expectedTarget" | "selected">,
  context: StorageContext,
  deps: CleanupDeps,
) {
  const probe = await readComputerDiskUsage(input, context, deps);
  if (probe.outcome.status !== "available") throw reviewChanged();
  const paths = new Set(input.selected.map(({ path }) => path));
  const observed = probe.outcome.data.candidates.flatMap(({ path, logicalBytes, cleanup }) =>
    cleanup && paths.has(path) ? [{ path, logicalBytes, ...cleanup }] : [],
  );
  if (!sameSelection(input.selected, observed)) throw reviewChanged();
  return ComputerCleanupEntriesSchema.parse(observed);
}

async function lockWorkspace(tx: Prisma.TransactionClient, context: StorageContext, botId: string) {
  await lockActiveMembership(tx, context.actor, requireSession(context));
  const { userId, spaceId } = context.actor;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM public.bots b
    JOIN public.computers c ON c.id = b."computerId" AND c."spaceId" = b."spaceId"
    WHERE b.id = ${botId} AND b."userId" = ${userId}
      AND b."spaceId" = ${spaceId} AND b."archivedAt" IS NULL
    FOR SHARE OF b, c`;
  if (!rows.length) throw reviewChanged();
  const bot = await tx.bot.findFirst({
    where: { id: botId, userId, spaceId, archivedAt: null },
    include: { computer: true },
  });
  if (bot?.computer?.kind !== "docker" || !ownedWorkspace(context.actor, bot))
    throw reviewChanged();
  context.signal?.throwIfAborted();
  return { bot, computer: bot.computer };
}

function assertReceiptHome(workspace: Awaited<ReturnType<typeof lockWorkspace>>, row: PlanRow) {
  if (workspace.computer.id !== row.computerId || workspace.computer.homeKey !== row.homeKey)
    throw reviewChanged();
}

function replayPlan(row: PlanRow, input: PlanComputerCleanupInput) {
  const plan = planDto(row);
  if (
    row.botId !== input.botId ||
    row.target !== input.expectedTarget ||
    !sameSelection(input.selected, plan.selected)
  )
    throw reviewChanged();
  return plan;
}

export async function planComputerCleanup(
  input: PlanComputerCleanupInput,
  context: StorageContext,
  deps: CleanupDeps,
) {
  requireSession(context);
  const owner = scope(context);
  const key = { ...owner, requestNonce: input.requestNonce };
  const lookup = (db: Pick<PrismaClient, "computerCleanupPlan">) =>
    db.computerCleanupPlan.findUnique({ where: { spaceId_userId_requestNonce: key } });
  async function readReceipt() {
    if (!(await lookup(deps.prisma))) return;
    return deps.prisma.$transaction(async (tx) => {
      const workspace = await lockWorkspace(tx, context, input.botId);
      const row = await lookup(tx);
      if (!row) return;
      assertReceiptHome(workspace, row);
      return replayPlan(row, input);
    });
  }

  const previous = await readReceipt();
  if (previous) return previous;
  try {
    const selected = await checkSelection(input, context, deps);
    return await deps.prisma.$transaction(async (tx) => {
      const { bot, computer } = await lockWorkspace(tx, context, input.botId);
      if (
        !computer.providerRef ||
        input.expectedTarget !== computerStorageTarget(context.actor, bot)
      )
        throw reviewChanged();
      // Keep the nonce bound after expiry so a delayed retry cannot start a new plan.
      await tx.$executeRaw`
        INSERT INTO cogine_storage.computer_cleanup_plans
          (id, "userId", "spaceId", "botId", "computerId", "homeKey", "providerRef", target, "requestNonce", selected, "expiresAt")
        VALUES
          (${randomUUID()}, ${owner.userId}, ${owner.spaceId}, ${input.botId}, ${computer.id},
           ${computer.homeKey}, ${computer.providerRef}, ${input.expectedTarget}, ${input.requestNonce},
           ${JSON.stringify(selected)}::jsonb, (clock_timestamp() AT TIME ZONE 'UTC') + interval '10 minutes')
        ON CONFLICT ("spaceId", "userId", "requestNonce") DO NOTHING`;
      const row = await lookup(tx);
      if (!row) throw reviewChanged();
      return replayPlan(row, input);
    });
  } catch (error) {
    if (error instanceof ORPCError && error.code === "CONFLICT") {
      const receipt = await readReceipt();
      if (receipt) return receipt;
    }
    throw error;
  }
}

async function scopedPlan(
  db: Pick<PrismaClient, "computerCleanupPlan">,
  input: UpdateComputerCleanupInput,
  context: StorageContext,
) {
  const row = await db.computerCleanupPlan.findFirst({
    where: { ...scope(context), id: input.planId, botId: input.botId },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

function confirmedReceipt(row: PlanRow, input: ConfirmComputerCleanupInput) {
  const plan = planDto(row);
  if (plan.status === "expired" || plan.status === "cancelled") return plan;
  if (plan.status === "reviewed") {
    if (
      row.confirmationNonce !== input.requestNonce ||
      plan.revision !== input.expectedRevision + 1
    )
      throw reviewChanged();
    return plan;
  }
  if (plan.revision !== input.expectedRevision) throw reviewChanged();
}

export async function confirmComputerCleanup(
  input: ConfirmComputerCleanupInput,
  context: StorageContext,
  deps: CleanupDeps,
) {
  requireSession(context);
  const plan = await scopedPlan(deps.prisma, input, context);
  const readReceipt = () =>
    deps.prisma.$transaction(async (tx) => {
      const workspace = await lockWorkspace(tx, context, plan.botId);
      const current = await scopedPlan(tx, input, context);
      assertReceiptHome(workspace, current);
      return confirmedReceipt(current, input);
    });

  if (confirmedReceipt(plan, input)) {
    const receipt = await readReceipt();
    if (receipt) return receipt;
    throw reviewChanged();
  }
  try {
    await checkSelection(
      {
        botId: plan.botId,
        expectedTarget: plan.target,
        selected: ComputerCleanupEntriesSchema.parse(plan.selected),
      },
      context,
      deps,
    );
    return await deps.prisma.$transaction(async (tx) => {
      const workspace = await lockWorkspace(tx, context, plan.botId);
      assertReceiptHome(workspace, plan);
      if (
        workspace.computer.providerRef !== plan.providerRef ||
        plan.target !== computerStorageTarget(context.actor, workspace.bot)
      )
        throw reviewChanged();
      await tx.$executeRaw`
        UPDATE cogine_storage.computer_cleanup_plans
        SET status = 'reviewed', revision = revision + 1,
            "confirmationNonce" = ${input.requestNonce}, "confirmedAt" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE id = ${plan.id} AND "userId" = ${plan.userId} AND "spaceId" = ${plan.spaceId}
          AND status = 'awaiting_confirmation' AND revision = ${input.expectedRevision}
          AND "expiresAt" > clock_timestamp() AT TIME ZONE 'UTC'`;
      const result = confirmedReceipt(await scopedPlan(tx, input, context), input);
      if (result) return result;
      throw reviewChanged();
    });
  } catch (error) {
    // A concurrent retry can commit while this request is still checking the workspace.
    if (error instanceof ORPCError && error.code === "CONFLICT") {
      const receipt = await readReceipt();
      if (receipt) return receipt;
    }
    throw error;
  }
}

export async function cancelComputerCleanup(
  input: UpdateComputerCleanupInput,
  context: StorageContext,
  deps: CleanupDeps,
) {
  requireSession(context);
  return deps.prisma.$transaction(async (tx) => {
    const plan = await scopedPlan(tx, input, context);
    const workspace = await lockWorkspace(tx, context, plan.botId);
    assertReceiptHome(workspace, plan);
    await tx.$executeRaw`
      UPDATE cogine_storage.computer_cleanup_plans
      SET status = 'cancelled', revision = revision + 1
      WHERE id = ${plan.id} AND "userId" = ${plan.userId} AND "spaceId" = ${plan.spaceId}
        AND status = 'awaiting_confirmation' AND revision = ${input.expectedRevision}
        AND "expiresAt" > clock_timestamp() AT TIME ZONE 'UTC'`;
    const result = planDto(await scopedPlan(tx, input, context));
    if (
      result.status !== "expired" &&
      (result.status !== "cancelled" || result.revision !== input.expectedRevision + 1)
    )
      throw reviewChanged();
    return result;
  });
}
