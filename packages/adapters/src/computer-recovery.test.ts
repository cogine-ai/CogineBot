import type * as FileSystemPromises from "node:fs/promises";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerBusyError,
  ComputerRecoveryRequiredError,
  provisionComputer,
  replaceComputer,
} from "./computer-lifecycle.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const stagingFaults = vi.hoisted(() => ({
  create: undefined as Error | undefined,
  write: undefined as Error | undefined,
  cleanup: undefined as Error | undefined,
  cleanupTarget: undefined as string | undefined,
  failedCleanups: 0,
  diskChecksUntilFull: undefined as number | undefined,
  directories: new Set<string>(),
  writeTargets: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const staging = String(args[0]).replace(/\\/g, "/").split("/").at(-1) === "workspace-save-";
      if (staging && stagingFaults.create) throw stagingFaults.create;
      const directory = await actual.mkdtemp(...args);
      if (staging && typeof directory === "string") stagingFaults.directories.add(directory);
      return directory;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      const staging = [...stagingFaults.directories].some(
        (directory) => target.startsWith(`${directory}/`) || target.startsWith(`${directory}\\`),
      );
      if (staging) {
        stagingFaults.writeTargets.push(target);
        if (stagingFaults.write) throw stagingFaults.write;
      }
      return actual.open(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (stagingFaults.cleanupTarget === String(args[0]) && stagingFaults.cleanup) {
        stagingFaults.failedCleanups++;
        throw stagingFaults.cleanup;
      }
      return actual.rm(...args);
    },
    statfs: async (target: string) => {
      const disk = await actual.statfs(target);
      if (
        stagingFaults.directories.has(target) &&
        stagingFaults.diskChecksUntilFull !== undefined &&
        stagingFaults.diskChecksUntilFull-- <= 0
      ) {
        return { ...disk, bavail: 0 };
      }
      return disk;
    },
  };
});

function clearStagingFaults() {
  stagingFaults.create = undefined;
  stagingFaults.write = undefined;
  stagingFaults.cleanup = undefined;
  stagingFaults.cleanupTarget = undefined;
  stagingFaults.failedCleanups = 0;
  stagingFaults.diskChecksUntilFull = undefined;
  stagingFaults.writeTargets = [];
}

function failSaveCleanup(home: LocalAgentHomeStore, error: Error) {
  stagingFaults.cleanup = error;
  const createStaging = home.createStaging.bind(home);
  vi.spyOn(home, "createStaging").mockImplementation(async () => {
    const staging = await createStaging();
    stagingFaults.cleanupTarget = staging.path;
    return staging;
  });
}

const context = {
  operationId: "recovery",
  traceId: "recovery",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
afterEach(async () => {
  clearStagingFaults();
  const staging = [...stagingFaults.directories];
  await Promise.all(staging.map((directory) => rm(directory, { recursive: true, force: true })));
  for (const directory of staging)
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  stagingFaults.directories.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: "fake" | "desktop" = "fake") {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-recovery-"));
  roots.push(root);
  const sandbox: SandboxProvider =
    provider === "desktop" ? new DesktopSandboxProvider({ root }) : new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  await home.writeFile("bot", "notes.txt", "checkpoint", context);
  await sandbox.writeFile(
    first,
    { path: "notes.txt", content: new TextEncoder().encode("live work") },
    context,
  );
  const row = {
    id: "computer",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    providerRef: first.providerRef as string | null,
    kind: first.kind,
    controlHolder: "none",
    controlLeaseId: null,
    maintenanceId: null as string | null,
    homeRevision: "saved",
    restorePending: false,
    stopRequestedAt: null as Date | null,
    autoRecoveredAt: null as Date | null,
    screenGeneration: 0,
    controlFence: 0,
    executionFence: 0,
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };
  // Model the atomic scalar predicates used by claims, including stale references
  // and the updatedAt claim stamp used for booting reclaim / end-of-boot writes.
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    findFirst: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const matches = [
        "id",
        "state",
        "providerRef",
        "kind",
        "updatedAt",
        "stopRequestedAt",
        "autoRecoveredAt",
        "screenGeneration",
      ].every((key) => {
        if (!(key in where)) return true;
        if (key === "stopRequestedAt" && where[key]?.not === null) {
          return row.stopRequestedAt !== null;
        }
        return where[key] === row[key as keyof typeof row];
      });
      if (!matches) return { count: 0 };
      if (
        (data.state &&
          data.state !== row.state &&
          !(row.state === "booting" && data.state === "running")) ||
        ("providerRef" in data && data.providerRef !== row.providerRef)
      )
        row.screenGeneration += 1;
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) =>
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data),
    ),
  };
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: row.id }]),
    $transaction: vi.fn(async (work: (tx: PrismaClient) => Promise<unknown>) =>
      work(prisma as unknown as PrismaClient),
    ),
    computer,
    computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { deps, row, computer, first, root };
}

