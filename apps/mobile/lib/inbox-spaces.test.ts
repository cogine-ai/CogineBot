import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptDeletedSpaceFallback,
  type MobileBot,
  rpc,
  selectedSpaceId,
  selectSpace,
} from "./api";
import {
  canDeleteInboxSpace,
  type InboxSpace,
  inboxNeedsCreateHint,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "./inbox-spaces";

vi.mock("./api", () => ({
  adoptDeletedSpaceFallback: vi.fn(),
  rpc: vi.fn(),
  selectedSpaceId: vi.fn(),
  selectSpace: vi.fn(),
}));

function space(overrides: Partial<InboxSpace> = {}): InboxSpace {
  return {
    id: "space-work",
    name: "Work",
    isDefault: false,
    hasContent: false,
    canDelete: true,
    bots: [],
    groups: [],
    botSections: [],
    ...overrides,
  };
}

const bot: MobileBot = {
  id: "bot-1",
  name: "Helper",
  preview: "",
  title: "",
  color: "gray",
  computerMode: "team",
  notifyOnFinish: true,
  threadId: "thread-1",
  pinned: false,
  status: "idle",
  sectionId: null,
  archivedAt: null,
  unread: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  autoSpeak: false,
};

describe("spaceInboxItems", () => {
  it("keeps an empty space visible and selectable by its own id", () => {
    const empty = space();
    expect(spaceInboxItems([empty])).toEqual([
      { type: "heading", key: empty.id, title: empty.name, space: empty },
    ]);
  });

  it("keeps the only empty default space visible without offering deletion", () => {
    const personal = space({ isDefault: true, canDelete: true });
    const items = spaceInboxItems([personal]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "heading", space: personal });
    expect(canDeleteInboxSpace(personal)).toBe(false);
    expect(inboxNeedsCreateHint(items)).toBe(true);
  });

  it("does not ask for a create hint once a space has a bot", () => {
    expect(inboxNeedsCreateHint(spaceInboxItems([space({ isDefault: true, bots: [bot] })]))).toBe(
      false,
    );
    expect(inboxNeedsCreateHint([])).toBe(false);
  });

  it("renders space actions once, separate from pinned and named bot sections", () => {
    const work = space({
      bots: [
        { ...bot, pinned: true },
        { ...bot, id: "bot-2", sectionId: "section-1" },
      ],
      botSections: [
        {
          id: "section-1",
          name: "Research",
          position: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const headings = spaceInboxItems([work]).filter((item) => item.type === "heading");
    expect(headings.map((item) => item.title)).toEqual(["Work", "Research", "Unassigned"]);
    expect(headings.filter((item) => item.space)).toEqual([
      { type: "heading", key: work.id, title: work.name, space: work },
    ]);
  });

  it("keeps populated default-space chrome minimal and retains group rows", () => {
    const group = {
      id: "group-1",
      name: "Planning",
      preview: "",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      unread: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      members: [],
    };
    const items = spaceInboxItems([space({ isDefault: true, bots: [bot], groups: [group] })]);
    expect(items.map((item) => item.type)).toEqual(["bot", "group"]);
    expect(items[0]).toMatchObject({ type: "bot", depth: 0, hasChildren: false });
  });

  it("counts only unpinned conversations and collapses custom and system sections independently", () => {
    const work = space({
      isDefault: true,
      bots: [
        { ...bot, id: "pinned", pinned: true, sectionId: "research" },
        { ...bot, id: "research", sectionId: "research" },
        { ...bot, id: "loose" },
      ],
      botSections: [
        { id: "research", name: "Research", position: 0, createdAt: "", updatedAt: "" },
      ],
    });
    const collapsed = spaceInboxItems([work], new Set(), new Set([`${work.id}:section:research`]));
    expect(collapsed.filter((item) => item.type === "bot").map((item) => item.bot.id)).toEqual([
      "pinned",
      "loose",
    ]);
    expect(collapsed.find((item) => item.type === "heading" && item.section)).toMatchObject({
      title: "Research",
      count: 1,
      collapsed: true,
    });
    const systemCollapsed = spaceInboxItems([work], new Set(), new Set([`${work.id}:unassigned`]));
    expect(
      systemCollapsed.filter((item) => item.type === "bot").map((item) => item.bot.id),
    ).toEqual(["pinned", "research"]);
    expect(
      systemCollapsed.find((item) => item.type === "heading" && item.title === "Unassigned"),
    ).toMatchObject({
      count: 1,
      collapsed: true,
      section: undefined,
    });
  });

  it("keeps empty sections visible and ignores remembered system folding without custom sections", () => {
    const empty = space({
      isDefault: true,
      bots: [bot],
      botSections: [{ id: "empty", name: "Empty", position: 0, createdAt: "", updatedAt: "" }],
    });
    expect(
      spaceInboxItems([empty]).find((item) => item.type === "heading" && item.section),
    ).toMatchObject({ count: 0 });
    const plain = { ...empty, botSections: [] };
    expect(spaceInboxItems([plain], new Set(), new Set([`${plain.id}:unassigned`]))).toMatchObject([
      { type: "bot", bot: { id: bot.id } },
    ]);
  });

  it("does not present a new-inbox hint when existing conversations are all folded", () => {
    const work = space({
      isDefault: true,
      bots: [{ ...bot, sectionId: "research" }],
      botSections: [
        { id: "research", name: "Research", position: 0, createdAt: "", updatedAt: "" },
      ],
    });
    const items = spaceInboxItems(
      [work],
      new Set(),
      new Set([`${work.id}:section:research`, `${work.id}:unassigned`]),
    );
    expect(items.every((item) => item.type === "heading")).toBe(true);
    expect(inboxNeedsCreateHint(items)).toBe(false);
  });

  it("temporarily expands sections for filtered results without changing remembered folding", () => {
    const work = space({
      isDefault: true,
      bots: [bot],
      botSections: [{ id: "empty", name: "Empty", position: 0, createdAt: "", updatedAt: "" }],
    });
    const collapsed = new Set([`${work.id}:unassigned`]);
    expect(
      spaceInboxItems([work], new Set(), collapsed, true).some((item) => item.type === "bot"),
    ).toBe(true);
    expect(collapsed.has(`${work.id}:unassigned`)).toBe(true);
  });

  it("nests child bots under their parent and can collapse them", () => {
    const parent = { ...bot, id: "parent", parentBotId: null };
    const child = { ...bot, id: "child", parentBotId: "parent" };
    const expanded = spaceInboxItems([space({ isDefault: true, bots: [parent, child] })]);
    expect(expanded.map((item) => ("bot" in item ? [item.bot.id, item.depth] : item.type))).toEqual(
      [
        ["parent", 0],
        ["child", 1],
      ],
    );
    expect(expanded[0]).toMatchObject({ hasChildren: true });
    const collapsed = spaceInboxItems(
      [space({ isDefault: true, bots: [parent, child] })],
      new Set(["parent"]),
    );
    expect(collapsed.map((item) => ("bot" in item ? item.bot.id : item.type))).toEqual(["parent"]);
  });

  it("keeps empty spaces beside a populated space", () => {
    const personal = space({ id: "personal", isDefault: true, bots: [bot] });
    expect(spaceInboxItems([personal, space()]).map((item) => item.type)).toEqual([
      "heading",
      "bot",
      "heading",
    ]);
  });

  it.each([undefined, false])("hides deletion unless ownership is explicit (%s)", (canDelete) => {
    expect(canDeleteInboxSpace(space({ canDelete }))).toBe(false);
  });

  it("offers deletion for an explicitly authorized empty non-default space", () => {
    expect(canDeleteInboxSpace(space())).toBe(true);
  });

  it("hides deletion while a space still has content", () => {
    expect(canDeleteInboxSpace(space({ hasContent: true }))).toBe(false);
  });
});

describe("removeInboxSpace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(selectedSpaceId).mockReturnValue("space-work");
    vi.mocked(rpc).mockResolvedValue({ ok: true, activeSpaceId: "personal" });
    vi.mocked(selectSpace).mockResolvedValue(true);
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(true);
  });

  it("awaits saving the server fallback before refreshing a deleted current space", async () => {
    let finishSelection!: (saved: boolean) => void;
    vi.mocked(selectSpace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSelection = resolve;
        }),
    );
    const refresh = vi.fn(async () => undefined);
    const removing = removeInboxSpace("space-work", refresh);
    await vi.waitFor(() => expect(selectSpace).toHaveBeenCalledWith("personal"));
    expect(refresh).not.toHaveBeenCalled();
    finishSelection(true);
    await expect(removing).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("spaces/remove", { spaceId: "space-work" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the selection when deleting another space", async () => {
    vi.mocked(selectedSpaceId).mockReturnValue("personal");
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(selectSpace).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("adopts and refreshes the server fallback when direct persistence fails", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledWith("personal");
    expect(refresh).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("retains a retry when neither fallback recovery write is durable", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    const recoveryId = await removeInboxSpace("space-work", refresh);
    expect(recoveryId).toBe("personal");
    expect(refresh).toHaveBeenCalledOnce();
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(true);
    await expect(retryInboxSpaceFallback(recoveryId!, refresh)).resolves.toBe(true);
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledTimes(2);
    expect(adoptDeletedSpaceFallback).toHaveBeenLastCalledWith("personal");
    expect(selectSpace).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("keeps the retry visible when fallback persistence still fails", async () => {
    vi.mocked(adoptDeletedSpaceFallback).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(retryInboxSpaceFallback("personal", refresh)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("selects an empty inbox without creating a bot or starting onboarding", async () => {
    const refresh = vi.fn(async () => undefined);
    await expect(selectInboxSpace("space-work", refresh)).resolves.toBe(true);
    expect(selectSpace).toHaveBeenCalledWith("space-work");
    expect(refresh).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not refresh when selecting an empty space fails", async () => {
    vi.mocked(selectSpace).mockResolvedValue(false);
    const refresh = vi.fn(async () => undefined);
    await expect(selectInboxSpace("space-work", refresh)).resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("also adopts the fallback when native selection throws", async () => {
    vi.mocked(selectSpace).mockRejectedValue(new Error("storage unavailable"));
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).resolves.toBeNull();
    expect(adoptDeletedSpaceFallback).toHaveBeenCalledWith("personal");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("leaves selection and inbox unchanged when deletion is rejected", async () => {
    vi.mocked(rpc).mockRejectedValue(new Error("Space is not empty"));
    const refresh = vi.fn(async () => undefined);
    await expect(removeInboxSpace("space-work", refresh)).rejects.toThrow("Space is not empty");
    expect(selectSpace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
