import { normalizeSkillFilePath, readSkillMarkdownReferences } from "./agent-skill.js";

const SKILL_TEXT_FILE = /\.(md|mdx|txt|json|ya?ml|csv)$/i;
const INLINE_SKILL_FILE =
  /^(?:\{baseDir\}\/|(?:\.\/|(?:\.\.\/)+)?(?:assets|references|scripts|templates)\/).+\.[a-z0-9]+(?:#.*)?$/i;
const INLINE_BACKUP_FILE = /^(?:(?:\.\.?\/)+|examples\/).+\.[a-z0-9]+(?:#.*)?$/i;
const BACKUP_PATH_PREFIX =
  /(?:\{baseDir\}\/|(?:\.\.?\/)+|(?:references|assets|examples|scripts|templates)\/)/;
const BACKUP_URL_PREFIX = /(?:[a-z][a-z\d+.-]*:)?\/\//;
const BACKUP_URL_START = new RegExp(`^${BACKUP_URL_PREFIX.source}`, "i");
const BACKUP_TOKEN_START = "(?:^|[\\s(=,<>|;&])";
const BACKUP_TARGET_START = `(?:${BACKUP_PATH_PREFIX.source}|${BACKUP_URL_PREFIX.source})`;
const QUOTED_BACKUP_TARGET = `(["'])(${BACKUP_TARGET_START}[^\\r\\n]*?)\\1`;
const UNQUOTED_BACKUP_PATH = `${BACKUP_PATH_PREFIX.source}[^\\s<>"'()[\\]|;&\\u0060]*`;
const BACKUP_PROSE_TARGET = new RegExp(
  `${BACKUP_TOKEN_START}(?:${QUOTED_BACKUP_TARGET}|(${UNQUOTED_BACKUP_PATH}|${BACKUP_URL_PREFIX.source}[^\\s<>"']+))`,
  "gi",
);
const BACKUP_COMMAND_TARGET = new RegExp(
  `${BACKUP_TOKEN_START}(?:${QUOTED_BACKUP_TARGET}|(${UNQUOTED_BACKUP_PATH}|${BACKUP_URL_PREFIX.source}[^\\s<>"'|;&\\u0060]+))`,
  "gi",
);

export function isPortableSkillReferencePath(path: string): boolean {
  return (
    path.length <= 300 &&
    !path.split("/").some((part) => part.startsWith(".")) &&
    !/(?:^|\/)(?:credentials|sessions|logs|cron|secrets|node_modules|venv|site-packages|auth\.json|config\.yaml|openclaw\.json|SKILL\.md)(?:\/|$)/i.test(
      path,
    ) &&
    isSkillTextFile(path)
  );
}

function resolveSkillReference(base: string, relative: string): string | undefined {
  const parts: string[] = [];
  for (const part of (base + relative).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export function isSkillTextFile(path: string): boolean {
  return normalizeSkillFilePath(path) === path && SKILL_TEXT_FILE.test(path);
}

/** Walk references from the main recipe and any Markdown reached through them. */
export function hasMissingSkillReference(
  body: string,
  files: ReadonlyMap<string, string>,
  inferInlineFiles: boolean,
  includeProse = false,
): boolean {
  const visited = new Set(["SKILL.md"]);
  const pending = [{ path: "SKILL.md", body }];
  const isInlineFile = (value: string) =>
    INLINE_SKILL_FILE.test(value) || (includeProse && INLINE_BACKUP_FILE.test(value));
  function visit(path: string): boolean {
    if (visited.has(path)) return true;
    const text = files.get(path);
    if (text === undefined) return false;
    visited.add(path);
    if (/\.mdx?$/i.test(path)) pending.push({ path, body: text });
    return true;
  }
  for (const document of pending) {
    const { links, inlineCode, prose, code } = readSkillMarkdownReferences(document.body);
    const documentDir = document.path.slice(0, document.path.lastIndexOf("/") + 1);
    const inlineBase = (target: string) =>
      target.startsWith("./") || target.startsWith("../") ? documentDir : "";
    const references = [
      ...links.map((target) => ({ target, base: documentDir, canBeDirectory: true })),
      ...inlineCode
        .filter((text) => (inferInlineFiles || text.startsWith("{baseDir}/")) && isInlineFile(text))
        .map((target) => ({
          target,
          base: inlineBase(target),
          canBeDirectory: false,
        })),
      ...(includeProse
        ? [
            ...prose.flatMap((text) => backupReferenceTargets(text, BACKUP_PROSE_TARGET)),
            ...code
              .concat(inlineCode.filter((value) => !isInlineFile(value)))
              .flatMap((text) => backupReferenceTargets(text, BACKUP_COMMAND_TARGET)),
          ].map((target) => ({
            target,
            base: inlineBase(target),
            canBeDirectory: false,
          }))
        : []),
    ];
    for (const { target, base, canBeDirectory } of references) {
      try {
        const atSkillRoot = target.startsWith("{baseDir}/");
        const decoded = decodeURIComponent(target.replace(/^\{baseDir\}\//, "").split("#", 1)[0]!);
        if (
          !decoded ||
          decoded.length > 2048 ||
          /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(decoded) ||
          /[\\%?#]/.test(decoded) ||
          [...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
        )
          return true;
        const path = resolveSkillReference(atSkillRoot ? "" : base, decoded);
        if (path === undefined) return true;
        const directory = decoded.endsWith("/") || decoded === "." || decoded === "..";
        if (directory && !path) {
          if (includeProse) for (const file of files.keys()) visit(file);
          continue;
        }
        const relative = normalizeSkillFilePath(path);
        if (!relative) return true;
        if (!directory && visit(relative)) continue;
        if (!directory && !canBeDirectory) return true;
        const children = [...files.keys()].filter((file) => file.startsWith(`${relative}/`));
        if (!children.length) return true;
        if (includeProse) children.forEach(visit);
      } catch {
        return true;
      }
    }
  }
  return false;
}

function backupReferenceTargets(text: string, pattern: RegExp): string[] {
  // Match each token once so a URL or path can't be reinterpreted from the middle.
  const paths: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const target = match[2] ?? match[3]!.replace(/[.,;:!?]+$/, "");
    if (!BACKUP_URL_START.test(target)) paths.push(target);
  }
  return paths;
}
