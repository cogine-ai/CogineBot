import type { MenuAction } from "@expo/ui/community/menu";
import type { Bot, BotSection, RemovedBotSection } from "@rakazo/contracts";
import { BotSectionNameSchema } from "@rakazo/contracts";
import type { MobileBot, MobileGroup, MobileSpace } from "./api";
import { t } from "./i18n";

export type InboxOrganizationState = {
  spaceId: string | null;
  bots: MobileBot[];
  groups: MobileGroup[];
  botSections: BotSection[];
  spaces: MobileSpace[];
};

type ChatPatch = Partial<
  Pick<Bot, "pinned" | "sectionId" | "unread" | "notifyOnFinish" | "updatedAt">
>;
type ChatTarget = { kind: "bot" | "group"; id: string };
export type InboxOrganizationChange = { spaceId: string } & (
  | ({ type: "chat"; patch: ChatPatch } & ChatTarget)
  | { type: "section"; section: BotSection; target?: ChatTarget }
  | { type: "sections"; sections: BotSection[] }
  | { type: "remove"; snapshot: RemovedBotSection }
  | { type: "restore"; snapshot: RemovedBotSection; section: BotSection }
);

/** Reconcile only fields confirmed by an organization write, keeping later chat choices intact. */
export function reconcileInboxOrganization(
  state: InboxOrganizationState,
  change: InboxOrganizationChange,
): InboxOrganizationState {
  const botIds = new Set("snapshot" in change ? change.snapshot.botIds : []);
  const groupIds = new Set("snapshot" in change ? change.snapshot.groupIds : []);
  function chats<T extends { id: string; sectionId: string | null; pinned: boolean }>(
    rows: T[],
    kind: "bot" | "group",
  ): T[] {
    return rows.map((chat) => {
      if (change.type === "chat" && change.kind === kind && change.id === chat.id)
        return { ...chat, ...change.patch };
      if (change.type === "section" && change.target?.kind === kind && change.target.id === chat.id)
        return { ...chat, sectionId: change.section.id, pinned: false };
      const member = (kind === "bot" ? botIds : groupIds).has(chat.id);
      if (change.type === "remove" && member && chat.sectionId === change.snapshot.section.id)
        return { ...chat, sectionId: null };
      if (change.type === "restore" && member && chat.sectionId === null)
        return { ...chat, sectionId: change.section.id };
      return chat;
    });
  }
  function sections(current: BotSection[]): BotSection[] {
    if (change.type === "sections") return change.sections;
    if (change.type === "remove")
      return current.filter((section) => section.id !== change.snapshot.section.id);
    if (change.type !== "section" && change.type !== "restore") return current;
    const found = current.some((section) => section.id === change.section.id);
    const next = current.map((section) => {
      if (section.id === change.section.id) return change.section;
      return change.type === "restore" && !found && section.position >= change.section.position
        ? { ...section, position: section.position + 1 }
        : section;
    });
    if (!found) next.push(change.section);
    return next.sort((a, b) => a.position - b.position);
  }
  return {
    ...state,
    ...(state.spaceId === change.spaceId
      ? {
          bots: chats(state.bots, "bot"),
          groups: chats(state.groups, "group"),
          botSections: sections(state.botSections),
        }
      : {}),
    spaces: state.spaces.map((space) =>
      space.id === change.spaceId
        ? {
            ...space,
            bots: chats(space.bots, "bot"),
            groups: chats(space.groups, "group"),
            botSections: sections(space.botSections),
          }
        : space,
    ),
  };
}

export function sectionNameValidationError(value: string, initialName?: string): string | null {
  const name = value.trim();
  if (initialName !== undefined && name === initialName.trim()) return null;
  if (!name) return t("Enter a name");
  if (name.length > 60) return t("Use 60 characters or fewer");
  if (
    !BotSectionNameSchema.safeParse(name).success ||
    name.toLowerCase() === t("Unassigned").trim().toLowerCase()
  ) {
    return t("Choose another group name");
  }
  return null;
}

type OrganizationTarget = {
  pinned: boolean;
  sectionId: string | null;
  unread: boolean;
  notifyOnFinish?: boolean;
};

export function chatOrganizationActions(
  target: OrganizationTarget,
  sections: readonly BotSection[],
): MenuAction[] {
  return [
    sections.length
      ? {
          id: "move",
          title: t("Move to"),
          subactions: [
            ...sections.map(
              (section): MenuAction => ({
                id: `section:${section.id}`,
                title: section.name,
                state: !target.pinned && target.sectionId === section.id ? "on" : "off",
              }),
            ),
            {
              id: "unassigned",
              title: t("Unassigned"),
              state: !target.pinned && !target.sectionId ? "on" : "off",
            },
            { id: "create-section", title: t("Create section") },
          ],
        }
      : { id: "create-section", title: t("Group…") },
    { id: "pin", title: target.pinned ? t("Unpin") : t("Pin"), image: "pin" },
    { id: "unread", title: target.unread ? t("Mark as read") : t("Mark as unread") },
    ...(typeof target.notifyOnFinish === "boolean"
      ? [
          {
            id: "notifications",
            title: target.notifyOnFinish ? t("Silence notifications") : t("Resume notifications"),
            image: "bell" as const,
          },
        ]
      : []),
  ];
}

export function sectionOrganizationActions(
  sectionId: string,
  sections: readonly BotSection[],
): MenuAction[] {
  const index = sections.findIndex((section) => section.id === sectionId);
  if (index < 0) return [];
  return [
    { id: "rename", title: t("Rename"), image: "pencil" },
    ...(index > 0 ? [{ id: "up", title: t("Move up"), image: "arrow.up" as const }] : []),
    ...(index < sections.length - 1
      ? [{ id: "down", title: t("Move down"), image: "arrow.down" as const }]
      : []),
    {
      id: "delete",
      title: t("Delete section"),
      image: "trash",
      attributes: { destructive: true },
    },
  ];
}

export function reorderedSectionIds(
  sections: readonly BotSection[],
  sectionId: string,
  direction: "up" | "down",
): string[] | null {
  const ids = sections.map((section) => section.id);
  const index = ids.indexOf(sectionId);
  const destination = index + (direction === "up" ? -1 : 1);
  if (index < 0 || destination < 0 || destination >= ids.length) return null;
  [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
  return ids;
}
