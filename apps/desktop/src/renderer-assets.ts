import path from "node:path";
import { isPageShareApiPath, isPageShareDocumentPath, PAGE_RUNTIME_PATH } from "@rakazo/contracts";

const PASSTHROUGH_PATHS = ["/api", "/rpc", "/novnc"];
const VIEWER_DOCUMENT = "html-viewer.html";

export const rendererViewerDocumentHeaders = {
  "content-security-policy": "frame-ancestors 'self'",
  "referrer-policy": "no-referrer",
};

export const rendererPageShareDocumentHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function bundledRendererCandidates(
  root: string,
  requestUrl: string,
  webOrigin: string,
  acceptsHtml: boolean,
): [string, ...string[]] | null {
  const url = new URL(requestUrl);
  if (
    url.origin !== webOrigin ||
    isPageRuntimePath(url.pathname) ||
    isPageShareApiPath(url.pathname) ||
    PASSTHROUGH_PATHS.some((prefix) => matchesPrefix(url.pathname, prefix))
  ) {
    return null;
  }
  if (acceptsHtml && isPageShareDocumentPath(url.pathname)) return [path.join(root, "index.html")];

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;

  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = safeChild(root, requested);
  if (!candidate) return null;
  if (isRendererViewerDocument(root, candidate)) return [path.resolve(root, VIEWER_DOCUMENT)];
  return acceptsHtml ? [candidate, path.join(root, "index.html")] : [candidate];
}

/** Match the resolved file so encoded paths and case-insensitive filesystems use the same policy. */
export function isRendererViewerDocument(root: string, file: string): boolean {
  return path.relative(root, file).toLowerCase() === VIEWER_DOCUMENT;
}

export function contentType(file: string) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function immutableRendererAsset(file: string) {
  return path.basename(path.dirname(file)) === "assets";
}

export function isRendererAssetMiss(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}

export function forwardedRendererRequestInit(
  request: Request,
  webOrigin: string,
): RequestInit & { bypassCustomProtocolHandlers: boolean } {
  const init: RequestInit & { bypassCustomProtocolHandlers: boolean } = {
    bypassCustomProtocolHandlers: true,
    credentials: "include",
  };
  const url = new URL(request.url);
  const sameOrigin = url.origin === webOrigin;
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && sameOrigin && isPageShareApiPath(url.pathname)) {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("referer");
    return {
      ...init,
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers,
    };
  }
  if (isPageRuntimePath(url.pathname) && read && (sameOrigin || request.credentials === "omit")) {
    // This fixed script is public. The managed renderer's credentialed proxy
    // must not add an account session to a viewer's anonymous revalidation.
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    return { ...init, credentials: "omit", headers };
  }
  if (!sameOrigin) return init;
  const headers = new Headers(request.headers);
  headers.set("origin", webOrigin);
  return { ...init, headers };
}

function isPageRuntimePath(pathname: string) {
  try {
    // Match the server's URI decoding while keeping encoded path separators distinct.
    return decodeURI(pathname) === PAGE_RUNTIME_PATH;
  } catch {
    return false;
  }
}

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function safeChild(root: string, requested: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}
