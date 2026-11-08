import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, {
  createServer as createHttpServer,
  get,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pageSharePaths from "@rakazo/contracts";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import { createServer, type Plugin, preview } from "vite";
import { describe, expect, it, vi } from "vitest";
import { pageShareEdge } from "./page-share-edge.js";

const token = "z".repeat(43);
const apiPath = `${pageSharePaths.SHARED_PAGE_PATH_PREFIX}${token}`;
const documentPath = `/p/synthetic-plan-${token}`;

function origin(server: { address(): AddressInfo | string | null }) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return origin(server);
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function expectPrivacy(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

describe("Page share development and preview edge", () => {
  it("forwards only the anonymous request and keeps token-bearing failures out of diagnostics", async () => {
    const headers: IncomingMessage["headers"][] = [];
    const upstream = createHttpServer((request, response) => {
      expect(request.url).toBe(apiPath);
      headers.push(request.headers);
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "21",
        "set-cookie": "must-not-forward",
      });
      response.end('{"error":"Rate limited"}');
    });
    const api = await listen(upstream);
    const report = vi.fn();
    const middleware = pageShareEdge(api, pageSharePaths, report);
    const edge = createHttpServer((request, response) =>
      middleware(request, response, () => {
        response.end("generic");
      }),
    );
    const web = await listen(edge);
    try {
      const successful = await fetch(`${web}${apiPath}?ignored=${token}`, {
        headers: {
          "x-forwarded-for": "203.0.113.5",
          authorization: "Bearer synthetic-session",
          cookie: "session=synthetic",
          referer: `${web}${documentPath}`,
        },
      });
      expect(successful.status).toBe(429);
      expectPrivacy(successful);
      expect(successful.headers.get("retry-after")).toBe("21");
      expect(successful.headers.get("set-cookie")).toBeNull();
      expect(await successful.json()).toEqual({ error: "Rate limited" });
      expect(headers).toHaveLength(1);
      expect(headers[0]?.["x-forwarded-for"]).toBe("127.0.0.1");
      expect(headers[0]).not.toHaveProperty("authorization");
      expect(headers[0]).not.toHaveProperty("cookie");
      expect(headers[0]).not.toHaveProperty("referer");
      for (const path of [
        `/api/v1/pages/%73hared/${token}`,
        `/api//v1/pages/shared/${token}`,
        `/p%2f${token}`,
        `//p/${token}`,
      ]) {
        const malformed = await fetch(`${web}${path}`);
        expect(malformed.status).toBe(404);
        expectPrivacy(malformed);
      }
      expect(headers).toHaveLength(1);
      const ordinary = await fetch(`${web}/unrelated`);
      expect(await ordinary.text()).toBe("generic");
      expect(ordinary.headers.get("referrer-policy")).toBeNull();

      await close(upstream);
      const unavailable = await fetch(`${web}${apiPath}`);
      expect(unavailable.status).toBe(502);
      expectPrivacy(unavailable);
      expect(await unavailable.text()).toBe("");
      expect(report.mock.calls).toEqual([[]]);
      const aliasStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = get(
          {
            host: "127.0.0.1",
            port: (edge.address() as AddressInfo).port,
            path: `/api/v1/temporary/../pages/shared/${token}`,
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.once("error", reject);
      });
      expect(aliasStatus).toBe(404);
      expect(report.mock.calls).toEqual([[]]);
    } finally {
      if (upstream.listening) await close(upstream);
      await close(edge);
    }
  });

  it("does not forward a request whose browser disconnects during proxy DNS resolution", async () => {
    const upstream = createHttpServer((_request, response) => response.end());
    const api = await listen(upstream);
    const started = deferred<void>();
    const browserClosed = deferred<void>();
    const lookup = deferred<string[]>();
    const resolved = deferred<void>();
    const resolve = createClientIpResolver(["host-proxy"], {
      resolve: () => {
        started.resolve();
        return lookup.promise;
      },
    });
    const report = vi.fn();
    const middleware = pageShareEdge(api, pageSharePaths, report, async (input) => {
      const address = await resolve(input);
      resolved.resolve();
      return address;
    });
    const edge = createHttpServer((request, response) => {
      response.once("close", browserClosed.resolve);
      void middleware(request, response, () => response.end());
    });
    const web = await listen(edge);
    const proxyRequests = vi.spyOn(http, "request");
    const browser = get(`${web}${apiPath}`, {
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    browser.on("error", () => {});
    try {
      await started.promise;
      proxyRequests.mockClear();
      browser.destroy();
      await browserClosed.promise;
      lookup.resolve(["127.0.0.1"]);
      await resolved.promise;
      await Promise.resolve();
      expect(proxyRequests).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      lookup.resolve([]);
      browser.destroy();
      proxyRequests.mockRestore();
      await Promise.all([close(edge), close(upstream)]);
    }
  });

  it.each([
    {
      failure: "address resolution rejects",
      api: "http://127.0.0.1:1",
      rejectAddress: true,
      transportCalls: 0,
    },
    {
      failure: "transport setup throws",
      api: "http://127.0.0.1:1",
      rejectAddress: false,
      transportCalls: 1,
    },
    {
      failure: "upstream URL has userinfo",
      api: "http://%FF@127.0.0.1:1",
      rejectAddress: false,
      transportCalls: 0,
    },
  ])(
    "protects the error response and diagnostic when $failure",
    async ({ api, rejectAddress, transportCalls }) => {
      const report = vi.fn();
      const failure = new Error(`Unexpected proxy failure for ${apiPath}`);
      const proxyRequest = vi.spyOn(http, "request").mockImplementation(() => {
        throw failure;
      });
      const middleware = pageShareEdge(
        api,
        pageSharePaths,
        report,
        rejectAddress
          ? async () => {
              throw failure;
            }
          : undefined,
      );
      const edge = createHttpServer(
        (request, response) => void middleware(request, response, () => response.end()),
      );
      const web = await listen(edge);
      try {
        const result = await fetch(`${web}${apiPath}`);
        expect(result.status).toBe(502);
        expectPrivacy(result);
        expect(await result.text()).toBe("");
        expect(report.mock.calls).toEqual([[]]);
        expect(proxyRequest).toHaveBeenCalledTimes(transportCalls);
      } finally {
        proxyRequest.mockRestore();
        await close(edge);
      }
    },
  );

  it("serves the first document in real Vite dev and preview with no-store even on a conditional request", async () => {
    const root = await mkdtemp(join(tmpdir(), "page-share-vite-"));
    const html = "<!doctype html><title>Synthetic Vite document</title>";
    const dist = join(root, "dist");
    await mkdir(dist);
    await Promise.all(
      [root, dist].map((directory) => writeFile(join(directory, "index.html"), html)),
    );
    const middleware = pageShareEdge("http://127.0.0.1:1", pageSharePaths, vi.fn());
    const plugin: Plugin = {
      name: "test-page-share-edge",
      configureServer: (server) => {
        server.middlewares.use(middleware);
      },
      configurePreviewServer: (server) => {
        server.middlewares.use(middleware);
      },
    };
    const config = {
      configFile: false as const,
      root,
      logLevel: "silent" as const,
      server: { host: "127.0.0.1", port: 0, ws: false as const },
      preview: { host: "127.0.0.1", port: 0 },
      plugins: [plugin],
    };
    const dev = await createServer(config);
    let previewServer: Awaited<ReturnType<typeof preview>> | undefined;
    try {
      await dev.listen();
      previewServer = await preview(config);
      for (const server of [dev.httpServer!, previewServer.httpServer]) {
        const web = origin(server);
        const initial = await fetch(`${web}/index.html`);
        const etag = initial.headers.get("etag");
        expect(etag).toBeTruthy();
        const ordinaryDocument = await initial.text();
        expect(ordinaryDocument).toContain("<title>Synthetic Vite document</title>");
        const shared = await fetch(`${web}${documentPath}`, {
          headers: { "if-none-match": etag!, range: "bytes=0-8" },
        });
        expect(shared.status).toBe(200);
        expectPrivacy(shared);
        expect(await shared.text()).toBe(ordinaryDocument);
      }
    } finally {
      await dev.close();
      if (previewServer) await previewServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
