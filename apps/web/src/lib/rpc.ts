import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@rakazo/contracts";
import { LOCAL_SETTINGS_PAGE, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import { desktopBridge } from "./desktop";
import type { SessionGate } from "./session-gate";

const SPACE_STORAGE_KEY = "rakazo:space-id";
let spaceSelectionGeneration = 0;
const spaceSelectionListeners = new Set<() => void>();
const subscriptionListeners = new Set<() => void>();
let rpcSessionOwner: string | null = null;
let rpcSessionGeneration = 0;
let implicitSpace: { id: string; sessionGeneration: number; selectionGeneration: number } | null =
  null;

/** Auth identity changes invalidate in-flight recovery, including A to B to A. */
export function synchronizeRpcSession(
  gate: SessionGate,
  userId?: string,
  sessionId?: string,
): void {
  if (gate === "loading" || gate === "unreachable") return;
  const next =
    gate === "authenticated" && userId ? JSON.stringify([userId, sessionId ?? null]) : null;
  if (next === rpcSessionOwner) return;
  rpcSessionOwner = next;
  rpcSessionGeneration += 1;
  implicitSpace = null;
}

export function currentRpcSessionGeneration(): number {
  return rpcSessionGeneration;
}

export function rememberImplicitRpcSpace(
  id: string,
  sessionGeneration: number,
  selectionGeneration: number,
): void {
  if (
    sessionGeneration !== rpcSessionGeneration ||
    selectionGeneration !== spaceSelectionGeneration ||
    selectedSpaceId() !== null
  )
    return;
  implicitSpace = { id, sessionGeneration, selectionGeneration };
}

export type RpcRecoveryScope = {
  spaceId: string | null;
  sessionGeneration: number;
  selectionGeneration: number;
};

export function captureRpcRecoveryScope(
  spaceId: string | null = selectedSpaceId(),
): RpcRecoveryScope {
  return {
    spaceId,
    sessionGeneration: rpcSessionGeneration,
    selectionGeneration: spaceSelectionGeneration,
  };
}

export function subscribeSelectedSpace(listener: () => void): () => void {
  spaceSelectionListeners.add(listener);
  const storageChanged = (event: StorageEvent) => {
    if (event.key === SPACE_STORAGE_KEY || event.key === null) changedSpaceSelection();
  };
  window.addEventListener("storage", storageChanged);
  return () => {
    spaceSelectionListeners.delete(listener);
    window.removeEventListener("storage", storageChanged);
  };
}

export function subscribeSubscriptionRequired(listener: () => void): () => void {
  subscriptionListeners.add(listener);
  return () => {
    subscriptionListeners.delete(listener);
  };
}

export function noteSubscriptionRequired(scope: RpcRecoveryScope, isCurrent: () => boolean): void {
  const selected = selectedSpaceId();
  const effective =
    selected ??
    (implicitSpace?.sessionGeneration === rpcSessionGeneration &&
    implicitSpace.selectionGeneration === spaceSelectionGeneration
      ? implicitSpace.id
      : null);
  if (
    !isCurrent() ||
    scope.sessionGeneration !== rpcSessionGeneration ||
    scope.selectionGeneration !== currentSpaceSelectionGeneration() ||
    (scope.spaceId !== selected && scope.spaceId !== effective)
  )
    return;
  for (const listener of subscriptionListeners) {
    try {
      listener();
    } catch {
      /* Preserve the original HTTP admission response. */
    }
  }
}

function changedSpaceSelection(): void {
  spaceSelectionGeneration += 1;
  for (const listener of spaceSelectionListeners) {
    try {
      listener();
    } catch {
      /* A UI observer cannot change the selection receipt. */
    }
  }
}

export function currentSpaceSelectionGeneration(): number {
  return spaceSelectionGeneration;
}

type RpcClientContext = {
  spaceId?: string | null;
  isCurrent?: () => boolean;
  ownerGeneration?: number;
};

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function selectSpace(id: string): boolean {
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    changedSpaceSelection();
    return true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      return window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      return false;
    }
  }
}

export function clearSpaceSelection(): void {
  changedSpaceSelection();
  try {
    window.localStorage.removeItem(SPACE_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-rakazo-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-rakazo-space-id", spaceId);
  else headers.delete("x-rakazo-space-id");
  return headers;
}

const link = new RPCLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined"
      ? "http://127.0.0.1:5173/rpc"
      : `${window.location.origin}${window.location.pathname === LOCAL_SETTINGS_PAGE ? LOCAL_SETTINGS_RPC : "/rpc"}`,
  fetch: async (input, init, options) => {
    const assertCurrent = () => {
      if (
        options.context.isCurrent?.() === false ||
        (options.context.ownerGeneration !== undefined &&
          options.context.ownerGeneration !== rpcSessionGeneration)
      )
        throw new DOMException("Settings closed", "AbortError");
    };
    assertCurrent();
    const request = new Request(input, init);
    if (typeof window !== "undefined" && window.location.pathname === LOCAL_SETTINGS_PAGE) {
      const bridge = desktopBridge()?.localSettings;
      if (!bridge) throw new Error("Local settings require the desktop app");
      const body = await request.text();
      assertCurrent();
      const result = await bridge.request(new URL(request.url).pathname, body);
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const scope = {
      ...captureRpcRecoveryScope(spaceId),
      sessionGeneration: options.context.ownerGeneration ?? rpcSessionGeneration,
    };
    const response = await fetch(request, {
      headers: withSpaceHeaders(request.headers, spaceId),
      credentials: "include",
      signal: options.signal,
    });
    if (response.status === 402) {
      noteSubscriptionRequired(
        scope,
        () => options.context.isCurrent?.() !== false && !options.signal?.aborted,
      );
    }
    return response;
  },
});

export type RpcClient = ContractRouterClient<AppContract, RpcClientContext>;
export const rpc: RpcClient = createORPCClient({
  call: (path, input, options) =>
    link.call(path, input, {
      ...options,
      context: {
        ...options.context,
        ownerGeneration: options.context.ownerGeneration ?? rpcSessionGeneration,
      },
    }),
});

/** Capture a request target without changing the selected conversation. */
export function createSpaceRpc(spaceId: string | null, isCurrent?: () => boolean): RpcClient {
  return createORPCClient({
    call: (path, input, options) => {
      if (isCurrent?.() === false) throw new DOMException("Settings closed", "AbortError");
      return link.call(path, input, {
        ...options,
        context: {
          ...options.context,
          ownerGeneration: options.context.ownerGeneration ?? rpcSessionGeneration,
          spaceId: options.context.spaceId === undefined ? spaceId : options.context.spaceId,
          ...(isCurrent
            ? { isCurrent: () => isCurrent() && options.context.isCurrent?.() !== false }
            : {}),
        },
      });
    },
  });
}

const spaceClients = new Map<string, RpcClient>();

export function rpcForSpace(spaceId: string): RpcClient {
  let client = spaceClients.get(spaceId);
  if (!client) {
    client = createSpaceRpc(spaceId);
    spaceClients.set(spaceId, client);
  }
  return client;
}
