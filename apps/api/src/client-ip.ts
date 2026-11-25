import { getConnInfo } from "@hono/node-server/conninfo";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
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

export function requestClientIp(c: Context, resolve: ReturnType<typeof createClientIpResolver>) {
  return resolve(requestClientIpSource(c));
}

export function createAuditRequestIpReader(trustedProxies?: string[]) {
  let resolve: ReturnType<typeof createClientIpResolver> | undefined;
  return (c: Context) => {
    const source = requestClientIpSource(c);
    return async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        resolve ??= createClientIpResolver(trustedProxies);
        return await Promise.race([
          resolve(source),
          new Promise<undefined>((done) => {
            // A named proxy can require DNS; request attribution is best effort.
            timer = setTimeout(() => done(undefined), 250);
            timer.unref();
          }),
        ]);
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    };
  };
}
