import { getConnInfo } from "@hono/node-server/conninfo";
import type { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import type { Context } from "hono";

export function requestClientIp(c: Context, resolve: ReturnType<typeof createClientIpResolver>) {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // In-process HTTP fixtures have no connected socket.
  }
  return resolve({ peer, forwarded: c.req.header("x-forwarded-for") });
}
