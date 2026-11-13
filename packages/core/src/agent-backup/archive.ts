import { BOT_PACKAGE_MAX_BYTES, isAgentBackupPath } from "@rakazo/contracts";
import { Gunzip, Inflate } from "fflate";

/**
 * Modified for bounded text-only Bot package import.
 * Reads an agent backup in the client before anything is sent.
 * OpenClaw backups are `.tar.gz` with a manifest; zips (Hermes) are mapped by layout. Only
 * files an import might use are decompressed; others are listed by name only.
 */

export const AGENT_IMPORT_ARCHIVE_LIMITS = {
  archiveBytes: BOT_PACKAGE_MAX_BYTES,
  entries: 2_000,
  /** One file that is read. Larger files are never sent (the upload cap is far lower). */
  fileBytes: 400_000,
  /** Everything read, before the upload's own total cap. */
  readBytes: BOT_PACKAGE_MAX_BYTES,
  /**
   * Everything a tar stream keeps in memory, before the agent's home is known: a backup can
   * hold other agents' files that are never read.
   */
  retainedBytes: BOT_PACKAGE_MAX_BYTES,
  /** Everything a gzip stream inflates to, including skipped entries. */
  inflatedBytes: BOT_PACKAGE_MAX_BYTES,
  /** Inflated size per compressed byte above which data is treated as a bomb. */
  ratio: 200,
} as const;

type AgentImportArchiveLimits = Record<keyof typeof AGENT_IMPORT_ARCHIVE_LIMITS, number>;

export type AgentImportArchiveErrorReason = "unreadable" | "too_large";

export class AgentImportArchiveError extends Error {
  constructor(readonly reason: AgentImportArchiveErrorReason) {
    super(reason === "too_large" ? "The backup is too large." : "The backup could not be read.");
    this.name = "AgentImportArchiveError";
  }
}

const unreadable = () => new AgentImportArchiveError("unreadable");
const tooLarge = () => new AgentImportArchiveError("too_large");

type Entry = { path: string; data?: Uint8Array; skipped?: true };

/**
 * Paths are mapped under `.openclaw/` or `.hermes/` when the layout is known. Files outside
 * what an import reads were never kept, so reading them fails.
 */
export function openAgentImportArchive(data: Uint8Array): {
  paths: string[];
  skippedPaths: string[];
  declaredWorkspace: boolean;
  workspaceSourcePath?: string;
  stateSourcePath?: string;
  readOpenClawConfig(): string | undefined;
  has(path: string): boolean;
  readOptional(path: string): string | undefined;
  read: (path: string) => string;
} {
  const limits = AGENT_IMPORT_ARCHIVE_LIMITS;
  if (data.length > limits.archiveBytes) throw tooLarge();
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const isGzip = data[0] === 0x1f && data[1] === 0x8b;
  if (!isZip && !isGzip) throw unreadable();
  const zip = isZip ? zipEntries(data, limits) : null;
  const entries = zip ? zip.entries : tarEntries(data, limits);
  let read = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function readEntryBytes(entry: Entry): Uint8Array | undefined {
    if (entry.skipped || !mayBeRead(entry.path)) throw unreadable();
    const bytes = entry.data ?? zip?.read(entry.path);
    if (!bytes) return undefined;
    if (read + bytes.length > limits.readBytes) throw tooLarge();
    read += bytes.length;
    return bytes;
  }
  function readEntry(entry: Entry): string {
    const bytes = readEntryBytes(entry);
    if (!bytes) throw tooLarge();
    return decoder.decode(bytes);
  }
  const layout = archiveLayout(entries, readEntry);
  const paths: string[] = [];
  const skippedPaths: string[] = [];
  const byVirtual = new Map<string, Entry>();
  for (const entry of entries) {
    const path = layout.map(entry.path);
    if (!path) continue;
    // Two entries for one file (repeated, or equal after normalising) are ambiguous.
    if (byVirtual.has(path)) throw unreadable();
    (entry.skipped ? skippedPaths : paths).push(path);
    byVirtual.set(path, entry);
  }
  // Counted once per selected file.
  const texts = new Map<string, string>();
  function readOptionalEntry(entry: Entry | undefined) {
    if (!entry || entry.skipped || !mayBeRead(entry.path)) return undefined;
    const cached = texts.get(entry.path);
    if (cached !== undefined) return cached;
    const bytes = readEntryBytes(entry);
    if (!bytes) return undefined;
    try {
      const text = decoder.decode(bytes);
      texts.set(entry.path, text);
      return text;
    } catch (error) {
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  }
  return {
    paths,
    skippedPaths,
    declaredWorkspace: layout.declaredWorkspace,
    workspaceSourcePath: layout.workspaceSourcePath,
    stateSourcePath: layout.stateSourcePath,
    has: (path) => byVirtual.has(path),
    readOptional: (path) => readOptionalEntry(byVirtual.get(path)),
    readOpenClawConfig: () => {
      if (!layout.configArchivePath) return undefined;
      const matches = entries.filter(({ path }) => path === layout.configArchivePath);
      return matches.length === 1 ? readOptionalEntry(matches[0]) : undefined;
    },
    read: (path) => {
      const entry = byVirtual.get(path);
      if (!entry) throw unreadable();
      const cached = texts.get(entry.path);
      if (cached !== undefined) return cached;
      const text = readEntry(entry);
      texts.set(entry.path, text);
      return text;
    },
  };
}

/**
 * An archive path made relative and safe, or null for a directory. Absolute paths, drive
 * letters, backslashes, NUL and `..` make the whole archive unreadable.
 */
function safeArchivePath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw unreadable();
  }
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw unreadable();
  if (raw.endsWith("/") || segments.length === 0) return null;
  const path = segments.join("/");
  if (!isAgentBackupPath(path)) throw unreadable();
  return path;
}

