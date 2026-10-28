import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { TASK_CATALOG_GUIDANCE, taskCatalogFromTool } from "./task-catalog.js";

describe("task catalog", () => {
  it.each([0, 1, 49, 50, 51, 200, 201])(
    "counts and pages %s authorized matching skills",
    async (count) => {
      const { prisma, input } = catalogFixture(
        Array.from({ length: count }, (_, index) => fixtureSkill(index + 1)),
      );
      const result = await taskCatalogFromTool({ prisma: prisma as never }, input);
      expect(result.skills).toHaveLength(Math.min(count, 50));
      expect(result.skillsPage).toEqual({ total: count, nextOffset: count > 50 ? 50 : null });
      expect(prisma.agentSkill.findMany).toHaveBeenCalledOnce();
      expect(pageBytes(result)).toBeLessThanOrEqual(8192);
    },
  );

  it.each([undefined, "", "  "])(
    "includes the full effective directory for query %s",
    async (skillsQuery) => {
      const { prisma, input } = catalogFixture([fixtureSkill(1)]);
      const result = await taskCatalogFromTool(
        { prisma: prisma as never },
        { ...input, skillsQuery },
      );
      expect(result.skillsPage).toEqual({
        total: 1 + BUILTIN_AGENT_SKILLS.length,
        nextOffset: null,
      });
      expect(result.skills.some((skill) => skill.id === "skill-001")).toBe(true);
      expect(result.skills.some((skill) => skill.source === "builtin" && skill.readOnly)).toBe(
        true,
      );
    },
  );

  it("filters after owner scope and matches description substrings without leaking foreign counts", async () => {
    const rows = [
      fixtureSkill(1),
      { ...fixtureSkill(2), description: "Needle目标 recipe", source: "plugin" },
      { ...fixtureSkill(3), description: "Needle目标 foreign", userId: "other-user" },
      { ...fixtureSkill(4), description: "Needle目标 foreign", spaceId: "other-space" },
    ];
    const { prisma, input } = catalogFixture(rows);
    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      { ...input, skillsQuery: "  nEeDlE目  " },
    );
    expect(result.skillsPage).toEqual({ total: 1, nextOffset: null });
    expect(result.skills).toEqual([
      {
        id: "skill-002",
        name: "Fixture 002",
        description: "Needle目标 recipe",
        source: "plugin",
        readOnly: true,
      },
    ]);
    expect(prisma.agentSkill.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { spaceId: "space-1", userId: "user-1" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  });

  it("keeps owned builtin shadows and breaks equal-name ties by exact id", async () => {
    const builtin = BUILTIN_AGENT_SKILLS[0]!;
    const { prisma, input } = catalogFixture([
      { ...fixtureSkill(1), id: "tie-z", name: "Fixture tie" },
      { ...fixtureSkill(2), id: "tie-a", name: "Fixture tie" },
      { ...fixtureSkill(3), id: "owned-shadow", name: builtin.name },
    ]);
    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      { ...input, skillsQuery: "" },
    );
    expect(
      result.skills.filter((skill) => skill.name === "Fixture tie").map((skill) => skill.id),
    ).toEqual(["tie-a", "tie-z"]);
    expect(result.skills.find((skill) => skill.name === builtin.name)).toMatchObject({
      id: "owned-shadow",
      source: "user",
      readOnly: false,
    });
    expect(result.skillsPage.total).toBe(3 + BUILTIN_AGENT_SKILLS.length - 1);
    expect(result.skills.some((skill) => skill.id === `builtin:${builtin.name}`)).toBe(false);
  });

  it.each([1, 50, 100])("accepts an explicit limit of %s", async (skillsLimit) => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      ...fixtureSkill(index + 1),
      id: `s${String(index + 1).padStart(3, "0")}`,
      name: `Fx${String(index + 1).padStart(3, "0")}`,
      description: "",
    }));
    const { prisma, input } = catalogFixture(rows);
    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      { ...input, skillsQuery: "fx", skillsLimit },
    );
    expect(result.skills).toHaveLength(skillsLimit);
    expect(result.skillsPage).toEqual({ total: 201, nextOffset: skillsLimit });
    expect(pageBytes(result)).toBeLessThanOrEqual(8192);
  });

  it.each([200, 201, 202, Number.MAX_SAFE_INTEGER])(
    "ends or advances correctly at offset %s",
    async (skillsOffset) => {
      const { prisma, input } = catalogFixture(
        Array.from({ length: 201 }, (_, index) => fixtureSkill(index + 1)),
      );
      const result = await taskCatalogFromTool(
        { prisma: prisma as never },
        { ...input, skillsOffset },
      );
      expect(result.skills.map((skill) => skill.id)).toEqual(
        skillsOffset === 200 ? ["skill-201"] : [],
      );
      expect(result.skillsPage).toEqual({ total: 201, nextOffset: null });
    },
  );

  it.each([
    { skillsOffset: -1 },
    { skillsOffset: 0.5 },
    { skillsOffset: Number.NaN },
    { skillsOffset: Number.POSITIVE_INFINITY },
    { skillsOffset: Number.MAX_SAFE_INTEGER + 1 },
    { skillsOffset: "1" },
    { skillsOffset: null },
    { skillsLimit: 0 },
    { skillsLimit: -1 },
    { skillsLimit: 1.5 },
    { skillsLimit: 101 },
    { skillsLimit: Number.NaN },
    { skillsLimit: Number.POSITIVE_INFINITY },
    { skillsLimit: "50" },
    { skillsLimit: null },
    { skillsQuery: null },
    { skillsQuery: 1 },
    { skillsQuery: {} },
  ])("rejects malformed paging without reading the directory: %j", async (invalid) => {
    const { prisma, input } = catalogFixture([fixtureSkill(1)]);
    await expect(
      taskCatalogFromTool({ prisma: prisma as never }, { ...input, ...invalid }),
    ).rejects.toThrow(/^skills(?:Query|Offset|Limit) must/);
    expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
    expect(prisma.scratchpadItem.findMany).not.toHaveBeenCalled();
  });

  it("preserves the separate taught catalog while paging reusable skills", async () => {
    const { prisma, input } = catalogFixture([fixtureSkill(1), fixtureSkill(2)]);
    const taught = Array.from({ length: 25 }, (_, index) => ({
      id: `taught-${index}`,
      name: `Taught ${index}`,
      goal: "Unchanged goal",
      status: "saved",
    }));
    prisma.taughtSkill.findMany.mockResolvedValue(taught);
    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      { ...input, skillsLimit: 1 },
    );
    expect(result.skills).toHaveLength(1);
    expect(result.skillsPage).toEqual({ total: 2, nextOffset: 1 });
    expect(result.taughtSkills).toEqual(
      taught.map((skill) => ({ ...skill, source: "taught_skill" })),
    );
  });

  it.each([8191, 8192, 8193])(
    "accounts for the complete JSON envelope at %s bytes",
    async (bytes) => {
      const item = {
        id: "",
        name: "Fixture boundary",
        description: "DD",
        source: "user",
        readOnly: false,
      };
      const fixedBytes = Buffer.byteLength(
        JSON.stringify({ skills: [item], skillsPage: { total: 1, nextOffset: null } }),
        "utf8",
      );
      const id = "i".repeat(bytes - fixedBytes);
      const { prisma, input } = catalogFixture([{ ...fixtureSkill(1), ...item, id }]);
      const result = await taskCatalogFromTool({ prisma: prisma as never }, input);
      expect(pageBytes(result)).toBe(bytes === 8193 ? 8192 : bytes);
      expect(result.skills[0]?.id).toBe(id);
      expect(result.skills[0]?.name).toBe(item.name);
      expect(result.skills[0]?.description).toBe(bytes === 8193 ? "D" : "DD");
      expect(result.skillsPage).toEqual({ total: 1, nextOffset: null });
    },
  );

  it("reduces entries only after shortening descriptions and traverses with the actual cursor", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      ...fixtureSkill(index + 1),
      id: `full-id-${String(index + 1).padStart(3, "0")}-${"x".repeat(200)}`,
      description: "z".repeat(2000),
    }));
    const { prisma, input } = catalogFixture(rows);
    let offset: number | null = 0;
    const ids: string[] = [];
    for (let attempts = 0; offset !== null && attempts < 201; attempts++) {
      const result = await taskCatalogFromTool(
        { prisma: prisma as never },
        { ...input, skillsLimit: 100, skillsOffset: offset },
      );
      expect(result.skills.length).toBeGreaterThan(0);
      expect(result.skills.length).toBeLessThan(100);
      expect(pageBytes(result)).toBeLessThanOrEqual(8192);
      if (result.skillsPage.nextOffset !== null) {
        expect(result.skillsPage.nextOffset).toBe(offset + result.skills.length);
      }
      ids.push(...result.skills.map((skill) => skill.id));
      offset = result.skillsPage.nextOffset;
    }
    expect(offset).toBeNull();
    expect(ids).toEqual(rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(201);
    expect(rows.every((row) => row.description === "z".repeat(2000))).toBe(true);
  });

  it("fails explicitly when an intact identity cannot fit, instead of returning a stuck cursor", async () => {
    const { prisma, input } = catalogFixture([{ ...fixtureSkill(1), id: "x".repeat(9000) }]);
    await expect(taskCatalogFromTool({ prisma: prisma as never }, input)).rejects.toThrow(
      "A skill identity exceeds the catalog page limit. Narrow skillsQuery to continue.",
    );
  });

  it("propagates directory failures without a fabricated page or retries", async () => {
    const { prisma, input } = catalogFixture([fixtureSkill(1)]);
    const error = new Error("Synthetic directory unavailable");
    prisma.agentSkill.findMany.mockRejectedValueOnce(error);
    await expect(taskCatalogFromTool({ prisma: prisma as never }, input)).rejects.toBe(error);
    expect(prisma.agentSkill.findMany).toHaveBeenCalledOnce();
    const result = await taskCatalogFromTool({ prisma: prisma as never }, input);
    expect(result.skillsPage).toEqual({ total: 1, nextOffset: null });
    expect(prisma.agentSkill.findMany).toHaveBeenCalledTimes(2);
  });

  it("shortens descriptions to bound the complete page without changing stored metadata", async () => {
    const description = '🧪中"\\\n'.repeat(200);
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...fixtureSkill(index + 1),
      description,
    }));
    const { prisma, input } = catalogFixture(rows);
    const result = await taskCatalogFromTool({ prisma: prisma as never }, input);
    expect(result.skills).toHaveLength(20);
    expect(result.skillsPage).toEqual({ total: 20, nextOffset: null });
    expect(pageBytes(result)).toBeLessThanOrEqual(8192);
    for (const skill of result.skills) {
      expect(description.startsWith(skill.description)).toBe(true);
      expect(skill.description).not.toBe(description);
      expect(Buffer.from(skill.description, "utf8").toString("utf8")).toBe(skill.description);
      expect(skill).toMatchObject({
        id: expect.stringMatching(/^skill-\d{3}$/),
        source: "user",
        readOnly: false,
      });
    }
    expect(rows.every((row) => row.description === description)).toBe(true);
  });

  it("discovers all 201 matching skills through stable pages with exact ids", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => fixtureSkill(index + 1));
    const { prisma, input } = catalogFixture(rows.reverse());
    const first = await taskCatalogFromTool({ prisma: prisma as never }, input);
    expect(first.skills).toHaveLength(50);
    expect(first.skillsPage).toEqual({ total: 201, nextOffset: 50 });
    expect(first.skills[0]).toMatchObject({ id: "skill-001", name: "Fixture 001" });
    const ids = first.skills.map((skill) => skill.id);
    let nextOffset = first.skillsPage.nextOffset;
    for (let attempts = 0; nextOffset !== null && attempts < 201; attempts++) {
      const page = await taskCatalogFromTool(
        { prisma: prisma as never },
        { ...input, skillsOffset: nextOffset },
      );
      expect(page.skillsPage.total).toBe(201);
      ids.push(...page.skills.map((skill) => skill.id));
      nextOffset = page.skillsPage.nextOffset;
    }
    expect(nextOffset).toBeNull();
    expect(ids).toEqual(
      Array.from({ length: 201 }, (_, index) => `skill-${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(ids).size).toBe(201);
    expect(JSON.stringify(first)).not.toContain("Original body");
    expect(prisma.agentSkill.findMany).toHaveBeenCalledTimes(5);
  });

  it("returns the bot's real work records and exposed tool roster", async () => {
    const prisma = {
      $queryRaw: vi.fn(async () => [{ ownedRoutineId: "routine-1", id: null }]),
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "item-1",
            botId: "bot-1",
            title: "Check the inbox",
            status: "open",
            notes: "Use the connected mail tool.",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      routine: {
        findMany: vi.fn(async () => [
          {
            id: "routine-1",
            name: "Morning report",
            prompt: "Read the report and summarize it.",
            crons: ["0 9 * * *"],
            active: true,
            nextRunAt: new Date("2026-01-03T09:00:00.000Z"),
          },
        ]),
      },
      taughtSkill: {
        findMany: vi.fn(async (_args: Record<string, unknown>) => [
          { id: "taught-1", name: "Export report", goal: "Export the report", status: "saved" },
        ]),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily report",
            description: "Build the daily report",
            content: "steps",
            source: "user",
          },
        ]),
      },
    };

    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        tools: [
          { name: "task_catalog", description: "Catalog", readOnly: true },
          { name: "task_catalog", description: "Duplicate", readOnly: true },
          { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
        ],
      },
    );

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: "item-1", title: "Check the inbox", source: "scratchpad" }),
    ]);
    expect(result.routines).toEqual([
      expect.objectContaining({ routineId: "routine-1", name: "Morning report", active: true }),
    ]);
    expect(result.routines[0]?.nativeTriggers).toEqual([]);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(result.taughtSkills).toEqual([
      {
        id: "taught-1",
        name: "Export report",
        goal: "Export the report",
        status: "saved",
        source: "taught_skill",
      },
    ]);
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          botId: "bot-1",
          status: "saved",
        },
      }),
    );
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ userId: expect.anything() }),
      }),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Daily report", source: "user", readOnly: false }),
      ]),
    );
    expect(result.tools).toEqual([
      { name: "task_catalog", description: "Catalog", readOnly: true },
      { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
    ]);
    expect(result.guidance).toBe(TASK_CATALOG_GUIDANCE);
  });

  it("treats a retry as the same tool call with the same arguments", () => {
    expect(TASK_CATALOG_GUIDANCE).toContain(
      "Correct the specific field once as a separate attempt; if that attempt fails, stop and explain the blocker",
    );
    expect(TASK_CATALOG_GUIDANCE).not.toContain("after a second failure of the same call");
    expect(TASK_CATALOG_GUIDANCE).toContain("A different command is not a retry.");
    expect(TASK_CATALOG_GUIDANCE).not.toContain("after a second failure, stop");
  });
});

type FixtureSkill = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  spaceId: string;
  userId: string;
};

function fixtureSkill(index: number): FixtureSkill {
  const number = String(index).padStart(3, "0");
  return {
    id: `skill-${number}`,
    name: `Fixture ${number}`,
    description: "Reusable fixture recipe",
    content: `Original body ${number}`,
    source: "user",
    spaceId: "space-1",
    userId: "user-1",
  };
}

function catalogFixture(rows: FixtureSkill[]) {
  return {
    prisma: {
      $queryRaw: vi.fn(async () => []),
      scratchpadItem: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      taughtSkill: {
        findMany: vi.fn(
          async (): Promise<
            Array<{ id: string; name: string; goal: string; status: string }>
          > => [],
        ),
      },
      agentSkill: {
        findMany: vi.fn(async ({ where }: { where: { spaceId: string; userId: string } }) =>
          rows.filter((row) => row.spaceId === where.spaceId && row.userId === where.userId),
        ),
      },
    },
    input: {
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      tools: [],
      skillsQuery: "Fixture",
    },
  };
}

function pageBytes(result: Awaited<ReturnType<typeof taskCatalogFromTool>>) {
  return Buffer.byteLength(
    JSON.stringify({ skills: result.skills, skillsPage: result.skillsPage }),
    "utf8",
  );
}
