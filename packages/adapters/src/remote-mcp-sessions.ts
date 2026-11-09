import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { combineSignals } from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import type { RemoteMcpOptions } from "./remote-mcp.js";
import {
  assertSafeRemoteUrl,
  createRemoteMcpClient,
  createSafeRemoteFetch,
  MCP_TIMEOUT_MS,
} from "./remote-mcp.js";
import { withAbort } from "./web-ssrf.js";

const CLOSE_TIMEOUT_MS = 5_000;
const IDLE_MS = 10 * 60_000;

export type RemoteMcpRunScope = { spaceId: string; userId: string; runId: string };
type UseClient<T> = (client: Client, signal: AbortSignal) => Promise<T>;
type VerifyDispatch = (signal: AbortSignal) => Promise<void>;

export interface RemoteMcpToolSession {
  use<T>(options: RemoteMcpOptions, call: UseClient<T>): Promise<T>;
}

const runBinding = Symbol("remote MCP Run binding");
type Binding = {
  scope: RemoteMcpRunScope;
  assertCurrent: () => Promise<void>;
  assertAccountCurrent?: (call: ConnectorCall) => Promise<void>;
  pool: RemoteMcpSessionPool;
  stop: AbortController;
};
type BoundContext = AdapterContext & { [runBinding]?: Binding };
type RunSessions = {
  scope: RemoteMcpRunScope;
  servers: Map<string, Entry>;
};
type Session = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
  disconnected: boolean;
};
type Entry = {
  group: RunSessions;
  server: string;
  identity: string;
  lifetime: AbortController;
  initializingBinding: AbortSignal;
  connecting: Promise<Session>;
  session?: Session;
  closing?: Promise<void>;
  lastUsed: number;
  inFlight: number;
  retired: boolean;
};

function scopeKey(scope: RemoteMcpRunScope) {
  return JSON.stringify([scope.spaceId, scope.userId, scope.runId]);
}

/** Only the executor attaches a binding after acquiring the real Run lease. */
export function remoteMcpToolSession(
  context: AdapterContext,
  server: string,
  revision: string | number,
  authorization?: { account: ConnectorCall } | { verify: () => Promise<void> },
): RemoteMcpToolSession | undefined {
  const binding = (context as BoundContext)[runBinding];
  if (!binding) return undefined;
  if (
    context.runId !== binding.scope.runId ||
    context.userId !== binding.scope.userId ||
    context.spaceId !== binding.scope.spaceId
  )
    throw new Error("Remote MCP Run scope changed");
  const verifyAuthorization =
    authorization &&
    ("verify" in authorization
      ? authorization.verify
      : () => {
          if (!binding.assertAccountCurrent)
            throw new Error("Remote MCP account cannot be rechecked");
          return binding.assertAccountCurrent(authorization.account);
        });
  return {
    use: (options, call) =>
      binding.pool.use(binding, server, revision, options, call, verifyAuthorization),
  };
}

/** One pool per executor. A retired client can finish existing sibling calls. */
export class RemoteMcpSessionPool {
  private readonly bindings = new Map<string, Set<Binding>>();
  private readonly runs = new Map<string, RunSessions>();
  private readonly entries = new Set<Entry>();
  private readonly request = new AsyncLocalStorage<{
    signal: AbortSignal;
    verify: VerifyDispatch;
  }>();
  private timer?: ReturnType<typeof setInterval>;
  private reaping?: Promise<void>;
  private closing?: Promise<void>;

  constructor(
    private readonly options: {
      activeRuns?: (scopes: RemoteMcpRunScope[]) => Promise<RemoteMcpRunScope[]>;
      now?: () => number;
      idleMs?: number;
      closeTimeoutMs?: number;
    } = {},
  ) {}