/** Besides skills and daily memory. */
const READ_MARKDOWN = new Set([
  "SOUL.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "BOOT.md",
  "HERMES.md",
  ".hermes.md",
]);
const NOISE_FOLDERS = new Set(["node_modules", ".git", ".venv", "venv", "site-packages"]);

/** Only these are kept while a gzip stream is inflated. */
function mayBeRead(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  const folder = segments.at(-2) ?? "";
  if (segments.some((segment) => NOISE_FOLDERS.has(segment))) return false;
  return (
    name === "SKILL.md" ||
    READ_MARKDOWN.has(name) ||
    ((folder === "memory" || folder === "memories") && name.endsWith(".md")) ||
    name === "manifest.json" ||
    (folder === "cron" && name === "jobs.json") ||
    name === "openclaw.json" ||
    name === "config.yaml"
  );
}

const NESTED_ARCHIVE = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/i;

function zipEntries(data: Uint8Array, limits: AgentImportArchiveLimits) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw unreadable();
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  // ZIP64 archives mark these fields as saturated; they are refused rather than misread.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw unreadable();
  if (count > limits.entries) throw tooLarge();
  if (offset + size > end) throw unreadable();
  const directoryEnd = offset + size;
  type ZipEntry = Entry & {
    method: number;
    compressed: number;
    size: number;
    local: number;
    crc: number;
    rawName: Uint8Array;
  };
  const entries: Entry[] = [];
  const readable = new Map<string, ZipEntry>();
  let at = offset;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let declaredBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directoryEnd || view.getUint32(at, true) !== 0x02014b50) throw unreadable();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const crc = view.getUint32(at + 16, true);
    const external = view.getUint32(at + 38, true);
    const local = view.getUint32(at + 42, true);
    // Every record stays inside the central directory, and every file before it.
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || local + 30 > offset) throw unreadable();
    const rawName = data.subarray(at + 46, at + 46 + nameLength);
    const name = decoder.decode(rawName);
    at = next;
    const path = safeArchivePath(name);
    const type = (external >>> 16) & 0o170000;
    if (path) {
      declaredBytes += uncompressed;
      if (declaredBytes > limits.inflatedBytes) throw tooLarge();
    }
    // Directories, links, devices, encrypted entries and archives inside are never read.
    if (!path || type === 0o040000) continue;
    if (
      (type !== 0 && type !== 0o100000) ||
      flags & 1 ||
      NESTED_ARCHIVE.test(path) ||
      (method !== 0 && method !== 8)
    ) {
      entries.push({ path, skipped: true });
      continue;
    }
    const entry = { path, method, compressed, size: uncompressed, local, crc, rawName };
    readable.set(path, entry);
    entries.push(entry);
  }
  if (at !== directoryEnd) throw unreadable();
  const read = (path: string): Uint8Array | undefined => {
    const entry = readable.get(path);
    if (!entry) return undefined;
    if (entry.size > limits.fileBytes) return undefined;
    if (entry.size > 1024 * 1024 && entry.size > entry.compressed * limits.ratio) throw tooLarge();
    if (view.getUint32(entry.local, true) !== 0x04034b50) throw unreadable();
    // The local header must agree with the central directory on name and method.
    const nameLength = view.getUint16(entry.local + 26, true);
    const localName = data.subarray(entry.local + 30, entry.local + 30 + nameLength);
    if (
      view.getUint16(entry.local + 8, true) !== entry.method ||
      !sameBytes(localName, entry.rawName)
    ) {
      throw unreadable();
    }
    const start = entry.local + 30 + nameLength + view.getUint16(entry.local + 28, true);
    if (start + entry.compressed > offset) throw unreadable();
    const body = data.subarray(start, start + entry.compressed);
    const bytes = entry.method === 0 ? body : inflateCapped(body, entry.size);
    // The declared size and checksum must match what was actually stored.
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw unreadable();
    return bytes;
  };
  return { entries, read };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Raw DEFLATE, stopped as soon as the output passes the declared size (a false size). */
