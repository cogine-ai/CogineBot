import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
  StreamedPortableFile,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import { SandboxDamagedError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import type { ComputerMode, WorkspaceSaveProgress } from "@rakazo/contracts";
import { parseScreenLeaseId } from "@rakazo/core";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  notifyWorkspaceSaveChanged,
  recordWorkspaceSaveFailure,
  WorkspaceSaveDiskSpaceError,
  workspaceSaveFailureReason,
  writeWorkspaceSaveProgress,
} from "./computer-save-status.js";
import { normalizeWorkspacePath, teamBotWorkspaceDirectory } from "./computer-support.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";
import type { HomePublisher } from "./home.js";
import { createStagingDirectory, LocalAgentHomeStore } from "./home.js";
import { shouldSkipPortableWorkspaceFile, WORKSPACE_SAVE_LIMITS } from "./workspace-save-policy.js";

export { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

export const PORTABLE_TRANSFER_BATCH_BYTES = 8 * 1024 * 1024;
const SAVE_DISK_RESERVE_BYTES = 2 * 1024 ** 3;
const FREE_DISK_CHECK_BYTES = 256 * 1024 ** 2;
const FILE_DISK_OVERHEAD_BYTES = 4096;

type CheckpointOptions = {
  onExported?: () => void;
  onStagingFailure?: () => void;
  onProgress?: (progress: WorkspaceSaveProgress, finished?: boolean) => Promise<void>;
  prisma?: PrismaClient;
  publish?: (
    install: (currentRevision: string) => Promise<string>,
    staging?: string,
  ) => Promise<string>;
};

export class ComputerCheckpointChangedError extends Error {
  constructor() {
    super("The computer changed while its files were being saved. Try again.");
    this.name = "ComputerCheckpointChangedError";
  }
}

export async function restoreComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) return;
  await sandbox.importWorkspace(computer, home.exportHome(homeKey, context), context);
}

