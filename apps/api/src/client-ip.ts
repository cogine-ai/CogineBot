import { getConnInfo } from "@hono/node-server/conninfo";
import type { ClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import { createClientIpResolver, resolveClientIpForAudit } from "@rakazo/core/node/trusted-proxy";
import type { Context } from "hono";

function requestClientIpSource(c: Context) {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // In-process HTTP fixtures have no connected socket.
  }
  return { peer, forwarded: c.req.header("x-forwarded-for") };
}

export function requestClientIp(c: Context, resolve: ClientIpResolver) {
  return resolve(requestClientIpSource(c));
}

export function createAuditRequestIpReader(trustedProxies?: string[]) {
  let resolve: ClientIpResolver | undefined;
  return (c: Context) => {
    const source = requestClientIpSource(c);
    return async () => {
      try {
        resolve ??= createClientIpResolver(trustedProxies);
        return resolveClientIpForAudit(resolve, source);
      } catch {
        return undefined;
      }
    };
  };
}