function inflateCapped(body: Uint8Array, cap: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) throw unreadable();
    parts.push(chunk);
  });
  feed(body, (chunk, final) => inflate.push(chunk, final));
  return concat(parts, total);
}

/**
 * Inflates a gzip stream and parses the tar inside as it arrives (ustar, pax and GNU long
 * names). Only entries an import might read are kept; links, devices and other types are
 * skipped. Stops at the first cap passed.
 */
function tarEntries(data: Uint8Array, limits: AgentImportArchiveLimits): Entry[] {
  const entries: Entry[] = [];
  const tar = new TarStream(entries, limits);
  let inflated = 0;
  const gunzip = new Gunzip((chunk) => {
    inflated += chunk.length;
    if (inflated > limits.inflatedBytes) throw tooLarge();
    if (inflated > 1024 * 1024 && inflated > data.length * limits.ratio) throw tooLarge();
    tar.push(chunk);
  });
  try {
    feed(data, (chunk, final) => gunzip.push(chunk, final));
  } catch (error) {
    if (error instanceof AgentImportArchiveError) throw error;
    throw unreadable();
  }
  tar.finish();
  return entries;
}

class TarStream {
  private header = new Uint8Array(512);
  private headerFill = 0;
  /** Bytes left in the current entry's data, then its padding. */
  private remaining = 0;
  private padding = 0;
  private current: { path: string | null; kind: "file" | "pax" | "longname" | "skip" } | null =
    null;
  private buffer: Uint8Array[] = [];
  private bufferSize = 0;
  private keep = false;
  private nextName: string | null = null;
  private ended = false;
  private count = 0;
  private sawHeader = false;
  /** Bytes kept so far; checked before an entry's data is buffered. */
  private retained = 0;

