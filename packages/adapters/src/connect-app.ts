import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { MessageBlock } from "@rakazo/contracts";
import { appConnectCard, matchAppCatalog, matchesAppConnection } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { completeExternalEffect } from "./approval-effect.js";
import type { ExecutorDeps } from "./executor.js";
import { renewRunLease } from "./run-lifecycle.js";
import { persistMessageInTransaction, runLeaseFor } from "./run-messages.js";

export const ConnectAppInput = z.strictObject({
  app: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^:/\\]+$/)
    .refine((app) => !/\p{Cc}/u.test(app)),
});

const RECENT_MESSAGES = 50;
const INVALID_APP = { error: "Provide an application name or slug, up to 100 characters." };
const UNAVAILABLE_APP = { error: "This app is not available to connect here." };
const CATALOG_UNAVAILABLE = {
  error: "Could not finish checking the application catalog. Try again.",
  retryable: true,
};
const ALREADY_CONNECTED = { status: "connected", message: "This app is already connected." };
const CARD_SHOWN = {
  status: "pending",
  message: "Connection card shown. Wait for the user to authorize the app.",
};
const CARD_ALREADY_SHOWN = {
  ...CARD_SHOWN,
  message: "A connection card is already open for this app. Wait for the user to authorize it.",
};

type ConnectAppRun = {
  id: string;
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
};
type CardEffect = { id: string; expectedStatus: "intended" | "approved" };

/** Catalog readers never receive model-supplied URLs or instructions. */
async function readAppCatalog(
  providers: readonly ManagedConnectorProvider[],
  context: AdapterContext,
) {
  const catalogs = await Promise.all(
    providers.map(async (provider) => {
      try {
        const connectorId = provider.describe().id;
        return (await provider.catalog(context)).filter(
          (entry) => entry.connectorId === connectorId,
        );
      } catch {
        context.signal.throwIfAborted();
        return undefined;
      }
    }),
  );
  return {
    catalog: catalogs.flatMap((items) => items ?? []),
    failed: catalogs.includes(undefined),
  };
}

export async function connectApp(
  deps: ExecutorDeps,
  providers: readonly ManagedConnectorProvider[],
  context: AdapterContext,
  run: ConnectAppRun,
  input: Record<string, unknown>,
  effect: CardEffect,
  readPolicyBlock: (tx: Prisma.TransactionClient) => Promise<{ error: string } | undefined>,
) {
  // Approval replay can replace the arguments validated at the dispatcher entry.
  const parsed = ConnectAppInput.safeParse(input);
  const { catalog, failed } = parsed.success
    ? await readAppCatalog(providers, context)
    : { catalog: [], failed: false };
  const lease = runLeaseFor(deps, run.id);
  if (!lease) return undefined;
  context.signal.throwIfAborted();
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
      if (!(await renewRunLease(deps, run.id, lease.owner, lease.fence, tx))) return undefined;
      context.signal.throwIfAborted();

      const liveEffect = await tx.externalEffect.findUnique({
        where: { id: effect.id, runId: run.id, spaceId: run.spaceId, kind: "connect_app" },
        select: { status: true, result: true },
      });
      if (liveEffect?.status === "completed")
        return { result: liveEffect.result, message: undefined };
      if (liveEffect?.status !== effect.expectedStatus) return undefined;
      const blocked = await readPolicyBlock(tx);
      if (blocked) {
        return (await completeExternalEffect(tx, effect.id, effect.expectedStatus, blocked))
          ? { result: blocked, message: undefined }
          : undefined;
      }
      let result: typeof UNAVAILABLE_APP | typeof CARD_SHOWN = parsed.success
        ? UNAVAILABLE_APP
        : INVALID_APP;
      let message: Awaited<ReturnType<typeof persistMessageInTransaction>> | undefined;
      if (parsed.success && matchAppCatalog(catalog, parsed.data.app)) {
        const rows = await tx.connection.findMany({
          where: { userId: run.userId, spaceId: run.spaceId, status: "connected" },
          select: { connectorId: true, provider: true },
        });
        const connected = matchAppCatalog(
          catalog.filter(
            (item) =>
              item.connected &&
              rows.some(
                (row) =>
                  row.connectorId === item.connectorId &&
                  row.provider.toLowerCase() === item.slug.toLowerCase(),
              ),
          ),
          parsed.data.app,
        );
        // Native apps choose a deployed configuration before authorizing. Their
        // existing settings flow handles that separately from managed app OAuth.
        const available = matchAppCatalog(
          catalog.filter((item) => item.connectable !== false && item.connectorId !== "native"),
          parsed.data.app,
        );
        if (connected) result = ALREADY_CONNECTED;
        else if (available) {
          const recent = await tx.message.findMany({
            where: { threadId: run.threadId },
            orderBy: { seq: "desc" },
            take: RECENT_MESSAGES,
            select: { blocks: true, role: true },
          });
          const pending = recent.some(
            ({ blocks, role }) =>
              role === "bot" &&
              Array.isArray(blocks) &&
              blocks.some((candidate) => {
                const block = MessageBlock.safeParse(candidate);
                return (
                  block.success &&
                  matchesAppConnection(block.data, available.connectorId, available.slug) &&
                  block.data.status === "pending"
                );
              }),
          );
          result = pending ? CARD_ALREADY_SHOWN : CARD_SHOWN;
          if (!pending) {
            message = await persistMessageInTransaction(
              tx,
              run,
              "bot",
              [appConnectCard({ ...available, connected: false })],
              undefined,
              `connect-app:${effect.id}`,
              false,
              lease,
            );
          }
        }
      }
      if (failed && result === UNAVAILABLE_APP)
        return { result: CATALOG_UNAVAILABLE, message: undefined };
      // An effect superseded during approval can never leave a card behind.
      if (!(await completeExternalEffect(tx, effect.id, effect.expectedStatus, result))) {
        throw new Error("The connection request changed before it could be recorded.");
      }
      return { result, message };
    }),
  );
  if (committed?.message) {
    await deps.events
      .notify(run.threadId, committed.message.eventSeq, committed.message.firstResponseRunId)
      .catch((error) => getLogger().error("connection card realtime notification", error));
  }
  return committed?.result;
}
