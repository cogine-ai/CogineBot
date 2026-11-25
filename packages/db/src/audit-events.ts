import { randomUUID } from "node:crypto";
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

type AuditUser = { userId: string; spaceId: string };
type AuditBotRun = { botId: string; spaceId: string; runId: string; threadId: string };
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

async function writeAuditEvents(
  prisma: Pick<PrismaClient, "$transaction">,
  spaceId: string,
  actions: string[],
  getRows: (tx: Prisma.TransactionClient) => Promise<AuditRow[]>,
): Promise<void> {
  try {
    await runAsSystem("append committed audit events", () =>
      prisma.$transaction(
        async (tx) => {
          const rows = await getRows(tx);
          if (!rows.length) return;
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
    for (const action of new Set(actions)) {
      getLogger().warn("audit.event.write_failed", { action });
    }
  }
}

/** Record committed facts without changing the outcome of the business transaction. */
function appendAuditEvents(
  prisma: Pick<PrismaClient, "$transaction">,
  spaceId: string,
  rows: AuditRow[],
  liveRun?: { runId: string; threadId: string; lease: RunLease },
): Promise<void> {
  return writeAuditEvents(
    prisma,
    spaceId,
    rows.map((row) => row.action),
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
        if (!current) return [];
      }
      return rows;
    },
  );
}

export function recordApprovalRuleAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  ruleId: string,
  happenedAt: Date,
  change: ApprovalRuleChange,
  requestIp?: string,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      ...approvalRuleAuditRow(actor.userId, ruleId, happenedAt, change),
      ...(requestIp ? { requestIp } : {}),
    },
  ]);
}

export function recordAutoReviewPreferenceAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  preference: { id: string; enabled: boolean },
  happenedAt: Date,
  requestIp?: string,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      id: randomUUID(),
      createdAt: happenedAt,
      actorType: "user",
      actorId: actor.userId,
      ...(requestIp ? { requestIp } : {}),
      action: "approval.policy.changed",
      targetType: "auto_review_preference",
      targetId: preference.id,
      outcome: "success",
      metadata: { enabled: preference.enabled },
    },
  ]);
}

const pluginUninstallEvents = {
  uninstalling: { action: "plugin.uninstall.started", outcome: "pending" },
  cleanup_failed: { action: "plugin.uninstall.cleanup_failed", outcome: "error" },
  removed: { action: "plugin.uninstall.removed", outcome: "success" },
} as const;

export function recordPluginUninstallAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  transition: { id: string; revision: number; updatedAt: Date },
  status: keyof typeof pluginUninstallEvents,
): Promise<void> {
  const { action, outcome } = pluginUninstallEvents[status];
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      id: `plugin.uninstall:${transition.id}:${transition.revision}`,
      createdAt: transition.updatedAt,
      actorType: "user",
      actorId: actor.userId,
      action,
      targetType: "plugin_install",
      targetId: transition.id,
      outcome,
      metadata: { revision: transition.revision },
    },
  ]);
}

type CredentialAuditTarget =
  | "bot_secret"
  | "webhook"
  | "model_credential"
  | "voice_credential"
  | "memory_credential"
  | "mcp_oauth"
  | "mcp_server"
  | "capability_install";
type CredentialAuditAction = "credential.created" | "credential.changed" | "credential.deleted";

function credentialAuditRow(
  actor: AuditUser | AuditBotRun,
  targetType: CredentialAuditTarget,
  targetId: string,
  action: CredentialAuditAction,
  happenedAt: Date,
): AuditRow {
  return {
    // A model credential row has one creation, including import receipt replays.
    id:
      targetType === "model_credential" && action === "credential.created"
        ? `${action}:${targetType}:${targetId}`
        : randomUUID(),
    createdAt: happenedAt,
    ...("runId" in actor
      ? { actorType: "bot", actorId: actor.botId, runId: actor.runId, threadId: actor.threadId }
      : { actorType: "user", actorId: actor.userId }),
    action,
    targetType,
    targetId,
    outcome: "success",
    metadata: {},
  };
}

export function recordCredentialAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser | AuditBotRun,
  target: { type: CredentialAuditTarget; ids: readonly string[] },
  action: CredentialAuditAction,
  happenedAt: Date,
): Promise<void> {
  if (!target.ids.length) return Promise.resolve();
  return appendAuditEvents(
    prisma,
    actor.spaceId,
    target.ids.map((id) => credentialAuditRow(actor, target.type, id, action, happenedAt)),
  );
}

