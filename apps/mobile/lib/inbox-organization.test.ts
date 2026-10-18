import { beforeEach, describe, expect, it } from "vitest";
import { activateUiLocale, t } from "./i18n";
import type { InboxOrganizationState } from "./inbox-organization";
import {
  chatOrganizationActions,
  reconcileInboxOrganization,
  reorderedSectionIds,
  sectionNameValidationError,
  sectionOrganizationActions,
} from "./inbox-organization";

const target = { pinned: false, sectionId: null, unread: false };
const sections = [
  { id: "work", name: "Work", position: 0, createdAt: "", updatedAt: "" },
  { id: "home", name: "Home", position: 1, createdAt: "", updatedAt: "" },
];

beforeEach(() => activateUiLocale("en"));

describe("native inbox organization", () => {
  it("validates changed names with the shared rules while accepting unchanged historical names", () => {
    expect(sectionNameValidationError(" Product ", "Projects")).toBeNull();
    for (const name of [
      "Unassigned",
      " unASSIGNED ",
      "未分组",
      "Nicht zugewiesen",
      "Sin asignar",
      "Без раздела",
    ]) {
      expect(sectionNameValidationError(name, "Product")).toBe("Choose another group name");
      expect(sectionNameValidationError(name, name.trim())).toBeNull();
    }
    expect(sectionNameValidationError(" ")).toBe("Enter a name");
    expect(sectionNameValidationError("a".repeat(61))).toBe("Use 60 characters or fewer");
  });

  it("returns translated validation feedback in every supported non-English locale", () => {
    for (const locale of ["zh-CN", "de", "ru"] as const) {
      activateUiLocale(locale);
      const message = sectionNameValidationError("Unassigned", "Product");
      expect(message).toBe(t("Choose another group name"));
      expect(message).not.toBe("Choose another group name");
      expect(sectionNameValidationError(t("Unassigned"), "Product")).toBe(message);
    }
  });
  it("offers creation from the selected chat before any custom section exists", () => {
    const actions = chatOrganizationActions(target, []);
    expect(actions[0]).toMatchObject({ id: "create-section", title: "Group…" });
    expect(actions[0]?.subactions).toBeUndefined();
    expect(actions.some((action) => action.id === "unassigned")).toBe(false);
    activateUiLocale("zh-CN");
    expect(chatOrganizationActions(target, [])[0]?.title).toBe("分组");
  });

  it("offers actual native destination subactions once a section exists", () => {
    const move = chatOrganizationActions(
      { ...target, pinned: true, sectionId: "work" },
      sections,
    )[0]!;
    expect(move.id).toBe("move");
    expect(move.subactions?.map((action) => action.id)).toEqual([
      "section:work",
      "section:home",
      "unassigned",
      "create-section",
    ]);
    expect(move.subactions?.some((action) => action.state === "on")).toBe(false);
    expect(move.displayInline).toBeUndefined();
    expect(
      chatOrganizationActions({ ...target, sectionId: "work" }, sections)[0]?.subactions?.[0]
        ?.state,
    ).toBe("on");
  });

  it("hides impossible reorders and never provides system-section management", () => {
    expect(sectionOrganizationActions("work", sections).map((action) => action.id)).toEqual([
      "rename",
      "down",
      "delete",
    ]);
    expect(sectionOrganizationActions("home", sections).map((action) => action.id)).toEqual([
      "rename",
      "up",
      "delete",
    ]);
    expect(sectionOrganizationActions("unassigned", sections)).toEqual([]);
    expect(reorderedSectionIds(sections, "work", "down")).toEqual(["home", "work"]);
    expect(reorderedSectionIds(sections, "work", "up")).toBeNull();
    expect(reorderedSectionIds(sections, "missing", "down")).toBeNull();
  });
});

function inboxState(): InboxOrganizationState {
  const bots = [
    {
      id: "a",
      sectionId: "work",
      pinned: true,
      unread: false,
      notifyOnFinish: true,
      preview: "Keep this preview",
    },
    { id: "b", sectionId: "home", pinned: false, unread: true, notifyOnFinish: true },
  ];
  const groups = [{ id: "chat", sectionId: "work", pinned: false, unread: false }];
  return {
    spaceId: "space-1",
    bots,
    groups,
    botSections: sections,
    spaces: [
      {
        id: "space-1",
        bots: structuredClone(bots),
        groups: structuredClone(groups),
        botSections: sections,
      },
      {
        id: "space-2",
        bots: structuredClone(bots),
        groups: structuredClone(groups),
        botSections: sections,
      },
    ],
  } as InboxOrganizationState;
}

