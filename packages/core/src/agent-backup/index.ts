import type {
  AgentBackupDocument,
  AgentBackupOmissionReason,
  AgentBackupSource,
  BotPackagePreviewInput,
} from "@rakazo/contracts";
import {
  AGENT_BACKUP_FORMAT,
  AGENT_BACKUP_MAX_FILES,
  AgentBackupDocumentSchema,
  agentBackupOmissionReasons,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_PACKAGE_MAX_BYTES,
  BOT_PACKAGE_MAX_MEMORY_FILES,
  BOT_PACKAGE_MAX_ROUTINES,
  BOT_PACKAGE_MEMORY_MAX_BYTES,
  BotPackageMemorySchema,
  BotPackageSkillSchema,
  botPackageUtf8Bytes,
  isAgentBackupPath,
} from "@rakazo/contracts";
import type { ParsedSkillMd } from "../agent-skill.js";
import { parseSkillMd } from "../agent-skill.js";
import { AgentImportArchiveError, openAgentImportArchive } from "./archive.js";
import { parseOpenClawIdentity } from "./identity.js";
import {
  backupJobsPath,
  backupWorkspaceAgent,
  isBackupRoutine,
  isBackupRoutineOmission,
  projectBackupJobs,
  readBackupRoutine,
} from "./routines.js";
import { isHermesDefault, isOpenClawDefault } from "./stock.js";

const openClawInstructions = ["SOUL.md", "AGENTS.md"] as const;
const hermesInstructions = ["SOUL.md", "AGENTS.md", "HERMES.md", ".hermes.md"] as const;
export const backupInstructions = {
  openclaw: openClawInstructions,
  hermes: hermesInstructions,
};
export const openClawRuntimeFiles = new Set([
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "BOOT.md",
]);
export const isBackupSkill = (path: string) =>
  /^(?:\.agents\/)?skills\/(?:[^/]+\/){1,4}SKILL\.md$/.test(path);
export function isBackupMemory(source: AgentBackupSource, path: string) {
  return source === "openclaw"
    ? /^(?:MEMORY|USER)\.md$|^memory\/[^/]+\.md$/.test(path)
    : /^memories\/(?:MEMORY|USER)\.md$/.test(path);
}

export function selectBackupMemory(
  source: AgentBackupSource,
  files: AgentBackupDocument["files"],
  omit?: (path: string, reason: string) => void,
) {
  const candidates = backupMemoryCandidates(source, files, (path, reason) =>
    omit?.(path, agentBackupOmissionReasons[reason]),
  );
  const notes: AgentBackupDocument["files"] = [];
  let totalBytes = 0;
  for (const { file, note } of candidates) {
    const bytes = botPackageUtf8Bytes(note.content);
    if (
      notes.length >= BOT_PACKAGE_MAX_MEMORY_FILES ||
      totalBytes + bytes > BOT_PACKAGE_MEMORY_MAX_BYTES
    ) {
      omit?.(file.path, "This note exceeds the Bot memory limits.");
      continue;
    }
    totalBytes += bytes;
    notes.push(note);
  }
  return { notes, available: candidates.length };
}

