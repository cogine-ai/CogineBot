import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "@rakazo/db";
import {
  approvalRoutesMatch,
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
} from "../approval-effect.js";
import { asRecord } from "../connector-http.js";
import { NativeActionError } from "./action.js";

const MARKER = "__rakazoCatalogTool";
/** New native receipts are redacted before persistence, including interrupted runs. */
export function nativeCheckpointRecovery(result: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(result)?.nativeRecovery);
}
/** Same existing effect, exact original route/args, still-executing run only. */
export async function nativeEffectCheckpoint(
  prisma: PrismaClient,
  call: ConnectorCall,
  context: AdapterContext,
  revalidate: () => Promise<void>,
  protect: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<{
  recovery?: Record<string, unknown>;
  checkpoint(value: Record<string, unknown>): Promise<void>;
}> {
  if (!context.runId)
    throw new NativeActionError(
      "invalid_input",
      "Native actions require the existing run execution context.",
    );
  const effect = await prisma.externalEffect.findFirst({
    where: {
      idempotencyKey: call.executionId,
      spaceId: context.spaceId,
      runId: context.runId,
      run: { userId: context.userId, botId: context.botId, status: "running" },
    },
  });
  const direct = effect && boundDirectApprovalDetails(effect.request, MARKER);
  const catalog = effect && catalogApprovalDetails(effect.request, MARKER);
  const bound =
    direct ?? (catalog ? { ...catalog, args: catalogApprovalInnerArgs(catalog) } : undefined);
  if (
    effect?.status !== "executing" ||
    !bound?.route ||
    !approvalRoutesMatch(bound.route, call.route as Parameters<typeof approvalRoutesMatch>[1]) ||
    stableJsonValue(bound.args) !== stableJsonValue(call.args)
  )
    throw new NativeActionError(
      "invalid_input",
      "The original approved action binding is unavailable.",
    );
  const stored = nativeCheckpointRecovery(effect.result);
  const recovery = stored ? protect(stored) : undefined;
  return {
    recovery,
    checkpoint: async (value) => {
      context.signal.throwIfAborted();
      const safe = protect(value);
      const bytes = Buffer.byteLength(JSON.stringify(safe));
      if (bytes > 64_000)
        throw new NativeActionError("invalid_input", "The action recovery receipt is too large.");
      await revalidate();
      const changed = await prisma.externalEffect.updateMany({
        where: {
          id: effect.id,
          idempotencyKey: call.executionId,
          spaceId: context.spaceId,
          runId: context.runId,
          status: "executing",
          request: { equals: effect.request as never },
          run: { userId: context.userId, botId: context.botId, status: "running" },
        },
        data: { result: { nativeRecovery: safe } as never },
      });
      if (changed.count !== 1)
        throw new NativeActionError(
          "result_unknown",
          "The original execution stopped. Verify its recorded remote IDs before another action.",
          { uncertain: true, recovery: safe },
        );
    },
  };
}
