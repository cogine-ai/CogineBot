import type { Prisma } from "@rakazo/db";

/** The policy check refused admission before the next provider request. */
export class ActionRuleDispatchError extends Error {}

/** Managed MCP already owns a dispatch transaction. Reuse it instead of borrowing another connection. */
export const dispatchTransaction = Symbol("connector dispatch transaction");

export type ConnectorDispatchCheck = (() => Promise<void>) & {
  [dispatchTransaction]?: (tx: Prisma.TransactionClient) => Promise<void>;
};
