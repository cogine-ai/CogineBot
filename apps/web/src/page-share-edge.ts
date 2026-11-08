import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import type * as PageShareContracts from "@rakazo/contracts";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";

type PageSharePaths = Pick<
  typeof PageShareContracts,
  | "isPageShareApiPath"
  | "isPageShareDocumentPath"
  | "isSensitivePageShareDocumentPath"
  | "pageShareTokenFromSlug"
  | "SHARED_PAGE_PATH_PREFIX"
>;

export function pageShareEdge(
  api: string,
  {
    isPageShareApiPath,
    isPageShareDocumentPath,
    isSensitivePageShareDocumentPath,
    pageShareTokenFromSlug,
    SHARED_PAGE_PATH_PREFIX,
  }: PageSharePaths,
  reportProxyFailure: () => void,
  resolveClientIp = createClientIpResolver(),
) {
  return async (
    request: IncomingMessage & { originalUrl?: string },
    response: ServerResponse,
    next: () => void,
  ) => {
    const path = request.url?.split("?", 1)[0] ?? "";
    const document = isPageShareDocumentPath(path);
    // Match normalization aliases for privacy, but authorize only the raw route below.
    if (!isPageShareApiPath(path) && !isSensitivePageShareDocumentPath(path)) {
      next();
      return;
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-robots-tag", "noindex, nofollow");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (document) {
      // Serve the SPA without passing a capability through Vite's URL or error handling.
      request.url = "/index.html";
      request.originalUrl = request.url;
      delete request.headers["if-none-match"];
      delete request.headers["if-modified-since"];
      delete request.headers.range;
      // Vite development unconditionally sets no-cache on transformed HTML.
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) =>
        setHeader(name, name.toLowerCase() === "cache-control" ? "no-store" : value);
      next();
      return;
    }
    const token = path.startsWith(SHARED_PAGE_PATH_PREFIX)
      ? path.slice(SHARED_PAGE_PATH_PREFIX.length)
      : "";
    if (!token || pageShareTokenFromSlug(token) !== token) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const unavailable = () => {
      if (response.destroyed || response.writableEnded) return;
      reportProxyFailure();
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 502;
      response.end();
    };
    let target: URL;
    try {
      target = new URL(path, api);
    } catch {
      unavailable();
      return;
    }
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username ||
      target.password
    ) {
      unavailable();
      return;
    }
    let address: string | undefined;
    try {
      const forwarded = request.headers["x-forwarded-for"];
      address = await resolveClientIp({
        peer: request.socket.remoteAddress,
        forwarded: Array.isArray(forwarded) ? forwarded.join(",") : forwarded,
      });
    } catch {
      unavailable();
      return;
    }
    // A hostname lookup may outlast the browser connection.
    if (response.destroyed || response.writableEnded) return;
    const transport = target.protocol === "https:" ? https : http;
    // Vite's generic proxy logs the full request URL on failure and can pass through
    // a caller-supplied forwarding chain. Forward only the resolved address.
    let upstream: ClientRequest | undefined;
    try {
      upstream = transport.request(
        target,
        {
          method: request.method,
          headers: address ? { "x-forwarded-for": address } : {},
        },
        (incoming) => {
          if (response.destroyed) {
            incoming.destroy();
            return;
          }
          response.statusCode = incoming.statusCode ?? 502;
          for (const name of ["content-type", "retry-after"]) {
            const value = incoming.headers[name];
            if (value) response.setHeader(name, value);
          }
          incoming.on("error", unavailable);
          incoming.pipe(response);
        },
      );
      upstream.on("error", unavailable);
      upstream.setTimeout(15_000, () => upstream?.destroy());
      response.once("close", () => upstream?.destroy());
      upstream.end();
    } catch {
      upstream?.destroy();
      unavailable();
    }
  };
}
