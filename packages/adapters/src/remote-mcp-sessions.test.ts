import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider } from "./installed-connectors.js";
import { callRemoteMcpTool, MCP_TIMEOUT_MS, type RemoteMcpOptions } from "./remote-mcp.js";
import {
  type RemoteMcpRunScope,
  RemoteMcpSessionPool,
  remoteMcpToolSession,
} from "./remote-mcp-sessions.js";

const scope = { userId: "user", spaceId: "space", runId: "run" };
const endpoint = "https://connectors.example.test/mcp";
const resolveHostname = async () => [{ address: "203.0.113.10", family: 4 as const }];
const result = { content: [{ type: "text", text: "done" }] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function context(
  overrides: Partial<AdapterContext & RemoteMcpRunScope> = {},
): AdapterContext & RemoteMcpRunScope {
  return {
    ...scope,
    operationId: "operation",
    traceId: "trace",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function server(
  hooks: {
    initialize?: (session: string, signal: AbortSignal | null | undefined) => Promise<void>;
    stream?: (signal: AbortSignal | null | undefined) => Response;
    tool?: (name: string, session: string | null, id: number) => Response | Promise<Response>;
    close?: (signal: AbortSignal | null | undefined) => Promise<Response>;
    stateless?: boolean;
  } = {},
) {
  const initialized: string[] = [];
  const tools: Array<{ name: string; session: string | null }> = [];
  const closed: Array<string | null> = [];
  const notifications: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const session = new Headers(init?.headers).get("mcp-session-id");
    if (init?.method === "GET")
      return hooks.stream?.(init.signal) ?? new Response(null, { status: 405 });
    if (init?.method === "DELETE") {
      closed.push(session);
      return hooks.close ? hooks.close(init.signal) : new Response(null, { status: 204 });
    }
    const rpc = JSON.parse(String(init?.body));
    if (rpc.method === "initialize") {
      const next = String(initialized.length + 1);
      initialized.push(next);
      await hooks.initialize?.(next, init?.signal);
      return Response.json(
        {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        },
        { headers: hooks.stateless ? {} : { "mcp-session-id": next } },
      );
    }
    if (rpc.method === "tools/call") {
      tools.push({ name: rpc.params.name, session });
      return hooks.tool ? hooks.tool(rpc.params.name, session, rpc.id) : toolResult(rpc.id);
    }
    notifications.push(rpc.method);
    return new Response(null, { status: 202 });
  };
  return { fetch, initialized, tools, closed, notifications };
}

function toolResult(id: number) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function invoke(
  adapterContext: AdapterContext,
  fetch: typeof globalThis.fetch,
  options: Partial<RemoteMcpOptions> = {},
  {
    name = "write",
    server = "server",
    revision = 1,
  }: { name?: string; server?: string; revision?: string | number } = {},
) {
  return callRemoteMcpTool(
    {
      endpoint,
      resolveHostname,
      fetch,
      signal: adapterContext.signal,
      session: remoteMcpToolSession(adapterContext, server, revision),
      ...options,
    },
    name,
    {},
  );
}

describe("remote MCP tool sessions", () => {
  let pool: RemoteMcpSessionPool;
  const current = async () => {};
  afterEach(async () => {
    await pool?.close();
  });

  it("keeps the Streamable HTTP event stream through setup expiry and releases it when the Run ends", async () => {
    pool = new RemoteMcpSessionPool();
    const setupDeadlines: AbortController[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      if (ms !== MCP_TIMEOUT_MS) return realTimeout(ms);
      const deadline = new AbortController();
      setupDeadlines.push(deadline);
      return AbortSignal.any([deadline.signal, realTimeout(2_500)]);
    });
    const streamSignals: AbortSignal[] = [];
    const fake = server({
      stream(signal) {
        if (signal) streamSignals.push(signal);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const bound = pool.bind(context(), current);
      await expect(invoke(bound.context, fake.fetch)).resolves.toMatchObject({
        ...result,
        isError: false,
      });
      await vi.waitFor(() => expect(streamSignals).toHaveLength(1));
      const [streamSignal] = streamSignals;
      expect(streamSignal?.aborted).toBe(false);
      expect(setupDeadlines.length).toBeGreaterThanOrEqual(2);
      for (const deadline of setupDeadlines) deadline.abort(new Error("Initial deadline passed"));
      expect(streamSignal?.aborted).toBe(false);
      await expect(invoke(bound.context, fake.fetch, {}, { name: "read" })).resolves.toMatchObject({
        ...result,
        isError: false,
      });
      expect(streamSignals).toHaveLength(1);
      expect(streamSignal?.aborted).toBe(false);
      expect(fake.initialized).toEqual(["1"]);
      expect(fake.tools.map(({ session }) => session)).toEqual(["1", "1"]);
      pool.endRun(scope);
      await vi.waitFor(() => {
        expect(streamSignal?.aborted).toBe(true);
        expect(fake.closed).toEqual(["1"]);
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it("rechecks the current approval after DNS on a reused MCP session", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const bound = pool.bind(context(), current);
    let revokeOnLookup = false;
    let revoked = false;
    const resolve = async () => {
      if (revokeOnLookup) revoked = true;
      return resolveHostname();
    };
    await invoke(bound.context, fake.fetch, { resolveHostname: resolve }, { name: "read" });
    revokeOnLookup = true;
    await expect(
      invoke(bound.context, fake.fetch, {
        resolveHostname: resolve,
        beforeDispatch: async () => {
          if (revoked) throw new Error("Approval revoked");
        },
      }),
    ).rejects.toThrow(/Approval revoked/);
    expect(fake.tools.map((call) => call.name)).toEqual(["read"]);
  });

  it("shares an in-flight initialization without sharing callers' cancellation", async () => {
    pool = new RemoteMcpSessionPool();
    const initializing = deferred();
    const finish = deferred();
    const fake = server({
      initialize: async () => {
        initializing.resolve();
        await finish.promise;
      },
    });
    const abort = new AbortController();
    const bound = pool.bind(context(), current);
    const cancelled = invoke({ ...bound.context, signal: abort.signal }, fake.fetch);
    const cancelledCheck = expect(cancelled).rejects.toThrow(/cancelled first/);
    await initializing.promise;
    const survives = invoke(bound.context, fake.fetch);
    abort.abort(new Error("cancelled first"));
    await cancelledCheck;
    finish.resolve();
    await expect(survives).resolves.toMatchObject(result);
    expect(fake.initialized).toEqual(["1"]);
    expect(fake.tools).toEqual([{ name: "write", session: "1" }]);
  });

  it("retains a paused Run's session and closes it on termination", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const initial = pool.bind(context(), current);
    await invoke(initial.context, fake.fetch);
    initial.release();
    await expect(invoke(initial.context, fake.fetch)).rejects.toThrow(/Run has ended/);
    const resumed = pool.bind(context(), current);
    await invoke(resumed.context, fake.fetch);
    expect(fake.initialized).toEqual(["1"]);
    pool.endRun(scope);
    await expect(invoke(resumed.context, fake.fetch)).rejects.toThrow(/Run has ended/);
    await pool.close();
    expect(fake.closed).toEqual(["1"]);
    expect(fake.notifications).toEqual(["notifications/initialized"]);
  });

  it("opens a fresh session when a resumed Run replaces a still-initializing binding", async () => {
    pool = new RemoteMcpSessionPool();
    const started = deferred();
    const finish = deferred();
    const fake = server({
      initialize: async (id) => {
        if (id !== "1") return;
        started.resolve();
        await finish.promise;
      },
    });
    const old = pool.bind(context(), current);
    const cancelled = expect(invoke(old.context, fake.fetch)).rejects.toThrow(/Run has ended/);
    await started.promise;
    old.release();
    const resumed = pool.bind(context(), current);
    await expect(invoke(resumed.context, fake.fetch)).resolves.toMatchObject(result);
    finish.resolve();
    await cancelled;
    expect(fake.initialized).toEqual(["1", "2"]);
    expect(fake.tools).toEqual([{ name: "write", session: "2" }]);
  });

  it("does not let a superseded attempt retire the current attempt's initialization", async () => {
    pool = new RemoteMcpSessionPool();
    const started = deferred();
    const finish = deferred();
    const fake = server({
      initialize: async () => {
        started.resolve();
        await finish.promise;
      },
    });
    const stale = pool.bind(context(), async () => {
      throw new Error("lease lost");
    });
    const valid = pool.bind(context(), current);
    const pending = invoke(valid.context, fake.fetch);
    await started.promise;
    await expect(invoke(stale.context, fake.fetch)).rejects.toThrow(/lease lost/);
    finish.resolve();
    await expect(pending).resolves.toMatchObject(result);
    expect(fake.initialized).toEqual(["1"]);
  });

  it.each([
    ["user", { userId: "other" }],
    ["space", { spaceId: "other" }],
    ["run", { runId: "other" }],
  ] as const)("isolates the %s in the Run scope", async (_label, overrides) => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const first = pool.bind(context(), current);
    const second = pool.bind(context(overrides), current);
    await invoke(first.context, fake.fetch);
    await invoke(second.context, fake.fetch);
    pool.endRun(scope);
    await invoke(second.context, fake.fetch);
    expect(fake.initialized).toEqual(["1", "2"]);
    expect(fake.tools.map(({ session }) => session)).toEqual(["1", "2", "2"]);
    expect(() => remoteMcpToolSession({ ...first.context, ...overrides }, "server", 1)).toThrow(
      /scope changed/,
    );
  });

  it("separates server, endpoint, private policy, revision and credentials", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const { context: bound } = pool.bind(context(), current);
    const headers = { authorization: "Bearer fixture-a" };
    await invoke(bound, fake.fetch, { headers });
    await invoke(bound, fake.fetch, { headers: { Authorization: "Bearer fixture-a" } });
    await invoke(bound, fake.fetch, { headers }, { server: "other" });
    await invoke(bound, fake.fetch, { headers }, { revision: 2 });
    await invoke(
      bound,
      fake.fetch,
      { headers: { authorization: "Bearer fixture-b" } },
      { revision: 2 },
    );
    await invoke(bound, fake.fetch, { headers, allowPrivateEndpoint: true }, { revision: 2 });
    await invoke(
      bound,
      fake.fetch,
      { headers, endpoint: "https://other.example.test/mcp", allowPrivateEndpoint: true },
      { revision: 2 },
    );
    await pool.close();
    expect(fake.tools.map(({ session }) => session)).toEqual(["1", "1", "2", "3", "4", "5", "6"]);
    expect(fake.closed.sort()).toEqual(fake.initialized);
  });

  it.each([
    [404, ""],
    [404, "unknown session"],
    [
      404,
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Session not found" },
      }),
    ],
    [
      400,
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Bad Request: Server not initialized" },
      }),
    ],
  ] as const)(
    "reconnects after a transport HTTP %s rejection of an assigned session",
    async (status, body) => {
      pool = new RemoteMcpSessionPool();
      const fake = server({
        tool: (_name, session, id) =>
          session === "1" ? new Response(body, { status }) : toolResult(id),
      });
      const { context: bound } = pool.bind(context(), current);
      await expect(invoke(bound, fake.fetch)).resolves.toMatchObject(result);
      expect(fake.tools.map(({ session }) => session)).toEqual(["1", "2"]);
    },
  );

  it("attempts at most one reconnect", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server({ tool: () => new Response("unknown session", { status: 404 }) });
    await expect(invoke(pool.bind(context(), current).context, fake.fetch)).rejects.toMatchObject({
      code: 404,
    });
    expect(fake.tools.map(({ session }) => session)).toEqual(["1", "2"]);
  });

  it.each([
    [
      "a tool request ID",
      (id: number) =>
        Response.json(
          { jsonrpc: "2.0", id, error: { code: -32000, message: "tool result unavailable" } },
          { status: 404 },
        ),
    ],
    [
      "an unreadable body",
      (id: number) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`{"jsonrpc":"2.0","id":${id},"result":`));
              controller.error(new Error("response interrupted"));
            },
          }),
          { status: 404 },
        ),
    ],
    [
      "an SSE tool reply",
      (id: number) =>
        new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
          status: 404,
          headers: { "content-type": "text/event-stream" },
        }),
    ],
    [
      "an unrecognized body",
      (_id: number) => new Response("Tool result unavailable", { status: 404 }),
    ],
  ] as const)(
    "retires an ambiguous HTTP 404 with %s without replaying it",
    async (_label, reply) => {
      pool = new RemoteMcpSessionPool();
      const fake = server({
        tool: (name, _session, id) => (name === "ambiguous" ? reply(id) : toolResult(id)),
      });
      const { context: bound } = pool.bind(context(), current);
      await expect(invoke(bound, fake.fetch, {}, { name: "ambiguous" })).rejects.toMatchObject({
        code: 404,
      });
      await expect(invoke(bound, fake.fetch, {}, { name: "next" })).resolves.toMatchObject(result);
      expect(fake.tools).toEqual([
        { name: "ambiguous", session: "1" },
        { name: "next", session: "2" },
      ]);
    },
  );

  it.each([
    ["stateless 404", true, (_id: number) => new Response("missing", { status: 404 })],
    ["unrelated 400", false, (_id: number) => new Response("Invalid arguments", { status: 400 })],
    [
      "HTTP 400 with a tool request ID",
      false,
      (id: number) =>
        Response.json(
          {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "Bad Request: Server not initialized" },
          },
          { status: 400 },
        ),
    ],
    [
      "JSON-RPC -32000",
      false,
      (id: number) =>
        Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Bad Request: Server not initialized" },
        }),
    ],
    [
      "ambiguous network failure",
      false,
      (_id: number) => {
        throw new TypeError("socket closed");
      },
    ],
  ] as const)("does not replay %s", async (_label, stateless, response) => {
    pool = new RemoteMcpSessionPool();
    const fake = server({ stateless, tool: (_name, _session, id) => response(id) });
    await expect(invoke(pool.bind(context(), current).context, fake.fetch)).rejects.toThrow();
    expect(fake.tools).toHaveLength(1);
    expect(fake.initialized).toHaveLength(1);
  });

  it("rechecks the Run lease before reconnecting", async () => {
    pool = new RemoteMcpSessionPool();
    let currentLease = true;
    const fake = server({
      tool: () => {
        currentLease = false;
        return new Response("unknown session", { status: 404 });
      },
    });
    const { context: bound } = pool.bind(context(), async () => {
      if (!currentLease) throw new Error("lease ended");
    });
    await expect(invoke(bound, fake.fetch)).rejects.toThrow(/lease ended/);
    expect(fake.initialized).toEqual(["1"]);
    expect(fake.tools).toHaveLength(1);
  });

  it("keeps installed MCP routes compatible and declines replay across an install revision", async () => {
    pool = new RemoteMcpSessionPool();
    let revision = 1;
    const fake = server({
      tool: (name, _session, id) => {
        if (name === "rejected") {
          revision++;
          return new Response("unknown session", { status: 404 });
        }
        return toolResult(id);
      },
    });
    const connector = new InstalledConnectorProvider(
      {
        capabilityInstall: {
          findFirst: async () => ({
            id: "install",
            name: "Fixture MCP",
            kind: "mcp",
            source: endpoint,
            secretId: null,
            revision,
            config: { preset: "custom", auth: { type: "none" } },
          }),
        },
      } as never,
      {} as never,
      { resolveHostname, fetch: fake.fetch },
    );
    const { context: bound } = pool.bind(context(), current);
    const execute = async (tool: string) => {
      const events: ConnectorEvent[] = [];
      for await (const event of connector.execute(
        {
          tool,
          args: {},
          executionId: tool,
          route: { connectorId: "installed", resourceId: "install", toolName: tool },
        },
        bound,
      )) {
        events.push(event);
      }
      return events;
    };
    await expect(execute("first")).resolves.toMatchObject([{ type: "result", data: result }]);
    await expect(execute("rejected")).resolves.toEqual([
      {
        type: "error",
        message: "Installed connector authorization changed",
      },
    ]);
    await expect(execute("next")).resolves.toMatchObject([{ type: "result", data: result }]);
    expect(fake.tools).toEqual([
      { name: "first", session: "1" },
      { name: "rejected", session: "1" },
      { name: "next", session: "2" },
    ]);
  });

  it("checks private endpoint authorization after waiting on the Run lease", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const leaseStarted = deferred();
    const leaseChecked = deferred();
    let holdLease = false;
    let ownerUserId = scope.userId;
    const connector = new InstalledConnectorProvider(
      {
        capabilityInstall: {
          findFirst: async () => ({
            id: "install",
            name: "Private MCP",
            kind: "mcp",
            source: "http://127.0.0.1:4321/mcp",
            secretId: null,
            revision: 1,
            config: { preset: "custom", auth: { type: "none" } },
          }),
        },
        deploymentSettings: { findUnique: async () => ({ ownerUserId }) },
      } as never,
      {} as never,
      { resolveHostname, fetch: fake.fetch },
    );
    const { context: bound } = pool.bind(context(), async () => {
      if (holdLease) {
        leaseStarted.resolve();
        await leaseChecked.promise;
      }
    });
    const execute = (tool: string) =>
      connector
        .execute(
          {
            tool,
            args: {},
            executionId: tool,
            route: { connectorId: "installed", resourceId: "install", toolName: tool },
          },
          bound,
        )
        [Symbol.asyncIterator]()
        .next();

    await expect(execute("warm")).resolves.toMatchObject({ value: { type: "result" } });
    holdLease = true;
    const rejected = execute("revoked");
    await leaseStarted.promise;
    ownerUserId = "new-owner";
    leaseChecked.resolve();
    await expect(rejected).resolves.toMatchObject({
      value: { type: "error", message: "Installed connector authorization changed" },
    });
    expect(fake.tools).toEqual([{ name: "warm", session: "1" }]);
  });

  it("rechecks the Run lease if connector authorization had to wait", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server();
    const authorizationStarted = deferred();
    const finishAuthorization = deferred();
    let leaseActive = true;
    const { context: bound } = pool.bind(context(), async () => {
      if (!leaseActive) throw new Error("lease ended");
    });
    await invoke(bound, fake.fetch);
    const session = remoteMcpToolSession(bound, "server", 1, {
      verify: async () => {
        authorizationStarted.resolve();
        await finishAuthorization.promise;
      },
    });
    const rejected = expect(invoke(bound, fake.fetch, { session })).rejects.toThrow(/lease ended/);
    await authorizationStarted.promise;
    leaseActive = false;
    finishAuthorization.resolve();
    await rejected;
    expect(fake.tools).toHaveLength(1);
  });

  it("checks authorization after the guarded socket DNS lookup with the default HTTP transport", async () => {
    pool = new RemoteMcpSessionPool();
    const fake = server({
      tool: (name, _session, id) =>
        name === "stream"
          ? new Response(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`,
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          : toolResult(id),
    });
    const toolSockets = new Set<Socket>();
    const controlSockets = new Set<Socket>();
    const lookingUpSocket = deferred();
    const finishLookup = deferred();
    const origin = createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(chunk);
      const payload = Buffer.concat(body).toString();
      if (request.method === "POST") {
        const { method } = JSON.parse(payload);
        if (method === "tools/call") toolSockets.add(request.socket);
        if (method === "notifications/initialized") controlSockets.add(request.socket);
      }
      const reply = await fake.fetch("http://localhost/mcp", {
        method: request.method,
        headers: Object.entries(request.headers).map(
          ([key, value]) => [key, String(value)] as [string, string],
        ),
        body: payload,
      });
      for (const [key, value] of reply.headers) response.setHeader(key, value);
      response.writeHead(reply.status === 202 ? 200 : reply.status);
      response.end(Buffer.from(await reply.arrayBuffer()));
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    let authorized = true;
    let holdSocketLookup = false;
    let lookups = 0;
    const { context: bound } = pool.bind(context(), current);
    const options: RemoteMcpOptions = {
      endpoint: `http://fixture.internal:${(origin.address() as AddressInfo).port}/mcp`,
      allowPrivateEndpoint: true,
      resolveHostname: async () => {
        if (holdSocketLookup && ++lookups === 2) {
          lookingUpSocket.resolve();
          await finishLookup.promise;
        }
        return [{ address: "127.0.0.1", family: 4 }];
      },
      session: remoteMcpToolSession(bound, "server", 1, {
        verify: async () => {
          if (!authorized) throw new Error("authorization changed");
        },
      }),
    };
    try {
      await expect(callRemoteMcpTool(options, "warm", {})).resolves.toMatchObject(result);
      await expect(callRemoteMcpTool(options, "stream", {})).resolves.toMatchObject(result);
      expect(toolSockets.size).toBe(2);
      expect(controlSockets.size).toBe(1);
      expect([...toolSockets].some((socket) => controlSockets.has(socket))).toBe(false);
      holdSocketLookup = true;
      const pending = callRemoteMcpTool(options, "revoked", {});
      const reachedSocketLookup = await Promise.race([
        lookingUpSocket.promise.then(() => true),
        pending.then(
          () => false,
          () => false,
        ),
      ]);
      expect(reachedSocketLookup).toBe(true);
      authorized = false;
      finishLookup.resolve();
      await expect(pending).rejects.toThrow("authorization changed");
      expect(fake.tools).toEqual([
        { name: "warm", session: "1" },
        { name: "stream", session: "1" },
      ]);
    } finally {
      await pool.close();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });

  it("cancels pending initialization when the Run ends", async () => {
    pool = new RemoteMcpSessionPool();
    let initializing: AbortSignal | undefined;
    const fake = server({
      initialize: (_session, signal) => {
        initializing = signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const { context: bound } = pool.bind(context(), current);
    const rejected = expect(invoke(bound, fake.fetch)).rejects.toThrow();
    await vi.waitFor(() => expect(initializing?.aborted).toBe(false));
    pool.endRun(scope);
    await rejected;
    await vi.waitFor(() => expect(initializing?.aborted).toBe(true));
    expect(fake.tools).toEqual([]);
  });

  it("does not close a retired session while its sibling call is still running", async () => {
    pool = new RemoteMcpSessionPool();
    const started = deferred();
    const finish = deferred();
    const fake = server({
      tool: async (name, _session, id) => {
        if (name === "slow") {
          started.resolve();
          await finish.promise;
        }
        return toolResult(id);
      },
    });
    const { context: bound } = pool.bind(context(), current);
    const slow = invoke(bound, fake.fetch, {}, { name: "slow" });
    await started.promise;
    await invoke(bound, fake.fetch, {}, { revision: 2 });
    expect(fake.closed).toEqual([]);
    finish.resolve();
    await expect(slow).resolves.toMatchObject(result);
    await pool.close();
    expect(fake.closed.sort()).toEqual(["1", "2"]);
  });

  it("does not send a cancelled tool after its DNS lookup finishes with a sibling still running", async () => {
    pool = new RemoteMcpSessionPool();
    const inFlight = deferred();
    const finish = deferred();
    const resolving = deferred();
    const finishDns = deferred();
    let holdDns = false;
    const resolve = async () => {
      if (holdDns) {
        holdDns = false;
        resolving.resolve();
        await finishDns.promise;
      }
      return resolveHostname();
    };
    const fake = server({
      tool: async (_name, _session, id) => {
        inFlight.resolve();
        await finish.promise;
        return toolResult(id);
      },
    });
    const abort = new AbortController();
    const { context: bound } = pool.bind(context(), current);
    const first = invoke(bound, fake.fetch, { resolveHostname: resolve }, { name: "sibling" });
    await inFlight.promise;
    holdDns = true;
    const rejected = expect(invoke({ ...bound, signal: abort.signal }, fake.fetch)).rejects.toThrow(
      /stopped/,
    );
    await resolving.promise;
    abort.abort(new Error("stopped"));
    finishDns.resolve();
    await rejected;
    finish.resolve();
    await expect(first).resolves.toMatchObject(result);
    await pool.close();
    expect(fake.tools).toEqual([{ name: "sibling", session: "1" }]);
  });

  it.each(["endRun", "reaper", "release"] as const)(
    "cancels a queued tool POST when %s closes its binding",
    async (close) => {
      let runActive = true;
      pool = new RemoteMcpSessionPool({ activeRuns: async (scopes) => (runActive ? scopes : []) });
      const resolving = deferred();
      const finishDns = deferred();
      let holdDns = false;
      const resolve = async () => {
        if (holdDns) {
          holdDns = false;
          resolving.resolve();
          await finishDns.promise;
        }
        return resolveHostname();
      };
      const fake = server();
      const bound = pool.bind(context(), current);
      await invoke(bound.context, fake.fetch, { resolveHostname: resolve }, { name: "warm" });
      holdDns = true;
      const rejected = expect(invoke(bound.context, fake.fetch)).rejects.toThrow(/Run has ended/);
      await resolving.promise;
      if (close === "endRun") pool.endRun(scope);
      else if (close === "release") bound.release();
      else {
        runActive = false;
        await pool.reap();
      }
      finishDns.resolve();
      await rejected;
      await pool.close();
      expect(fake.tools).toEqual([{ name: "warm", session: "1" }]);
    },
  );

  it("reaps idle and externally ended Runs and bounds a stalled DELETE", async () => {
    let time = 0;
    let deleteAborted = false;
    pool = new RemoteMcpSessionPool({
      now: () => time,
      activeRuns: async (scopes) => scopes.filter(({ runId }) => runId !== "ended"),
      idleMs: 10,
      closeTimeoutMs: 25,
    });
    const fake = server({
      close: (signal) =>
        new Promise(() => {
          signal?.addEventListener(
            "abort",
            () => {
              deleteAborted = true;
            },
            { once: true },
          );
        }),
    });
    const idle = pool.bind(context(), current);
    const ended = pool.bind(context({ runId: "ended" }), current);
    await invoke(idle.context, fake.fetch);
    await invoke(ended.context, fake.fetch);
    await pool.reap();
    await expect(invoke(ended.context, fake.fetch)).rejects.toThrow(/Run has ended/);
    time = 10;
    await pool.reap();
    await invoke(idle.context, fake.fetch);
    await pool.close();
    expect(fake.closed.sort()).toEqual(["1", "2", "3"]);
    expect(deleteAborted).toBe(true);
  });
});
