import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, currentSpaceSelectionGeneration, rpc, selectedSpaceId } from "./rpc";

type SpaceRpc = { client: RpcClient; spaceId: string | null; isCurrent: () => boolean };
const SpaceRpcContext = createContext<SpaceRpc>({
  client: rpc,
  spaceId: null,
  isCurrent: () => true,
});

/** Edit one Space while retaining the account and conversation that opened settings. */
export function SpaceRpcProvider({
  spaceId,
  ownerKey,
  children,
}: {
  spaceId: string | null | undefined;
  ownerKey?: string;
  children: ReactNode;
}) {
  const binding = useMemo(
    () => ({
      spaceId: spaceId ?? null,
      ownerKey,
      originSpaceId: selectedSpaceId(),
      originGeneration: currentSpaceSelectionGeneration(),
    }),
    [spaceId, ownerKey],
  );
  const committed = useRef<typeof binding | null>(null);
  const isCurrent = useCallback(
    () =>
      committed.current === binding &&
      binding.originSpaceId === selectedSpaceId() &&
      binding.originGeneration === currentSpaceSelectionGeneration(),
    [binding],
  );
  const value = useMemo<SpaceRpc>(
    () => ({
      spaceId: binding.spaceId,
      client: createSpaceRpc(binding.spaceId ?? binding.originSpaceId, isCurrent),
      isCurrent,
    }),
    [binding, isCurrent],
  );
  useLayoutEffect(() => {
    committed.current = binding;
    return () => {
      if (committed.current === binding) committed.current = null;
    };
  }, [binding]);
  return <SpaceRpcContext.Provider value={value}>{children}</SpaceRpcContext.Provider>;
}

export function useSpaceRpc(): RpcClient {
  return useContext(SpaceRpcContext).client;
}
export function useBoundSpaceId(): string | null {
  return useContext(SpaceRpcContext).spaceId;
}
export function useSpaceRpcCurrent(): () => boolean {
  return useContext(SpaceRpcContext).isCurrent;
}
