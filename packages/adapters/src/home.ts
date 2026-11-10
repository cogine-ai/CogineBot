import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext, AgentHomeStore, PortableFile } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { fileHandlePath } from "./file-handle-path.js";

const SAVE_STAGING_PREFIX = "workspace-save-";
const STAGING_HEARTBEAT_MS = 30_000;
const STALE_STAGING_MS = 5 * 60_000;
const HOME_LOCK_WAIT_MS = 20_000;
const SQLITE_BUSY = 5;

export interface HomePublisher {
  prisma: PrismaClient;
  publish(install: (currentRevision: string) => Promise<string>): Promise<string>;
}

interface PendingCheckpoint {
  revision: string;
  baseRevision: string;
  previousMarker: string | null;
  replaceHome: boolean;
  hadHome: boolean;
}

interface WorkspaceRetirement {
  staging?: Awaited<ReturnType<typeof createStagingDirectory>>;
  count: number;
}

function newHomeRevision() {
  return `rev-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function createStagingDirectory(parent = tmpdir()) {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, SAVE_STAGING_PREFIX));
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(directory, now, now).catch(() => undefined);
  }, STAGING_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    path: directory,
    async remove() {
      clearInterval(heartbeat);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export class LocalAgentHomeStore implements AgentHomeStore {
  private readonly saveStaging = new Set<string>();
  private readonly botWrites = new Map<string, Promise<void>>();
  private readonly retiredStaging = new Map<string, WorkspaceRetirement>();
  private nextStagingSweep = 0;

  constructor(
    private readonly root: string,
    private readonly prisma?: PrismaClient,
  ) {}

  describe() {
    return {
      id: "local-fs",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  private botDir(botId: string) {
    if (!botId || botId === "." || botId === ".." || path.basename(botId) !== botId) {
      throw new Error("Invalid bot id");
    }
    return path.join(this.root, "homes", botId);
  }

  pathFor(botId: string) {
    return path.resolve(this.botDir(botId));
  }

  async ensureHomeDirectory(botId: string) {
    await this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      await mkdir(this.botDir(botId), { recursive: true });
    });
  }

  async removeHome(botId: string) {
    await this.withBotWrite(botId, async () => {
      const directory = this.botDir(botId);
      await this.retireDirectory(botId, directory);
      await this.retireDirectory(botId, `${directory}.previous`);
      await rm(this.pendingPath(botId), { force: true });
      await rm(this.markerPath(botId), { force: true });
    });
  }

  async checkout(botId: string, dest: string, _context: AdapterContext): Promise<string> {
    await this.waitForBotWrite(botId);
    return this.withHomeLock(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      await mkdir(dest, { recursive: true });
      const src = this.botDir(botId);
      await mkdir(src, { recursive: true });
      await copyDir(src, dest);
      return "working";
    });
  }

  /** API and worker share the volume. An OS-backed lock outlives a timed-out DB transaction. */
  async withHomeLock<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const unlock = await this.lockHome(botId);
    const retired: WorkspaceRetirement = { count: 0 };
    this.retiredStaging.set(botId, retired);
    try {
      return await work();
    } finally {
      this.retiredStaging.delete(botId);
      unlock();
      // Each directory has already been detached under the lock. Recursive removal
      // cannot block database settlement or touch the next published home.
      void retired.staging?.remove().catch((error) => {
        getLogger().warn("workspace save cleanup", { error });
      });
    }
  }

  private async retireDirectory(botId: string, directory: string) {
    if (!(await pathExists(directory))) return;
    const retired = this.retiredStaging.get(botId);
    if (!retired) throw new Error("Workspace retirement requires the home lock");
    retired.staging ??= await createStagingDirectory(path.join(this.root, "staging"));
    await rename(directory, path.join(retired.staging.path, String(++retired.count)));
  }

  async discardStagedDirectory(botId: string, staging: string, directory: string) {
    if (!this.saveStaging.has(staging)) throw new Error("Workspace staging is not owned");
    await this.retireDirectory(botId, safeJoin(staging, directory));
  }

  async discardSavedDirectory(botId: string, directory: string) {
    const [root, target] = await Promise.all([realpath(this.botDir(botId)), realpath(directory)]);
    if (target !== directory || target === root) throw new Error("Path escapes the bot home");
    assertContained(root, target);
    await this.retireDirectory(botId, target);
  }

  private async lockHome(botId: string, mode: "shared" | "exclusive" = "exclusive") {
    this.botDir(botId);
    const directory = path.join(this.root, "workspace-locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Keep the empty lock file stable. Replacing it while another process holds it
    // would let two processes lock different inodes for the same home.
    const database = new DatabaseSync(path.join(directory, `${botId}.sqlite`), { timeout: 0 });
    const deadline = performance.now() + HOME_LOCK_WAIT_MS;
    try {
      while (true) {
        try {
          if (mode === "shared") {
            database.exec("BEGIN");
            try {
              database.exec("SELECT name FROM sqlite_schema LIMIT 1");
            } catch (error) {
              database.exec("ROLLBACK");
              throw error;
            }
          } else {
            database.exec("BEGIN EXCLUSIVE");
          }
          return () => database.close();
        } catch (error) {
          if (!isBusyLock(error) || performance.now() >= deadline) throw error;
          await delay(50);
        }
      }
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async lockReadableHome(botId: string) {
    while (true) {
      const unlock = await this.lockHome(botId, "shared");
      try {
        if (!(await this.needsRecovery(botId))) return unlock;
      } catch (error) {
        unlock();
        throw error;
      }
      unlock();
      // Finishing a pending publication is a write, so do not upgrade a held read lock.
      await this.withHomeLock(botId, () => this.recoverInterruptedCommit(botId));
    }
  }

  async createStaging() {
    const now = Date.now();
    if (now >= this.nextStagingSweep) {
      this.nextStagingSweep = now + STALE_STAGING_MS;
      await this.removeStaleStaging(now).catch((error) => {
        getLogger().warn("workspace staging cleanup", { error });
      });
    }
    const staging = await createStagingDirectory(path.join(this.root, "staging"));
    this.saveStaging.add(staging.path);
    return {
      path: staging.path,
      remove: async () => {
        this.saveStaging.delete(staging.path);
        await staging.remove();
      },
    };
  }

  /** Only owned save directories on this store's volume are eligible for age-based cleanup. */
  async removeStaleStaging(now = Date.now()) {
    const parent = path.join(this.root, "staging");
    const entries = await readdir(parent, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(SAVE_STAGING_PREFIX) ||
        !/^[A-Za-z0-9]{6}$/.test(entry.name.slice(SAVE_STAGING_PREFIX.length))
      )
        continue;
      const directory = path.join(parent, entry.name);
      if (this.saveStaging.has(directory)) continue;
      const info = await lstat(directory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info?.isDirectory() && info.mtimeMs < now - STALE_STAGING_MS)
        await rm(directory, { recursive: true, force: true });
    }
  }

  async commit(
    botId: string,
    src: string,
    _context: AdapterContext,
    publisher?: HomePublisher,
  ): Promise<string> {
    return this.withBotWrite(botId, async () => {
      const dest = this.botDir(botId);
      const parent = path.dirname(dest);
      const staged = this.saveStaging.has(src);
      const staging = staged ? src : path.join(parent, `.${botId}.staging-${randomUUID()}`);
      await mkdir(parent, { recursive: true });
      try {
        if (!staged) {
          await mkdir(staging, { recursive: true });
          await copyDir(src, staging);
        }
        if (publisher) return await this.publishCheckpoint(botId, staging, publisher);
        await this.recoverInterruptedCommit(botId);
        const previous = `${dest}.previous`;
        const hadHome = await pathExists(dest);
        await rm(previous, { recursive: true, force: true });
        if (hadHome) await rename(dest, previous);
        let installed = false;
        try {
          await rename(staging, dest);
          installed = true;
          const revision = newHomeRevision();
          await this.writeMarker(botId, revision);
          await this.cleanCommittedPath(previous);
          return revision;
        } catch (error) {
          if (installed) await rename(dest, staging);
          if (hadHome) await rename(previous, dest);
          throw error;
        }
      } finally {
        if (!staged) await this.cleanCommittedPath(staging);
      }
    });
  }

  async revise(botId: string, publisher?: HomePublisher): Promise<string> {
    return this.withBotWrite(botId, async () => {
      if (publisher) return this.publishCheckpoint(botId, undefined, publisher);
      await this.recoverInterruptedCommit(botId);
      const revision = newHomeRevision();
      await this.writeMarker(botId, revision);
      return revision;
    });
  }

  private async publishCheckpoint(
    botId: string,
    staging: string | undefined,
    { publish, prisma }: HomePublisher,
  ) {
    const revision = newHomeRevision();
    const dest = this.botDir(botId);
    const previous = `${dest}.previous`;
    let started = false;
    try {
      await publish(async (baseRevision) => {
        const pending: PendingCheckpoint = {
          revision,
          baseRevision,
          previousMarker: await this.readMarker(botId),
          replaceHome: staging !== undefined,
          hadHome: await pathExists(dest),
        };
        if (staging) await this.retireDirectory(botId, previous);
        await this.writeMetadata(this.pendingPath(botId), JSON.stringify(pending));
        started = true;
        if (staging) {
          if (pending.hadHome) await rename(dest, previous);
          await rename(staging, dest);
        }
        await this.writeMarker(botId, revision);
        return revision;
      });
    } catch (error) {
      if (started) {
        // A failed or unacknowledged DB commit must be reconciled under a new row lock.
        try {
          if ((await this.settleCheckpoint(botId, prisma)) === revision) return revision;
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "Workspace save needs to be reconciled",
          );
        }
      }
      throw error;
    }
    await this.settleCheckpoint(botId, prisma);
    return revision;
  }

  private pendingPath(botId: string) {
    this.botDir(botId);
    return path.join(this.root, "home-revisions", `${botId}.pending.json`);
  }

  private async settleCheckpoint(botId: string, prisma: PrismaClient) {
    return prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
        SELECT id FROM computers WHERE "homeKey" = ${botId} FOR UPDATE
      `;
        const record = await tx.computer.findFirst({
          where: { homeKey: botId },
          select: { homeRevision: true },
        });
        if (!record) throw new Error("Could not confirm the computer's saved revision");
        await this.reconcileCheckpoint(botId, record.homeRevision);
        return record.homeRevision;
      },
      { timeout: 20_000 },
    );
  }

  /** The caller holds the Computer row lock, including when finishing another process's save. */
  async reconcileCheckpoint(botId: string, committedRevision: string) {
    const journal = this.pendingPath(botId);
    const raw = await readFile(journal, "utf8").catch(ignoreMissingFile);
    const dest = this.botDir(botId);
    const previous = `${dest}.previous`;
    if (raw === null) {
      await this.recoverLegacyBackup(dest, previous);
      return;
    }
    const pending = JSON.parse(raw) as PendingCheckpoint;
    if (pending.revision === committedRevision) {
      if (pending.replaceHome && !(await pathExists(dest))) {
        throw new Error("The saved workspace directory is missing");
      }
      await this.writeMarker(botId, pending.revision);
      if (pending.replaceHome) await this.retireDirectory(botId, previous);
    } else if (pending.baseRevision === committedRevision) {
      if (pending.replaceHome) {
        if (await pathExists(previous)) {
          await this.retireDirectory(botId, dest);
          await rename(previous, dest);
        } else if (!pending.hadHome) {
          await this.retireDirectory(botId, dest);
        } else if (!(await pathExists(dest))) {
          throw new Error("The previous workspace directory is missing");
        }
      }
      await this.writeMarker(botId, pending.previousMarker);
    } else {
      throw new Error("The workspace save does not match the recorded revision");
    }
    await rm(journal, { force: true });
  }

  private async recoverLegacyBackup(dest: string, previous: string) {
    if ((await pathExists(previous)) && !(await pathExists(dest))) await rename(previous, dest);
  }

  private async cleanCommittedPath(directory: string) {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      getLogger().warn("workspace save cleanup", { error });
    });
  }

  async restore(
    botId: string,
    _revision: string,
    dest: string,
    context: AdapterContext,
  ): Promise<void> {
    await this.checkout(botId, dest, context);
  }

  async *exportHome(
    botId: string,
    _context: AdapterContext,
    { directory = "", skipHidden = false }: { directory?: string; skipHidden?: boolean } = {},
  ): AsyncIterable<PortableFile> {
    const unlock = await this.lockReadableHome(botId);
    try {
      const dir = this.botDir(botId);
      // Resolve the configured store first so a linked home cannot redefine containment.
      const storeRoot = await resolveExportPath(this.root);
      if (!storeRoot) return;
      const home = await resolveExportPath(dir);
      if (home !== safeJoin(storeRoot, `homes/${botId}`)) return;
      const expected = safeJoin(home, directory);
      const root = await resolveExportPath(expected);
      if (root !== expected) return;
      yield* walkFiles(root, root, skipHidden);
    } finally {
      unlock();
    }
  }

  async readFile(
    botId: string,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string> {
    return (await this.readFileBytes(botId, filePath, options?.maxBytes)).toString("utf8");
  }

  async readFileBytes(botId: string, filePath: string, maxBytes?: number): Promise<Buffer> {
    const unlock = await this.lockReadableHome(botId);
    const { handle, root } = await (async () => {
      const root = await realpath(this.botDir(botId));
      const full = await containedExistingPath(root, filePath);
      const handle = await open(
        full,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      return { handle, root };
    })().finally(unlock);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Home entry is not a regular file");
      assertContained(root, await fileHandlePath(handle.fd));
      if (maxBytes === undefined) return await handle.readFile();
      const tooLarge = () => new Error(`agent home file exceeds ${maxBytes} bytes`);
      if (info.size > maxBytes) throw tooLarge();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        start: 0,
        end: maxBytes,
      })) {
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size > maxBytes) throw tooLarge();
      }
      return Buffer.concat(chunks, size);
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    botId: string,
    filePath: string,
    content: string,
    _context: AdapterContext,
  ): Promise<void> {
    await this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const full = await containedWritePath(this.botDir(botId), filePath);
      const handle = await open(
        full,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  async list(botId: string, dirPath: string, _context: AdapterContext) {
    const unlock = await this.lockReadableHome(botId);
    try {
      const root = this.botDir(botId);
      const candidate = safeJoin(root, dirPath);
      const full = await ensureContainedDirectory(root, candidate);
      const entries = await readdir(full, { withFileTypes: true });
      const listed = await Promise.all(
        entries.map(async (entry) => {
          const child = await containedTarget(root, path.join(full, entry.name)).catch(() => null);
          if (!child) return null;
          const info = await stat(child);
          return {
            path: path.posix.join(dirPath.replace(/\\/g, "/"), entry.name),
            kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
            size: info.size,
          };
        }),
      );
      return listed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    } finally {
      unlock();
    }
  }

  private markerPath(botId: string) {
    this.botDir(botId);
    return path.join(this.root, "home-revisions", `${botId}.txt`);
  }

  private readMarker(botId: string) {
    return readFile(this.markerPath(botId), "utf8").catch(ignoreMissingFile);
  }

  private async writeMarker(botId: string, revision: string | null) {
    const file = this.markerPath(botId);
    if (revision === null) await rm(file, { force: true });
    else await this.writeMetadata(file, revision);
  }

  private async writeMetadata(file: string, content: string) {
    const staged = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(staged, content, { encoding: "utf8", mode: 0o600 });
      await rename(staged, file);
    } finally {
      await this.cleanCommittedPath(staged);
    }
  }

  private async needsRecovery(botId: string) {
    const dest = this.botDir(botId);
    return (
      (await pathExists(this.pendingPath(botId))) ||
      ((await pathExists(`${dest}.previous`)) && !(await pathExists(dest)))
    );
  }

  private async recoverInterruptedCommit(botId: string) {
    if (await pathExists(this.pendingPath(botId))) {
      if (!this.prisma) throw new Error("The saved workspace needs to be reconciled");
      await this.settleCheckpoint(botId, this.prisma);
    } else {
      const dest = this.botDir(botId);
      await this.recoverLegacyBackup(dest, `${dest}.previous`);
    }
  }

  private async withBotWrite<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.botWrites.get(botId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep the chain alive even when a prior write rejects, so later writers are not stuck
    // behind a permanently rejected predecessor.
    const queued = previous.catch(() => undefined).then(() => current);
    this.botWrites.set(botId, queued);
    await previous.catch(() => undefined);
    try {
      return await this.withHomeLock(botId, work);
    } finally {
      release();
      if (this.botWrites.get(botId) === queued) this.botWrites.delete(botId);
    }
  }

  private async waitForBotWrite(botId: string) {
    await (this.botWrites.get(botId) ?? Promise.resolve());
  }
}

