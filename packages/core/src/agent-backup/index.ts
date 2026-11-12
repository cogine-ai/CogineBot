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
export const hermesBundledManifest = "skills/.bundled_manifest";
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
    (source === "openclaw" && (path === "IDENTITY.md" || openClawRuntimeFiles.has(path))) ||
    (source === "hermes" && path === hermesBundledManifest)
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
      return /^workspace(?:-[^/]+)?$/.test(folder) && isBackupTextFile(source, rest.join("/"))
        ? [folder]
        : [];
    }),
  );
  const workspace = workspaces.has("workspace")
    ? "workspace"
    : workspaces.size === 1
      ? [...workspaces][0]
      : undefined;
  if (source === "openclaw" && !workspace && workspaces.size)
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

export function isAgentBackupUpload(source: string): boolean {
  return source.startsWith(`{"format":"${AGENT_BACKUP_FORMAT}","`);
}

export function agentBackupPreviewSource(source: string, includeMemory: boolean): string {
  if (includeMemory || !isAgentBackupUpload(source)) return source;
  const parsed = AgentBackupDocumentSchema.safeParse(JSON.parse(source));
  if (!parsed.success) return source;
  const backup = parsed.data;
  const files = backup.files.filter(({ path }) => !isBackupMemory(backup.source, path));
  if (files.length === backup.files.length) return source;
  return JSON.stringify({
    ...backup,
    files,
    excludedMemoryCount: backup.files.length - files.length,
  });
}
