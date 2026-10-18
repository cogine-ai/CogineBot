import { beforeEach, describe, expect, it } from "vitest";
import { activateUiLocale } from "./i18n";
import {
  chatOrganizationActions,
  reorderedSectionIds,
  sectionOrganizationActions,
} from "./inbox-organization";

const target = { pinned: false, sectionId: null, unread: false };
const sections = [
  { id: "work", name: "Work", position: 0, createdAt: "", updatedAt: "" },
  { id: "home", name: "Home", position: 1, createdAt: "", updatedAt: "" },
];

beforeEach(() => activateUiLocale("en"));

describe("native inbox organization", () => {
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