describe("computer recovery preserves live work", () => {
  it("quarantines an abandoned stop before any provider operation", async () => {
    const { deps, row, first } = await fixture();
    row.state = "suspending";
    row.stopRequestedAt = row.updatedAt;
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerRecoveryRequiredError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      state: "quarantined",
      providerRef: first.providerRef,
      stopRequestedAt: null,
    });
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerRecoveryRequiredError,
    );
    await replaceComputer(deps, row.id, "recover", context);
    expect(row.state).toBe("running");
  });

  it("quarantines a stale restore without reusing the persisted candidate", async () => {
    const { deps, row, first } = await fixture();
    row.state = "restoring";
    row.restorePending = true;
    const provision = vi.spyOn(deps.sandbox, "provision");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerRecoveryRequiredError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "quarantined", providerRef: first.providerRef });
    await replaceComputer(deps, row.id, "recover", context);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerRef: first.providerRef }),
      expect.anything(),
    );
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      provision.mock.invocationCallOrder[0]!,
    );
    expect(row.state).toBe("running");
  });

  it("does not let an interrupted Desktop import write into a retired workspace's successor", async () => {
    const { deps, first, root } = await fixture("desktop");
    const successor = new DesktopSandboxProvider({ root });
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const content = new TextEncoder().encode("late");
    const importResult = deps.sandbox.importWorkspace(
      first,
      (async function* () {
        started();
        await gate;
        yield { path: "notes.txt", content };
      })(),
      context,
    );
    const checked = expect(importResult).rejects.toThrow();
    try {
      await paused;
      await successor.destroy(first, context, { retireWorkspace: true });
      const next = await successor.provision(
        { botId: "bot", homePath: root, isolateWorkspaceGeneration: true },
        context,
      );
      expect(next.providerRef).not.toBe(first.providerRef);
      await successor.writeFile(next, {
        path: "notes.txt",
        content: new TextEncoder().encode("new"),
      });
      // The older request can be delivered again after the new computer is active.
      await successor.destroy(first, context, { retireWorkspace: true });
      release();
      await checked;
      expect(new TextDecoder().decode(await successor.readFile(next, "notes.txt"))).toBe("new");
    } finally {
      release();
    }
  });

  it("renews a live restore through import and reconnect without a fixed deadline", async () => {
    const { deps, row } = await fixture();
    row.restorePending = true;
    const importWorkspace = deps.sandbox.importWorkspace.bind(deps.sandbox);
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markReconnecting!: () => void;
    let finishReconnecting!: () => void;
    const reconnecting = new Promise<void>((resolve) => {
      markReconnecting = resolve;
    });
    const reconnectGate = new Promise<void>((resolve) => {
      finishReconnecting = resolve;
    });
    vi.spyOn(deps.sandbox, "importWorkspace").mockImplementationOnce(async (...args) => {
      ready();
      await gate;
      await importWorkspace(...args);
    });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const restoring = provisionComputer(deps, row.id, context, "none", async (stage) => {
        if (stage !== "reconnecting") return;
        markReconnecting();
        await reconnectGate;
      });
      await started;
      const stamp = row.updatedAt.getTime();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(stamp + 5 * 60_000);
      await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      release();
      await reconnecting;
      const reconnectStamp = row.updatedAt.getTime();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(reconnectStamp + 5 * 60_000);
      await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      finishReconnecting();
      await restoring;
      expect(row).toMatchObject({ state: "running", restorePending: false });
    } finally {
      release();
      finishReconnecting();
      vi.useRealTimers();
    }
  });

  it("uses only one automatic attempt per saved workspace", async () => {
    const { deps, row, first } = await fixture();
    const stop = vi.spyOn(deps.sandbox, "stop").mockResolvedValue(undefined);
    const prepare = vi.spyOn(deps.sandbox, "prepare");
    prepare.mockRejectedValueOnce(new SandboxDamagedError());
    await provisionComputer(deps, row.id, context);
    expect(stop).toHaveBeenCalledOnce();
    expect(row.autoRecoveredAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({
      state: "running",
      providerRef: first.providerRef,
      restorePending: false,
    });
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");

    prepare.mockRejectedValueOnce(new SandboxDamagedError());
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      SandboxDamagedError,
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "needs_recovery", providerRef: first.providerRef });
  });

  it("reopens automatic recovery only after a new save, not a reset from the same revision", async () => {
    const { deps, row } = await fixture();
    const originalAttempt = new Date();
    row.autoRecoveredAt = originalAttempt;
    row.state = "needs_recovery";

    const reset = await replaceComputer(deps, row.id, "reset", context);
    expect(row.autoRecoveredAt).toBe(originalAttempt);
    await checkpointAndRecordComputerWorkspace(
      deps,
      { ...row, spaceId: context.spaceId },
      reset,
      context,
    );
    expect(row.autoRecoveredAt).toBeNull();
  });

  it("retries restoration for a live reference that is still marked pending", async () => {
    const { deps, row, first } = await fixture();
    row.restorePending = true;
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");

    const current = await provisionComputer(deps, row.id, context);

    expect(current.providerRef).toBe(first.providerRef);
    expect(restore).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", restorePending: false });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(current, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("blocks competing maintenance and boots while an update owns the computer", async () => {
    const { deps, row } = await fixture();
    row.maintenanceId = "other-update";
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    for (const mode of ["update", "recover", "reset"] as const) {
      await expect(replaceComputer(deps, row.id, mode, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("claims a running computer before concurrent workers can create competing replacements", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    // Both workers read the original row before either claims it; later reads
    // (claim stamp, activation) must see the live row so updatedAt fencing works.
    const original = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return { ...original };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const results = await Promise.allSettled([
      provisionComputer(deps, row.id, context),
      provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
    expect(provision).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(row.providerRef).toBe(successful[0]?.value.providerRef);
    expect(row.state).toBe("running");
  });

  it("rejects a delayed reconnect whose original reference was already replaced", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    const stale = { ...row };
    const winner = await provisionComputer(deps, row.id, context);
    await deps.sandbox.writeFile(
      winner,
      { path: "notes.txt", content: new TextEncoder().encode("winner work") },
      context,
    );
    computer.findUniqueOrThrow.mockResolvedValue(stale);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(winner.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(winner, "notes.txt", context)),
    ).toBe("winner work");
  });

  it("claims an abandoned booting computer only once when callers have no screenLeaseId", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "booting";
    row.providerRef = null;
    const observed = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      // First two reads are the concurrent observations before either claims.
      if (reads <= 2) return { ...observed };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      const results = await Promise.allSettled([
        provisionComputer(deps, row.id, context),
        provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
      expect(provision).toHaveBeenCalledOnce();
      expect(row.state).toBe("running");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the reference and workspace through an uncertain reconnect and a retry", async () => {
    const { deps, row, first } = await fixture();
    const error = new Error("fetch failed");
    vi.spyOn(deps.sandbox, "provision").mockRejectedValueOnce(error);
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(error);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(restore).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each(["running", "error", "stopped", "suspended"])(
    "reconnects desktop files after an adapter restart from %s without importing an old checkpoint",
    async (state) => {
      const { deps, row, root, first } = await fixture("desktop");
      row.state = state;
      deps.sandbox = new DesktopSandboxProvider({ root });
      const restore = vi.spyOn(deps.sandbox, "importWorkspace");
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(restore).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("live work");
    },
  );

  it("restores the checkpoint when a desktop workspace is actually absent after restart", async () => {
    const { deps, row, root, first } = await fixture("desktop");
    expect(first.fresh).toBe(true);
    await rm(first.providerRef, { recursive: true });
    deps.sandbox = new DesktopSandboxProvider({ root });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ fresh: true });
    expect(reconnected.providerRef).not.toBe(first.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("retains restore intent if Desktop recreates its directory and provisioning is interrupted", async () => {
    const { deps, row, root, first } = await fixture("desktop");
    await rm(first.providerRef, { recursive: true });
    const provider = new DesktopSandboxProvider({ root });
    deps.sandbox = provider;
    const provision = provider.provision.bind(provider);
    const interrupted = new Error("Synthetic interruption after workspace creation");
    vi.spyOn(provider, "provision").mockImplementationOnce(async (...args) => {
      const recreated = await provision(...args);
      expect(row.restorePending).toBe(true);
      expect(recreated).toMatchObject({ fresh: true });
      expect(recreated.providerRef).not.toBe(first.providerRef);
      expect(row.providerRef).toBe(recreated.providerRef);
      throw interrupted;
    });

    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(interrupted);
    expect(row).toMatchObject({ state: "error", restorePending: true });
    await expect(access(first.providerRef)).rejects.toMatchObject({ code: "ENOENT" });
    const candidate = row.providerRef!;
    await expect(access(candidate)).resolves.toBeUndefined();

    deps.sandbox = new DesktopSandboxProvider({ root });
    const restarted = await provisionComputer(deps, row.id, context);
    expect(restarted).toMatchObject({ providerRef: candidate, fresh: false });
    expect(row).toMatchObject({ state: "running", restorePending: false });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(restarted, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("does not implicitly recreate a missing desktop workspace while preparing Team folders", async () => {
    const { deps, row, first } = await fixture("desktop");
    await rm(first.providerRef, { recursive: true });
    const execute = deps.sandbox.execute(
      first,
      { argv: ["mkdir", "-p", "shared", "bots/bot"] },
      context,
    );
    const events = [];
    for await (const event of execute) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 1 });
    await expect(access(first.providerRef)).rejects.toMatchObject({ code: "ENOENT" });

    const restored = await provisionComputer(deps, row.id, context);
    expect(restored).toMatchObject({ fresh: true });
    expect(restored.providerRef).not.toBe(first.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(restored, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it.each([
    "Path notes.txt not found",
    "404: file not found",
    "command not found",
    "checkpoint directory does not exist",
    "export process killed",
    "ECONNRESET",
  ])("aborts update and its retry when checkpoint fails with %s", async (message) => {
    const { deps, row, first } = await fixture();
    const error = new Error(message);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw error;
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(error);
      expect(row).toMatchObject({
        state: "running",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("continues update from the last revision when checkpoint finds the sandbox gone", async () => {
    const { deps, row } = await fixture();
    row.kind = "e2b";
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw Object.assign(new Error("Sandbox not found"), { name: "SandboxNotFoundError" });
    });
    const updated = await replaceComputer(deps, row.id, "update", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each([
    { label: "gone before bytes", partial: false, confirmed: true, cancelled: false },
    { label: "gone after partial bytes", partial: true, confirmed: true, cancelled: false },
    { label: "transport error after bytes", partial: true, confirmed: false, cancelled: false },
    { label: "cancelled after bytes", partial: true, confirmed: true, cancelled: true },
  ])("classifies streamed workspace failure: $label", async ({ partial, confirmed, cancelled }) => {
    const { deps, row, first } = await fixture();
    row.kind = "e2b";
    const abort = new AbortController();
    const failure = new Error("Synthetic streamed provider failure");
    if (confirmed) failure.name = "SandboxNotFoundError";
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield {
        path: "notes.txt",
        body: (async function* () {
          if (partial) yield Buffer.from("partial workspace bytes");
          if (cancelled) abort.abort(failure);
          throw failure;
        })(),
      };
    });
    const commit = vi.spyOn(deps.home, "commit");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    const recovery = replaceComputer(deps, row.id, "recover", { ...context, signal: abort.signal });
    if (confirmed && !cancelled) {
      const recovered = await recovery;
      expect(recovered.fresh).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(row.providerRef).toBe(recovered.providerRef);
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe("checkpoint");
    } else {
      await expect(recovery).rejects.toBe(failure);
      expect(destroy).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(row.providerRef).toBe(first.providerRef);
    }
    expect(row).toMatchObject({ state: "running", homeRevision: "saved" });
    expect(commit).not.toHaveBeenCalled();
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each(["running", "error"])(
    "updates a %s computer only after saving its current workspace",
    async (state) => {
      const { deps, row } = await fixture();
      row.state = state;
      const updated = await replaceComputer(deps, row.id, "update", context);
      expect(updated.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it.each([
    { label: "storage", gone: false },
    { label: "gone-shaped storage", gone: true },
  ])(
    "blocks recovery and its retry after a complete export on $label failure",
    async ({ gone }) => {
      const { deps, row, first } = await fixture();
      const failure = new Error("Synthetic home commit failure");
      if (gone) failure.name = "SandboxNotFoundError";
      const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
      let completedExports = 0;
      const exported = vi
        .spyOn(deps.sandbox, "exportWorkspace")
        .mockImplementation(async function* (...args) {
          yield* exportWorkspace(...args);
          completedExports += 1;
        });
      const commit = vi.spyOn(deps.home, "commit").mockRejectedValue(failure);
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      const provision = vi.spyOn(deps.sandbox, "provision");
      for (let attempt = 1; attempt <= 2; attempt++) {
        await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
        expect(completedExports).toBe(attempt);
        expect(commit).toHaveBeenCalledTimes(attempt);
        expect(row).toMatchObject({
          state: "running",
          providerRef: first.providerRef,
          homeRevision: "saved",
        });
        expect(destroy).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(
          new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
        ).toBe("live work");
        expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
      }
      commit.mockRestore();
      const recovered = await replaceComputer(deps, row.id, "recover", context);
      expect(recovered.fresh).toBe(true);
      expect(exported).toHaveBeenCalledTimes(3);
      expect(destroy).toHaveBeenCalledOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it("blocks recovery and its retry when the committed home revision cannot be recorded", async () => {
    const { deps, row, computer, first } = await fixture();
    const failure = new Error("Synthetic home revision record failure");
    const update = computer.updateMany.getMockImplementation();
    if (!update) throw new Error("Expected the fixture's fenced computer update");
    computer.updateMany.mockImplementation(async (input) => {
      if ("homeRevision" in input.data) throw failure;
      return update(input);
    });
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    const commit = vi.spyOn(deps.home, "commit");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
      expect(exported).toHaveBeenCalledTimes(attempt);
      expect(commit).toHaveBeenCalledTimes(attempt);
      expect(row).toMatchObject({
        state: "running",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
    }
    computer.updateMany.mockImplementation(update);
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(row.homeRevision).not.toBe("saved");
    expect(destroy).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
  });

  it.each([
    { state: "running", stage: "saving" },
    { state: "running", stage: "recreating" },
    { state: "error", stage: "recreating" },
  ] as const)(
    "preserves a $state computer when recovery progress fails at $stage",
    async ({ state, stage }) => {
      const { deps, row, first } = await fixture();
      row.state = state;
      const failure = new Error(`Synthetic ${stage} progress failure`);
      const progress = vi.fn<NonNullable<Parameters<typeof replaceComputer>[5]>>(
        async (current) => {
          if (current === stage) throw failure;
        },
      );
      const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      const provision = vi.spyOn(deps.sandbox, "provision");
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          replaceComputer(deps, row.id, "recover", context, "none", progress),
        ).rejects.toBe(failure);
        expect(row).toMatchObject({ state, providerRef: first.providerRef });
        expect(destroy).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(
          new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
        ).toBe("live work");
        expect(await deps.home.readFile("bot", "notes.txt", context)).toBe(
          state === "running" && stage === "recreating" ? "live work" : "checkpoint",
        );
      }
      if (stage === "saving" || state === "error") expect(exported).not.toHaveBeenCalled();
      else expect(exported).toHaveBeenCalledTimes(2);
      progress.mockImplementation(async () => undefined);
      const recovered = await replaceComputer(deps, row.id, "recover", context, "none", progress);
      expect(recovered.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe(state === "error" ? "checkpoint" : "live work");
    },
  );

  it.each([
    { label: "transport failure", gone: false },
    { label: "gone provider", gone: true },
  ])("preserves the saved home when workspace export stops early with $label", async ({ gone }) => {
    const { deps, row } = await fixture();
    row.kind = "e2b";
    const failure = new Error("Synthetic incomplete workspace export");
    if (gone) failure.name = "SandboxNotFoundError";
    const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* (...args) {
      for await (const file of exportWorkspace(...args)) {
        yield file;
        throw failure;
      }
      throw failure;
    });
    const commit = vi.spyOn(deps.home, "commit");
    if (!gone) {
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
      expect(destroy).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(row).toMatchObject({ state: "running", homeRevision: "saved" });
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
      return;
    }
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      state: "running",
      providerRef: recovered.providerRef,
      homeRevision: "saved",
    });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("checkpoint");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("recovers an error-started computer without exporting its live workspace", async () => {
    const { deps, row } = await fixture();
    row.state = "error";
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    const commit = vi.spyOn(deps.home, "commit");
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(exported).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(row).toMatchObject({
      state: "running",
      providerRef: recovered.providerRef,
      homeRevision: "saved",
    });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the old reference after ambiguous recovery teardown failure and retries safely", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("Synthetic provider teardown transport failure");
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
      cause: failure,
    });
    expect(row).toMatchObject({ state: "quarantined", providerRef: first.providerRef });
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    destroy.mockRestore();
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(exported).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
  });

  it("continues recovery when teardown reports the old provider gone", async () => {
    const { deps, row } = await fixture();
    const destroyComputer = deps.sandbox.destroy.bind(deps.sandbox);
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockImplementationOnce(async (...args) => {
      await destroyComputer(...args);
      throw Object.assign(new Error("Synthetic provider already removed"), {
        name: "SandboxNotFoundError",
      });
    });
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(recovered.fresh).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
  });

  it("restores the committed revision even if staging cleanup fails", async () => {
    const { deps, row } = await fixture();
    failSaveCleanup(deps.home, new Error("Synthetic staging cleanup failure"));
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");

    const recovered = await replaceComputer(deps, row.id, "recover", context);

    expect(recovered.fresh).toBe(true);
    expect(stagingFaults.failedCleanups).toBe(1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(row).toMatchObject({
      state: "running",
      providerRef: recovered.providerRef,
      homeRevision: expect.stringMatching(/^rev-/),
    });
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each([
    "mkdtemp ENOSPC",
    "disk reserve exhausted after export",
    "staged write ENOSPC",
    "staged write with a provider-shaped error",
    "staged write with iterator return trap",
    "staged write with cleanup failure",
    "provider next with cleanup failure",
    "invalid portable path",
  ])("blocks recovery and retry after trusted local checkpoint staging: %s", async (stage) => {
    const { deps, row, first } = await fixture();
    clearStagingFaults();
    const localFailure = Object.assign(new Error("Synthetic local staging ENOSPC"), {
      code: "ENOSPC",
    });
    if (stage === "staged write with a provider-shaped error") {
      localFailure.name = "SandboxNotFoundError";
    }
    const cleanupFailure = new Error("Synthetic staging cleanup failure");
    const iteratorFailure = Object.assign(new Error("Synthetic provider iterator ENOSPC"), {
      code: "ENOSPC",
    });
    const returnFailure = new Error("Synthetic provider return trap");
    const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace");
    let returnTraps = 0;
    if (stage === "mkdtemp ENOSPC") stagingFaults.create = localFailure;
    if (stage.startsWith("staged write")) stagingFaults.write = localFailure;
    if (stage.endsWith("cleanup failure")) failSaveCleanup(deps.home, cleanupFailure);
    if (stage === "staged write with iterator return trap") {
      exported.mockImplementation(async function* (...args) {
        try {
          yield* exportWorkspace(...args);
        } finally {
          returnTraps += 1;
          // biome-ignore lint/correctness/noUnsafeFinally: Deliberately simulate a provider iterator that throws while closing.
          throw returnFailure;
        }
      });
    } else if (stage === "provider next with cleanup failure") {
      exported.mockImplementation(async function* (...args) {
        for await (const file of exportWorkspace(...args)) {
          yield file;
          throw iteratorFailure;
        }
        throw iteratorFailure;
      });
    } else if (stage === "invalid portable path") {
      exported.mockImplementation(async function* () {
        yield { path: "../escape", content: new TextEncoder().encode("must never leave staging") };
      });
    }
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (stage === "disk reserve exhausted after export") stagingFaults.diskChecksUntilFull = 1;
        const recovery = replaceComputer(deps, row.id, "recover", context);
        if (stage === "invalid portable path")
          await expect(recovery).rejects.toThrow("Path escapes the computer workspace");
        else if (stage === "disk reserve exhausted after export")
          await expect(recovery).rejects.toMatchObject({ name: "WorkspaceTooLargeError" });
        else if (stage === "provider next with cleanup failure")
          await expect(recovery).rejects.toBe(iteratorFailure);
        else await expect(recovery).rejects.toBe(localFailure);
        expect(row).toMatchObject({
          state: "running",
          providerRef: first.providerRef,
          homeRevision: "saved",
        });
        expect(destroy).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        expect(
          new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context)),
        ).toBe("live work");
        expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
        if (stage.endsWith("cleanup failure")) expect(stagingFaults.failedCleanups).toBe(attempt);
        if (stage === "staged write with iterator return trap") expect(returnTraps).toBe(attempt);
        if (stage === "invalid portable path") expect(stagingFaults.writeTargets).toEqual([]);
      }
      clearStagingFaults();
      exported.mockRestore();
      const recovered = await replaceComputer(deps, row.id, "recover", context);
      expect(recovered.fresh).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(provision).toHaveBeenCalledOnce();
      expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    } finally {
      clearStagingFaults();
      exported.mockRestore();
    }
  });

  it("keeps a reachable computer when a provider export fails with ENOSPC", async () => {
    const { deps, row } = await fixture();
    clearStagingFaults();
    const failure = Object.assign(new Error("Synthetic provider iterator ENOSPC"), {
      code: "ENOSPC",
    });
    const exportWorkspace = deps.sandbox.exportWorkspace.bind(deps.sandbox);
    const exported = vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* (
      ...args
    ) {
      for await (const file of exportWorkspace(...args)) {
        yield file;
        throw failure;
      }
      throw failure;
    });
    const commit = vi.spyOn(deps.home, "commit");
    try {
      const destroy = vi.spyOn(deps.sandbox, "destroy");
      await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
      expect(destroy).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(row).toMatchObject({ state: "running", homeRevision: "saved" });
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
    } finally {
      clearStagingFaults();
      exported.mockRestore();
    }
  });

  it("resets a computer stuck suspending after a hung stop", async () => {
    const { deps, row } = await fixture();
    row.state = "suspending";
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("refuses Reset while a suspend claim is still live", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "suspending";
    row.updatedAt = new Date();
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(computer.updateMany).not.toHaveBeenCalled();
    expect(row.state).toBe("suspending");
  });

  it("resets a missing computer after idempotent provider teardown", async () => {
    const { deps, row, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the reference when reset teardown fails ambiguously", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("404: configuration file not found");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
      cause: failure,
    });
    expect(provision).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "quarantined", providerRef: first.providerRef });
  });
});
