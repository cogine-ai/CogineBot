import type { ToolResultHistoryReference } from "@rakazo/adapter-kit";
import { sanitizeJsonValue } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import type { HistoryScope } from "./history-retrieval.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Full redacted results only: a partial prefix must never masquerade as an original. */
export const TOOL_RESULT_HISTORY_MAX_BYTES = 1_048_576;

export async function storeToolResultHistory(
  prisma: PrismaClient,
  scope: HistoryScope & { activeRunId: string },
  input: { name: string; executionId: string; text: string },
): Promise<ToolResultHistoryReference | undefined> {
  const text = sanitizeJsonValue(input.text) as string;
  const storedBytes = Buffer.byteLength(text, "utf8");
  if (storedBytes > TOOL_RESULT_HISTORY_MAX_BYTES) return;
  // Ensure the stored text can be reassembled into a full JSON result.
  JSON.parse(text);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const run = await tx.run.findFirst({
        where: {
          id: scope.activeRunId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          threadId: scope.threadId,
          botId: scope.botId,
        },
        select: { id: true },
      });
      if (!run) return;
      const event = await appendEventInTransaction(tx, {
        spaceId: scope.spaceId,
        threadId: scope.threadId,
        botId: scope.botId,
        runId: run.id,
        type: "agent.tool.result.stored",
        payload: { name: input.name, executionId: input.executionId, storedBytes },
      });
      await tx.event.update({
        where: { id: event.id },
        data: { toolResult: { text, storedBytes } satisfies Prisma.InputJsonObject },
      });
      return { tool: "read_history" as const, arguments: { toolResultId: event.id } };
    }),
  );
}
