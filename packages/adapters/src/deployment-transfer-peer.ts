import { lookup } from "node:dns/promises";
import { normalizeDeploymentTransferOrigin } from "@rakazo/contracts";
import { combineSignals } from "./connector-safety.js";
import {
  DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES,
  encodeDeploymentTransferJson,
} from "./deployment-transfer-crypto.js";
import type { ResolveHostname } from "./network-address.js";
import { isCloudMetadataAddress, isPrivateAddress } from "./network-address.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export interface DeploymentTransferPeer {
  identity(origin: string, signal?: AbortSignal): Promise<unknown>;
  challenge(origin: string, locator: string, signal?: AbortSignal): Promise<unknown>;
  propose(origin: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  grant(origin: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  item(origin: string, token: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  status(origin: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  cancel(origin: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Fixed peer endpoints reuse address validation at both inspection and socket lookup. */
export function createDeploymentTransferPeer(
  dependencies: RemoteTransportDependencies = {},
): DeploymentTransferPeer {
  const resolve: ResolveHostname =
    dependencies.resolveHostname ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  const publicResolve: ResolveHostname = async (hostname) => {
    const addresses = await resolve(hostname);
    if (
      addresses.length === 0 ||
      addresses.some(
        (entry) => isPrivateAddress(entry.address) || isCloudMetadataAddress(entry.address),
      )
    )
      throw new Error("Deployment transfer requires a public HTTPS endpoint");
    return addresses;
  };
  // Do not inherit the MCP private-endpoint escape or its MagicDNS address exception.
  const remote = createSafeRemoteFetch(dependencies.fetch, publicResolve);
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;

  async function request(
    origin: string,
    operation: "identity" | "challenge" | "proposal" | "grant" | "item" | "status" | "cancel",
    value: unknown,
    parentSignal?: AbortSignal,
    token?: string,
  ): Promise<unknown> {
    const signal = combineSignals(lifetime.signal, parentSignal, AbortSignal.timeout(20_000));
    try {
      signal?.throwIfAborted();
      const base = normalizeDeploymentTransferOrigin(origin);
      const headers = new Headers({ accept: "application/json" });
      if (token !== undefined) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
        headers.set("authorization", `Bearer ${token}`);
      }
      const body = operation === "identity" ? undefined : encodeDeploymentTransferJson(value);
      if (body !== undefined) headers.set("content-type", "application/json");
      const response = await withAbort(
        remote(`${base}/api/deployment-transfer/v1/${operation}`, {
          method: operation === "identity" ? "GET" : "POST",
          headers,
          body,
          signal,
        }),
        signal,
      );
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error();
      }
      const bytes = await readBodyCapped(response, DEPLOYMENT_TRANSFER_MAX_WIRE_BYTES, signal);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      // Parser/provider errors can contain echoed values. Never propagate their body or cause.
      throw new Error("Deployment transfer peer is unavailable");
    }
  }

  return {
    identity: (origin, signal) => request(origin, "identity", undefined, signal),
    challenge: (origin, locator, signal) => request(origin, "challenge", { locator }, signal),
    propose: (origin, value, signal) => request(origin, "proposal", value, signal),
    grant: (origin, value, signal) => request(origin, "grant", value, signal),
    item: (origin, token, value, signal) => request(origin, "item", value, signal, token),
    status: (origin, value, signal) => request(origin, "status", value, signal),
    cancel: (origin, value, signal) => request(origin, "cancel", value, signal),
    close() {
      closing ??= (async () => {
        lifetime.abort();
        await remote.close();
      })();
      return closing;
    },
  };
}
