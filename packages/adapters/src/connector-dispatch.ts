import type { LookupFunction } from "node:net";
import type { Prisma } from "@rakazo/db";
import { buildConnector } from "undici";

/** The policy check refused admission before the next provider request. */
export class ActionRuleDispatchError extends Error {}

/** Managed MCP already owns a dispatch transaction. Reuse it instead of borrowing another connection. */
export const dispatchTransaction = Symbol("connector dispatch transaction");

export type ConnectorDispatchCheck = (() => Promise<void>) & {
  [dispatchTransaction]?: (tx: Prisma.TransactionClient) => Promise<void>;
};

/** A request-owned connection rechecks authorization after DNS and TCP/TLS. */
export function guardedConnect(
  lookup: LookupFunction,
  beforeDispatch: () => Promise<void>,
): buildConnector.connector {
  const connect = buildConnector({ lookup });
  return (options, callback) => {
    connect(options, (...[error, socket]) => {
      if (error) {
        callback(error, null);
        return;
      }
      // Recheck after DNS and TCP/TLS, before handing the socket over for the write.
      void Promise.resolve()
        .then(beforeDispatch)
        .then(
          () => callback(null, socket),
          (reason: unknown) => {
            socket.destroy();
            callback(reason instanceof Error ? reason : new Error(String(reason)), null);
          },
        );
    });
  };
}
