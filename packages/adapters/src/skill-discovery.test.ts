import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { boundToolResultText } from "./context-selection.js";
import { createRunExecutor } from "./executor.js";
import { serializeToolResult } from "./pi-runtime.js";

type SkillRow = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  description: string;
  content: string;
  source: string;
};
type Catalog = {
  skills: Array<{ id: string; name: string; source: string; readOnly: boolean }>;
  skillsPage: { total: number; nextOffset: number | null };
};
const owner = { spaceId: "space-1", userId: "user-1" };

function skillRows() {
  return Array.from({ length: 201 }, (_, index): SkillRow => {
    const number = String(index + 1).padStart(3, "0");
    const name = index === 0 ? BUILTIN_AGENT_SKILLS[0]!.name : `Recipe ${number}`;
    return {
      id: `skill-${number}`,
      ...owner,
      name,
      description: `Find marker ${number}`,
      content: `---\nname: ${name}\ndescription: Find marker ${number}\n---\n\nSearch for: recipe-${number}\r\n`,
      source: index === 200 ? "plugin" : "user",
    };
  });
}

async function runDiscovery(
  rows: SkillRow[],
  script: (request: AgentRunRequest) => Promise<void>,
  options: {
    largeCatalog?: boolean;
    protectedOverflow?: boolean;
    disabledCatalog?: boolean;
    prompt?: string;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    ...owner,
    status: "queued",
    trigger: "routine",
    routineId: "routine-1",
    retryOfRunId: null,
    leaseFence: 0,
    checkpoint: null,
  };
  const taught = Array.from({ length: 23 }, (_, index) => ({
    id: `taught-${index}`,
    name: `Taught ${String(index).padStart(2, "0")}`,
    goal: "Independent playbook",
    status: "saved",
    playbook: { steps: [] },
  }));
  const computer = {
    id: "computer-1",
    scope: "dedicated",
    state: "stopped",
    kind: "e2b",
    providerRef: null,
    homeKey: "home-1",
  };
  const prisma = {
    $queryRaw: vi.fn(async () =>
      options.largeCatalog ? [{ ownedRoutineId: "catalog-routine", id: null }] : [],
    ),
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: {
      findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })),
      findMany: vi.fn(async () =>
        options.largeCatalog
          ? [
              {
                id: "catalog-routine",
                name: "Saved routine",
                prompt: "Routine instructions ".repeat(2_000),
                crons: ["0 9 * * *"],
                active: true,
                nextRunAt: new Date(0),
              },
            ]
          : [],
      ),
    },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        disabledBuiltinTools: options.disabledCatalog ? ["task_catalog"] : [],
        computer,
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.taskId,
        prompt: options.prompt ?? "Find the requested reusable recipe and follow it.",
      })),
    },
    computer: { findUniqueOrThrow: vi.fn(async () => computer) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => taught) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: {
      findMany: vi.fn(async ({ where }: { where: typeof owner }) =>
        rows.filter((row) => row.spaceId === where.spaceId && row.userId === where.userId),
      ),
    },
    scratchpadItem: {
      findMany: vi.fn(async () =>
        options.largeCatalog || options.protectedOverflow
          ? [
              {
                id: options.protectedOverflow ? "task-".repeat(5_000) : "task-exact",
                botId: run.botId,
                title: "Open work",
                status: "open",
                notes: "Evidence ".repeat(5_000),
                createdAt: new Date(0),
                updatedAt: new Date(0),
              },
            ]
          : [],
      ),
    },
    externalEffect: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    artifact: { findMany: vi.fn(async () => []) },
  };
  let callbackError: unknown;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    try {
      await script(request);
    } catch (error) {
      callbackError = error;
      throw error;
    }
    yield { type: "done" as const, text: "Recipe checked." };
  });
  const search = vi.fn(async () => [
    { title: "Synthetic result", url: "https://example.test", snippet: "Verified" },
  ]);
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    shutdownSignal: new AbortController().signal,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ id: "fixture-sandbox", capabilities: { graphical: false } }) },
    web: {
      describe: () => ({ id: "fixture-web", capabilities: { search: true, fetch: true } }),
      search,
    },
    home: { commit: vi.fn(async () => "synthetic-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: { append: vi.fn(), finalizeRun },
    jobs: { enqueue: vi.fn() },
    notifications: { send: vi.fn() },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  if (callbackError) throw callbackError;
  expect(runtimeRun).toHaveBeenCalledOnce();
  expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  return { prisma, search };
}

describe("model-visible skill discovery", () => {
  it("offers bounded catalog parameters and permits id-only skill reads", () => {
    const catalog = builtinAgentTools.find((tool) => tool.name === "task_catalog")!;
    expect(catalog.inputSchema.properties).toMatchObject({
      skillsQuery: { type: "string" },
      skillsOffset: { type: "integer", minimum: 0 },
      skillsLimit: { type: "integer", minimum: 1, maximum: 100 },
    });
    const read = builtinAgentTools.find((tool) => tool.name === "skill_read")!;
    expect(read.inputSchema.properties).toHaveProperty("skillId");
    expect(read.inputSchema.required ?? []).not.toContain("name");
  });

  it.each([51, 200, 201])(
    "discovers recipe %s through the executor and follows its exact content",
    async (target) => {
      const rows = skillRows();
      rows.push({
        ...rows[0]!,
        id: "foreign",
        spaceId: "other-space",
        name: "Private",
        description: `Find marker ${String(target).padStart(3, "0")}`,
        content: "private",
      });
      const number = String(target).padStart(3, "0");
      const f = await runDiscovery(rows, async (request) => {
        const catalog = (await request.executeTool!(
          "task_catalog",
          {
            skillsQuery: ` MARKER ${number} `,
            skillsLimit: 1,
            userId: "other-user",
            spaceId: "other-space",
          },
          "catalog",
        )) as Catalog;
        expect(catalog.skillsPage).toEqual({ total: 1, nextOffset: null });
        expect(catalog.skills).toEqual([
          expect.objectContaining({
            id: `skill-${number}`,
            source: target === 201 ? "plugin" : "user",
            readOnly: target === 201,
          }),
        ]);
        const read = (await request.executeTool!(
          "skill_read",
          { skillId: catalog.skills[0]!.id },
          "read",
        )) as { content: string };
        expect(read.content).toBe(rows[target - 1]!.content);
        const query = /Search for: ([^\r\n]+)/.exec(read.content)![1]!;
        await request.executeTool!("web_search", { query }, "execute-recipe");
      });
      expect(f.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: `recipe-${number}` }),
        expect.objectContaining(owner),
      );
      expect(
        f.prisma.agentSkill.findMany.mock.calls.every(
          ([args]) => args.where.spaceId === owner.spaceId && args.where.userId === owner.userId,
        ),
      ).toBe(true);
    },
  );

  it("uses actual pagination wiring and rechecks ownership after a page was returned", async () => {
    const rows = skillRows();
    await runDiscovery(rows, async (request) => {
      const first = (await request.executeTool!(
        "task_catalog",
        { skillsLimit: 1 },
        "first",
      )) as Catalog;
      const second = (await request.executeTool!(
        "task_catalog",
        { skillsLimit: 1, skillsOffset: first.skillsPage.nextOffset },
        "second",
      )) as Catalog;
      expect(first.skills).toHaveLength(1);
      expect(second.skills).toHaveLength(1);
      expect(second.skills[0]!.id).not.toBe(first.skills[0]!.id);
      const target = (await request.executeTool!(
        "task_catalog",
        { skillsQuery: "marker 201" },
        "target",
      )) as Catalog;
      rows[200]!.userId = "other-user";
      expect(
        await request.executeTool!(
          "skill_read",
          { skillId: target.skills[0]!.id, name: rows[1]!.name },
          "revoked",
        ),
      ).toEqual({ error: "Skill not found." });
      await expect(
        request.executeTool!("task_catalog", { skillsOffset: "1" }, "invalid"),
      ).rejects.toThrow("skillsOffset");
    });
  });

  it("requires exact ids for same-name recipes through the model's actual read tool", async () => {
    const rows = skillRows();
    rows[49]!.name = "Shared review";
    rows[199]!.name = " shared REVIEW ";
    rows[49]!.description = rows[199]!.description = "duplicate-marker";
    rows.push({ ...rows[49]!, id: "foreign-review", userId: "other-user", content: "private" });
    await runDiscovery(rows, async (request) => {
      const catalog = (await request.executeTool!(
        "task_catalog",
        { skillsQuery: "duplicate-marker" },
        "catalog",
      )) as Catalog;
      expect(catalog.skillsPage.total).toBe(2);
      expect(new Set(catalog.skills.map((skill) => skill.id))).toEqual(
        new Set(["skill-050", "skill-200"]),
      );
      expect(
        await request.executeTool!("skill_read", { name: "SHARED review" }, "ambiguous"),
      ).toEqual({ error: "Multiple skills match this name. Use an exact skillId." });
      for (const skill of catalog.skills) {
        const read = (await request.executeTool!(
          "skill_read",
          { skillId: skill.id },
          skill.id,
        )) as { content: string };
        expect(read.content).toBe(rows.find((row) => row.id === skill.id)!.content);
      }
    });
  });

  it.each(["/Recipe 201\nFollow this recipe.", "Follow @Recipe 201"])(
    "keeps explicit expansion outside the prompt preview for %j",
    async (prompt) => {
      await runDiscovery(
        skillRows(),
        async (request) => {
          expect(request.prompt).toContain("Search for: recipe-201");
          expect(request.prompt).not.toContain("@Recipe 201");
        },
        { prompt },
      );
    },
  );

  it("keeps taught prompt limits separate while discovering the complete reusable catalog", async () => {
    const rows = skillRows();
    await runDiscovery(rows, async (request) => {
      expect(request.instructions).toContain("Taught 19");
      expect(request.instructions).not.toContain("Taught 20");
      expect(request.instructions).not.toContain("Recipe 201:");
      const catalog = (await request.executeTool!("task_catalog", {}, "catalog")) as Catalog & {
        taughtSkills: unknown[];
      };
      expect(catalog.taughtSkills).toHaveLength(23);
      expect(catalog.skillsPage.total).toBe(201 + BUILTIN_AGENT_SKILLS.length - 1);
      expect(catalog.skills.find((skill) => skill.id === "skill-001")).toMatchObject({
        source: "user",
        readOnly: false,
      });
    });
  });

  it("does not advertise a disabled catalog in the reusable skill prompt", async () => {
    await runDiscovery(
      skillRows(),
      async (request) => {
        expect(request.tools.map((tool) => tool.name)).not.toContain("task_catalog");
        expect(request.instructions).not.toContain("task_catalog");
        expect(request.instructions).toContain("Recipe 002");
      },
      { disabledCatalog: true },
    );
  });

  it.each(["", null, 0, false, {}])(
    "does not substitute a name for an invalid explicit skill id %j",
    async (skillId) => {
      await runDiscovery(skillRows(), async (request) => {
        const result = await request.executeTool!(
          "skill_read",
          { skillId, name: "Recipe 002" },
          "invalid-id",
        );
        expect(result).toMatchObject({ error: expect.any(String) });
        expect(result).not.toHaveProperty("content");
      });
    },
  );

  it("preserves exact skill ids and numeric cursors through current and history result budgets", async () => {
    const rows = skillRows();
    rows.forEach((row) => {
      row.description = `"資料😀" ${"description ".repeat(100)}`;
    });
    await runDiscovery(
      rows,
      async (request) => {
        const raw = (await request.executeTool!(
          "task_catalog",
          { skillsLimit: 50 },
          "catalog",
        )) as Catalog;
        expect(raw.skillsPage.nextOffset).toBeGreaterThan(0);
        for (const strategy of ["current", "retrieval"] as const) {
          const current = serializeToolResult(raw, strategy, "task_catalog", { skillsLimit: 50 });
          const historical = boundToolResultText(current, 10_000, {
            retained: true,
            wrapped: true,
          });
          for (const text of [current, historical]) {
            expect(text.length).toBeLessThanOrEqual(12_000);
            const parsed = JSON.parse(text);
            expect(parsed.historyReference).toBeUndefined();
            const view = (parsed.result ?? parsed.controlMetadata) as Catalog;
            expect(view.skills.map((skill) => skill.id)).toEqual(
              raw.skills.map((skill) => skill.id),
            );
            expect(view.skillsPage).toEqual(raw.skillsPage);
            expect(view).toMatchObject({
              tasks: [{ id: "task-exact" }],
              routines: [{ routineId: "catalog-routine" }],
            });
          }
        }
      },
      { largeCatalog: true },
    );
  });

  it("returns a bounded honest failure when protected metadata cannot fit the final result", async () => {
    await runDiscovery(
      skillRows(),
      async (request) => {
        const raw = await request.executeTool!("task_catalog", {}, "catalog");
        const current = serializeToolResult(raw, "current", "task_catalog", {});
        const historical = boundToolResultText(current, 1_000, { retained: true, wrapped: true });
        for (const text of [current, historical]) {
          expect(text.length).toBeLessThanOrEqual(1_000);
          expect(JSON.parse(text)).toEqual({
            contextTruncated: true,
            error: "budget_error",
            historyUnavailable: true,
          });
        }
      },
      { protectedOverflow: true },
    );
  });
});
