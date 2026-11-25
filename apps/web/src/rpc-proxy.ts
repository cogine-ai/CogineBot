import type { ClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import { resolveClientIpForAudit } from "@rakazo/core/node/trusted-proxy";
import type { ProxyOptions } from "vite";

const auditedApprovalPaths = new Set([
  "/rpc/approvalRules/set",
  "/rpc/approvalRules/remove",
  "/rpc/autoReview/set",
]);

export function createRpcProxy(api: string, resolveClientIp: ClientIpResolver): ProxyOptions {
  return {
    target: api,
    changeOrigin: true,
    async bypass(request) {
      const forwarded = request.headers["x-forwarded-for"];
      delete request.headers["x-forwarded-for"];
      // Other RPCs do not need address resolution before dispatch.
      if (
        request.method !== "POST" ||
        !auditedApprovalPaths.has(request.url?.split("?", 1)[0] ?? "")
      )
        return;
      const ip = await resolveClientIpForAudit(resolveClientIp, {
        peer: request.socket.remoteAddress,
        forwarded: Array.isArray(forwarded) ? forwarded.join(",") : forwarded,
      });
      if (ip) request.headers["x-forwarded-for"] = ip;
    },
  };
}
