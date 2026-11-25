import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClientIpResolver } from "@rakazo/core/node/trusted-proxy";
import { createServer, preview } from "vite";
import { expect, it, vi } from "vitest";
import { createRpcProxy } from "./rpc-proxy.js";

const origin = (server: Pick<Server, "address">) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

it.each([
  { mode: "direct", trusted: [], chain: "192.0.2.21, 203.0.113.23", expected: "127.0.0.1" },
  {
    mode: "trusted outer proxy",
    trusted: ["127.0.0.1"],
    chain: "192.0.2.21, 203.0.113.23",
    expected: "203.0.113.23",
  },
  { mode: "trusted proxy without a client", trusted: ["127.0.0.1"] },
])("rebuilds the upstream RPC forwarding header in dev and preview for $mode", async (test) => {
  const root = await mkdtemp(path.join(tmpdir(), "rpc-forwarding-"));
  const upstream = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ ip: request.headers["x-forwarded-for"], method: request.method }),
    );
  });
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  let built: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "index.html"), "<title>Synthetic application</title>");
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const resolve = vi.fn(createClientIpResolver(test.trusted));
    const proxy = { "/rpc": createRpcProxy(origin(upstream), resolve) };
    const config = {
      configFile: false as const,
      root,
      logLevel: "silent" as const,
      server: { host: "127.0.0.1", port: 0, ws: false as const, proxy },
      preview: { host: "127.0.0.1", port: 0, proxy },
    };
    dev = await createServer(config);
    await dev.listen();
    built = await preview(config);
    for (const server of [dev.httpServer!, built.httpServer]) {
      for (const [path, method] of [
        ["/rpc/approvalRules/set", "POST"],
        ["/rpc/approvalRules/set/?view=fixture", "PUT"],
      ]) {
        const response = await fetch(`${origin(server)}${path}`, {
          method,
          headers: test.chain ? { "x-forwarded-for": test.chain } : {},
          body: "{}",
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ ip: test.expected, method });
      }
      const lookups = resolve.mock.calls.length;
      const stopped = await fetch(`${origin(server)}/rpc/threads/stop`, {
        method: "POST",
        headers: { "x-forwarded-for": "192.0.2.21" },
        body: "{}",
      });
      expect(stopped.status).toBe(200);
      await expect(stopped.json()).resolves.toEqual({ method: "POST" });
      expect(resolve).toHaveBeenCalledTimes(lookups);
    }
  } finally {
    await dev?.close();
    await built?.close();
    if (upstream.listening) await new Promise<void>((done) => upstream.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
