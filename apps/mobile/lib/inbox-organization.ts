import type { MenuAction } from "@expo/ui/community/menu";
import type { BotSection } from "@rakazo/contracts";
import { t } from "./i18n";

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
