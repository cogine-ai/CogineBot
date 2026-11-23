import type { ActionApprovalRule } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

type ApprovalRuleChange =
  | ({ action: "approval.rule.created" } & Pick<ActionApprovalRule, "effect" | "matchKind">)
  | { action: "approval.rule.deleted" };

/** The rule transaction has committed. An audit failure leaves the change in place. */
export async function recordApprovalRuleAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: { userId: string; spaceId: string },
  ruleId: string,
  happenedAt: Date,
  change: ApprovalRuleChange,
): Promise<void> {
  try {
    await runAsSystem("append a committed approval rule audit event", () =>
      prisma.$transaction(
        async (tx) => {
          const { organizationId } = await tx.space.findUniqueOrThrow({
            where: { id: actor.spaceId },
            select: { organizationId: true },
          });
          await tx.auditEvent.createMany({
            skipDuplicates: true,
            data: {
              id: `${change.action}:${ruleId}`,
              createdAt: happenedAt,
              organizationId,
              spaceId: actor.spaceId,
              actorType: "user",
              actorId: actor.userId,
              action: change.action,
              targetType: "approval_rule",
              targetId: ruleId,
              outcome: "success",
              metadata:
                change.action === "approval.rule.created"
                  ? { effect: change.effect, matchKind: change.matchKind }
                  : {},
            },
          });
        },
        { maxWait: 1000, timeout: 1000 },
      ),
    );
  } catch {
    // Driver diagnostics may contain query arguments. Report only the gap.
    getLogger().warn("audit.event.write_failed", { action: change.action });
  }
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
