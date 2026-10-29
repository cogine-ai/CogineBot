const covers = new Set<object>();
const listeners = new Set<() => void>();

export function replyAnnouncementsVisible(): boolean {
  return covers.size === 0;
}

export function subscribeReplyAnnouncementVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A mounted modal owns its cover until it closes or its scope unmounts. */
export function coverReplyAnnouncements(): () => void {
  const owner = {};
  covers.add(owner);
  for (const listener of listeners) listener();
  return () => {
    if (!covers.delete(owner)) return;
    for (const listener of listeners) listener();
  };
}
