import type { NativeSlackLifecycleSignal } from "@rakazo/contracts";
import { NativeSlackLifecycleJobSchema, NativeSlackLifecycleSignalSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { z } from "zod";
import type { NativeSlackHookStore } from "./slack-hooks.js";
import type { SlackVerifiedHook } from "./slack-signals.js";

const Target = z
  .object({
    grantId: z.string().min(1),
    connectionId: z.string().min(1),
    userId: z.string().min(1),
    spaceId: z.string().min(1),
    configId: z.string().min(1),
    configRevision: z.number().int().positive(),
    authGeneration: z.number().int().positive(),
    tokenVersion: z.number().int().positive(),
    secretId: z.string().min(1),
  })
  .strict();
export const NativeSlackLifecycleReceiptSchema = z
  .object({
    kind: z.literal("lifecycle"),
    signal: NativeSlackLifecycleSignalSchema,
    targets: z.array(Target).max(10000),
    appliedAt: z.string().optional(),
  })
  .strict();
export type NativeSlackLifecycleReceipt = z.infer<typeof NativeSlackLifecycleReceiptSchema>;

/** Capture once at signed ingress, not at worker retry. No token material or business content. */
export async function snapshotSlackLifecycleTargets(
  tx: Prisma.TransactionClient,
  hook: SlackVerifiedHook,
  signal: NativeSlackLifecycleSignal,
): Promise<NativeSlackLifecycleReceipt["targets"]> {
  const beforeEvent = new Date(signal.eventTime * 1000);
  if (!Number.isFinite(beforeEvent.getTime())) return [];
  if (signal.type === "tokens_revoked" && !signal.botUserIds.length && !signal.oauthUserIds.length)
    return [];
  const affected =
    signal.type === "app_uninstalled"
      ? Prisma.sql`true`
      : Prisma.sql`((g.principal->>'tokenType'='bot' AND g.subject IN (${Prisma.join(signal.botUserIds.length ? signal.botUserIds : ["__no_bot__"])})) OR (g.principal->>'tokenType'='user' AND g.subject IN (${Prisma.join(signal.oauthUserIds.length ? signal.oauthUserIds : ["__no_user__"])})))`;
  const appProof =
    signal.type === "tokens_revoked"
      ? Prisma.sql`(g.principal->>'appId'=${signal.appId} OR (g.principal->>'appId' IS NULL AND g."configId"=${hook.configId}))`
      : Prisma.sql`(
          g.principal->>'appId'=${signal.appId} OR (
            g.principal->>'appId' IS NULL AND g."configId"=${hook.configId} AND g.principal->>'tokenType'='bot' AND EXISTS(
              SELECT 1 FROM native_slack_event_inbox prior
              WHERE prior."hookId"=${hook.id} AND prior."hookRevision"=${hook.revision}
                AND prior.signal->>'appId'=${signal.appId} AND prior.signal->>'teamId'=${signal.teamId}
                AND prior.signal->'authorizations' @> jsonb_build_array(jsonb_build_object('userId',g.subject,'teamId',${signal.teamId}::text,'isBot',true))
            )
          )
        )`;
  const rows = await tx.$queryRaw<NativeSlackLifecycleReceipt["targets"]>(Prisma.sql`
    SELECT g.id AS "grantId",c.id AS "connectionId",g."userId",g."spaceId",g."configId",g."configRevision",g."authGeneration",g."tokenVersion",g."secretId"
    FROM native_oauth_grants g JOIN connections c ON c."oauthGrantId"=g.id JOIN native_app_configs a ON a.id=g."configId"
    WHERE c."connectorId"='native' AND c.provider='slack' AND c.status='connected' AND c."userId"=g."userId" AND c."spaceId"=g."spaceId"
      AND c."nativeConfigId"=g."configId" AND c."nativeConfigRevision"=g."configRevision" AND c.metadata->>'authRevision'=g.id||':'||g."authGeneration"::text
      AND g."revokedAt" IS NULL AND g."secretId" IS NOT NULL AND g.tenant=${signal.teamId} AND g.principal->>'teamId'=${signal.teamId}
      AND g.principal->>'tokenType' IN ('bot','user') AND (${signal.enterpriseId}::text IS NULL OR g.principal->>'enterpriseId'=${signal.enterpriseId})
      AND a."appId"='slack' AND a.enabled=true AND a.revision=g."configRevision"
      AND g."createdAt"<${beforeEvent} AND g."updatedAt"<${beforeEvent}
      AND ${appProof} AND ${affected} ORDER BY g."configId",g.id,c.id LIMIT 10001`);
  // Fail closed rather than silently dropping revocations beyond the operational bound.
  return z.array(Target).max(10000).parse(rows);
}

/** Local revocation only. Existing secret-persistence composition retires exact native_grant records. */
export async function applyNativeSlackLifecycle(
  prisma: PrismaClient,
  hooks: Pick<NativeSlackHookStore, "loadLifecycleInbox">,
  raw: unknown,
): Promise<number> {
  const payload = NativeSlackLifecycleJobSchema.parse(raw),
    loaded = await hooks.loadLifecycleInbox(payload.inboxId, payload.hookId, payload.hookRevision);
  if (!loaded) return 0;
  return prisma.$transaction(async (tx) => {
    const configs = [
      ...new Set([
        loaded.hook.configId,
        ...loaded.receipt.targets.map((target) => target.configId),
      ]),
    ].sort();
    for (const configId of configs)
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM native_app_configs WHERE id=${configId} FOR UPDATE`,
      );
    const current = await tx.$queryRaw<Array<{ signal: unknown }>>(Prisma.sql`
      SELECT i.signal FROM native_slack_event_inbox i JOIN native_slack_hooks h ON h.id=i."hookId" JOIN native_app_configs a ON a.id=h."configId"
      WHERE i.id=${payload.inboxId} AND h.id=${payload.hookId} AND h."deliveryRevision"=${payload.hookRevision} AND h."deliveryRevision"=i."hookRevision"
        AND h."configId"=${loaded.hook.configId} AND h."configRevision"=i."configRevision" AND h."configRevision"=a.revision
        AND h.enabled=true AND h."disabledAt" IS NULL AND h."ownerConfirmedAt" IS NOT NULL
        AND h."secretRecordId" IS NOT NULL AND h.ciphertext IS NOT NULL AND a.enabled=true AND a."appId"='slack'
      FOR UPDATE OF i,h`);
    if (current.length !== 1) return 0;
    const receipt = NativeSlackLifecycleReceiptSchema.parse(current[0]!.signal);
    if (
      receipt.appliedAt ||
      receipt.signal.appId !== loaded.hook.appId ||
      (loaded.hook.teamId && loaded.hook.teamId !== receipt.signal.teamId)
    )
      return 0;
    let count = 0;
    for (const target of receipt.targets) {
      const app = await tx.nativeAppConfig.findFirst({
        where: {
          id: target.configId,
          revision: target.configRevision,
          enabled: true,
          appId: "slack",
        },
        select: { id: true },
      });
      if (!app) continue;
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM connections WHERE id=${target.connectionId} AND "userId"=${target.userId} AND "spaceId"=${target.spaceId} FOR UPDATE`,
      );
      const connection = await tx.connection.findFirst({
        where: {
          id: target.connectionId,
          userId: target.userId,
          spaceId: target.spaceId,
          connectorId: "native",
          provider: "slack",
          status: "connected",
          oauthGrantId: target.grantId,
          nativeConfigId: target.configId,
          nativeConfigRevision: target.configRevision,
          metadata: {
            path: ["authRevision"],
            equals: `${target.grantId}:${target.authGeneration}`,
          },
        },
        select: { id: true },
      });
      if (!connection) continue;
      const changed = await tx.nativeOAuthGrant.updateMany({
        where: {
          id: target.grantId,
          userId: target.userId,
          spaceId: target.spaceId,
          configId: target.configId,
          configRevision: target.configRevision,
          authGeneration: target.authGeneration,
          tokenVersion: target.tokenVersion,
          secretId: target.secretId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          secretId: null,
          authGeneration: { increment: 1 },
          refreshLeaseId: null,
          refreshLeaseUntil: null,
          refreshRecoveryUntil: null,
        },
      });
      if (!changed.count) continue;
      await tx.connection.updateMany({
        where: {
          id: target.connectionId,
          userId: target.userId,
          spaceId: target.spaceId,
          oauthGrantId: target.grantId,
          status: "connected",
        },
        data: { status: "revoked" },
      });
      await tx.secret.deleteMany({
        where: {
          id: target.secretId,
          userId: target.userId,
          spaceId: target.spaceId,
          kind: "native_grant",
        },
      });
      count++;
    }
    await tx.$executeRaw(
      Prisma.sql`UPDATE native_slack_event_inbox SET signal=${JSON.stringify({ ...receipt, appliedAt: new Date().toISOString() })}::jsonb WHERE id=${payload.inboxId} AND "hookId"=${payload.hookId} AND "hookRevision"=${payload.hookRevision}`,
    );
    return count;
  });
}
