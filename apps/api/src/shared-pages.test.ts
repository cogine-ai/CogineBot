import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import * as pageSharePaths from "@rakazo/contracts";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { requestLogging } from "@rakazo/logging/hono";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageShareEdge } from "../../web/src/page-share-edge.js";
import { mountSharedPages, sharedPageLogRoute } from "./shared-pages.js";

const { SHARED_PAGE_PATH_PREFIX } = pageSharePaths;
const token = "a".repeat(43);
const url = `${SHARED_PAGE_PATH_PREFIX}${token}`;
const updatedAt = new Date("2026-01-02T03:04:05.000Z");
const loggedRoute = `${SHARED_PAGE_PATH_PREFIX}:token`;
const originalLogger = getLogger();
afterEach(() => installLogger(originalLogger));

function fixture(enabled = true, trustedProxies?: string[]) {
  const $queryRaw = vi.fn(async (_sql: TemplateStringsArray, _kind: string, _hash: string) => [
    { title: "Synthetic plan", code: "compiledPage()", version: 2, updatedAt },
  ]);
  const app = new Hono();
  const sink = createTestSink();
  const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
  installLogger(logger);
  app.use(
    "*",
    requestLogging(logger, {
      sensitiveRoute: sharedPageLogRoute,
    }),
  );
  mountSharedPages(app, { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">, {
    enabled,
    trustedProxies,
  });
  const authenticate = vi.fn(() => new Response("Not authenticated", { status: 401 }));
  app.all("*", authenticate);
  return { app, $queryRaw, sink, authenticate };
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function expectProtected(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
}

describe("public Page HTTP", () => {
  it("looks up one authorized current version in system scope and serves only public fields", async () => {
    const { app, $queryRaw, authenticate, sink } = fixture();
    const databaseScope: Array<ReturnType<typeof currentDbContext>> = [];
    const read = $queryRaw.getMockImplementation()!;
    $queryRaw.mockImplementation((...args) => {
      databaseScope.push(currentDbContext());
      return read(...args);
    });
    const response = await runAsTenant({ userId: "foreign-user", spaceId: "foreign-space" }, () =>
      app.request(url, { headers: { "x-request-id": token, cookie: "synthetic=ignored" } }),
    );
    expect(response.status).toBe(200);
    expectProtected(response);
    expect(await response.json()).toEqual({
      title: "Synthetic plan",
      code: "compiledPage()",
      version: 2,
      updatedAt: updatedAt.toISOString(),
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(databaseScope).toEqual([{ kind: "system", reason: "read an authorized shared Page" }]);
    expect($queryRaw).toHaveBeenCalledExactlyOnceWith(
      expect.any(Array),
      "page_share",
      createHash("sha256").update(token).digest("hex"),
    );
    const sql = $queryRaw.mock.calls[0]?.[0].join("?");
    expect(sql).toContain('s."userId" = p."userId" AND s."spaceId" = p."spaceId"');
    expect(sql).toContain('v.version = p."currentVersion"');
    expect(JSON.stringify(sink.events)).not.toContain(token);
    expect(sink.events.at(-1)).toMatchObject({ "http.route": loggedRoute });
  });

  it("returns the same absence response for disabled, malformed and unavailable links", async () => {
    const disabled = fixture(false);
    const rejected = await disabled.app.request(url);
    expectProtected(rejected);
    expect(rejected.status).toBe(404);
    expect(disabled.$queryRaw).not.toHaveBeenCalled();
    const { app, $queryRaw, sink, authenticate } = fixture();
    $queryRaw.mockResolvedValue([]);
    for (const [path, method] of [
      [url, "GET"],
      [`${SHARED_PAGE_PATH_PREFIX}%ZZ${token}`, "GET"],
      [`/api/v1/pages/%73hared/${token}/extra`, "GET"],
      [`/api/v1/pages/shared%2f${token}`, "GET"],
      [`/api//v1/pages/shared/${token}`, "GET"],
      [url, "POST"],
      [url, "OPTIONS"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
      expectProtected(response);
      expect(await response.json()).toEqual(await rejected.clone().json());
    }
    expect($queryRaw).toHaveBeenCalledOnce();
    expect(authenticate).not.toHaveBeenCalled();
    expect(sink.events.every((event) => event["http.route"] === loggedRoute)).toBe(true);
    expect(JSON.stringify(sink.events)).not.toContain(token);
  });

  it("returns HEAD without a body and rate limits before a new database read", async () => {
    const { app, $queryRaw } = fixture();
    const head = await app.request(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expectProtected(head);
    expect(await head.text()).toBe("");
    for (let index = 1; index < 120; index++) {
      const response = await app.request(url, {
        headers: { "x-forwarded-for": `192.0.2.${index}` },
      });
      expect(response.status).toBe(200);
    }
    const limited = await app.request(url, { headers: { "x-forwarded-for": "203.0.113.1" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expectProtected(limited);
    expect($queryRaw).toHaveBeenCalledTimes(120);
  });

  it("keeps visitor buckets separate through a trusted Web hop and ignores forged direct forwarding", async () => {
    const { app, $queryRaw } = fixture(true, ["127.0.0.1"]);
    const upstream = createServer(getRequestListener(app.fetch));
    const api = `http://127.0.0.1:${await listen(upstream)}`;
    const report = vi.fn();
    const trusted = pageShareEdge(
      api,
      pageSharePaths,
      report,
      createClientIpResolver(["127.0.0.1"]),
    );
    const untrusted = pageShareEdge(api, pageSharePaths, report);
    const trustedWeb = createServer((req, res) => void trusted(req, res, () => res.end()));
    const directWeb = createServer((req, res) => void untrusted(req, res, () => res.end()));
    const read = async (port: number, forwarded: string) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        method: "HEAD",
        headers: { "x-forwarded-for": forwarded },
      });
    try {
      const trustedPort = await listen(trustedWeb);
      const directPort = await listen(directWeb);
      for (let index = 1; index <= 120; index++) {
        expect((await read(trustedPort, `203.0.113.${index}, 2001:db8:11:5::1`)).status).toBe(200);
        expect((await read(directPort, `198.51.100.${index}`)).status).toBe(200);
      }
      expect((await read(trustedPort, "2001:db8:11:5::2")).status).toBe(429);
      expect((await read(trustedPort, "2001:db8:11:6::1")).status).toBe(200);
      expect((await read(directPort, "203.0.113.201")).status).toBe(429);
      expect($queryRaw).toHaveBeenCalledTimes(241);
      expect(report).not.toHaveBeenCalled();
    } finally {
      await Promise.all([close(trustedWeb), close(directWeb), close(upstream)]);
    }
  });

  it("reports a database failure without echoing its diagnostic", async () => {
    const { app, $queryRaw, sink } = fixture();
    $queryRaw.mockRejectedValue(new Error(`Unexpected connection data ${url}`));
    const response = await app.request(url);
    expect(response.status).toBe(503);
    expectProtected(response);
    expect(await response.json()).toEqual({ error: "Could not load the Page" });
    expect(JSON.stringify(sink.events)).not.toContain(token);
    expect(sink.events.at(-1)).toMatchObject({ "http.route": loggedRoute, "http.status": 503 });
  });

  it("does not log a document capability sent directly to the API", async () => {
    const { app, $queryRaw, sink } = fixture();
    for (const path of [`/p/${token}`, `/%70%2f${token}`, `//p/${token}`]) {
      const response = await app.request(path, { headers: { "x-request-id": token } });
      expect(response.status).toBe(401);
    }
    expect($queryRaw).not.toHaveBeenCalled();
    expect(sink.events.map((event) => event["http.route"])).toEqual(Array(3).fill("/p/:slug"));
    expect(JSON.stringify(sink.events)).not.toContain(token);
  });

  it("rejects dot aliases from Node origin-form and absolute-form targets before the database", async () => {
    const { app, $queryRaw, sink } = fixture();
    const server = createServer(getRequestListener(app.fetch));
    const port = await listen(server);
    try {
      const statusFor = (path: string) =>
        new Promise<number | undefined>((resolve, reject) => {
          const outgoing = request({ host: "127.0.0.1", port, path }, (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          });
          outgoing.once("error", reject);
          outgoing.end();
        });
      const dotAlias = `/api/v1/temporary/../pages/shared/${token}`;
      const authority = `http://127.0.0.1:${port}`;
      expect(await statusFor(dotAlias)).toBe(404);
      expect(await statusFor(`${authority}${dotAlias}`)).toBe(404);
      expect($queryRaw).not.toHaveBeenCalled();
      expect(sink.events.at(-1)).toMatchObject({ "http.route": loggedRoute });
      expect(await statusFor(url)).toBe(200);
      expect(await statusFor(`${authority}${url}`)).toBe(200);
      expect($queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      await close(server);
    }
  });
});
