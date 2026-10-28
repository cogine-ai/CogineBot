import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { SkillSource } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { listSchedulesFromTool } from "./schedule-tools.js";
import { listScratchpadItems } from "./scratchpad-tools.js";
import { listAgentSkillRecords } from "./skill-tools.js";

export type TaskCatalogToolDeps = {
  prisma: PrismaClient;
};

type TaskCatalogInput = {
  spaceId: string;
  botId: string;
  userId: string;
  threadId?: string;
  tools: readonly Pick<ConnectorTool, "name" | "description" | "readOnly">[];
  skillsQuery?: unknown;
  skillsOffset?: unknown;
  skillsLimit?: unknown;
};

type CatalogSkill = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  readOnly: boolean;
};

const SKILLS_PAGE_BYTE_LIMIT = 8192;

/**
 * Guidance injected alongside the catalog tool. Keep this short: the live
 * records returned by task_catalog are the source of truth for names and ids.
 */
export const TASK_CATALOG_GUIDANCE = [
  "Task execution: task_catalog is the source of truth for this bot's open work, routines, skills, and exposed tools; conversation or memory text is not proof that a task exists.",
  "When a request refers to an existing task, routine, skill, or capability, call task_catalog first and use the exact returned id/name.",
  "For an open task, perform the work with the exposed tools, verify the result, then use scratchpad_update or scratchpad_complete. Never mark work done before verification.",
  "For a schedule, provide exactly one timing mode to schedule_create (cron, every+unit, runAt, delayMinutes, or delaySeconds), then call schedule_list and only report success when the routine is present.",
  "If a tool returns an error, do not repeat the same tool call with the same arguments. Correct the specific field once as a separate attempt; if that attempt fails, stop and explain the blocker instead of narrating more retries. A different command is not a retry.",
].join("\n");

export async function taskCatalogFromTool(deps: TaskCatalogToolDeps, input: TaskCatalogInput) {
  const { query, offset, limit } = skillsCatalogOptions(input);
  const [tasks, schedules, taughtSkills, skills] = await Promise.all([
    listScratchpadItems(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      includeDone: false,
    }),
    listSchedulesFromTool(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }),
    deps.prisma.taughtSkill.findMany({
      where: {
        spaceId: input.spaceId,
        botId: input.botId,
        status: "saved",
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, name: true, goal: true, status: true },
    }),
    listAgentSkillRecords(deps.prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
    }),
  ]);

  const seenTools = new Set<string>();
  const exposedTools = input.tools.flatMap((tool) => {
    if (seenTools.has(tool.name)) return [];
    seenTools.add(tool.name);
    return [
      {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly ?? false,
      },
    ];
  });

  const matchingSkills = skills
    .filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query),
    )
    .sort((left, right) => {
      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      if (left.id !== right.id) return left.id < right.id ? -1 : 1;
      return 0;
    });
  const page = matchingSkills.slice(offset, offset + limit).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
  }));

  return {
    guidance: TASK_CATALOG_GUIDANCE,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      notes: task.notes,
      source: "scratchpad",
    })),
    routines: schedules.routines,
    taughtSkills: taughtSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      goal: skill.goal,
      status: skill.status,
      source: "taught_skill",
    })),
    ...boundedSkillsPage(page, matchingSkills.length, offset),
    tools: exposedTools,
  };
}

function boundedSkillsPage(skills: CatalogSkill[], total: number, offset: number) {
  const metadata = (count: number) => ({
    total,
    nextOffset: offset + count < total ? offset + count : null,
  });
  if (skills.length === 0) return { skills, skillsPage: metadata(0) };

  // Shorten descriptions before reducing the number of intact identities.
  const identities: CatalogSkill[] = [];
  let entriesBytes = 0;
  for (const skill of skills) {
    const identity = { ...skill, description: "" };
    const identityBytes = Buffer.byteLength(JSON.stringify(identity), "utf8");
    const count = identities.length + 1;
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ skills: [], skillsPage: metadata(count) }),
      "utf8",
    );
    if (envelopeBytes + entriesBytes + identityBytes + count - 1 > SKILLS_PAGE_BYTE_LIMIT) break;
    identities.push(identity);
    entriesBytes += identityBytes;
  }
  if (identities.length === 0) {
    throw new Error(
      "A skill identity exceeds the catalog page limit. Narrow skillsQuery to continue.",
    );
  }
  const skillsPage = metadata(identities.length);
  const minimumBytes = Buffer.byteLength(
    JSON.stringify({ skills: identities, skillsPage }),
    "utf8",
  );
  const remainingBytes = SKILLS_PAGE_BYTE_LIMIT - minimumBytes;
  const descriptions = skills.slice(0, identities.length).map((skill) => {
    const characters: string[] = [];
    for (const character of skill.description) {
      if (characters.length === remainingBytes) break;
      characters.push(character);
    }
    return characters;
  });
  const page = (length: number) => ({
    skills: identities.map((identity, index) => ({
      ...identity,
      description: descriptions[index]!.slice(0, length).join(""),
    })),
    skillsPage,
  });
  let low = 0;
  let high = Math.max(...descriptions.map((description) => description.length));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(page(middle)), "utf8") <= SKILLS_PAGE_BYTE_LIMIT)
      low = middle;
    else high = middle - 1;
  }
  return page(low);
}

function skillsCatalogOptions(input: TaskCatalogInput) {
  const query = input.skillsQuery === undefined ? "" : input.skillsQuery;
  const offset = input.skillsOffset === undefined ? 0 : input.skillsOffset;
  const limit = input.skillsLimit === undefined ? 50 : input.skillsLimit;
  if (typeof query !== "string") throw new Error("skillsQuery must be a string.");
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("skillsOffset must be a non-negative safe integer.");
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("skillsLimit must be an integer from 1 to 100.");
  }
  return { query: query.trim().toLowerCase(), offset, limit };
}
