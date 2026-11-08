import { createHash } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import {
  isPageShareApiPath,
  isSensitivePageShareDocumentPath,
  pageShareTokenFromSlug,
  SHARED_PAGE_PATH_PREFIX,
  SharedPageSchema,
} from "@rakazo/contracts";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import type { PrismaClient } from "@rakazo/db";
import { PAGE_SHARE_SECRET_KIND, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { requestClientIp } from "./client-ip.js";
import { throttleKey, windowCounter } from "./window-counter.js";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};
const readsPerMinute = 120;
const minuteMs = 60_000;

type PublicPageRow = { title: string; code: string; version: number; updatedAt: Date };

function shareRequestPath(c: Context) {
  const incoming = (c.env as HttpBindings | undefined)?.incoming?.url;
  // Node also accepts absolute-form proxy requests. Strip the authority without normalizing the path.
  return incoming === undefined
    ? new URL(c.req.url).pathname
    : incoming.replace(/^https?:\/\/[^/?#\\]*/i, "").split("?", 1)[0]!;
}

export function sharedPageLogRoute(path: string, c: Context) {
  const raw = shareRequestPath(c);
  if (isPageShareApiPath(raw) || isPageShareApiPath(path))
    return `${SHARED_PAGE_PATH_PREFIX}:token`;
  if (isSensitivePageShareDocumentPath(raw) || isSensitivePageShareDocumentPath(path))
    return "/p/:slug";
}

async function readSharedPage(prisma: Pick<PrismaClient, "$queryRaw">, token: string) {
  const hash = createHash("sha256").update(token).digest("hex");
  // The owner's direct rename updates the live title. Versioned writes supply the content.
  const [row] = await runAsSystem(
    "read an authorized shared Page",
    () => prisma.$queryRaw<PublicPageRow[]>`
      SELECT p.title, v.code, v.version, p."updatedAt"
      FROM cogine_pages.pages p
      JOIN public.secrets s ON s.id = p."shareSecretId"
        AND s."userId" = p."userId" AND s."spaceId" = p."spaceId"
        AND s.kind = ${PAGE_SHARE_SECRET_KIND}
      JOIN cogine_pages.page_versions v ON v."pageId" = p.id AND v.version = p."currentVersion"
      WHERE p.visibility = 'link' AND p."shareTokenHash" = ${hash}
    `,
  );
  if (!row) return null;
  return SharedPageSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
}

export function mountSharedPages(
  app: Hono,
  prisma: Pick<PrismaClient, "$queryRaw">,
  options: { enabled?: boolean; trustedProxies?: string[] },
) {
  const resolveClientIp = options.enabled
    ? createClientIpResolver(options.trustedProxies)
    : undefined;
  const reads = windowCounter(minuteMs);
  // Intercept the entire namespace before CORS and auth, including malformed and wrong-method paths.
  app.use("*", async (c, next) => {
    const path = shareRequestPath(c);
    if (!isPageShareApiPath(path)) return next();
    if (!resolveClientIp || (c.req.method !== "GET" && c.req.method !== "HEAD"))
      return c.json({ error: "Not found" }, 404, headers);
    try {
      const ip = await requestClientIp(c, resolveClientIp);
      if (reads(throttleKey(ip)) > readsPerMinute) {
        return c.json({ error: "Too many requests" }, 429, { ...headers, "retry-after": "60" });
      }
      const token = path.startsWith(SHARED_PAGE_PATH_PREFIX)
        ? path.slice(SHARED_PAGE_PATH_PREFIX.length)
        : "";
      const page =
        token && pageShareTokenFromSlug(token) === token
          ? await readSharedPage(prisma, token)
          : null;
      return page ? c.json(page, 200, headers) : c.json({ error: "Not found" }, 404, headers);
    } catch {
      // Neither a request URL nor a driver diagnostic belongs in the log for this capability.
      getLogger().warn("Shared Page lookup failed");
      return c.json({ error: "Could not load the Page" }, 503, headers);
    }
  });
}