describe("confirmed inbox organization state", () => {
  const snapshot = { section: sections[0]!, botIds: ["a", "b"], groupIds: ["chat"] };

  it("removes the section and matching memberships from both current and matching space lists", () => {
    const state = inboxState();
    const next = reconcileInboxOrganization(state, {
      type: "remove",
      spaceId: "space-1",
      snapshot,
    });
    expect(next.botSections.map((section) => section.id)).toEqual(["home"]);
    expect(next.bots).toMatchObject([
      { id: "a", sectionId: null, pinned: true },
      { id: "b", sectionId: "home" },
    ]);
    expect(next.groups[0]?.sectionId).toBeNull();
    expect(next.spaces[0]).toMatchObject({
      botSections: [sections[1]],
      bots: [{ sectionId: null, pinned: true }, { sectionId: "home" }],
      groups: [{ sectionId: null }],
    });
    expect(next.spaces[1]).toBe(state.spaces[1]);
    expect(state.botSections).toHaveLength(2);
  });

  it("restores to the returned section ID without replacing later moves or pin choices", () => {
    const state = reconcileInboxOrganization(inboxState(), {
      type: "remove",
      spaceId: "space-1",
      snapshot,
    });
    const existing = { ...sections[0]!, id: "reused", name: "Work", position: 2 };
    state.botSections = [...state.botSections, existing];
    const next = reconcileInboxOrganization(state, {
      type: "restore",
      spaceId: "space-1",
      snapshot,
      section: existing,
    });
    expect(next.bots).toMatchObject([
      { id: "a", sectionId: "reused", pinned: true },
      { id: "b", sectionId: "home" },
    ]);
    expect(next.groups[0]?.sectionId).toBe("reused");
    expect(next.botSections.filter((section) => section.id === existing.id)).toHaveLength(1);
    expect(next.spaces[0]?.bots[0]).toMatchObject({ sectionId: "reused", pinned: true });
    expect(next.spaces[1]?.bots[0]?.sectionId).toBe("work");
  });

  it("applies creation, rename and returned reorder while retaining other conversation fields", () => {
    const created = { ...sections[0]!, id: "projects", name: "Projects", position: 2 };
    const createdState = reconcileInboxOrganization(inboxState(), {
      type: "section",
      spaceId: "space-1",
      section: created,
      target: { kind: "bot", id: "a" },
    });
    expect(createdState.bots[0]).toMatchObject({
      sectionId: "projects",
      pinned: false,
      preview: "Keep this preview",
    });
    expect(createdState.spaces[0]?.bots[0]).toMatchObject({ sectionId: "projects", pinned: false });
    const renamed = { ...created, name: "Delivery" };
    const renamedState = reconcileInboxOrganization(createdState, {
      type: "section",
      spaceId: "space-1",
      section: renamed,
    });
    expect(renamedState.botSections.at(-1)?.name).toBe("Delivery");
    const reordered = [renamed, sections[1]!, sections[0]!].map((section, position) => ({
      ...section,
      position,
    }));
    const next = reconcileInboxOrganization(renamedState, {
      type: "sections",
      spaceId: "space-1",
      sections: reordered,
    });
    expect(next.botSections).toEqual(reordered);
    expect(next.spaces[0]?.botSections).toEqual(reordered);
  });

  it("applies confirmed pin, unread and notification fields without touching another space", () => {
    const next = reconcileInboxOrganization(inboxState(), {
      type: "chat",
      spaceId: "space-1",
      kind: "bot",
      id: "a",
      patch: { pinned: false, unread: true, notifyOnFinish: false, updatedAt: "confirmed" },
    });
    expect(next.bots[0]).toMatchObject({
      sectionId: "work",
      pinned: false,
      unread: true,
      notifyOnFinish: false,
      updatedAt: "confirmed",
      preview: "Keep this preview",
    });
    expect(next.spaces[0]?.bots[0]).toMatchObject({
      pinned: false,
      unread: true,
      notifyOnFinish: false,
    });
    expect(next.spaces[1]?.bots[0]).toMatchObject({
      pinned: true,
      unread: false,
      notifyOnFinish: true,
    });
    const otherSpace = reconcileInboxOrganization(next, {
      type: "chat",
      spaceId: "space-2",
      kind: "group",
      id: "chat",
      patch: { pinned: true },
    });
    expect(otherSpace.groups).toBe(next.groups);
    expect(otherSpace.spaces[1]?.groups[0]?.pinned).toBe(true);
  });

  it("reinserts a recreated section at its returned position", () => {
    const state = inboxState();
    state.botSections = [{ ...sections[1]!, position: 0 }];
    const restored = { ...sections[0]!, position: 0 };
    const next = reconcileInboxOrganization(state, {
      type: "restore",
      spaceId: "space-1",
      snapshot,
      section: restored,
    });
    expect(next.botSections.map((section) => [section.id, section.position])).toEqual([
      ["work", 0],
      ["home", 1],
    ]);
  });
});
