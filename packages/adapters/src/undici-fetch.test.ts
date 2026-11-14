import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js";
import { Agent, Response as UndiciResponse } from "undici";
import { describe, expect, it } from "vitest";
import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";

describe("fetchPairedWithDispatcher", () => {
  it("sends global FormData fields with the multipart boundary", async () => {
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set(
      "file",
      new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "audio/webm" }),
      "speech.webm",
    );
    const posted = await postThroughPackageFetch((url, dispatcher) =>
      fetchPairedWithDispatcher(globalThis.fetch)(url, {
        method: "POST",
        body: form,
        dispatcher,
      } as RequestInit & { dispatcher: Agent }),
    );

    expect(posted.status).toBe(204);
    expect(posted.lookups).toBeGreaterThan(0);
    const boundary = boundaryOf(posted.contentType);
    const raw = posted.body.toString("latin1");
    expect(raw).toContain(`--${boundary}`);
    expect(raw).toContain(`--${boundary}--`);
    expect(raw).toContain('name="model"');
    expect(raw).toContain("whisper-1");
    expect(raw).toContain('name="file"');
    expect(raw).toContain('filename="speech.webm"');
    expect(raw).toContain("audio/webm");
    expect(posted.body.includes(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(raw).not.toContain("[object FormData]");
  });

  it("passes other bodies through the same dispatcher", async () => {
    const posted = await postThroughPackageFetch((url, dispatcher) =>
      dispatcherFetch(url, {
        method: "POST",
        body: "plain-body",
        dispatcher,
      } as RequestInit & { dispatcher: Agent }),
    );

    expect(posted.status).toBe(204);
    expect(posted.lookups).toBeGreaterThan(0);
    expect(posted.body.toString("utf8")).toBe("plain-body");
    expect(posted.contentType ?? "").not.toMatch(/multipart\/form-data/i);
  });

  it("leaves a caller-supplied fetch and its FormData unchanged", async () => {
    const form = new FormData();
    form.set("a", "b");
    let seen: BodyInit | null | undefined;
    const custom = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.body;
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const transport = fetchPairedWithDispatcher(custom);

    expect(transport).toBe(custom);
    const response = await transport("https://example.test/upload", { method: "POST", body: form });
    expect(response.status).toBe(204);
    expect(seen).toBe(form);
  });
});

describe("dispatcherFetch OAuth responses", () => {
  it("lets the MCP SDK read an undici error response", async () => {
    const body = JSON.stringify({
      error: "registration_not_supported",
      error_description: "Dynamic client registration is not supported",
    });
    const foreign = new UndiciResponse(body, {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    expect(foreign instanceof Response).toBe(false);
    const masked = await parseErrorResponse(foreign as unknown as Response);
    expect(masked.message).toContain("[object Response]");
    expect(masked.message).not.toContain("HTTP 403");

    const served = await withLocalResponse(
      body,
      403,
      {
        "content-type": "application/json",
        "www-authenticate": 'Bearer error="invalid_token"',
      },
      async (response) => {
        expect(response instanceof Response).toBe(true);
        expect(response.status).toBe(403);
        expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
        return parseErrorResponse(response);
      },
    );
    expect(served.message).toBe("Dynamic client registration is not supported");
    expect(served.message).not.toContain("[object Response]");

    const fallback = await withLocalResponse(
      "missing bearer token",
      401,
      { "content-type": "text/plain" },
      (response) => parseErrorResponse(response),
    );
    expect(fallback.message).toContain("HTTP 401");
    expect(fallback.message).toContain("missing bearer token");
    expect(fallback.message).not.toContain("[object Response]");
  });
});

describe.each([
  ["Node fetch", globalThis.fetch],
  ["package fetch", dispatcherFetch],
] as const)("%s response handling", (_name, fetch) => {
  it("decodes gzip and reports a damaged gzip body as a read error", async () => {
    const body = gzipSync("compressed response");
    const damaged = Buffer.from(body);
    const checksum = damaged.length - 8;
    damaged[checksum] = damaged.readUInt8(checksum) ^ 1;
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(request.url === "/damaged" ? damaged : body);
    });
    await withServer(server, async (url) => {
      const response = await fetch(`${url}/damaged`);
      await expect(response.text()).rejects.toBeInstanceOf(Error);
      await expect((await fetch(url)).text()).resolves.toBe("compressed response");
    });
  });

  it.each(["client cancellation", "peer disconnect"])(
    "reports %s during a response body and leaves the service reachable",
    async (interruption) => {
      let disconnectPeer: (() => void) | undefined;
      const server = createServer((request, response) => {
        if (request.url === "/stream") {
          disconnectPeer = () => response.destroy();
          response.writeHead(200, { "content-type": "text/plain" });
          response.write("partial response");
          return;
        }
        response.end("still available");
      });
      await withServer(server, async (url) => {
        const controller = new AbortController();
        const response = await fetch(`${url}/stream`, { signal: controller.signal });
        const body = response.text();
        if (interruption === "client cancellation") {
          controller.abort();
          await expect(body).rejects.toMatchObject({ name: "AbortError" });
        } else {
          if (!disconnectPeer) throw new Error("Fixture did not start a response");
          disconnectPeer();
          await expect(body).rejects.toBeInstanceOf(Error);
        }
        await expect((await fetch(url)).text()).resolves.toBe("still available");
      });
    },
  );
});

async function withLocalResponse<T>(
  body: string,
  status: number,
  headers: Record<string, string>,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const server = createServer((_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  });
  return withServer(server, async (url) => read(await dispatcherFetch(url)));
}

async function withServer<T>(
  server: ReturnType<typeof createServer>,
  run: (url: string) => Promise<T>,
): Promise<T> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function boundaryOf(contentType: string | undefined): string {
  const match = /boundary="?([^";]+)"?/i.exec(contentType ?? "");
  const boundary = match?.[1];
  if (!boundary) throw new Error("multipart Content-Type is missing a boundary");
  return boundary;
}

async function postThroughPackageFetch(
  send: (url: string, dispatcher: Agent) => Promise<Response>,
): Promise<{ status: number; contentType: string | undefined; body: Buffer; lookups: number }> {
  const chunks: Buffer[] = [];
  let contentType: string | undefined;
  const server = createServer((request, response) => {
    contentType = request.headers["content-type"];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === "string")
    throw new Error("Missing test server address");
  let lookups = 0;
  const dispatcher = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        lookups += 1;
        const all =
          typeof options === "object" &&
          options != null &&
          "all" in options &&
          options.all === true;
        if (all) {
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
          return;
        }
        callback(null, "127.0.0.1", 4);
      },
    },
  });
  try {
    const response = await send(`http://upload.example.test:${address.port}/upload`, dispatcher);
    return { status: response.status, contentType, body: Buffer.concat(chunks), lookups };
  } finally {
    await dispatcher.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
