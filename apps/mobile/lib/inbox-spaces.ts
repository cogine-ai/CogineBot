import type { BotSection, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { groupBotsForSidebar, nestRosterByParent } from "@rakazo/core";
import {
  adoptDeletedSpaceFallback,
  type MobileBot,
  type MobileGroup,
  type MobileSpace,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "./api";
import { t } from "./i18n";

export type InboxSpace = Pick<
  MobileSpace,
  "id" | "name" | "isDefault" | "hasContent" | "canDelete" | "botSections"
> & {
  bots: (MobileBot | SpaceBot)[];
  groups: (MobileGroup | SpaceGroup)[];
};

export type InboxSpaceItem =
  | {
      type: "bot";
      bot: MobileBot | SpaceBot;
      depth: number;
      hasChildren: boolean;
    }
  | { type: "group"; group: MobileGroup | SpaceGroup }
  | {
      type: "heading";
      key: string;
      title: string;
      space?: InboxSpace;
      spaceId?: string;
      section?: BotSection;
      count?: number;
      collapsed?: boolean;
    };

export function canDeleteInboxSpace(
  space: Pick<InboxSpace, "isDefault" | "hasContent" | "canDelete">,
) {
  return !space.isDefault && !space.hasContent && space.canDelete === true;
}

/** A brand-new space renders only its heading until it has a bot or group. */
export function inboxNeedsCreateHint(items: readonly { type: string; count?: number }[]): boolean {
  return items.length > 0 && items.every((item) => item.type === "heading" && !item.count);
}

export function spaceInboxItems(
  spaces: InboxSpace[],
  collapsedParentIds: ReadonlySet<string> = new Set(),
  collapsedSectionKeys: ReadonlySet<string> = new Set(),
  expandSections = false,
): InboxSpaceItem[] {
  return spaces.flatMap((space): InboxSpaceItem[] => {
    const chats = [
      ...space.bots.map((chat) => ({
        type: "bot" as const,
        bot: chat,
        id: chat.id,
        parentBotId: chat.parentBotId,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
      ...space.groups.map((chat) => ({
        type: "group" as const,
        group: chat,
        id: chat.id,
        pinned: chat.pinned,
        sectionId: chat.sectionId,
      })),
    ];
    const items: InboxSpaceItem[] = [];
    if (spaces.length > 1 || !space.isDefault || chats.length === 0) {
      items.push({ type: "heading", key: space.id, title: space.name, space });
    }
    for (const group of groupBotsForSidebar(chats, space.botSections)) {
      const section = space.botSections.find((entry) => group.key === `section:${entry.id}`);
      const hasHeading = !!section || (group.key === "unassigned" && space.botSections.length > 0);
      const key = `${space.id}:${group.key}`;
      const collapsed = hasHeading && !expandSections && collapsedSectionKeys.has(key);
      if (hasHeading) {
        items.push({
          type: "heading",
          key,
          title: section?.name ?? t("Unassigned"),
          spaceId: space.id,
          section,
          count: group.bots.length,
          collapsed,
        });
      }
      if (collapsed) continue;
      for (const row of nestRosterByParent(group.bots, collapsedParentIds)) {
        if (row.item.type === "bot") {
          items.push({
            type: "bot",
            bot: row.item.bot,
            depth: row.depth,
            hasChildren: row.hasChildren,
          });
        } else {
          items.push({ type: "group", group: row.item.group });
        }
      }
    }
    return items;
  });
}

export async function selectInboxSpace(spaceId: string, refresh: () => Promise<void>) {
  if (!(await selectSpace(spaceId).catch(() => false))) return false;
  await refresh();
  return true;
}

export async function retryInboxSpaceFallback(spaceId: string, refresh: () => Promise<void>) {
  if (!(await adoptDeletedSpaceFallback(spaceId))) return false;
  await refresh();
  return true;
}

// Return the selection to retry if native storage fails after a successful deletion.
// The inbox must not refresh against the deleted selection in that case.
export async function removeInboxSpace(
  spaceId: string,
  refresh: () => Promise<void>,
): Promise<string | null> {
  const response = await rpc<{ ok: true; activeSpaceId: string }>("spaces/remove", { spaceId });
  if (selectedSpaceId() === spaceId) {
    if (await selectSpace(response.activeSpaceId).catch(() => false)) {
      await refresh();
      return null;
    }
    const durable = await adoptDeletedSpaceFallback(response.activeSpaceId);
    await refresh();
    return durable ? null : response.activeSpaceId;
  }
  await refresh();
  return null;
}
