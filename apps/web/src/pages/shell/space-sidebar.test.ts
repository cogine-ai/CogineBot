import { describe, expect, it, vi } from "vitest";
import {
  commitSpaceRename,
  restoreSidebarSectionOrder,
  sidebarGroupsForSpaces,
} from "./space-sidebar";

describe("restoreSidebarSectionOrder", () => {
  it("keeps an independently restored group in its current slot", () => {
    expect(restoreSidebarSectionOrder(["a", "c", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(restoreSidebarSectionOrder(["c", "a", "b"], ["b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("ignores deleted originals and includes every current group exactly once", () => {
    expect(restoreSidebarSectionOrder(["d", "c", "new", "b"], ["a", "b", "c", "d"])).toEqual([
      "b",
      "c",
      "new",
      "d",
    ]);
    expect(restoreSidebarSectionOrder(["new", "restored"], ["deleted"])).toEqual([
      "new",
      "restored",
    ]);
    expect(restoreSidebarSectionOrder([], ["deleted"])).toEqual([]);
  });
});

function chat(id: string, name: string) {
  return {
    id,
    name,
    title: "",
    preview: "",
    pinned: false,
    sectionId: null,
    parentBotId: null,
  };
}

function space(
  id: string,
  name: string,
  options: { canRename?: boolean; canDelete?: boolean; bots?: ReturnType<typeof chat>[] } = {},
) {
  return {
    id,
    name,
    canRename: options.canRename ?? false,
    canDelete: options.canDelete ?? false,
    bots: options.bots ?? [chat(`${id}-bot`, "Chief")],
    groups: [],
    botSections: [],
  };
}

describe("sidebarGroupsForSpaces", () => {
  it("keeps rename on the only space without showing its name", () => {
    const [group] = sidebarGroupsForSpaces([space("space-1", "Personal", { canRename: true })], "");

    expect(group).toMatchObject({
      title: null,
      spaceName: "Personal",
      canRenameSpace: true,
      canDeleteSpace: false,
      showLock: false,
    });
    expect(group?.bots).toHaveLength(1);
  });

  it("still names each space once there is more than one", () => {
    const groups = sidebarGroupsForSpaces(
      [
        space("space-1", "Personal", { canRename: true }),
        space("space-2", "Support", { canRename: true, canDelete: true, bots: [] }),
      ],
      "",
    );

    expect(groups.map((group) => group.title)).toEqual(["Personal", "Support"]);
    expect(groups[0]).toMatchObject({ canRenameSpace: true, canDeleteSpace: false });
    expect(groups[1]).toMatchObject({
      canRenameSpace: true,
      canDeleteSpace: true,
      emptySpaceId: "space-2",
    });
  });

  it("keeps collapse identity stable when another space appears", () => {
    const personal = {
      ...space("space-1", "Personal"),
      botSections: [{ id: "s1", name: "Product" }],
    };
    const single = sidebarGroupsForSpaces([personal], "");
    const multiple = sidebarGroupsForSpaces([personal, space("space-2", "Support")], "");
    expect(single.find((group) => group.sectionId === "s1")?.collapseKey).toBe(
      "space:space-1:section:s1",
    );
    expect(multiple.find((group) => group.sectionId === "s1")?.collapseKey).toBe(
      single.find((group) => group.sectionId === "s1")?.collapseKey,
    );
    expect(single.find((group) => group.kind === "unassigned")?.collapseKey).toBe(
      "space:space-1:unassigned",
    );
  });

  it("distinguishes space labels from Unassigned and retains empty sections during filtering", () => {
    const grouped = {
      ...space("space-1", "Personal"),
      botSections: [{ id: "s1", name: "Product" }],
    };
    const groups = sidebarGroupsForSpaces([grouped, space("space-2", "Support")], "missing");
    expect(groups.find((group) => group.sectionId === "s1")).toMatchObject({
      baseTitle: "Product",
      bots: [],
    });
    expect(
      groups.find((group) => group.spaceId === "space-1" && group.kind === "unassigned"),
    ).toMatchObject({ baseTitle: "Unassigned", bots: [] });
    const noCustom = sidebarGroupsForSpaces(
      [space("space-1", "Personal"), space("space-2", "Support")],
      "",
    );
    expect(noCustom.every((group) => group.baseTitle === null)).toBe(true);
  });

  it("hides space actions while a search removes every chat from the only space", () => {
    expect(
      sidebarGroupsForSpaces([space("space-1", "Personal", { canRename: true })], "missing"),
    ).toEqual([]);
  });
});

describe("commitSpaceRename", () => {
  it("applies the saved name when the following refresh fails", async () => {
    const rename = vi.fn(async () => undefined);
    const apply = vi.fn();
    const refresh = vi.fn(async () => {
      throw new Error("list failed");
    });

    await expect(commitSpaceRename({ rename, apply, refresh })).resolves.toBeUndefined();
    expect(rename).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not apply a name when the rename itself fails", async () => {
    const apply = vi.fn();
    const refresh = vi.fn(async () => undefined);

    await expect(
      commitSpaceRename({
        rename: async () => {
          throw new Error("Space deletion is already in progress");
        },
        apply,
        refresh,
      }),
    ).rejects.toThrow("Space deletion is already in progress");
    expect(apply).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
