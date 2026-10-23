import { createBotCreation, createBotTemplateExamples } from "@rakazo/core";
import { useLayoutEffect, useMemo, useRef } from "react";
import { newClientId } from "./client-id";
import { createSpaceRpc, currentSpaceSelectionGeneration, selectedSpaceId } from "./rpc";

/** Capture committed account, Space and editor authority for one creation intent. */
export function useBotCreation(input: { ownerKey: string | null; spaceId: string | null }) {
  const selection = selectedSpaceId();
  const generation = currentSpaceSelectionGeneration();
  const origin = window.location.origin;
  const scope = useMemo(
    () => ({
      ownerKey: input.ownerKey,
      spaceId: input.spaceId,
      selection,
      generation,
      origin,
      key: JSON.stringify([input.ownerKey, input.spaceId, selection, generation, origin]),
    }),
    [input.ownerKey, input.spaceId, selection, generation, origin],
  );
  const committedScope = useRef<typeof scope | null>(null);
  useLayoutEffect(() => {
    committedScope.current = scope;
    return () => {
      if (committedScope.current === scope) committedScope.current = null;
    };
  }, [scope]);
  return useMemo(() => {
    const scopeCurrent = () =>
      Boolean(scope.ownerKey && scope.spaceId) &&
      (!scope.selection || scope.selection === scope.spaceId) &&
      committedScope.current === scope &&
      scope.selection === selectedSpaceId() &&
      scope.generation === currentSpaceSelectionGeneration() &&
      scope.origin === window.location.origin;
    const examples = createBotTemplateExamples({
      isCurrent: (key) => key === scope.key && scopeCurrent(),
    });
    return { scopeKey: scope.key, scopeCurrent, examples };
  }, [scope]);
}

export function useBotCreationEditor(input: {
  scope: ReturnType<typeof useBotCreation>;
  spaceId: string | null;
  enabled: boolean;
}) {
  const binding = useMemo(() => ({ ...input }), [input.scope, input.spaceId, input.enabled]);
  const committed = useRef<typeof binding | null>(null);
  useLayoutEffect(() => {
    committed.current = binding;
    return () => {
      if (committed.current === binding) committed.current = null;
    };
  }, [binding]);
  return useMemo(() => {
    if (!binding.enabled || !binding.spaceId) return null;
    const isCurrent = () => committed.current === binding && binding.scope.scopeCurrent();
    const client = createSpaceRpc(binding.spaceId, isCurrent);
    const creation = createBotCreation({
      spaceId: binding.spaceId,
      create: (draft) => client.bots.create(draft),
      list: async () => {
        const [active, archived] = await Promise.all([
          client.bots.list(),
          client.bots.listArchived(),
        ]);
        return [...active, ...archived];
      },
      makeNonce: () => newClientId(),
      isCurrent,
      // RPC failure alone cannot prove that a server write never happened.
      isAmbiguous: () => true,
    });
    return { creation, isCurrent };
  }, [binding]);
}