function backupMemoryCandidates(
  source: AgentBackupSource,
  files: AgentBackupDocument["files"],
  omit?: (path: string, reason: AgentBackupOmissionReason) => void,
) {
  const candidates: {
    file: AgentBackupDocument["files"][number];
    note: AgentBackupDocument["files"][number];
  }[] = [];
  const sorted = files
    .filter(({ path }) => isBackupMemory(source, path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const { path, content } = file;
    if (!content.trim()) continue;
    if (source === "openclaw" && isOpenClawDefault(path, content)) {
      omit?.(path, "stock");
      continue;
    }
    const note =
      source === "hermes"
        ? content
            .replace(/\r\n?/g, "\n")
            .split(/^[^\S\n]*§[^\S\n]*$/m)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .join("\n\n")
        : content;
    if (!note) continue;
    const target = source === "hermes" ? path.slice("memories/".length) : path;
    const candidate = BotPackageMemorySchema.safeParse({ path: target, content: note });
    if (!candidate.success) {
      omit?.(path, "memoryLimit");
      continue;
    }
    candidates.push({ file, note: candidate.data });
  }
  return candidates;
}

export function isBackupTextFile(source: AgentBackupSource, path: string) {
  return (
    backupInstructions[source].some((file) => file === path) ||
    isBackupMemory(source, path) ||
    isBackupSkill(path) ||
    (source === "openclaw" && (path === "IDENTITY.md" || openClawRuntimeFiles.has(path)))
  );
}

export { validateBackupRoutine } from "./routines.js";
export { isBackupRoutine, isBackupRoutineOmission };

export function assessBackupSkill(
  content: string,
  incomplete: boolean,
): { skill: ParsedSkillMd } | { reason: AgentBackupOmissionReason } {
  if (incomplete) return { reason: "missingSkillFiles" };
  const skill = parseSkillMd(content);
  if ("error" in skill) return { reason: "invalidSkill" };
  if (/\{baseDir\}|(?:^|[\s(`'"/])(?:scripts|references|templates|assets)\//m.test(skill.body))
    return { reason: "missingSkillFiles" };
  const { frontmatter } = skill;
  const metadata = frontmatter.metadata;
  if (
    Object.keys(frontmatter).some((key) =>
      /^(?:requires|prerequisites|platforms|os|required_environment_variables|allowed-tools)$/i.test(
        key,
      ),
    ) ||
    (typeof metadata === "string" && metadata.trim()) ||
    (metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      Object.keys(metadata).some((key) => /^(?:openclaw|hermes)$/i.test(key)))
  )
    return { reason: "skillRequirements" };
  if (
    !BotPackageSkillSchema.safeParse({ name: skill.name, description: skill.description, content })
      .success
  )
    return { reason: "skillLimit" };
  return { skill };
}

export function isStockBackupInstruction(source: AgentBackupSource, path: string, content: string) {
  return source === "openclaw"
    ? isOpenClawDefault(path, content)
    : path === "SOUL.md" && isHermesDefault(content);
}

function backupInstructionOmission(
  source: AgentBackupSource,
  path: string,
  content: string,
): AgentBackupOmissionReason | null {
  if (isStockBackupInstruction(source, path, content)) return "stock";
  if (source === "openclaw" && path === "IDENTITY.md") {
    const { name, description } = parseOpenClawIdentity(content);
    return name || description ? null : "identity";
  }
  return content.length > BOT_INSTRUCTIONS_MAX_LENGTH ? "instructionLimit" : null;
}

function sourceLayout(paths: readonly string[]): { source: AgentBackupSource; home: string } {
  const roots = new Map<string, AgentBackupSource>();
  for (const path of paths) {
    for (const source of ["openclaw", "hermes"] as const) {
      const label = `.${source}/`;
      const offset = path.startsWith(label) ? 0 : path.indexOf(`/${label}`) + 1;
      if (path.startsWith(label, offset)) roots.set(path.slice(0, offset + label.length), source);
    }
  }
  if (roots.size > 1) throw new AgentImportArchiveError("unreadable");
  const root = roots.entries().next().value;
  if (root) return { home: root[0], source: root[1] };
  const first = paths[0]?.split("/")[0];
  const wrapped =
    first &&
    !["skills", ".agents", "memory", "memories"].includes(first) &&
    !/^workspace(?:-[^/]+)?$/.test(first) &&
    paths.every((path) => path.startsWith(`${first}/`));
  const home = wrapped ? `${first}/` : "";
  const relative = paths.map((path) => path.slice(home.length));
  const openclaw = relative.some(
    (path) =>
      path === "openclaw.json" || path === "IDENTITY.md" || /^workspace(?:-[^/]+)?\//.test(path),
  );
  const hermes = relative.some(
    (path) => path === "config.yaml" || path === "HERMES.md" || path.startsWith("memories/"),
  );
  if (openclaw === hermes) throw new AgentImportArchiveError("unreadable");
  return { home, source: openclaw ? "openclaw" : "hermes" };
}

/** Reduce a selected backup on-device to known text files. No secret/config file is sent. */
export function encodeAgentBackup(data: Uint8Array): string {
  const archive = openAgentImportArchive(data);
  const { source, home } = sourceLayout(archive.paths);
  const relative = archive.paths
    .filter((path) => path.startsWith(home))
    .map((path) => [path, path.slice(home.length)] as const);
  const workspaces = new Set(
    relative.flatMap(([, path]) => {
      const [folder = "", ...rest] = path.split("/");
      const file = rest.join("/");
      return /^workspace(?:-[^/]+)?$/.test(folder) &&
        isBackupTextFile(source, file) &&
        !openClawRuntimeFiles.has(file)
        ? [folder]
        : [];
    }),
  );
  const [workspace] = workspaces;
  if (source === "openclaw" && workspaces.size > 1) throw new AgentImportArchiveError("unreadable");
  const files = new Map<string, string>();
  const add = (path: string, name: string) => {
    if (!isBackupTextFile(source, name)) return;
    if (!isAgentBackupPath(name)) throw new AgentImportArchiveError("unreadable");
    files.set(name, path);
    if (files.size > AGENT_BACKUP_MAX_FILES) throw new AgentImportArchiveError("too_large");
  };
  if (source === "openclaw" && workspace) {
    for (const [path, name] of relative) {
      if (name.startsWith(`${workspace}/`)) add(path, name.slice(workspace.length + 1));
    }
    for (const [path, name] of relative) {
      if (name.startsWith("skills/") && !files.has(name)) add(path, name);
    }
  } else if (source !== "openclaw" || !archive.declaredWorkspace) {
    for (const [path, name] of relative) add(path, name);
  }
  const jobPath = `${home}${backupJobsPath}`;
  const jobs = archive.readOptional(jobPath);
  const agentId =
    source === "openclaw" && jobs !== undefined
      ? backupWorkspaceAgent(
          archive.readOpenClawConfig(),
          archive.workspaceSourcePath ??
            (archive.stateSourcePath && workspace
              ? `${archive.stateSourcePath}/${workspace}`
              : undefined),
        )
      : null;
  const projected = jobs === undefined ? [] : projectBackupJobs(source, jobs, agentId);
  const routineOmissions = projected.flatMap((job) => ("reason" in job ? [job] : []));
  if (jobs === undefined && archive.has(jobPath))
    routineOmissions.push({ path: backupJobsPath, reason: "routineSchedule" });
  const routineFiles = projected.flatMap((job) =>
    "routine" in job ? [{ path: job.path, content: JSON.stringify(job.routine) }] : [],
  );
  if (source === "openclaw" && archive.declaredWorkspace && !workspace && !routineFiles.length)
    throw new AgentImportArchiveError("unreadable");
  if (files.size + routineFiles.length > AGENT_BACKUP_MAX_FILES)
    throw new AgentImportArchiveError("too_large");
  const backup: AgentBackupDocument = {
    format: AGENT_BACKUP_FORMAT,
    source,
    files: [
      ...[...files].map(([path, archivePath]) => ({
        path,
        content:
          source === "openclaw" && openClawRuntimeFiles.has(path) ? "" : archive.read(archivePath),
      })),
      ...routineFiles,
    ],
    excludedMemoryCount: 0,
    incompleteSkills: [...files].flatMap(([path, archivePath]) => {
      if (!isBackupSkill(path)) return [];
      const folder = archivePath.slice(0, -"SKILL.md".length);
      return [...archive.paths, ...archive.skippedPaths].some(
        (candidate) => candidate !== archivePath && candidate.startsWith(folder),
      )
        ? [path]
        : [];
    }),
    ...(routineOmissions.length ? { routineOmissions } : {}),
  };
  const parsed = AgentBackupDocumentSchema.safeParse(backup);
  if (!parsed.success) throw new AgentImportArchiveError("unreadable");
  const text = JSON.stringify(parsed.data);
  if (botPackageUtf8Bytes(text) > BOT_PACKAGE_MAX_BYTES)
    throw new AgentImportArchiveError("too_large");
  return text;
}

export function readBotImportBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > BOT_PACKAGE_MAX_BYTES) throw new AgentImportArchiveError("too_large");
  if ((bytes[0] === 0x50 && bytes[1] === 0x4b) || (bytes[0] === 0x1f && bytes[1] === 0x8b))
    return encodeAgentBackup(bytes);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export { parseOpenClawIdentity } from "./identity.js";
export { isHermesDefault, isOpenClawDefault } from "./stock.js";
export { AgentImportArchiveError };

/** Rewrite only the name in a colliding Skill, retaining the original Markdown. */
export function renameBackupSkill(content: string, name: string): string {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/.exec(content);
  if (!match) return content;
  const head = match[1]!;
  const body = match[2]!;
  const line = [...body.matchAll(/^name[ \t]*:[ \t]*(.*?)[ \t]*(\r?)$/gm)].at(-1);
  if (!line) return content;
  const newline = head.endsWith("\r\n") ? "\r\n" : "\n";
  const start = line.index + line[0].indexOf(":") + 1;
  let end = line.index + line[0].length - line[2]!.length;
  const scalar = name
    .split("\n")
    .map((part) => `  ${part}`)
    .join(newline);
  const replacement = ` |2-${newline}${scalar}`;
  if (/^[|>]/.test(line[1]!)) {
    const continuation =
      /^(?:\r?\n(?:[ \t][^\r\n]*|(?=\r?\n|$)))*/.exec(body.slice(end))?.[0] ?? "";
    end += continuation.length;
  }
  return `${head}${body.slice(0, start)}${replacement}${body.slice(end)}${content.slice(head.length + body.length)}`;
}

/** Display information only. File bodies stay in the editor until selected for preview. */
export function agentBackupFileGroups(raw: string) {
  if (!raw.trim() || raw.length > BOT_PACKAGE_MAX_BYTES) return null;
  const parsed = AgentBackupDocumentSchema.safeParse(botImportJsonObject(raw.trim()));
  if (!parsed.success) return null;
  const { source, files, incompleteSkills, routineOmissions } = parsed.data;
  const incomplete = new Set(incompleteSkills);
  const groups = {
    instructions: [] as string[],
    skills: [] as string[],
    memory: [] as string[],
    routines: [] as { path: string; name: string; schedule: string }[],
    unavailable: (routineOmissions ?? []).filter(({ path }) => isBackupRoutineOmission(path)) as {
      path: string;
      reason?: AgentBackupOmissionReason;
    }[],
  };
  const memoryOmissions = new Map<string, AgentBackupOmissionReason>();
  const memory = new Set(
    backupMemoryCandidates(source, files, (path, reason) => {
      memoryOmissions.set(path, reason);
    }).map(({ file }) => file.path),
  );
  for (const { path, content } of files) {
    if (isBackupRoutine(path)) {
      const routine = readBackupRoutine(content);
      if (routine)
        groups.routines.push({
          path,
          name: routine.name,
          schedule: `${routine.crons.join("; ")} · ${routine.timezone}`,
        });
      else groups.unavailable.push({ path, reason: "routineSchedule" });
      continue;
    }
    if (source === "openclaw" && openClawRuntimeFiles.has(path)) {
      groups.unavailable.push({ path });
      continue;
    }
    if (memory.has(path)) groups.memory.push(path);
    else if (isBackupMemory(source, path)) {
      const reason = memoryOmissions.get(path);
      if (reason) groups.unavailable.push({ path, reason });
    } else if (isBackupSkill(path)) {
      const assessed = assessBackupSkill(content, incomplete.has(path));
      if ("skill" in assessed) groups.skills.push(path);
      else groups.unavailable.push({ path, reason: assessed.reason });
    } else if (
      content.trim() &&
      (backupInstructions[source].some((file) => file === path) ||
        (source === "openclaw" && path === "IDENTITY.md"))
    ) {
      const reason = backupInstructionOmission(source, path, content);
      if (reason) groups.unavailable.push({ path, reason });
      else groups.instructions.push(path);
    }
  }
  groups.instructions.sort();
  groups.skills.sort();
  groups.memory.sort();
  groups.unavailable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return groups;
}

export function agentBackupSelectableGroups(
  files: NonNullable<ReturnType<typeof agentBackupFileGroups>>,
  includeMemory: boolean,
  excluded: ReadonlySet<string>,
  includedRoutines: ReadonlySet<string>,
) {
  const contentItems = (paths: readonly string[]) => paths.map((path) => ({ path, label: path }));
  const scheduleLabels = files.routines.map(({ path, name, schedule }) => ({
    path,
    label: `${name} · ${schedule}`.replace(/\s+/g, " "),
  }));
  const labelCounts = new Map<string, number>();
  for (const { label } of scheduleLabels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const groups = [
    { kind: "instructions", items: contentItems(files.instructions) },
    { kind: "skills", items: contentItems(files.skills) },
    { kind: "memory", items: includeMemory ? contentItems(files.memory) : [] },
    {
      kind: "routines",
      items: scheduleLabels.map(({ path, label }) => ({
        path,
        label:
          (labelCounts.get(label) ?? 0) > 1
            ? `${label} · #${path.slice("cron/routine-".length, -".json".length)}`
            : label,
      })),
    },
  ] as const;
  const visible = groups
    .filter(({ items }) => items.length)
    .map(({ kind, items }) => ({
      kind,
      items: items.map(({ path, label }) => {
        const selected = kind === "routines" ? includedRoutines.has(path) : !excluded.has(path);
        return {
          path,
          label,
          selected,
          atLimit:
            kind === "routines" && !selected && includedRoutines.size >= BOT_PACKAGE_MAX_ROUTINES,
        };
      }),
    }));
  return {
    groups: visible,
    hasSelection: visible.some(({ items }) => items.some(({ selected }) => selected)),
  };
}

