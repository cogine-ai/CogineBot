import type { Group, ThreadSnapshot } from "@rakazo/contracts";

export function syncSavedGroupSnapshot(
  snapshot: ThreadSnapshot | null,
  group: Pick<Group, "id" | "threadId" | "name" | "members"> | undefined,
): ThreadSnapshot | null {
  if (
    !snapshot ||
    !group ||
    snapshot.groupId !== group.id ||
    snapshot.threadId !== group.threadId
  ) {
    return snapshot;
  }
  return { ...snapshot, groupName: group.name, members: group.members };
}
