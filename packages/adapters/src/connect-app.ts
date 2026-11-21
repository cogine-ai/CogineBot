import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import { appConnectCard, matchAppCatalog, matchesAppConnection } from "@rakazo/core";
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
    .regex(/^[^:/\\\p{Cc}]+$/u),
});

const RECENT_MESSAGES = 50;
const INVALID_APP = { error: "Provide an application name or slug, up to 100 characters." };
const UNAVAILABLE_APP = { error: "This app is not available to connect here." };
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
type CardEffect = { id: string; expectedStatus: "intended" | "executing" };

/** Catalog readers never receive model-supplied URLs or instructions. */
async function readAppCatalog(
  providers: readonly ManagedConnectorProvider[],
  context: AdapterContext,
): Promise<ConnectionCatalogItem[]> {
  const catalogs = await Promise.all(
    providers.map(async (provider) => {
      try {
        const connectorId = provider.describe().id;
        return (await provider.catalog(context)).filter(
          (entry) => entry.connectorId === connectorId,
        );
      } catch {
        context.signal.throwIfAborted();
        return [];
      }
    }),
  );
  return catalogs.flat();
}

export async function connectApp(
  deps: ExecutorDeps,
  providers: readonly ManagedConnectorProvider[],
  context: AdapterContext,
  run: ConnectAppRun,
  input: Record<string, unknown>,
  effect: CardEffect,
) {
  const parsed = ConnectAppInput.safeParse(input);
  const catalog = parsed.success ? await readAppCatalog(providers, context) : [];
  const lease = runLeaseFor(deps, run.id);
  if (!lease) return undefined;
  context.signal.throwIfAborted();
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} AND "spaceId" = ${run.spaceId} FOR UPDATE`;
      if (!(await renewRunLease(deps, run.id, lease.owner, lease.fence, tx))) return undefined;
      context.signal.throwIfAborted();

      const nonce = `connect-app:${effect.id}`;
      const replayed = await tx.message.findFirst({
        where: { threadId: run.threadId, clientNonce: nonce, role: "bot", runId: run.id },
        select: { id: true },
      });
      let result = replayed ? CARD_SHOWN : parsed.success ? UNAVAILABLE_APP : INVALID_APP;
      let message: Awaited<ReturnType<typeof persistMessageInTransaction>> | undefined;
      if (!replayed && parsed.success && matchAppCatalog(catalog, parsed.data.app)) {
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
              nonce,
              false,
              lease,
            );
          }
        }
      }
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