function isBusyLock(error: unknown) {
  return (
    error instanceof Error &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}

function ignoreMissingFile(error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return null;
  throw error;
}

export function resolveAgentHomePath(home: AgentHomeStore, homeKey: string, dataDir = "./data") {
  if (home instanceof LocalAgentHomeStore) return home.pathFor(homeKey);
  return path.resolve(dataDir, "homes", homeKey);
}

function safeJoin(root: string, rel: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${rel.replace(/^\/+/, "")}`);
  assertContained(resolvedRoot, resolved);
  return resolved;
}

async function containedExistingPath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  return containedTarget(root, candidate);
}

async function containedWritePath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  const resolvedParent = await ensureContainedDirectory(root, path.dirname(candidate));
  try {
    return await containedTarget(root, path.join(resolvedParent, path.basename(candidate)));
  } catch (error) {
    if (isMissing(error)) return path.join(resolvedParent, path.basename(candidate));
    throw error;
  }
}

async function ensureContainedDirectory(root: string, candidate: string) {
  await mkdir(root, { recursive: true });
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  assertContained(lexicalRoot, lexicalCandidate);
  const resolvedRoot = await realpath(root);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      current = await realpath(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next).catch((mkdirError: unknown) => {
        if (
          !(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")
        ) {
          throw mkdirError;
        }
      });
      current = await realpath(next);
    }
    assertContained(resolvedRoot, current);
    if (!(await stat(current)).isDirectory()) throw new Error("Path component is not a directory");
  }
  return current;
}

async function containedTarget(root: string, candidate: string) {
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(candidate)]);
  assertContained(resolvedRoot, resolvedTarget);
  return resolvedTarget;
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertContained(root: string, candidate: string) {
  if (!isContained(root, candidate)) throw new Error("Path escapes the bot home");
}

function isHiddenTopEntry(root: string, candidate: string) {
  return path.relative(root, candidate).split(path.sep)[0]!.startsWith(".");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function resolveExportPath(candidate: string) {
  return realpath(candidate).catch((error: unknown) => {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  });
}

async function exportTarget(root: string, candidate: string, skipHidden: boolean) {
  const resolved = await resolveExportPath(candidate);
  if (!resolved || !isContained(root, resolved)) return null;
  if (skipHidden && isHiddenTopEntry(root, resolved)) return null;
  return resolved;
}

async function traversalTarget(root: string, candidate: string) {
  const resolved = await realpath(candidate);
  assertContained(root, resolved);
  return resolved;
}

async function readTraversalFile(root: string, full: string, skipHidden = false) {
  const handle = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Home entry is not a regular file");
    // O_NOFOLLOW only protects the final component. A parent can be swapped
    // during open and restored before any pathname recheck. Check the actual
    // opened object against the root captured once for the entire traversal.
    const opened = await fileHandlePath(handle.fd);
    assertContained(root, opened);
    if (skipHidden && isHiddenTopEntry(root, opened)) throw new Error("Home entry is hidden");
    return { content: await handle.readFile(), mode: info.mode };
  } finally {
    await handle.close();
  }
}

async function copyDir(
  src: string,
  dest: string,
  sourceRoot?: string,
  visited = new Set<string>(),
) {
  const root = sourceRoot ?? (await realpath(src));
  const current = await traversalTarget(root, src).catch(() => null);
  if (!current || visited.has(current)) return;
  await mkdir(dest, { recursive: true });
  visited.add(current);
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = await traversalTarget(root, path.join(current, entry.name)).catch(() => null);
    if (!from) continue;
    const to = path.join(dest, entry.name);
    const info = await stat(from);
    if (info.isDirectory()) await copyDir(from, to, root, visited);
    else if (info.isFile()) {
      const file = await readTraversalFile(root, from);
      await writeFile(to, file.content, { mode: file.mode & 0o777 });
    }
  }
}

async function* walkFiles(
  root: string,
  current: string,
  skipHidden: boolean,
  outputPath = "",
  visited = new Set<string>(),
): AsyncGenerator<PortableFile> {
  const resolvedCurrent = await exportTarget(root, current, skipHidden);
  if (!resolvedCurrent || visited.has(resolvedCurrent)) return;
  visited.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true });
  for (const entry of entries) {
    const portablePath = path.posix.join(outputPath, entry.name);
    if (skipHidden && portablePath.startsWith(".")) continue;
    const full = await exportTarget(root, path.join(resolvedCurrent, entry.name), skipHidden);
    if (!full) continue;
    const info = await stat(full);
    if (info.isDirectory()) {
      yield* walkFiles(root, full, skipHidden, portablePath, visited);
    } else if (info.isFile()) {
      const { content, mode } = await readTraversalFile(root, full, skipHidden);
      yield {
        path: portablePath,
        content: new Uint8Array(content),
        executable: Boolean(mode & 0o100),
      };
    }
  }
}
