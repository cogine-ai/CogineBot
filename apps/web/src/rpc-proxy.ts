import type { ClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import { resolveClientIpForAudit } from "@rakazo/core/node/trusted-proxy";
import type { ProxyOptions } from "vite";

export function createRpcProxy(api: string, resolveClientIp: ClientIpResolver): ProxyOptions {
  return {
    target: api,
    changeOrigin: true,
    async bypass(request) {
      const forwarded = request.headers["x-forwarded-for"];
      delete request.headers["x-forwarded-for"];
      const ip = await resolveClientIpForAudit(resolveClientIp, {
        peer: request.socket.remoteAddress,
        forwarded: Array.isArray(forwarded) ? forwarded.join(",") : forwarded,
      });
      if (ip) request.headers["x-forwarded-for"] = ip;
    },
  };
}
