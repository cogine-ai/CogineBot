import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";
import { BotSectionNameConflictError, IsolationError } from "./scope.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "test@example.com",
  isDeploymentOwner: false,
};
const scope = { spaceId: actor.spaceId, userId: actor.userId };
const date = new Date("2026-10-18T00:00:00Z");
type Section = typeof scope & {
  id: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};
type Member = typeof scope & {
  id: string;
  sectionId: string | null;
  pinned: boolean;
  archivedAt: Date | null;
};

function section(id: string, name = id, position = 0): Section {
  return { ...scope, id, name, position, createdAt: date, updatedAt: date };
}
function member(id: string, sectionId: string | null = null): Member {
  return { ...scope, id, sectionId, pinned: false, archivedAt: null };
}

// A stateful transaction double makes rollback and cross-actor effects observable.
function database(input: { sections?: Section[]; bots?: Member[]; groups?: Member[] } = {}) {
  const state = {
    sections: input.sections ?? [],
    bots: input.bots ?? [],
    groups: input.groups ?? [],
  };
  type Row = Section | Member;
  type Where = Record<string, unknown>;
  function matches(row: Row, where: Where): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const value = row[key as keyof Row];
      if (expected && typeof expected === "object") {
        if ("in" in expected) return (expected.in as unknown[]).includes(value);
        if ("gte" in expected) return Number(value) >= Number(expected.gte);
      }
      return value === expected;
    });
  }
  function model(key: keyof typeof state) {
    const rows = () => state[key] as Row[];
    const update = (row: Row, data: Where) => {
      for (const [field, value] of Object.entries(data)) {
        Object.assign(row, {
          [field]:
            value && typeof value === "object" && "increment" in value
              ? Number(row[field as keyof Row]) + Number(value.increment)
              : value,
        });
      }
      return row;
    };
    return {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows().filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => rows().find((row) => matches(row, where)) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Where }) => rows().find((row) => matches(row, where)) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { spaceId_userId_name: Where } }) => {
        const row = rows().find((item) => matches(item, where.spaceId_userId_name));
        if (!row) throw new Error("Missing section");
        return row;
      }),
      aggregate: vi.fn(async ({ where }: { where: Where }) => ({
        _max: {
          position: Math.max(
            -1,
            ...rows()
              .filter((row) => matches(row, where))
              .map((row) => (row as Section).position),
          ),
        },
      })),
      createMany: vi.fn(async ({ data }: { data: Section }) => {
        if (
          !state.sections.some(
            (row) =>
              row.spaceId === data.spaceId && row.userId === data.userId && row.name === data.name,
          )
        ) {
          state.sections.push({
            ...data,
            id: `new-${state.sections.length}`,
            createdAt: date,
            updatedAt: date,
          });
          return { count: 1 };
        }
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: Section }) => {
        const created = { ...data, createdAt: date, updatedAt: date };
        state.sections.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: Where; data: Where }) => {
        const row = rows().find((item) => matches(item, where));
        if (!row) throw Object.assign(new Error("Missing row"), { code: "P2025" });
        return update(row, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) => {
        const found = rows().filter((row) => matches(row, where));
        for (const row of found) update(row, data);
        return { count: found.length };
      }),
      delete: vi.fn(async ({ where }: { where: Where }) => {
        const index = rows().findIndex((row) => matches(row, where));
        if (index < 0) throw new Error("Missing row");
        rows().splice(index, 1);
      }),
    };
  }
  const tx = { botSection: model("sections"), bot: model("bots"), chatGroup: model("groups") };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => {
      const before = structuredClone(state);
      try {
        return await run(tx);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      }
    }),
  };
  return { state, prisma, repos: createRepos(prisma as unknown as PrismaClient) };
}