export function botImportJsonObject(raw: string): Record<string, unknown> | undefined {
  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?([\s\S]*?)```/gi)) {
    candidates.push((match[1] ?? "").trimStart());
    if (candidates.length >= 10) break;
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  }
}

export function agentBackupPreview(
  source: string,
  includeMemory: boolean,
  excludedPaths: readonly string[] = [],
  includedRoutinePaths: readonly string[] = [],
): Pick<BotPackagePreviewInput, "source" | "backupOmissions" | "backupRoutines"> {
  const value = botImportJsonObject(source.trim());
  if (value?.format !== AGENT_BACKUP_FORMAT) return { source };
  const parsed = AgentBackupDocumentSchema.safeParse(value);
  if (!parsed.success) throw new AgentImportArchiveError("unreadable");
  const backup = parsed.data;
  if (
    backup.files.some(
      ({ path }) => !isBackupTextFile(backup.source, path) && !isBackupRoutine(path),
    )
  )
    throw new AgentImportArchiveError("unreadable");
  const excluded = new Set(excludedPaths);
  const includedRoutines = new Set(includedRoutinePaths);
  const incomplete = new Set(backup.incompleteSkills);
  const omissions = new Map<string, AgentBackupOmissionReason>(
    backup.routineOmissions
      ?.filter(({ path }) => isBackupRoutineOmission(path))
      .map(({ path, reason }) => [path, reason]),
  );
  const filePaths = new Set(backup.files.map(({ path }) => path));
  for (const path of incomplete) {
    if (isBackupSkill(path) && !filePaths.has(path) && !excluded.has(path))
      omissions.set(path, "missingSkillFiles");
  }
  const unavailableMemory = new Map<string, AgentBackupOmissionReason>();
  const availableMemory = new Set(
    backupMemoryCandidates(backup.source, backup.files, (path, reason) => {
      unavailableMemory.set(path, reason);
    }).map(({ file }) => file.path),
  );
  let excludedMemoryCount = backup.excludedMemoryCount;
  const backupRoutines: NonNullable<BotPackagePreviewInput["backupRoutines"]> = [];
  const files = backup.files.filter((file) => {
    if (!file.content.trim())
      return backup.source === "openclaw" && openClawRuntimeFiles.has(file.path);
    if (excluded.has(file.path) && !isBackupMemory(backup.source, file.path)) return false;
    if (isBackupRoutine(file.path)) {
      if (!includedRoutines.has(file.path)) return false;
      const routine = readBackupRoutine(file.content);
      if (routine) backupRoutines.push({ path: file.path, routine });
      else omissions.set(file.path, "routineSchedule");
      return false;
    }
    let reason: AgentBackupOmissionReason | null = null;
    if (isBackupMemory(backup.source, file.path)) {
      if (!availableMemory.has(file.path)) {
        if (!includeMemory) return false;
        const omitted = unavailableMemory.get(file.path);
        if (!omitted) return false;
        reason = omitted;
      } else if (!includeMemory || excluded.has(file.path)) {
        excludedMemoryCount++;
        return false;
      }
    } else if (isBackupSkill(file.path)) {
      const assessed = assessBackupSkill(file.content, incomplete.has(file.path));
      if ("reason" in assessed) reason = assessed.reason;
    } else if (!openClawRuntimeFiles.has(file.path)) {
      reason = backupInstructionOmission(backup.source, file.path, file.content);
    }
    if (reason) omissions.set(file.path, reason);
    return reason === null;
  });
  const safeFiles = files.map((file) =>
    backup.source === "openclaw" && openClawRuntimeFiles.has(file.path)
      ? { path: file.path, content: "" }
      : file,
  );
  if (backupRoutines.length > BOT_PACKAGE_MAX_ROUTINES)
    throw new AgentImportArchiveError("too_large");
  if (!safeFiles.length && !excludedMemoryCount && !backupRoutines.length)
    throw new AgentImportArchiveError("unreadable");
  const backupOmissions = [...omissions].slice(0, AGENT_BACKUP_MAX_FILES).map(([path, reason]) => ({
    path,
    reason,
  }));
  const incompleteSkills = backupOmissions
    .filter(({ reason }) => reason === "missingSkillFiles")
    .map(({ path }) => path);
  const serialized = JSON.stringify({
    format: backup.format,
    source: backup.source,
    files: safeFiles,
    excludedMemoryCount,
    ...(incompleteSkills.length ? { incompleteSkills } : {}),
  });
  if (
    botPackageUtf8Bytes(serialized) +
      (backupRoutines.length ? botPackageUtf8Bytes(JSON.stringify(backupRoutines)) : 0) >
    BOT_PACKAGE_MAX_BYTES
  )
    throw new AgentImportArchiveError("too_large");
  return {
    source: serialized,
    ...(backupOmissions.length ? { backupOmissions } : {}),
    ...(backupRoutines.length ? { backupRoutines } : {}),
  };
}