export function recordImportedModelCredentialAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  importId: string,
  credentialId: string,
  happenedAt: Date,
): Promise<void> {
  const action = "credential.created";
  return writeAuditEvents(prisma, actor.spaceId, [action], async (tx) => {
    // Consume the pending receipt in the audit transaction. A failed append restores it.
    await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
    const consumed = await tx.$executeRaw`
      UPDATE bot_package_imports
      SET "createdModelCredentialId" = null, "modelCredentialCreatedAt" = null
      WHERE id = ${importId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
        AND status = 'completed' AND "createdModelCredentialId" = ${credentialId}
        AND "modelCredentialCreatedAt" = ${happenedAt}`;
    return consumed === 1
      ? [credentialAuditRow(actor, "model_credential", credentialId, action, happenedAt)]
      : [];
  });
}

export function recordOpenApiCredentialAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  receiptId: string,
  happenedAt: Date,
): Promise<void> {
  const action = "credential.created";
  const retention = auditEventRetentionDays(process.env.AUDIT_EVENT_RETENTION_DAYS);
  if (happenedAt.getTime() < Date.now() - retention * 86_400_000) return Promise.resolve();
  return writeAuditEvents(prisma, actor.spaceId, [action], async (tx) => {
    // The import reserves the installation ID as its receipt ID, even if the install is later removed.
    await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
    const consumed = await tx.$executeRaw`
      UPDATE openapi_import_receipts SET "pendingCredentialAuditAt" = null
      WHERE id = ${receiptId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
        AND state = 'installed' AND "pendingCredentialAuditAt" = ${happenedAt}`;
    return consumed === 1
      ? [credentialAuditRow(actor, "capability_install", receiptId, action, happenedAt)]
      : [];
  });
}

export function recordConnectionActivationAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser | { spaceId: string; system: "connection_reconciler" },
  connectionIds: string[],
  happenedAt: Date,
): Promise<void> {
  return appendAuditEvents(
    prisma,
    actor.spaceId,
    connectionIds.map((connectionId) => ({
      id: `connection.connected:${connectionId}`,
      createdAt: happenedAt,
      ...("userId" in actor
        ? { actorType: "user", actorId: actor.userId }
        : {
            actorType: "system",
            actorId: actor.system,
            actorLabel: "Connection reconciler",
          }),
      action: "connection.connected",
      targetType: "connection",
      targetId: connectionId,
      outcome: "success",
      metadata: {},
    })),
  );
}

export type ConnectionRevocationRemoteOutcome = "not_requested" | "unconfirmed" | "account_deleted";