export async function ensureComputerWorkspaceLayout(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string | undefined,
  context: AdapterContext,
): Promise<void> {
  if (scope !== "team" || !botId) return;
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(botId)] },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(`Could not prepare Team Computer folders${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

const TEAM_BOT_FOLDER_NAME = /^[A-Za-z0-9_-]+$/;
const TEAM_BROWSER_PROFILE_NAME = /^chromium-bot-[0-9a-f]{32}$/;

/** A bot id that names exactly one folder under bots/ on a Team Computer. */
export function isTeamBotFolderName(botId: string) {
  return TEAM_BOT_FOLDER_NAME.test(botId);
}

/** The bot's browser profile folder under .browser-profiles on a Team Computer. */
export function teamBrowserProfileName(botId: string) {
  const name = path.posix.basename(browserProfilePathForScreen(botId));
  if (!TEAM_BROWSER_PROFILE_NAME.test(name)) return null;
  return name;
}

const REMOVE_CONTAINED_DIRECTORIES = [
  'parent="$1"',
  "shift",
  'case "$parent" in',
  "  .browser-profiles) pattern='^chromium-bot-[0-9a-f]{32}$' ;;",
  "  bots) pattern='^[A-Za-z0-9_-]+$' ;;",
  '  *) echo "folder escapes the team home" >&2; exit 1 ;;',
  "esac",
  'if [ -L "$parent" ]; then echo "folder escapes the team home" >&2; exit 1; fi',
  "remove_one() {",
  '  name="$1"',
  '  if [[ ! "$name" =~ $pattern ]]; then echo "folder escapes the team home" >&2; return 1; fi',
  '  target="$parent/$name"',
  '  if [ ! -e "$target" ] && [ ! -L "$target" ]; then return 0; fi',
  '  if [ -L "$target" ]; then rm -- "$target"; return; fi',
  '  if [ ! -d "$target" ]; then echo "folder escapes the team home" >&2; return 1; fi',
  '  resolved_parent=$(cd -- "$parent" && pwd -P)',
  '  resolved_target=$(cd -- "$target" && pwd -P)',
  '  case "$resolved_target" in',
  '    "$resolved_parent/$name") ;;',
  '    *) echo "folder escapes the team home" >&2; return 1 ;;',
  "  esac",
  '  rm -rf -- "$target"',
  "}",
  "status=0",
  'for name in "$@"; do remove_one "$name" || status=1; done',
  'exit "$status"',
].join("\n");

/**
 * Delete folders on the computer. Each name is checked on its own: a symlinked parent is
 * refused, a final symlink is unlinked, and one refused name does not stop the rest.
 */
export async function removeComputerWorkspaceDirectories(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  parent: ".browser-profiles" | "bots",
  names: readonly string[],
  context: AdapterContext,
): Promise<void> {
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["bash", "-eu", "-c", REMOVE_CONTAINED_DIRECTORIES, "bash", parent, ...names],
      cwd: ".",
    },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "workspace folder cleanup failed");
  }
}

const DELETED_BOT_FOLDER_BATCH = 200;
const DELETED_BOT_FOLDER_BUDGET_MS = 20_000;

/**
 * Remove folders and browser profiles left by bots deleted while this Team Computer was asleep
 * or unreachable. Waits at most budgetMs; anything left is retried on a later boot.
 */
export async function removeDeletedBotWorkspaces(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: ComputerRef,
  spaceId: string,
  context: AdapterContext,
  budgetMs = DELETED_BOT_FOLDER_BUDGET_MS,
): Promise<void> {
  await withCleanupDeadline(context, budgetMs, (cleanupContext) =>
    removeDeletedBotFolders(deps, computer, spaceId, cleanupContext),
  );
}

/**
 * Run best-effort cleanup for at most budgetMs. Its commands are aborted at the deadline, and
 * a provider that ignores the abort still cannot hold the caller past it.
 */
export async function withCleanupDeadline(
  context: AdapterContext,
  budgetMs: number,
  work: (context: AdapterContext) => Promise<void>,
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("team bot folder cleanup ran out of time")),
    budgetMs,
  );
  const expired = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), {
      once: true,
    });
  });
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  try {
    await Promise.race([work({ ...context, signal }), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeDeletedBotFolders(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: ComputerRef,
  spaceId: string,
  context: AdapterContext,
) {
  // Work follows what is still on the computer, not the space's whole deletion history, so
  // every boot makes progress on the leftovers.
  const present = new Set(await listTeamBotEntries(deps.sandbox, computer, context));
  if (!present.size) return;
  const deleted = await deps.prisma.botDeletion.findMany({
    where: { spaceId },
    select: { id: true },
  });
  const folders: string[] = [];
  const profiles: string[] = [];
  for (const { id } of deleted) {
    if (!isTeamBotFolderName(id)) continue;
    if (present.has(`bots/${id}`)) folders.push(id);
    const profile = teamBrowserProfileName(id);
    if (profile && present.has(`.browser-profiles/${profile}`)) profiles.push(profile);
  }
  for (const [parent, names] of [
    ["bots", folders],
    [".browser-profiles", profiles],
  ] as const) {
    for (let start = 0; start < names.length; start += DELETED_BOT_FOLDER_BATCH) {
      if (context.signal.aborted) return;
      await removeComputerWorkspaceDirectories(
        deps.sandbox,
        computer,
        parent,
        names.slice(start, start + DELETED_BOT_FOLDER_BATCH),
        context,
      ).catch((error) => {
        getLogger().error("team bot folder cleanup", error);
      });
    }
  }
}

// A shell glob also lists the symlinks some provider file listings leave out.
const LIST_TEAM_BOT_ENTRIES = [
  "for dir in bots .browser-profiles; do",
  '  if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi',
  '  for entry in "$dir"/*; do',
  '    if [ -e "$entry" ] || [ -L "$entry" ]; then printf \'%s\\n\' "$entry"; fi',
  "  done",
  "done",
].join("\n");

async function listTeamBotEntries(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string[]> {
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-eu", "-c", LIST_TEAM_BOT_ENTRIES], cwd: "." },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) throw new Error(stderr.trim() || "workspace folder listing failed");
  return stdout.split("\n").filter(Boolean);
}

export async function checkpointComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
  options?: CheckpointOptions,
  saveLimits: WorkspaceExportLimits = WORKSPACE_SAVE_LIMITS,
): Promise<string> {
  const { prisma, publish, onProgress } = options ?? {};
  const publisher = (staging?: string): HomePublisher | undefined =>
    prisma && publish ? { prisma, publish: (install) => publish(install, staging) } : undefined;
  context.signal.throwIfAborted();
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) {
    options?.onExported?.();
    return home.revise(homeKey, publisher());
  }
  const failStaging: (error: unknown) => never = (error) => {
    options?.onStagingFailure?.();
    throw error;
  };
  let staging: Awaited<ReturnType<typeof createStagingDirectory>>;
  try {
    staging =
      home instanceof LocalAgentHomeStore
        ? await home.createStaging()
        : await createStagingDirectory();
  } catch (error) {
    failStaging(error);
  }
  try {
    const free = await freeSaveDisk(staging.path).catch(failStaging);
    if (free < 0) throw new WorkspaceSaveDiskSpaceError();
    const limits = { ...saveLimits, maxBytes: Math.min(saveLimits.maxBytes, free) };
    const diskLimited = limits.maxBytes < saveLimits.maxBytes;
    let bytes = 0;
    let files = 0;
    let unchecked = 0;
    const checkDisk = async (size: number) => {
      unchecked += size;
      if (unchecked < FREE_DISK_CHECK_BYTES) return;
      unchecked = 0;
      if ((await freeSaveDisk(staging.path)) < 0) throw new WorkspaceSaveDiskSpaceError();
    };
    const exportFiles = async function* () {
      try {
        yield* sandbox.exportWorkspace(computer, context, limits);
      } catch (error) {
        if (diskLimited && error instanceof WorkspaceTooLargeError && error.limit === "bytes")
          throw new WorkspaceSaveDiskSpaceError();
        throw error;
      }
    };
    for await (const file of exportFiles()) {
      let relative: string;
      try {
        context.signal.throwIfAborted();
        relative = normalizeWorkspacePath(file.path);
        if (shouldSkipPortableWorkspaceFile(relative)) continue;
        if (++files > limits.maxFiles) throw new WorkspaceTooLargeError("files");
        await checkDisk(FILE_DISK_OVERHEAD_BYTES);
      } catch (error) {
        failStaging(error);
      }
      await writePortableFile(
        staging.path,
        relative,
        file,
        async (size) => {
          bytes += size;
          if (bytes > limits.maxBytes) {
            throw diskLimited
              ? new WorkspaceSaveDiskSpaceError()
              : new WorkspaceTooLargeError("bytes");
          }
          await checkDisk(size);
          context.signal.throwIfAborted();
        },
        failStaging,
        onProgress ? () => onProgress({ files: files - 1, bytes }) : undefined,
      );
      await onProgress?.({ files, bytes });
    }
    await onProgress?.({ files, bytes }, true);
    options?.onExported?.();
    context.signal.throwIfAborted();
    if ((await freeSaveDisk(staging.path).catch(failStaging)) < 0)
      throw new WorkspaceSaveDiskSpaceError();
    const install = () => home.commit(homeKey, staging.path, context);
    const revision =
      home instanceof LocalAgentHomeStore
        ? await home.commit(homeKey, staging.path, context, publisher(staging.path))
        : await (publish?.(install, staging.path) ?? install());
    return revision;
  } finally {
    await staging.remove().catch((error) => {
      getLogger().warn("workspace staging cleanup", { error });
    });
  }
}

async function freeSaveDisk(directory: string) {
  const disk = await statfs(directory);
  return Number(disk.bavail) * Number(disk.bsize) - SAVE_DISK_RESERVE_BYTES;
}

/** Remote exports quiesce browsers, so a run must not checkpoint while peers are driving them. */
export async function checkpointRunComputerWorkspace(
  deps: {
    home: AgentHomeStore;
    sandbox: SandboxProvider;
    prisma: PrismaClient;
    events?: ThreadEvents;
  },
  computerRecord: { id: string; homeKey: string; scope: string; spaceId: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string | undefined> {
  if (computerRecord.scope !== "team" || computer.kind === "docker") {
    return checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  }
  const now = new Date();
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerRecord.id,
      state: "running",
      providerRef: computer.providerRef,
      ...checkpointAvailable(context, now),
    },
    data: { state: "suspending", updatedAt: now },
  });
  // The last finishing run or the already scheduled idle job will checkpoint the shared home.
  if (claimed.count !== 1) return undefined;
  const claim = { state: "suspending", updatedAt: now };
  try {
    return await checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context, {
      claim,
    });
  } catch (error) {
    if (!(error instanceof ComputerCheckpointChangedError)) throw error;
    return undefined;
  } finally {
    await deps.prisma.computer.updateMany({
      where: { id: computerRecord.id, ...claim, providerRef: computer.providerRef },
      data: { state: "running" },
    });
  }
}

export async function checkpointAndRecordComputerWorkspace(
  deps: {
    home: AgentHomeStore;
    sandbox: SandboxProvider;
    prisma: PrismaClient;
    events?: ThreadEvents;
  },
  computerRecord: { id: string; homeKey: string; scope: string; spaceId: string },
  computer: ComputerRef,
  context: AdapterContext,
  options?: Pick<CheckpointOptions, "onExported" | "onStagingFailure"> & {
    claim?: Prisma.ComputerWhereInput;
    shouldReportFailure?: (error: unknown) => Promise<boolean>;
  },
): Promise<string> {
  const target = {
    state: { in: ["running", "suspending"] },
    ...options?.claim,
    id: computerRecord.id,
    homeKey: computerRecord.homeKey,
    restorePending: false,
    stopRequestedAt: null,
    providerRef: computer.providerRef,
    kind: computer.kind,
    ...(computer.providerAuthority ? { providerAuthority: computer.providerAuthority } : {}),
  } satisfies Prisma.ComputerWhereInput;
  const starting = await deps.prisma.computer.findFirst({
    where: { ...target, ...checkpointAvailable(context, new Date()) },
    select: {
      state: true,
      screenGeneration: true,
      maintenanceId: true,
      homeRevision: true,
      controlFence: true,
      controlLeaseId: true,
      executionFence: true,
      providerAuthority: true,
      workspaceSaveFailure: true,
    },
  });
  if (!starting) throw new ComputerCheckpointChangedError();
  const { workspaceSaveFailure, ...checkpointIdentity } = starting;
  const fence = { ...target, ...checkpointIdentity };
  const claimAt = options?.claim?.updatedAt;
  const progressClaim = deps.events && claimAt instanceof Date ? claimAt : undefined;
  const initialProgress =
    computer.kind === "docker" && deps.home instanceof LocalAgentHomeStore
      ? null
      : { files: 0, bytes: 0 };
  let progressVisible =
    progressClaim !== undefined &&
    (await writeWorkspaceSaveProgress(deps, fence, progressClaim, initialProgress));
  if (progressVisible) await notifyWorkspaceSaveChanged(deps, computerRecord);
  let lastProgress = Date.now();
  let storageFailure = false;
  let failed = false;
  try {
    return await checkpointComputerWorkspace(
      deps.home,
      deps.sandbox,
      computerRecord.homeKey,
      computer,
      context,
      {
        onExported: () => {
          storageFailure = true;
          options?.onExported?.();
        },
        onStagingFailure: () => {
          storageFailure = true;
          options?.onStagingFailure?.();
        },
        onProgress: progressClaim
          ? async (progress, finished) => {
              if (!progressVisible || (!finished && Date.now() - lastProgress < 1000)) return;
              lastProgress = Date.now();
              progressVisible = await writeWorkspaceSaveProgress(
                deps,
                fence,
                progressClaim,
                progress,
              );
            }
          : undefined,
        prisma: deps.prisma,
        publish: async (install, staging) =>
          deps.prisma.$transaction(
            async (tx) => {
              // Acquire the same row that lifecycle writers and execution lease claims use.
              await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerRecord.id} FOR UPDATE`;
              const where = { ...fence, ...checkpointAvailable(context, new Date()) };
              const owned = await tx.computer.findFirst({
                where,
                select: { updatedAt: true, homeRevision: true },
              });
              if (!owned) throw new ComputerCheckpointChangedError();
              context.signal.throwIfAborted();
              if (deps.home instanceof LocalAgentHomeStore) {
                await deps.home.reconcileCheckpoint(computerRecord.homeKey, owned.homeRevision);
              }
              if (staging && computerRecord.scope === "team") {
                const home = deps.home;
                await removeDeletedStagedWorkspaces(
                  tx,
                  computerRecord.spaceId,
                  staging,
                  (directory) =>
                    home instanceof LocalAgentHomeStore
                      ? home.discardStagedDirectory(computerRecord.homeKey, staging, directory)
                      : rm(path.join(staging, directory), { recursive: true, force: true }),
                );
              }
              context.signal.throwIfAborted();
              const ready = await tx.computer.findFirst({
                where: { ...fence, ...checkpointAvailable(context, new Date()) },
                select: { id: true },
              });
              if (!ready) throw new ComputerCheckpointChangedError();
              const revision = await install(owned.homeRevision);
              const saved = await tx.computer.updateMany({
                where: { ...fence, ...checkpointAvailable(context, new Date()) },
                data: {
                  homeRevision: revision,
                  homeRevisionAt: new Date(),
                  workspaceSaveProgress: Prisma.DbNull,
                  workspaceSaveFailure: Prisma.DbNull,
                  autoRecoveredAt: null,
                  updatedAt: owned.updatedAt,
                },
              });
              if (saved.count !== 1) throw new ComputerCheckpointChangedError();
              return revision;
            },
            { timeout: 20_000 },
          ),
      },
    );
  } catch (error) {
    const defaultReport =
      storageFailure ||
      !(
        error instanceof SandboxDamagedError ||
        (computer.kind === "e2b" && isSandboxGoneError(error))
      );
    if (
      !context.signal.aborted &&
      !(error instanceof ComputerCheckpointChangedError) &&
      (options?.shouldReportFailure ? await options.shouldReportFailure(error) : defaultReport)
    ) {
      failed = true;
      await recordWorkspaceSaveFailure(
        deps,
        computerRecord,
        () => ({ ...fence, ...checkpointAvailable(context, new Date()) }),
        context,
        workspaceSaveFailureReason(error, storageFailure),
      );
    }
    throw error;
  } finally {
    if (progressClaim) {
      await writeWorkspaceSaveProgress(deps, fence, progressClaim, undefined);
    }
    if (progressClaim || failed || workspaceSaveFailure) {
      await notifyWorkspaceSaveChanged(deps, computerRecord);
    }
  }
}