  bind<T extends AdapterContext & RemoteMcpRunScope>(
    context: T,
    assertCurrent: () => Promise<void>,
    assertAccountCurrent?: (call: ConnectorCall) => Promise<void>,
  ): { context: T; release: () => void } {
    const { userId, spaceId, runId } = context;
    const binding: Binding = {
      scope: { userId, spaceId, runId },
      assertCurrent,
      assertAccountCurrent,
      pool: this,
      stop: new AbortController(),
    };
    const key = scopeKey(binding.scope);
    const current = this.bindings.get(key) ?? new Set<Binding>();
    if (this.closing) {
      stopBinding(binding);
    } else {
      current.add(binding);
      this.bindings.set(key, current);
    }
    return {
      context: { ...context, [runBinding]: binding },
      release: () => {
        stopBinding(binding);
        current.delete(binding);
        if (current.size === 0 && this.bindings.get(key) === current) this.bindings.delete(key);
      },
    };
  }

  async use<T>(
    binding: Binding,
    server: string,
    revision: string | number,
    options: RemoteMcpOptions,
    call: UseClient<T>,
    verifyAuthorization?: () => Promise<void>,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(MCP_TIMEOUT_MS);
    const signal = combineSignals(options.signal, binding.stop.signal, deadline);
    const verify = async (requestSignal: AbortSignal) => {
      requestSignal.throwIfAborted();
      binding.stop.signal.throwIfAborted();
      try {
        await withAbort(binding.assertCurrent(), requestSignal);
        binding.stop.signal.throwIfAborted();
        requestSignal.throwIfAborted();
        if (verifyAuthorization) {
          await withAbort(verifyAuthorization(), requestSignal);
          binding.stop.signal.throwIfAborted();
          requestSignal.throwIfAborted();
          await withAbort(binding.assertCurrent(), requestSignal);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Remote MCP authorization changed";
        throw new RemoteMcpAuthorizationError(message, { cause: error });
      }
      binding.stop.signal.throwIfAborted();
      requestSignal.throwIfAborted();
    };
    const identity = JSON.stringify([
      revision,
      options.endpoint,
      options.allowPrivateEndpoint === true,
      credentialDigest(JSON.stringify([...new Headers(options.headers).entries()])),
    ]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const entry = await this.acquire(binding, server, identity, options, signal, verify);
      entry.inFlight++;
      let dispatched = false;
      try {
        const session = await withAbort(entry.connecting, signal);
        signal.throwIfAborted();
        if (entry.retired) throw new Error("Remote MCP session changed");
        const sessionId = session.transport.sessionId;
        dispatched = true;
        try {
          return await withRequestSignal(signal, (requestSignal) =>
            this.request.run({ signal: requestSignal, verify }, () =>
              withAbort(call(session.client, requestSignal), requestSignal),
            ),
          );
        } catch (error) {
          const rejection = sessionId && rejectedSession(error);
          if (rejection) {
            const wasCurrent = !entry.retired;
            this.retire(entry);
            if (rejection === "gone" && attempt === 0 && wasCurrent && !signal.aborted) continue;
          }
          if (
            session.disconnected ||
            error instanceof RemoteMcpAuthorizationError ||
            (!signal.aborted && error instanceof RemoteMcpNetworkError)
          )
            this.retire(entry);
          throw error;
        }
      } finally {
        entry.inFlight--;
        entry.lastUsed = this.now();
        if (dispatched && deadline.aborted && signal.reason === deadline.reason) this.retire(entry);
        if (entry.retired && entry.inFlight === 0) void this.closeEntry(entry);
      }
    }
  }

  endRun(scope: RemoteMcpRunScope): void {
    const key = scopeKey(scope);
    for (const binding of this.bindings.get(key) ?? []) stopBinding(binding);
    this.bindings.delete(key);
    const group = this.runs.get(key);
    if (!group) return;
    for (const entry of [...group.servers.values()]) this.retire(entry);
  }

  async reap(): Promise<void> {
    if (this.reaping) return this.reaping;
    this.reaping = this.reapOnce().finally(() => {
      this.reaping = undefined;
    });
    return this.reaping;
  }

  private async reapOnce() {
    const now = this.now();
    for (const entry of this.entries) {
      if (
        !entry.retired &&
        entry.inFlight === 0 &&
        now - entry.lastUsed >= (this.options.idleMs ?? IDLE_MS)
      )
        this.retire(entry);
    }
    const groups = [...this.runs.values()];
    if (!this.options.activeRuns || groups.length === 0) return;
    const active = new Set(
      (await this.options.activeRuns(groups.map((group) => group.scope))).map(scopeKey),
    );
    for (const group of groups) {
      const key = scopeKey(group.scope);
      if (!active.has(key) && this.runs.get(key) === group) this.endRun(group.scope);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const bindings of this.bindings.values()) {
      for (const binding of bindings) stopBinding(binding);
    }
    this.bindings.clear();
    const entries = [...this.entries];
    this.closing = Promise.allSettled(
      entries.map((entry) => {
        this.retire(entry);
        return this.closeEntry(entry);
      }),
    ).then(() => undefined);
    return this.closing;
  }

  private async acquire(
    binding: Binding,
    server: string,
    identity: string,
    options: RemoteMcpOptions,
    signal: AbortSignal,
    verify: VerifyDispatch,
  ) {
    const { scope, stop } = binding;
    const key = scopeKey(scope);
    let group = this.runs.get(key);
    let current = group?.servers.get(server);
    const canReuse = (entry: Entry) =>
      entry.identity === identity &&
      (entry.session ? !entry.session.disconnected : entry.initializingBinding === stop.signal);
    if (current && canReuse(current)) return current;
    if (current) {
      // Verify ownership before displacing another binding or authorization generation.
      await verify(signal);
      group = this.runs.get(key);
      current = group?.servers.get(server);
      if (current && canReuse(current)) return current;
    }
    group ??= { scope, servers: new Map() };
    if (current) this.retire(current);
    this.runs.set(key, group);
    const lifetime = new AbortController();
    const entry: Entry = {
      group,
      server,
      identity,
      lifetime,
      initializingBinding: stop.signal,
      lastUsed: this.now(),
      inFlight: 0,
      retired: false,
      connecting: this.connect(options, lifetime.signal, verify).then(
        (session) => {
          entry.session = session;
          return session;
        },
        (error: unknown) => {
          this.retire(entry);
          throw error;
        },
      ),
    };
    group.servers.set(server, entry);
    this.entries.add(entry);
    this.timer ??= setInterval(() => void this.reap().catch(() => undefined), 60_000).unref();
    return entry;
  }

  private retire(entry: Entry) {
    if (entry.retired) return;
    entry.retired = true;
    if (entry.group.servers.get(entry.server) === entry) {
      entry.group.servers.delete(entry.server);
      if (entry.group.servers.size === 0) this.runs.delete(scopeKey(entry.group.scope));
    }
    if (!entry.session) entry.lifetime.abort();
    if (entry.inFlight === 0) void this.closeEntry(entry);
  }

  private closeEntry(entry: Entry): Promise<void> {
    entry.closing ??= entry.connecting
      .then((session) => session.close())
      .catch(() => undefined)
      .finally(() => {
        this.entries.delete(entry);
        if (this.entries.size === 0) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      });
    return entry.closing;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async connect(
    options: RemoteMcpOptions,
    lifetime: AbortSignal,
    verify: VerifyDispatch,
  ): Promise<Session> {
    const setup = combineSignals(lifetime, AbortSignal.timeout(MCP_TIMEOUT_MS));
    const policy = { allowPrivateEndpoint: options.allowPrivateEndpoint };
    const endpoint = await withAbort(
      assertSafeRemoteUrl(options.endpoint, options.resolveHostname, policy),
      setup,
    );
    setup.throwIfAborted();
    const safeFetch = createSafeRemoteFetch(options.fetch, options.resolveHostname, policy);
    let closeSignal: AbortSignal | undefined;
    const { transport, client } = createRemoteMcpClient(
      endpoint,
      options.headers,
      async (input, init) => {
        try {
          // The SDK uses its transport signal for HTTP. Also cancel delayed tool
          // POSTs (such as DNS) with the individual request, without closing siblings.
          const requiresGuard = init?.method === "POST" && guardedMcpRequest(init.body);
          const request = requiresGuard ? this.request.getStore() : undefined;
          if (requiresGuard && !request)
            throw new RemoteMcpAuthorizationError("Remote MCP request has no Run authorization");
          const signal =
            init?.method === "DELETE" ? closeSignal : combineSignals(lifetime, request?.signal);
          return await safeFetch(
            input,
            {
              ...init,
              signal: combineSignals(signal, init?.signal ?? undefined),
            },
            request && (() => request.verify(request.signal)),
          );
        } catch (error) {
          const authorization = findAuthorizationError(error);
          if (authorization) throw authorization;
          throw new RemoteMcpNetworkError("Remote MCP transport failed", { cause: error });
        }
      },
    );
    const session: Session = {
      client,
      transport,
      disconnected: false,
      close: async () => {
        closeSignal = AbortSignal.timeout(this.options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
        await withAbort(transport.terminateSession(), closeSignal).catch(() => undefined);
        await client.close().catch(() => undefined);
        await safeFetch.close(true).catch(() => undefined);
      },
    };
    const previousOnClose = client.onclose;
    client.onclose = () => {
      session.disconnected = true;
      previousOnClose?.();
    };
    try {
      await withRequestSignal(setup, (signal) =>
        this.request.run({ signal, verify }, () =>
          withAbort(client.connect(transport, { signal, timeout: MCP_TIMEOUT_MS }), signal),
        ),
      );
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

class RemoteMcpNetworkError extends Error {}
class RemoteMcpAuthorizationError extends Error {}

/** The HTTP transport wraps connection-time authorization failures in causes. */
function findAuthorizationError(error: unknown): RemoteMcpAuthorizationError | undefined {
  let cause = error;
  for (let depth = 0; cause instanceof Error && depth < 6; depth++) {
    if (cause instanceof RemoteMcpAuthorizationError) return cause;
    cause = cause.cause;
  }
}

/** Leave protocol responses and cancellation notifications outside the tool deadline. */
function guardedMcpRequest(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  // The transport serializes the request before handing it to the fetch wrapper.
  const { method } = JSON.parse(body);
  return method === "initialize" || method === "tools/call";
}

function stopBinding(binding: Binding) {
  binding.stop.abort(new Error("Remote MCP Run has ended"));
}

/** The SDK retains its abort listener after a response. Stop forwarding once it settles. */
async function withRequestSignal<T>(
  source: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  source.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    source.removeEventListener("abort", abort);
  }
}

/** Match a pre-dispatch session rejection before replaying a tool. */
function rejectedSession(error: unknown): "gone" | "ambiguous" | undefined {
  const prefix = "Streamable HTTP error: Error POSTing to endpoint: ";
  if (!(error instanceof StreamableHTTPError) || !error.message.startsWith(prefix)) return;
  if (error.code !== 400 && error.code !== 404) return;

  const body = error.message.slice(prefix.length).trim();
  const notFound = error.code === 404;
  const unresolved = notFound ? "ambiguous" : undefined;
  const confirmsMissingSession = notFound
    ? (message: string) => SESSION_NOT_FOUND_BODIES.has(message.trim().toLowerCase())
    : (message: string) => SESSION_NOT_INITIALIZED.test(message);
  if (confirmsMissingSession(body)) return "gone";
  try {
    const reply = JSON.parse(body);
    if (
      reply?.jsonrpc === "2.0" &&
      reply.id === null &&
      reply.error?.code === (notFound ? -32001 : -32000) &&
      typeof reply.error.message === "string" &&
      confirmsMissingSession(reply.error.message)
    )
      return "gone";
  } catch {
    return unresolved;
  }
  return unresolved;
}

const SESSION_NOT_FOUND_BODIES = new Set([
  "",
  "not found",
  "404 not found",
  "invalid session",
  "session expired",
  "session not found",
  "unknown session",
]);
const SESSION_NOT_INITIALIZED =
  /^Bad Request: (?:Server not initialized|No valid session ID(?: provided| or initialization request)?|Mcp-Session-Id header is required)$/i;
