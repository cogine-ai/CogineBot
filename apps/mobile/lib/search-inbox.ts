import { useSyncExternalStore } from "react";
import type { InboxSpace } from "./inbox-spaces";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent, subscribeMobileScope } from "./mobile-scope";

const empty: InboxSpace[] = [];
let snapshot = empty;
let owner: MobileScope | undefined;
const listeners = new Set<() => void>();

// Share the verified home roster without another request or navigation payload.
export function setSearchInbox(scope: MobileScope, spaces: InboxSpace[]): void {
  if (!isMobileScopeCurrent(scope)) return;
  snapshot = spaces;
  owner = scope;
  for (const listener of listeners) listener();
}

export function getSearchInbox(): InboxSpace[] {
  return owner && isMobileScopeCurrent(owner) ? snapshot : empty;
}

export function subscribeSearchInbox(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeMobileScope(listener);
  return () => {
    listeners.delete(listener);
    unsubscribe();
  };
}

export function useSearchInbox(): InboxSpace[] {
  return useSyncExternalStore(subscribeSearchInbox, getSearchInbox, getSearchInbox);
}
