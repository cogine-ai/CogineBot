import { disabledBuiltinToolSet } from "@rakazo/contracts";
import { resolveActionApprovalDetail } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

export function findSpaceMemoryConfig(
  prisma: Pick<PrismaClient, "spaceMemoryConfig">,
  spaceId: string,
) {
  return prisma.spaceMemoryConfig.findUnique({ where: { spaceId } });
}

export function effectiveMemoryScope(
  botScope: string | null,
  defaultScope: string,
): "isolated" | "shared" {
  const scope = botScope ?? defaultScope;
  return scope === "shared" ? "shared" : "isolated";
}

export async function checkMemoryWritePolicy(
  tx: Pick<Prisma.TransactionClient, "actionApprovalRule" | "bot">,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    tool: string;
    approved?: true;
    requireAlwaysAllow?: true;
  },
): Promise<"rule" | "revoked" | undefined> {
  const rules = await tx.actionApprovalRule.findMany({
    where: { spaceId: input.spaceId, createdByUserId: input.userId },
    select: { effect: true, matchKind: true, matchValue: true },
  });
  const resolved = resolveActionApprovalDetail({
    toolName: input.tool,
    rules: rules as Parameters<typeof resolveActionApprovalDetail>[0]["rules"],
  });
  if (resolved.decision === "deny") return "rule";
  if (
    (!input.approved && resolved.decision === "ask") ||
    (input.requireAlwaysAllow && resolved.source !== "always_allow")
  )
    return "revoked";
  const bot = await tx.bot.findUnique({
    where: { id: input.botId, spaceId: input.spaceId, userId: input.userId, archivedAt: null },
    select: { disabledBuiltinTools: true },
  });
  if (!bot || disabledBuiltinToolSet(bot.disabledBuiltinTools).has(input.tool)) return "revoked";
}

/** Settings edits advance this row so a stale Serializable write must retry policy evaluation. */
export async function touchActionApprovalPolicy(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  spaceId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE space_members SET role = role WHERE "spaceId" = ${spaceId} AND "userId" = ${userId}
  `;
}

/** A changed policy or Bot row after a Serializable snapshot forces a retry. */
export async function lockMemoryWritePolicyRows(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  input: { spaceId: string; userId: string; botId: string; requireAlwaysAllow?: true },
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM bots WHERE id = ${input.botId}
      AND "spaceId" = ${input.spaceId} AND "userId" = ${input.userId} FOR SHARE
  `;
  await tx.$queryRaw`
    SELECT id FROM space_members
    WHERE "spaceId" = ${input.spaceId} AND "userId" = ${input.userId} FOR SHARE
  `;
  if (input.requireAlwaysAllow) {
    await tx.$queryRaw`
      SELECT id FROM action_approval_rules WHERE "spaceId" = ${input.spaceId}
        AND "createdByUserId" = ${input.userId} AND effect = 'always_allow'
        ORDER BY id FOR SHARE
    `;
  }
}

export class MemoryWriteAuthorizationError extends Error {
  constructor(readonly reason: "rule" | "delegated" | "revoked") {
    super("Memory write is no longer authorized.");
    this.name = "MemoryWriteAuthorizationError";
  }
}
