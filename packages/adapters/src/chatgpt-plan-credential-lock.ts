import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { isChatGPTPlanRotationPendingError } from "./chatgpt-plan-auth.js";

/** Serialize reload/refresh/publication across API and worker processes, never across inference. */
export async function withChatGPTPlanCredentialLock<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  secretId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await prisma.$transaction(
    async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '15s'`);
      await transaction.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext('coginebot-chatgpt-plan'), hashtext(${secretId}))::text AS "lock"
    `);
      try {
        return { completed: true as const, value: await operation(transaction) };
      } catch (error) {
        // Commit the caller's encrypted rotation checkpoint before reporting
        // temporarily unavailable identity verification. Other errors roll back.
        if (isChatGPTPlanRotationPendingError(error)) return { completed: false as const, error };
        throw error;
      }
    },
    { maxWait: 15_000, timeout: 75_000 },
  );
  if (!result.completed) throw result.error;
  return result.value;
}