  constructor(
    private readonly entries: Entry[],
    private readonly limits: AgentImportArchiveLimits,
  ) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && !this.ended) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - at);
        if (this.keep) {
          this.buffer.push(chunk.slice(at, at + take));
          this.bufferSize += take;
        }
        this.remaining -= take;
        at += take;
        if (this.remaining === 0) this.endData();
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, chunk.length - at);
        this.padding -= take;
        at += take;
        continue;
      }
      const take = Math.min(512 - this.headerFill, chunk.length - at);
      this.header.set(chunk.subarray(at, at + take), this.headerFill);
      this.headerFill += take;
      at += take;
      if (this.headerFill === 512) {
        this.headerFill = 0;
        this.readHeader();
      }
    }
  }

  finish(): void {
    // A stream without its end-of-archive block, or stopping inside an entry, is truncated.
    if (!this.ended || this.remaining > 0 || this.headerFill > 0) throw unreadable();
  }

  private readHeader(): void {
    const block = this.header;
    if (block.every((byte) => byte === 0)) {
      this.ended = this.sawHeader;
      if (!this.sawHeader) throw unreadable();
      return;
    }
    if (!validChecksum(block)) throw unreadable();
    this.sawHeader = true;
    this.count += 1;
    if (this.count > this.limits.entries) throw tooLarge();
    const size = readSize(block.subarray(124, 136));
    const type = String.fromCharCode(block[156] ?? 0);
    const ustar = ascii(block.subarray(257, 262)) === "ustar";
    const prefix = ustar ? ascii(block.subarray(345, 500)) : "";
    const name =
      this.nextName ??
      (prefix ? `${prefix}/${ascii(block.subarray(0, 100))}` : ascii(block.subarray(0, 100)));
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    this.buffer = [];
    this.bufferSize = 0;
    this.keep = false;
    if (type === "x") {
      this.current = { path: null, kind: "pax" };
      this.keep = size <= 64 * 1024;
    } else if (type === "L") {
      this.current = { path: null, kind: "longname" };
      this.keep = size <= 64 * 1024;
    } else if (type === "0" || type === "\0" || type === "7") {
      this.nextName = null;
      const path = safeArchivePath(name);
      const read = path !== null && !NESTED_ARCHIVE.test(path) && mayBeRead(path);
      this.current = { path, kind: "file" };
      this.keep = read && size <= this.limits.fileBytes;
      if (this.keep) {
        this.retained += size;
        if (this.retained > this.limits.retainedBytes) throw tooLarge();
      }
      if (path)
        this.entries.push({ path, ...(NESTED_ARCHIVE.test(path) ? { skipped: true } : {}) });
    } else {
      // Directories, links, devices, FIFOs, global headers and anything unknown.
      this.nextName = null;
      const path = safeArchivePath(name);
      if (type !== "5" && path) this.entries.push({ path, skipped: true });
      this.current = { path: null, kind: "skip" };
    }
    if (size === 0) this.endData();
  }

  private endData(): void {
    const current = this.current;
    this.current = null;
    if (!current || !this.keep) return;
    const bytes = concat(this.buffer, this.bufferSize);
    if (current.kind === "pax") this.nextName = paxPath(bytes);
    else if (current.kind === "longname") this.nextName = ascii(bytes);
    else if (current.kind === "file" && current.path) {
      const entry = this.entries.at(-1);
      if (entry?.path === current.path) entry.data = bytes;
    }
  }
}

function validChecksum(block: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  const field = ascii(block.subarray(148, 156)).replace(/^ +| +$/g, "");
  return /^[0-7]+$/.test(field) && Number.parseInt(field, 8) === sum;
}

function readSize(field: Uint8Array): number {
  // Base-256 for sizes past the octal field's range.
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] ?? 0);
    if (!Number.isSafeInteger(value)) throw tooLarge();
    return value;
  }
  return octal(field);
}

/** A tar octal field: digits 0-7 only, padded with spaces or NULs. */
function octal(field: Uint8Array): number {
  const text = ascii(field).replace(/^ +| +$/g, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw unreadable();
  return Number.parseInt(text, 8);
}

/**
 * The `path` record of a pax header. Records are `<length> <key>=<value>\n`, where length
 * counts the whole record in bytes; a record that disagrees with its length is unreadable.
 */
function paxPath(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder();
  let path: string | null = null;
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space < 0) throw unreadable();
    const lengthText = ascii(bytes.subarray(at, space));
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw unreadable();
    const end = at + Number(lengthText);
    if (end > bytes.length || bytes[end - 1] !== 0x0a) throw unreadable();
    const record = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw unreadable();
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
    at = end;
  }
  return path;
}

function ascii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * Maps archive paths to `.openclaw/...` or `.hermes/...`, or null outside the agent's home.
 *
 * OpenClaw backups hold `<name>/manifest.json` and `<name>/payload/posix/<original path>`:
 * the `state` asset is the home, and a `workspace` asset outside it its workspace.
 */
