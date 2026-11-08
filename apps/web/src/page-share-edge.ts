import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

type PageSharePaths = Pick<
  typeof import("@rakazo/contracts"),
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
) {
  return (
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
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      unavailable();
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    // Vite's generic proxy logs the full request URL on failure and can pass through
    // a caller-supplied forwarding header. This public route needs neither behavior.
    const upstream = transport.request(
      target,
      {
        method: request.method,
        headers: request.socket.remoteAddress
          ? { "x-forwarded-for": request.socket.remoteAddress }
          : {},
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
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on("error", unavailable);
    response.on("close", () => upstream.destroy());
    upstream.end();
  };
}
