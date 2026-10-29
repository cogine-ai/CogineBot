import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@rakazo/contracts";
import { LOCAL_SETTINGS_PAGE, LOCAL_SETTINGS_RPC } from "@rakazo/contracts";
import { desktopBridge } from "./desktop";

const SPACE_STORAGE_KEY = "rakazo:space-id";
let spaceSelectionGeneration = 0;
const spaceSelectionListeners = new Set<() => void>();
const subscriptionListeners = new Set<() => void>();

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

export function noteSubscriptionRequired(
  spaceId: string | null,
  generation: number,
  isCurrent: () => boolean,
): void {
  if (
    !isCurrent() ||
    generation !== currentSpaceSelectionGeneration() ||
    spaceId !== selectedSpaceId()
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

type RpcClientContext = { spaceId?: string | null; isCurrent?: () => boolean };

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
      if (options.context.isCurrent?.() === false)
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
    const selectionGeneration = currentSpaceSelectionGeneration();
    const response = await fetch(request, {
      headers: withSpaceHeaders(request.headers, spaceId),
      credentials: "include",
      signal: options.signal,
    });
    if (response.status === 402) {
      noteSubscriptionRequired(
        spaceId,
        selectionGeneration,
        () => options.context.isCurrent?.() !== false && !options.signal?.aborted,
      );
    }
    return response;
  },
});

export type RpcClient = ContractRouterClient<AppContract, RpcClientContext>;
export const rpc: RpcClient = createORPCClient(link);

/** Capture a request target without changing the selected conversation. */
export function createSpaceRpc(spaceId: string | null, isCurrent?: () => boolean): RpcClient {
  return createORPCClient({
    call: (path, input, options) => {
      if (isCurrent?.() === false) throw new DOMException("Settings closed", "AbortError");
      return link.call(path, input, {
        ...options,
        context: {
          ...options.context,
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
