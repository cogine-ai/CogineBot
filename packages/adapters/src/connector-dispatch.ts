import type { Prisma } from "@rakazo/db";

/** Managed MCP already owns a dispatch transaction. Reuse it instead of borrowing another connection. */
export const dispatchTransaction = Symbol("connector dispatch transaction");

export type ConnectorDispatchCheck = (() => Promise<void>) & {
  [dispatchTransaction]?: (tx: Prisma.TransactionClient) => Promise<void>;
};
