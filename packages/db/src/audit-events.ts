import { ActionApprovalRuleSchema } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { Prisma, PrismaClient } from "./client.js";
import type { RunLease } from "./messages.js";
import { runAsSystem } from "./row-security.js";

type ApprovalRuleChange = {
  action: "approval.rule.created" | "approval.rule.deleted";
  effect: string;
  matchKind: string;
};

const approvalRuleAuditMetadata = ActionApprovalRuleSchema.pick({ effect: true, matchKind: true });

type ApprovalActor = { userId: string; spaceId: string };
type AuditRow = Omit<Prisma.AuditEventCreateManyInput, "organizationId" | "spaceId">;

function approvalRuleAuditRow(
  userId: string,
  ruleId: string,
  happenedAt: Date,
  change: ApprovalRuleChange,
): AuditRow {
  return {
    id: `${change.action}:${ruleId}`,
    createdAt: happenedAt,
    actorType: "user",
    actorId: userId,
    action: change.action,
    targetType: "approval_rule",
    targetId: ruleId,
    outcome: "success",
    metadata: approvalRuleAuditMetadata.safeParse(change).data ?? {},
  };
}

/** Record committed facts without changing the outcome of the business transaction. */
async function appendAuditEvents(
  prisma: Pick<PrismaClient, "$transaction">,
  spaceId: string,
  rows: AuditRow[],
  liveRun?: { runId: string; threadId: string; lease: RunLease },
): Promise<void> {
  try {
    await runAsSystem("append committed audit events", () =>
      prisma.$transaction(
        async (tx) => {
          if (liveRun) {
            // Sample ownership after the effect commits. The audit must not lock the Run against Stop.
            const current = await tx.run.findFirst({
              where: {
                id: liveRun.runId,
                spaceId,
                threadId: liveRun.threadId,
                status: "running",
                leaseOwner: liveRun.lease.owner,
                leaseFence: liveRun.lease.fence,
                leaseExpiresAt: { gt: new Date() },
              },
              select: { id: true },
            });
            if (!current) return;
          }
          const { organizationId } = await tx.space.findUniqueOrThrow({
            where: { id: spaceId },
            select: { organizationId: true },
          });
          await tx.auditEvent.createMany({
            skipDuplicates: true,
            data: rows.map((row) => ({ ...row, organizationId, spaceId })),
          });
        },
        { maxWait: 1000, timeout: 1000 },
      ),
    );
  } catch {
    // Driver diagnostics may contain query arguments. Report only the gap.
    for (const action of new Set(rows.map((row) => row.action))) {
      getLogger().warn("audit.event.write_failed", { action });
    }
  }
}

export function recordApprovalRuleAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: ApprovalActor,
  ruleId: string,
  happenedAt: Date,
  change: ApprovalRuleChange,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    approvalRuleAuditRow(actor.userId, ruleId, happenedAt, change),
  ]);
}

export type CommittedApprovalDecision = {
  effectId: string;
  decision: "allow" | "always" | "deny";
  happenedAt: Date;
  createdRules: { id: string; createdAt: Date; effect: string; matchKind: string }[];
};

export function recordManualApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: ApprovalActor,
  run: { runId: string; threadId: string },
  { effectId, decision, happenedAt, createdRules }: CommittedApprovalDecision,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      ...run,
      id: `approval.decided:${effectId}`,
      createdAt: happenedAt,
      actorType: "user",
      actorId: actor.userId,
      action: "approval.decided",
      targetType: "external_effect",
      targetId: effectId,
      outcome: decision === "deny" ? "denied" : "success",
      metadata: { decision },
    },
    ...createdRules.map(({ id, createdAt, effect, matchKind }) => ({
      ...approvalRuleAuditRow(actor.userId, id, createdAt, {
        action: "approval.rule.created",
        effect,
        matchKind,
      }),
      ...run,
    })),
  ]);
}

export function recordAutomaticApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    runId: string;
    threadId: string;
    effectId: string;
    happenedAt: Date;
  } & (
    | { decision: "pass"; outcome: "success"; lease: RunLease }
    | { decision: "ask" | "error"; outcome: "paused" }
  ),
): Promise<void> {
  return appendAuditEvents(
    prisma,
    input.spaceId,
    [
      {
        id: `approval.auto_reviewed:${input.effectId}`,
        createdAt: input.happenedAt,
        runId: input.runId,
        threadId: input.threadId,
        actorType: "system",
        actorId: "auto_review",
        action: "approval.auto_reviewed",
        targetType: "external_effect",
        targetId: input.effectId,
        outcome: input.outcome,
        metadata: { decision: input.decision },
      },
    ],
    input.outcome === "success" ? input : undefined,
  );
}

export function auditEventRetentionDays(value: string | undefined): number {
  const days = Number(value);
  return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : 365;
}

export const AUDIT_PRUNE_BATCH_SIZE = 500;

/** One bounded batch, run by the elected reconciler. */
export function pruneAuditEvents(
  prisma: Pick<PrismaClient, "$transaction">,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const before = new Date(now.getTime() - retentionDays * 86_400_000);
  return runAsSystem("prune expired audit events", () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '1s'`;
        return tx.$executeRaw`
          DELETE FROM cogine_audit.audit_events
          WHERE id IN (
            SELECT id FROM cogine_audit.audit_events
            WHERE "createdAt" < ${before}
            ORDER BY "createdAt", id
            LIMIT ${AUDIT_PRUNE_BATCH_SIZE}
          )
        `;
      },
      { maxWait: 1000, timeout: 2000 },
    ),
  );
}