export function recordConnectionRevocationAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  connectionId: string,
  remoteOutcome: ConnectionRevocationRemoteOutcome,
  happenedAt: Date,
  expectedVersion?: string,
): Promise<void> {
  return writeAuditEvents(prisma, actor.spaceId, ["connection.revoked"], async (tx) => {
    if (expectedVersion !== undefined) {
      await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
      // Compensation may have committed even when its response was lost.
      const [current] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM connections
        WHERE id = ${connectionId}
          AND "spaceId" = ${actor.spaceId}
          AND "userId" = ${actor.userId}
          AND status = 'revoked'
          AND xmin::text = ${expectedVersion}
        FOR SHARE`;
      if (!current) return [];
    }
    return [
      {
        // Reauthorizing creates a new connection row with its own lifecycle.
        id: `connection.revoked:${connectionId}`,
        createdAt: happenedAt,
        actorType: "user",
        actorId: actor.userId,
        action: "connection.revoked",
        targetType: "connection",
        targetId: connectionId,
        outcome: "success",
        metadata: { remoteOutcome },
      },
    ];
  });
}

export type CommittedApprovalDecision = {
  effectId: string;
  decision: "allow" | "always" | "deny";
  happenedAt: Date;
  createdRules: { id: string; createdAt: Date; effect: string; matchKind: string }[];
};

export function recordManualApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
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

export function recordMcpApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  input: {
    serverId: string;
    botId: string;
    threadId?: string;
    decision: "allow" | "dismiss";
    sharedPolicyChanged: boolean;
  },
  happenedAt: Date,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      id: randomUUID(),
      createdAt: happenedAt,
      actorType: "user",
      actorId: actor.userId,
      action: "approval.decided",
      targetType: "mcp_server",
      targetId: input.serverId,
      threadId: input.threadId,
      outcome: input.decision === "dismiss" ? "denied" : "success",
      metadata: {
        decision: input.decision,
        botId: input.botId,
        sharedPolicyChanged: input.sharedPolicyChanged,
      },
    },
  ]);
}

export function recordMcpToolPolicyAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  actor: AuditUser,
  policy: { serverId: string; allowAllTools: boolean; allowlistCount: number | null },
  happenedAt: Date,
): Promise<void> {
  return appendAuditEvents(prisma, actor.spaceId, [
    {
      id: randomUUID(),
      createdAt: happenedAt,
      actorType: "user",
      actorId: actor.userId,
      action: "approval.policy.changed",
      targetType: "mcp_server",
      targetId: policy.serverId,
      outcome: "success",
      metadata: { allowAllTools: policy.allowAllTools, allowlistCount: policy.allowlistCount },
    },
  ]);
}

type AutomaticApproval = {
  runId: string;
  threadId: string;
  effectId: string;
  happenedAt: Date;
} & (
  | { decision: "pass"; outcome: "success" }
  | { decision: "ask" | "error"; outcome: "paused" }
  | { decision: "deny"; outcome: "denied"; reason: "unattended" }
);

function automaticApprovalRow(input: AutomaticApproval): AuditRow {
  const denied = input.outcome === "denied";
  const action = denied ? "approval.auto_denied" : "approval.auto_reviewed";
  return {
    id: `${action}:${input.effectId}`,
    createdAt: input.happenedAt,
    runId: input.runId,
    threadId: input.threadId,
    actorType: "system",
    actorId: denied ? "approval_policy" : "auto_review",
    actorLabel: denied ? "Approval policy" : "Auto Review",
    action,
    targetType: "external_effect",
    targetId: input.effectId,
    outcome: input.outcome,
    metadata: denied
      ? { decision: input.decision, reason: input.reason }
      : { decision: input.decision },
  };
}

export function recordAutomaticApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  input: { spaceId: string } & AutomaticApproval &
    ({ outcome: "success"; lease: RunLease } | { outcome: "paused" | "denied" }),
): Promise<void> {
  return appendAuditEvents(
    prisma,
    input.spaceId,
    [automaticApprovalRow(input)],
    input.outcome === "success" ? input : undefined,
  );
}

/** Append after a fenced worker commits a correlated provider receipt. The initiating Run may have ended. */
export function recordCloudAgentApprovalAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  input: {
    spaceId: string;
    userId: string;
    kind: "cloud_agent_launch" | "cloud_agent_reply" | "cloud_agent_cancel";
    effectId: string;
    happenedAt: Date;
  },
): Promise<void> {
  return writeAuditEvents(prisma, input.spaceId, ["approval.auto_reviewed"], async (tx) => {
    const effect = await tx.externalEffect.findFirst({
      where: {
        id: input.effectId,
        spaceId: input.spaceId,
        kind: input.kind,
        reviewDecision: "pass",
        run: { spaceId: input.spaceId, userId: input.userId },
      },
      select: { runId: true, run: { select: { threadId: true } } },
    });
    if (!effect) return [];
    return [
      automaticApprovalRow({
        effectId: input.effectId,
        happenedAt: input.happenedAt,
        runId: effect.runId,
        threadId: effect.run.threadId,
        decision: "pass",
        outcome: "success",
      }),
    ];
  });
}

const toolCompletionLabels = {
  shell: "Shell",
  web_fetch: "Web fetch",
  secret_request: "Secret request",
} as const;

export function recordToolCompletionAudit(
  prisma: Pick<PrismaClient, "$transaction">,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  completion: {
    name: keyof typeof toolCompletionLabels;
    executionId: string;
    happenedAt: Date;
    durationMs: number;
    outcome: "success" | "error";
  },
): Promise<void> {
  return appendAuditEvents(prisma, run.spaceId, [
    {
      id: `tool.completed:${completion.executionId}`,
      createdAt: completion.happenedAt,
      actorType: "bot",
      actorId: run.botId,
      action: "tool.completed",
      targetType: "tool_execution",
      targetId: completion.executionId,
      targetLabel: toolCompletionLabels[completion.name],
      runId: run.id,
      threadId: run.threadId,
      outcome: completion.outcome,
      metadata: {
        name: completion.name,
        executionId: completion.executionId,
        durationMs: completion.durationMs,
      },
    },
  ]);
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
        await tx.$executeRaw`
          WITH expired AS (
            SELECT id FROM bot_package_imports
            WHERE "modelCredentialCreatedAt" < ${before}
            ORDER BY "modelCredentialCreatedAt", id
            LIMIT ${AUDIT_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
          )
          UPDATE bot_package_imports i
          SET "createdModelCredentialId" = null, "modelCredentialCreatedAt" = null
          FROM expired WHERE i.id = expired.id
        `;
        await tx.$executeRaw`
          WITH expired AS (
            SELECT id FROM openapi_import_receipts
            WHERE "pendingCredentialAuditAt" < ${before}
            ORDER BY "pendingCredentialAuditAt", id
            LIMIT ${AUDIT_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED
          )
          UPDATE openapi_import_receipts i SET "pendingCredentialAuditAt" = null
          FROM expired WHERE i.id = expired.id
        `;
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