describe("personal sidebar groups", () => {
  it("lists only the current user's sections in the requested space", async () => {
    const db = database({
      sections: [
        section("own"),
        { ...section("other-user"), userId: "user-2" },
        { ...section("other-space"), spaceId: "space-2" },
      ],
    });
    expect((await db.repos.listBotSections(actor)).map((row) => row.id)).toEqual(["own"]);
  });

  it.each(["bot", "group"] as const)(
    "creates a group and moves a pinned %s in one transaction",
    async (kind) => {
      const item = { ...member("target"), pinned: true };
      const db = database(kind === "bot" ? { bots: [item] } : { groups: [item] });
      const created = await db.repos.createBotSection(actor, {
        ...(kind === "bot" ? { botId: item.id } : { groupId: item.id }),
        name: "  Product  ",
      });
      expect(created.name).toBe("Product");
      expect(item).toMatchObject({ sectionId: created.id, pinned: false });
      expect(db.prisma.$transaction).toHaveBeenCalledOnce();
    },
  );

  it("rolls back a newly created section if the membership write fails", async () => {
    const db = database({ bots: [{ ...member("bot"), pinned: true }] });
    db.prisma.bot.update.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      db.repos.createBotSection(actor, { botId: "bot", name: "Product" }),
    ).rejects.toThrow("write failed");
    expect(db.state.sections).toEqual([]);
    expect(db.state.bots[0]).toMatchObject({ sectionId: null, pinned: true });
  });

  it.each(["bot", "group"] as const)(
    "rejects a duplicate group name without moving or unpinning the target %s",
    async (kind) => {
      const item = { ...member("target"), pinned: true };
      const db = database({
        sections: [section("existing", "Product")],
        ...(kind === "bot" ? { bots: [item] } : { groups: [item] }),
      });
      const before = structuredClone(db.state);

      await expect(
        db.repos.createBotSection(actor, {
          ...(kind === "bot" ? { botId: item.id } : { groupId: item.id }),
          name: "Product",
        }),
      ).rejects.toBeInstanceOf(BotSectionNameConflictError);

      expect(db.state).toEqual(before);
    },
  );

  it("rejects missing, ambiguous, foreign and archived creation targets", async () => {
    const db = database({
      bots: [
        { ...member("foreign"), userId: "user-2" },
        { ...member("archived"), archivedAt: date },
      ],
    });
    for (const target of [
      {},
      { botId: "foreign" },
      { botId: "archived" },
      { botId: "foreign", groupId: "group" },
    ]) {
      await expect(
        db.repos.createBotSection(actor, { ...target, name: "Product" }),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    expect(db.state.sections).toEqual([]);
  });

  it("reserves system names on creation and ordinary renames", async () => {
    const db = database({ sections: [section("own")], bots: [member("bot")] });
    for (const name of ["Unassigned", " unASSIGNED ", "未分组", " "]) {
      await expect(db.repos.createBotSection(actor, { botId: "bot", name })).rejects.toThrow();
      await expect(db.repos.updateBotSection(actor, { sectionId: "own", name })).rejects.toThrow();
    }
    await expect(
      db.repos.updateBotSection(actor, { sectionId: "own", name: " " }),
    ).rejects.toThrow();
    expect(db.state.sections).toHaveLength(1);
    expect(db.state.sections[0]?.name).toBe("own");
  });

  it("reorders the complete personal list without affecting another user", async () => {
    const db = database({
      sections: [
        section("a"),
        section("b", "b", 1),
        { ...section("foreign", "foreign", 8), userId: "user-2" },
      ],
    });
    expect(
      (await db.repos.reorderBotSections(actor, ["b", "a"])).map((row) => [row.id, row.position]),
    ).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
    expect(db.state.sections.find((row) => row.id === "foreign")?.position).toBe(8);
    for (const ids of [["a"], ["a", "missing"], ["a", "foreign"], ["a", "a"], []]) {
      const before = structuredClone(db.state);
      await expect(db.repos.reorderBotSections(actor, ids)).rejects.toBeInstanceOf(IsolationError);
      expect(db.state).toEqual(before);
    }
  });

  it("removes only the personal section and includes archived memberships in the undo snapshot", async () => {
    const db = database({
      sections: [section("work"), section("other"), { ...section("foreign"), userId: "user-2" }],
      bots: [
        member("active", "work"),
        { ...member("archived", "work"), archivedAt: date },
        member("other", "other"),
        { ...member("foreign", "foreign"), userId: "user-2" },
      ],
      groups: [{ ...member("archived-group", "work"), archivedAt: date }],
    });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    expect(snapshot.botIds).toEqual(["active", "archived"]);
    expect(snapshot.groupIds).toEqual(["archived-group"]);
    expect(db.state.bots.map((bot) => bot.sectionId)).toEqual([null, null, "other", "foreign"]);
    expect(db.state.groups[0]?.sectionId).toBeNull();
    await expect(db.repos.removeBotSection(actor, "foreign")).rejects.toBeInstanceOf(
      IsolationError,
    );
    const restored = await db.repos.restoreBotSection(actor, snapshot);
    expect(restored.id).toBe("work");
    expect(db.state.bots.map((bot) => bot.sectionId)).toEqual(["work", "work", "other", "foreign"]);
    expect(db.state.groups[0]?.sectionId).toBe("work");
  });

  it("rolls back membership clearing when section removal fails", async () => {
    const db = database({
      sections: [section("work")],
      bots: [member("bot", "work")],
      groups: [member("group", "work")],
    });
    const before = structuredClone(db.state);
    db.prisma.botSection.delete.mockRejectedValueOnce(new Error("delete failed"));
    await expect(db.repos.removeBotSection(actor, "work")).rejects.toThrow("delete failed");
    expect(db.state).toEqual(before);
  });

  it("restores the remaining members after a conversation was permanently deleted", async () => {
    const db = database({
      sections: [section("work")],
      bots: [member("kept", "work"), member("deleted", "work")],
      groups: [member("kept-group", "work"), member("deleted-group", "work")],
    });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    db.state.bots = db.state.bots.filter((bot) => bot.id !== "deleted");
    db.state.groups = db.state.groups.filter((group) => group.id !== "deleted-group");

    const restored = await db.repos.restoreBotSection(actor, snapshot);

    expect(restored.id).toBe("work");
    expect(db.state.bots).toEqual([expect.objectContaining({ id: "kept", sectionId: "work" })]);
    expect(db.state.groups).toEqual([
      expect.objectContaining({ id: "kept-group", sectionId: "work" }),
    ]);
  });

  it.each(["Unassigned", "未分组"])(
    "can undo removal of a historical group named %s",
    async (name) => {
      const db = database({ sections: [section("legacy", name)], bots: [member("bot", "legacy")] });
      const snapshot = await db.repos.removeBotSection(actor, "legacy");

      const restored = await db.repos.restoreBotSection(actor, snapshot);

      expect(restored).toMatchObject({ id: "legacy", name });
      expect(db.state.bots[0]?.sectionId).toBe("legacy");
      await expect(db.repos.createBotSection(actor, { botId: "bot", name })).rejects.toThrow();
    },
  );

  it.each(["Unassigned", "未分组"])(
    "can undo renaming a historical group named %s",
    async (name) => {
      const db = database({ sections: [section("legacy", name)] });

      await db.repos.updateBotSection(actor, { sectionId: "legacy", name: "Product" });
      expect(db.state.sections[0]?.name).toBe("Product");
      await expect(
        db.repos.updateBotSection(actor, { sectionId: "legacy", name }),
      ).rejects.toThrow();
      const restored = await db.repos.restoreBotSectionName(actor, {
        sectionId: "legacy",
        name,
        expectedName: "Product",
      });

      expect(restored).toMatchObject({ id: "legacy", name });
    },
  );

  it("restores a name idempotently and leaves subsequent renames untouched", async () => {
    const db = database({ sections: [section("work", "Product")] });
    const undo = { sectionId: "work", name: "Unassigned", expectedName: "Product" };
    await db.repos.restoreBotSectionName(actor, undo);
    await expect(db.repos.restoreBotSectionName(actor, undo)).resolves.toMatchObject({
      name: "Unassigned",
    });
    await db.repos.updateBotSection(actor, { sectionId: "work", name: "Later" });

    await expect(db.repos.restoreBotSectionName(actor, undo)).rejects.toBeInstanceOf(
      BotSectionNameConflictError,
    );

    expect(db.state.sections[0]?.name).toBe("Later");
  });

  it("checks name restoration against the actor and space", async () => {
    const db = database({
      sections: [
        { ...section("foreign", "Product"), userId: "user-2" },
        { ...section("other-space", "Product"), spaceId: "space-2" },
      ],
    });
    for (const sectionId of ["foreign", "other-space"]) {
      await expect(
        db.repos.restoreBotSectionName(actor, {
          sectionId,
          name: "Unassigned",
          expectedName: "Product",
        }),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    expect(db.state.sections.every((section) => section.name === "Product")).toBe(true);
  });

  it("does not overwrite a concurrent rename between checking and updating", async () => {
    const db = database({ sections: [section("work", "Product")] });
    const update = db.prisma.botSection.update.getMockImplementation()!;
    db.prisma.botSection.update.mockImplementationOnce(async (args) => {
      db.state.sections[0]!.name = "Later";
      return update(args);
    });

    await expect(
      db.repos.restoreBotSectionName(actor, {
        sectionId: "work",
        name: "Unassigned",
        expectedName: "Product",
      }),
    ).rejects.toBeInstanceOf(BotSectionNameConflictError);

    expect(db.state.sections[0]?.name).toBe("Later");
  });

  it("reuses a same-name personal section and preserves later moves and pin choices", async () => {
    const db = database({
      sections: [section("work", "Product"), section("other")],
      bots: [member("moved", "work"), member("pinned", "work")],
      groups: [member("group", "work")],
    });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    Object.assign(db.state.bots[0]!, { sectionId: "other" });
    Object.assign(db.state.bots[1]!, { pinned: true });
    db.state.sections.push(section("new-work", "Product"), {
      ...section("foreign-work", "Product"),
      userId: "user-2",
    });
    const restored = await db.repos.restoreBotSection(actor, snapshot);
    expect(restored.id).toBe("new-work");
    expect(db.state.sections).toHaveLength(3);
    expect(db.state.bots[0]).toMatchObject({ sectionId: "other", pinned: false });
    expect(db.state.bots[1]).toMatchObject({ sectionId: "new-work", pinned: true });
    expect(db.state.groups[0]?.sectionId).toBe("new-work");
  });

  it("retries a restore name race and reuses the concurrent winner", async () => {
    const db = database({ sections: [section("work", "Product")], bots: [member("bot", "work")] });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    const conflict = { code: "P2002" };
    const transaction = db.prisma.$transaction.getMockImplementation()!;
    db.prisma.botSection.create.mockRejectedValueOnce(conflict);
    db.prisma.$transaction.mockImplementation(async (run) => {
      try {
        return await transaction(run);
      } catch (error) {
        if (error === conflict) db.state.sections.push(section("winner", "Product"));
        throw error;
      }
    });

    const restored = await db.repos.restoreBotSection(actor, snapshot);

    expect(restored.id).toBe("winner");
    expect(db.state.sections).toHaveLength(1);
    expect(db.state.bots[0]?.sectionId).toBe("winner");
  });

  it("bounds restore retries when unique conflicts persist", async () => {
    const db = database({ sections: [section("work")], bots: [member("bot", "work")] });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    const conflict = { code: "P2002" };
    db.prisma.$transaction.mockClear();
    db.prisma.botSection.create.mockRejectedValue(conflict);

    await expect(db.repos.restoreBotSection(actor, snapshot)).rejects.toBe(conflict);

    expect(db.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(db.state.sections).toEqual([]);
    expect(db.state.bots[0]?.sectionId).toBeNull();
  });

  it("rechecks foreign ownership on a restore retry before reattaching anything", async () => {
    const db = database({ sections: [section("work")], bots: [member("bot", "work")] });
    const snapshot = await db.repos.removeBotSection(actor, "work");
    const conflict = { code: "P2002" };
    const transaction = db.prisma.$transaction.getMockImplementation()!;
    db.prisma.botSection.create.mockRejectedValueOnce(conflict);
    db.prisma.$transaction.mockImplementation(async (run) => {
      try {
        return await transaction(run);
      } catch (error) {
        if (error === conflict) db.state.sections.push({ ...section("work"), userId: "user-2" });
        throw error;
      }
    });

    await expect(db.repos.restoreBotSection(actor, snapshot)).rejects.toBeInstanceOf(
      IsolationError,
    );

    expect(db.state.sections).toEqual([expect.objectContaining({ id: "work", userId: "user-2" })]);
    expect(db.state.bots[0]?.sectionId).toBeNull();
  });

  it("authorizes all restore member IDs before changing any state", async () => {
    const db = database({
      sections: [{ ...section("foreign"), userId: "user-2" }],
      bots: [
        member("own"),
        { ...member("foreign"), userId: "user-2", archivedAt: date },
        { ...member("other-space"), spaceId: "space-2" },
      ],
      groups: [{ ...member("foreign-group"), userId: "user-2" }],
    });
    const snapshot = {
      section: {
        ...section("removed"),
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
      },
      botIds: ["own"],
      groupIds: [] as string[],
    };
    for (const bad of [
      { ...snapshot, botIds: ["own", "deleted", "foreign"] },
      { ...snapshot, botIds: ["own", "other-space"] },
      { ...snapshot, groupIds: ["foreign-group"] },
      { ...snapshot, section: { ...snapshot.section, id: "foreign" } },
    ]) {
      const before = structuredClone(db.state);
      await expect(db.repos.restoreBotSection(actor, bad)).rejects.toBeInstanceOf(IsolationError);
      expect(db.state).toEqual(before);
    }
  });
});
