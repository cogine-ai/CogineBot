import { lookup } from "node:dns/promises";
import { combineSignals } from "../connector-safety.js";
import type {
  RemoteTransportDependencies,
  RemoteUrlPolicy,
  SafeRemoteFetch,
} from "../remote-mcp.js";
import { createSafeRemoteFetch } from "../remote-mcp.js";

/** Bound the complete native operation, including DNS before fetch is called. */
export function nativeAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Reuse the existing DNS-pinned transport with cancellation scoped to this request. */
export function createNativeFetch(
  network: RemoteTransportDependencies = {},
  policy: RemoteUrlPolicy = {},
  timeoutMs = 30_000,
  protocol?: "google-drive-resumable",
): SafeRemoteFetch {
  const transports = new Map<SafeRemoteFetch, Promise<void> | undefined>();
  const drain = (transport: SafeRemoteFetch): Promise<void> => {
    let closing = transports.get(transport);
    if (!closing) {
      closing = transport.close().catch(() => undefined);
      transports.set(transport, closing);
      void closing.finally(() => transports.delete(transport));
    }
    return closing;
  };
  let closed = false;
  const fetch: SafeRemoteFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (closed) throw new Error("Native connector transport is closed");
      const signal = combineSignals(init?.signal ?? undefined, AbortSignal.timeout(timeoutMs));
      signal.throwIfAborted();
      const resolve =
        network.resolveHostname ??
        ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
      const transport = createSafeRemoteFetch(
        network.fetch,
        (hostname) => nativeAbortable(resolve(hostname), signal),
        policy,
        protocol === "google-drive-resumable"
          ? (url, method, status) =>
              status === 308 &&
              ["POST", "PUT"].includes(method) &&
              url.origin === "https://www.googleapis.com" &&
              /^\/upload\/drive\/v3\/files(?:\/[^/]+)?$/.test(url.pathname)
          : undefined,
      );
      transports.set(transport, undefined);
      try {
        const response = await nativeAbortable(transport(input, { ...init, signal }), signal);
        // close() drains this request without blocking the caller's body reader.
        void drain(transport);
        return response;
      } catch (error) {
        await drain(transport);
        throw error;
      }
    },
    {
      close: async () => {
        closed = true;
        await Promise.all([...transports.keys()].map(drain));
        transports.clear();
      },
    },
  );
  return fetch;
}