function checkpointAvailable(context: AdapterContext, now: Date): Prisma.ComputerWhereInput {
  const lease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : undefined;
  const own = lease ? { runId: lease.ownerId, fence: lease.fence } : undefined;
  const live = { expiresAt: { gt: now } };
  return {
    OR: [
      { controlHolder: { not: "user" } },
      { controlLeaseId: null },
      { controlLeaseExpiresAt: null },
      { controlLeaseExpiresAt: { lte: now } },
      ...(context.botId ? [{ controlBotId: context.botId }] : []),
    ],
    executionLeases: {
      none: { ...live, ...(own ? { NOT: own } : {}) },
      ...(own && context.runId === own.runId
        ? { some: { ...live, ...own, botId: context.botId } }
        : {}),
    },
  };
}

/** A snapshot from a still-running Team Computer may predate the deletion. */
async function removeDeletedStagedWorkspaces(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  spaceId: string,
  staging: string,
  discard: (directory: string) => Promise<void>,
) {
  const [folders, profiles] = await Promise.all([
    stagedTeamEntries(path.join(staging, "bots"), TEAM_BOT_FOLDER_NAME),
    stagedTeamEntries(path.join(staging, ".browser-profiles"), TEAM_BROWSER_PROFILE_NAME),
  ]);
  if (!folders.size && !profiles.size) return;

  // Match the browser's UTF-8 SHA-256 name without returning the space's deletion history.
  const deleted = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM bot_deletions
    WHERE "spaceId" = ${spaceId}
      AND (
        id = ANY(${[...folders]}::text[])
        OR ('chromium-bot-' || left(encode(sha256(convert_to(id, 'UTF8')), 'hex'), 32))
          = ANY(${[...profiles]}::text[])
      )
  `;
  for (const { id } of deleted) {
    if (folders.has(id)) await discard(`bots/${id}`);
    const profile = teamBrowserProfileName(id);
    if (profile && profiles.has(profile)) await discard(`.browser-profiles/${profile}`);
  }
}

async function stagedTeamEntries(directory: string, pattern: RegExp) {
  try {
    return new Set((await readdir(directory)).filter((name) => pattern.test(name)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return new Set<string>();
  }
}

async function writePortableFile(
  root: string,
  relative: string,
  file: PortableFile | StreamedPortableFile,
  count: (bytes: number) => Promise<void>,
  failStaging: (error: unknown) => never,
  onWritten?: () => Promise<void>,
) {
  let handle: FileHandle;
  try {
    if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
    const target = path.resolve(root, relative);
    const resolvedRoot = path.resolve(root);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Workspace snapshot path escapes its staging directory");
    }
    await mkdir(path.dirname(target), { recursive: true });
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      file.executable ? 0o700 : 0o600,
    );
  } catch (error) {
    failStaging(error);
  }
  let complete = false;
  try {
    // Iterator failures belong to the provider; only local writes mark staging failed.
    for await (const chunk of "body" in file ? file.body : [file.content]) {
      try {
        await count(chunk.byteLength);
        for (let offset = 0; offset < chunk.byteLength; ) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Workspace file write made no progress");
          offset += bytesWritten;
        }
      } catch (error) {
        failStaging(error);
      }
      await onWritten?.();
    }
    complete = true;
  } finally {
    await handle.close().catch((error) => {
      if (complete) failStaging(error);
      getLogger().warn("workspace staging file cleanup", { error });
    });
  }
}
