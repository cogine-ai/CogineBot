import {
  currentApiBase,
  currentApiBaseGeneration,
  currentSpaceSelectionGeneration,
  selectedSpaceId,
  spaceSelectionSeq,
  subscribeApiBase,
  subscribeSelectedSpace,
} from "./api";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

export type MobileScope = Readonly<{
  apiBase: string;
  apiGeneration: number;
  sessionGeneration: number;
  spaceId: string | null;
  spaceGeneration: number;
  selectionSeq: number;
}>;

export function captureMobileScope(): MobileScope {
  return {
    apiBase: currentApiBase(),
    apiGeneration: currentApiBaseGeneration(),
    sessionGeneration: currentSessionGeneration(),
    spaceId: selectedSpaceId(),
    spaceGeneration: currentSpaceSelectionGeneration(),
    selectionSeq: spaceSelectionSeq(),
  };
}

export function isMobileSessionCurrent(scope: MobileScope): boolean {
  return (
    scope.apiBase === currentApiBase() &&
    scope.apiGeneration === currentApiBaseGeneration() &&
    scope.sessionGeneration === currentSessionGeneration()
  );
}

export function isMobileScopeCurrent(scope: MobileScope): boolean {
  return (
    isMobileSessionCurrent(scope) &&
    scope.spaceId === selectedSpaceId() &&
    scope.spaceGeneration === currentSpaceSelectionGeneration() &&
    scope.selectionSeq === spaceSelectionSeq()
  );
}

export function mobileScopeKey(): string {
  return JSON.stringify(captureMobileScope());
}

export function subscribeMobileScope(listener: () => void): () => void {
  const unsubscribeApi = subscribeApiBase(listener);
  const unsubscribeSession = subscribeSessionGeneration(listener);
  const unsubscribeSpace = subscribeSelectedSpace(listener);
  return () => {
    unsubscribeApi();
    unsubscribeSession();
    unsubscribeSpace();
  };
}
