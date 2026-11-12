import type { AgentBackupDocument, AgentBackupSource } from "@rakazo/contracts";
import {
  AGENT_BACKUP_FORMAT,
  AGENT_BACKUP_MAX_FILES,
  AgentBackupDocumentSchema,
  BOT_PACKAGE_MAX_BYTES,
  botPackageUtf8Bytes,
  isAgentBackupPath,
} from "@rakazo/contracts";
import { AgentImportArchiveError, openAgentImportArchive } from "./archive.js";

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

export function isBackupTextFile(source: AgentBackupSource, path: string) {
  return (
    backupInstructions[source].some((file) => file === path) ||
    isBackupMemory(source, path) ||
    isBackupSkill(path) ||
    (source === "openclaw" && (path === "IDENTITY.md" || openClawRuntimeFiles.has(path)))
  );
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
  if (source === "openclaw" && (workspaces.size > 1 || (archive.declaredWorkspace && !workspace)))
    throw new AgentImportArchiveError("unreadable");
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
  } else {
    for (const [path, name] of relative) add(path, name);
  }
  const backup: AgentBackupDocument = {
    format: AGENT_BACKUP_FORMAT,
    source,
    files: [...files].map(([path, archivePath]) => ({
      path,
      content:
        source === "openclaw" && openClawRuntimeFiles.has(path) ? "" : archive.read(archivePath),
    })),
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

export function isAgentBackupUpload(source: string): boolean {
  return source.startsWith(`{"format":"${AGENT_BACKUP_FORMAT}","`);
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

export function agentBackupPreviewSource(source: string, includeMemory: boolean): string {
  if (includeMemory) return source;
  const value = botImportJsonObject(source.trim());
  if (value?.format !== AGENT_BACKUP_FORMAT) return source;
  const parsed = AgentBackupDocumentSchema.safeParse(value);
  if (!parsed.success) throw new AgentImportArchiveError("unreadable");
  const backup = parsed.data;
  const files = backup.files.filter(({ path }) => !isBackupMemory(backup.source, path));
  if (files.length === backup.files.length) return source;
  return JSON.stringify({
    ...backup,
    files,
    excludedMemoryCount: backup.files.length - files.length,
  });
}