function archiveLayout(
  entries: Entry[],
  readEntry: (entry: Entry) => string,
): {
  map: (path: string) => string | null;
  declaredWorkspace: boolean;
  workspaceSourcePath?: string;
  stateSourcePath?: string;
  configArchivePath?: string;
} {
  const fallback = (map: (path: string) => string | null) => ({ map, declaredWorkspace: false });
  const manifests = entries.filter((entry) => /^[^/]+\/manifest\.json$/.test(entry.path));
  if (manifests.length > 1) throw unreadable();
  const manifest = manifests[0];
  if (manifest) {
    const roots = openClawRoots(
      manifest.path,
      readEntry(manifest).replace(/^\uFEFF/, ""),
      entries.map((entry) => entry.path),
    );
    if (roots) {
      return {
        declaredWorkspace: Boolean(roots.workspace),
        workspaceSourcePath: roots.workspaceSourcePath,
        stateSourcePath: roots.stateSourcePath,
        map: (path) => {
          if (roots.workspace && path.startsWith(`${roots.workspace}/`)) {
            return `.openclaw/workspace/${path.slice(roots.workspace.length + 1)}`;
          }
          if (path.startsWith(`${roots.home}/`)) {
            const relative = path.slice(roots.home.length + 1);
            if (roots.workspace && /^workspace(?:-[^/]+)?\//.test(relative)) return null;
            return `.openclaw/${relative}`;
          }
          return null;
        },
        configArchivePath: roots.config,
      };
    }
  }
  const paths = entries.map((entry) => entry.path);
  // Explicit homes are checked for ambiguity by the reader.
  if (paths.some((path) => /(?:^|\/)\.(?:openclaw|hermes)\//.test(path)))
    return fallback((path) => path);
  const configs = paths.filter((path) => /^(?:[^/]+\/)?openclaw\.json$/.test(path));
  if (configs.length > 1) throw unreadable();
  const config = configs[0];
  if (config !== undefined) {
    const home = config.slice(0, -"openclaw.json".length).replace(/\/$/, "");
    return fallback((path) =>
      home === ""
        ? `.openclaw/${path}`
        : path.startsWith(`${home}/`)
          ? `.openclaw/${path.slice(home.length + 1)}`
          : null,
    );
  }
  const hermes = paths.some(
    (path) => path === "config.yaml" || path === "HERMES.md" || path.startsWith("memories/"),
  );
  if (hermes) return fallback((path) => `.hermes/${path}`);
  return fallback((path) => path);
}

function openClawRoots(
  manifestPath: string,
  manifestText: string,
  paths: readonly string[],
): {
  home: string;
  config?: string;
  workspace?: string;
  workspaceSourcePath?: string;
  stateSourcePath?: string;
} | null {
  let parsed: {
    schemaVersion?: number;
    archiveRoot?: string;
    paths?: {
      workspaceDirs?: unknown;
      stateDir?: unknown;
      configPath?: unknown;
      configSourcePath?: unknown;
    };
    assets?: { kind?: string; archivePath?: string; sourcePath?: string }[];
  };
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (parsed?.schemaVersion !== 1) return null;
  if (!Array.isArray(parsed.assets)) {
    if (parsed.archiveRoot !== undefined || parsed.paths?.workspaceDirs !== undefined)
      throw unreadable();
    return null;
  }
  try {
    const folder = manifestPath.slice(0, -"/manifest.json".length);
    // The manifest describes this archive only if it names the folder it sits in.
    if (parsed.archiveRoot !== undefined && parsed.archiveRoot !== folder) throw unreadable();
    const inArchive = (archivePath: string) => {
      const relative = safeArchivePath(archivePath.replace(/\/+$/, ""));
      if (!relative) return null;
      return relative.startsWith(`${folder}/`) ? relative : `${folder}/${relative}`;
    };
    const state = parsed.assets.find((asset) => asset.kind === "state" && asset.archivePath);
    const home = state?.archivePath ? inArchive(state.archivePath) : null;
    if (!home) throw unreadable();
    const stateSource = state?.sourcePath ?? parsed.paths?.stateDir;
    const stateSourcePath =
      typeof stateSource === "string" ? normalizeSourcePath(stateSource) : undefined;
    const activeConfigSource = parsed.paths?.configSourcePath ?? parsed.paths?.configPath;
    const activeConfig =
      typeof activeConfigSource === "string" ? normalizeSourcePath(activeConfigSource) : undefined;
    // A config asset can be an included fragment. Match only the declared active root.
    const configs = parsed.assets.filter(
      (asset) =>
        activeConfig &&
        asset.kind === "config" &&
        asset.archivePath &&
        typeof asset.sourcePath === "string" &&
        normalizeSourcePath(asset.sourcePath) === activeConfig,
    );
    const configPath =
      configs.length === 1
        ? (inArchive(configs[0]!.archivePath!) ?? undefined)
        : configs.length === 0 && stateSourcePath && activeConfig?.startsWith(`${stateSourcePath}/`)
          ? `${home}/${activeConfig.slice(stateSourcePath.length + 1)}`
          : undefined;
    // Every declared asset must exist in the archive, under its root folder.
    for (const asset of parsed.assets) {
      if (!asset.archivePath) continue;
      const declared = inArchive(asset.archivePath);
      if (
        !declared ||
        !paths.some(
          (path) =>
            path.startsWith(`${declared}/`) || (asset.kind === "config" && path === declared),
        )
      )
        throw unreadable();
    }
    const workspaces = parsed.assets.flatMap((asset) => {
      if (asset.kind !== "workspace" || !asset.archivePath) return [];
      const root = inArchive(asset.archivePath);
      return root ? [{ root, sourcePath: asset.sourcePath }] : [];
    });
    const [workspace] = workspaces;
    const declaredWorkspaceDirs = parsed.paths?.workspaceDirs;
    if (workspaces.length > 1) throw unreadable();
    if (declaredWorkspaceDirs !== undefined) {
      if (
        !Array.isArray(declaredWorkspaceDirs) ||
        declaredWorkspaceDirs.some((path) => typeof path !== "string" || !path)
      )
        throw unreadable();
      const declaredPaths = new Set(declaredWorkspaceDirs.map(normalizeSourcePath));
      if (declaredPaths.size > 1) throw unreadable();
      const [declaredPath] = declaredPaths;
      const statePath = stateSourcePath;
      if (declaredPath && statePath && declaredPath.startsWith(`${statePath}/`)) {
        const internal = safeArchivePath(declaredPath.slice(statePath.length + 1));
        const internalRoot = `${home}/${internal}`;
        if (!internal || (workspace && workspace.root !== internalRoot)) throw unreadable();
        return {
          home,
          config: configPath,
          workspace: internalRoot,
          workspaceSourcePath: declaredPath,
          stateSourcePath,
        };
      }
      if (
        declaredPath &&
        workspace &&
        typeof workspace.sourcePath === "string" &&
        normalizeSourcePath(workspace.sourcePath) === declaredPath
      )
        return {
          home,
          config: configPath,
          workspace: workspace.root,
          workspaceSourcePath: declaredPath,
          stateSourcePath,
        };
      if (declaredPaths.size || workspace) throw unreadable();
    } else if (
      workspace &&
      paths.some((path) => {
        return (
          path.startsWith(`${home}/`) && /^workspace(?:-[^/]+)?\//.test(path.slice(home.length + 1))
        );
      })
    ) {
      throw unreadable();
    }
    return workspace
      ? {
          home,
          config: configPath,
          workspace: workspace.root,
          workspaceSourcePath:
            typeof workspace.sourcePath === "string"
              ? normalizeSourcePath(workspace.sourcePath)
              : undefined,
          stateSourcePath,
        }
      : { home, config: configPath, stateSourcePath };
  } catch (error) {
    if (error instanceof AgentImportArchiveError) throw error;
    throw unreadable();
  }
}

function normalizeSourcePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/** Pushes data in small chunks, so a cap is noticed before much is inflated. */
function feed(data: Uint8Array, push: (chunk: Uint8Array, final: boolean) => void): void {
  const size = 16 * 1024;
  if (data.length === 0) push(data, true);
  for (let at = 0; at < data.length; at += size) {
    push(data.subarray(at, at + size), at + size >= data.length);
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
