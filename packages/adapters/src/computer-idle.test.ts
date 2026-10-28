import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { SandboxNotFoundError } from "@e2b/desktop";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_WORK_LAUNCH,
  BACKGROUND_WORK_PROBE,
  CANCEL_COMPUTER_RUN_WORK,
  CANCEL_PRIMARY_BROWSER_WORK,
  computerIdleSleepEnabled,
  DEFAULT_SANDBOX_IDLE_MS,
  sandboxIdleMs,
  scheduleComputerSleep,
  sleepComputerIfIdle,
} from "./computer-idle.js";
import { e2bCreateOptions } from "./e2b-sandbox.js";

describe("sandbox idle", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_IDLE_MS", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults to ten minutes when SANDBOX_IDLE_MS is unset", () => {
    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    expect(DEFAULT_SANDBOX_IDLE_MS).toBe(10 * 60 * 1000);
  });

  it.each(["0", " \t0\n"])("disables idle sleep for %j", async (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();

    expect(computerIdleSleepEnabled()).toBe(false);
    expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);
    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("running");
    expect(harness.prisma.computer.findUnique).not.toHaveBeenCalled();
    expect(harness.prisma.computer.updateMany).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
  });

  it.each(["", "invalid", "NaN", "Infinity", "-1", "29999", "00", "0.0"])(
    "keeps idle sleep enabled with the default timeout for %j",
    (value) => {
      vi.stubEnv("SANDBOX_IDLE_MS", value);

      expect(computerIdleSleepEnabled()).toBe(true);
      expect(sandboxIdleMs()).toBe(DEFAULT_SANDBOX_IDLE_MS);
    },
  );

  it.each(["30000", "900000"])("schedules idle sleep using %s ms", (value) => {
    vi.stubEnv("SANDBOX_IDLE_MS", value);
    const harness = idleHarness();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);

    expect(computerIdleSleepEnabled()).toBe(true);
    expect(sandboxIdleMs()).toBe(Number(value));
    scheduleComputerSleep(harness.deps.jobs, harness.computer.id);

    expect(harness.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(now + Number(value)) }),
    );
  });

  it("does not suspend a computer while a run is active", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValueOnce({ id: "run" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("clears a confirmed missing E2B sandbox after its probe without losing the saved home", async () => {
    const gone = new SandboxNotFoundError("Synthetic sandbox unavailable");
    const harness = idleHarness({ exportError: gone });
    harness.sandbox.execute.mockImplementationOnce(async function* () {
      yield await Promise.reject(gone);
    });
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.computer).toMatchObject({
      state: "stopped",
      providerRef: null,
      homeRevision: "rev-before",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    });
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("accepts a provider-native missing-sandbox probe without treating it as active work", async () => {
    const gone = new SandboxNotFoundError("Synthetic sandbox unavailable");
    const harness = idleHarness({ exportError: gone });
    const inspect = vi.fn().mockRejectedValue(gone);
    Object.assign(harness.sandbox, { inspectBackgroundWork: inspect });
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(inspect).toHaveBeenCalledOnce();
    expect(harness.sandbox.execute).not.toHaveBeenCalled();
    expect(harness.computer.state).toBe("stopped");
    expect(harness.computer.homeRevision).toBe("rev-before");
  });

  it.each([
    new Error("bash: helper: command not found"),
    new Error("Path /home/user/rakazo-home/notes.md not found"),
    Object.assign(new Error("file endpoint failed"), { status: 404 }),
    new Error("fetch failed"),
    new Error("Unauthorized"),
    new SandboxRateLimitError(),
  ])("preserves an uncertain computer after a probe failure: %s", async (error) => {
    const harness = idleHarness();
    harness.sandbox.execute.mockImplementationOnce(async function* () {
      yield await Promise.reject(error);
    });
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.computer).toMatchObject({
      state: "running",
      providerRef: "computer",
      homeRevision: "rev-before",
    });
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it.each(["box", "daytona", "fake"])(
    "does not apply E2B loss evidence to a %s computer",
    async (kind) => {
      const gone = new SandboxNotFoundError("Synthetic sandbox unavailable");
      const harness = idleHarness({ exportError: gone });
      harness.computer.kind = kind;
      await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBe(gone);
      expect(harness.computer).toMatchObject({
        state: "running",
        providerRef: "computer",
        homeRevision: "rev-before",
      });
      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["providerRef", "new-provider"],
    ["kind", "daytona"],
    ["screenGeneration", 2],
    ["maintenanceId", "new-maintenance"],
    ["state", "running"],
  ])("does not clear a missing reference after its %s claim changes", async (field, value) => {
    const harness = idleHarness();
    harness.sandbox.exportWorkspace.mockImplementationOnce(async function* () {
      Object.assign(harness.computer, {
        [field]: value,
        controlHolder: "user",
        controlLeaseId: "new-control",
      });
      yield await Promise.reject(new SandboxNotFoundError("Synthetic sandbox unavailable"));
    });
    await sleepComputerIfIdle(harness.deps, harness.computer.id);
    expect(harness.computer).toMatchObject({
      [field]: value,
      controlHolder: "user",
      controlLeaseId: "new-control",
      homeRevision: "rev-before",
    });
    expect(harness.computer.providerRef).toBe(
      field === "providerRef" ? "new-provider" : "computer",
    );
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.events.append).not.toHaveBeenCalled();
  });

  it("does not suspend a computer while bot-launched background work is active", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("probes background work with the database computer id, not providerRef", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 0 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: harness.computer.providerRef }),
      expect.objectContaining({
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", harness.computer.id],
      }),
      expect.anything(),
    );
    expect(harness.computer.id).not.toBe(harness.computer.providerRef);
  });

  it("fails closed when the provider cannot inspect background work", async () => {
    const harness = idleHarness({ backgroundWorkProbeCode: 2 });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider reports a command failure as exit one", async () => {
    const harness = idleHarness({ backgroundWorkProbeFailed: true });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("does not let an abandoned waiting takeover prevent idle suspension", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockImplementation(async ({ where }) =>
      where.status.in.includes("waiting_takeover") ? { id: "waiting" } : null,
    );

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("claims the lease boundary before any checkpoint export", async () => {
    const harness = idleHarness();
    harness.prisma.computer.updateMany.mockResolvedValueOnce({ count: 0 });
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).not.toHaveBeenCalled();
    expect(harness.sandbox.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it("rechecks background work after checkpointing before it suspends", async () => {
    const harness = idleHarness({ backgroundWorkProbeCodes: [1, 0] });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.sandbox.execute).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.sandbox.keepAlive).toHaveBeenCalledOnce();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
  });

  it("uses provider-native idle inspection instead of retaining emulator computers", async () => {
    const harness = idleHarness({ providerBackgroundWorkStatus: "idle" });

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.sandbox.inspectBackgroundWork).toHaveBeenCalledTimes(2);
    expect(harness.sandbox.execute).not.toHaveBeenCalled();
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("checkpoints before suspending a stable idle computer", async () => {
    const harness = idleHarness();
    harness.prisma.run.findFirst.mockResolvedValue(null);

    await sleepComputerIfIdle(harness.deps, harness.computer.id);

    expect(harness.home.commit).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sandbox.exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.prisma.computer.update).toHaveBeenCalledWith({
      where: {
        id: harness.computer.id,
        state: "suspending",
        providerRef: harness.computer.providerRef,
        kind: "e2b",
        screenGeneration: 1,
        maintenanceId: null,
        updatedAt: expect.any(Date),
      },
      data: {
        state: "suspended",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    expect(harness.events.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "computer.status", payload: { status: "suspended" } }),
    );
  });

  it("never stops the computer when checkpoint export fails", async () => {
    const harness = idleHarness({ exportError: new Error("checkpoint unavailable") });
    harness.prisma.run.findFirst.mockResolvedValueOnce(null);

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "checkpoint unavailable",
    );

    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.prisma.computer.update).not.toHaveBeenCalled();
  });

  it.each([
    new Error("bash: helper: command not found"),
    new Error("Path /home/user/rakazo-home/notes.md not found"),
    Object.assign(new Error("File endpoint failed"), { status: 404 }),
    new Error("Unauthorized"),
    new SandboxRateLimitError(),
  ])("retains the existing reference after a non-Gone export error: %s", async (error) => {
    const harness = idleHarness({ exportError: error });
    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toBe(error);
    expect(harness.computer).toMatchObject({
      state: "running",
      providerRef: "computer",
      homeRevision: "rev-before",
    });
    expect(harness.sandbox.stop).not.toHaveBeenCalled();
    expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    expect(harness.events.append).not.toHaveBeenCalled();
  });

  it("retains the saved revision when the database transition after stopping fails", async () => {
    const harness = idleHarness();
    harness.prisma.computer.update.mockRejectedValueOnce(new Error("database unavailable"));
    harness.sandbox.stop.mockImplementationOnce(async () => {
      expect(harness.computer.homeRevision).toBe("rev-checkpoint");
    });

    await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow(
      "database unavailable",
    );

    expect(harness.sandbox.stop).toHaveBeenCalledOnce();
    expect(harness.computer.homeRevision).toBe("rev-checkpoint");
  });

  it.each(["failure", "lost claim"])(
    "does not stop when recording the revision encounters a %s",
    async (outcome) => {
      const harness = idleHarness();
      const updateMany = harness.prisma.computer.updateMany.getMockImplementation()!;
      harness.prisma.computer.updateMany.mockImplementation(async (args) => {
        if (args.data.homeRevision) {
          if (outcome === "failure") throw new Error("database unavailable");
          harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
        }
        return updateMany(args);
      });

      const sleep = sleepComputerIfIdle(harness.deps, harness.computer.id);
      if (outcome === "failure") await expect(sleep).rejects.toThrow("database unavailable");
      else await sleep;

      expect(harness.sandbox.stop).not.toHaveBeenCalled();
      expect(harness.computer.homeRevision).toBe("rev-before");
      expect(harness.computer.state).toBe(outcome === "failure" ? "running" : "suspending");
      expect(harness.jobs.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["checkpoint failure", "stop failure", "stop success"])(
    "preserves a newer lifecycle owner after %s",
    async (stage) => {
      const harness = idleHarness();
      const invalidate = () => {
        harness.computer.updatedAt = new Date(harness.computer.updatedAt.getTime() + 1);
      };
      if (stage === "checkpoint failure") {
        harness.home.commit.mockImplementationOnce(async () => {
          invalidate();
          throw new Error("checkpoint interrupted");
        });
      } else {
        harness.sandbox.stop.mockImplementationOnce(async () => {
          invalidate();
          if (stage === "stop failure") throw new Error("stop interrupted");
        });
      }

      await expect(sleepComputerIfIdle(harness.deps, harness.computer.id)).rejects.toThrow();

      expect(harness.computer.state).toBe("suspending");
      expect(harness.events.append).not.toHaveBeenCalled();
    },
  );
});

describe("background work launch and probe", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const markers = new Set<string>();

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const marker of markers) {
      rmSync(marker, { force: true, recursive: true });
    }
    markers.clear();
  });

  it.skipIf(process.platform === "win32")(
    "detects active work only when launch and probe share the same marker id",
    async () => {
      const databaseId = "computer-db-id";
      const providerRef = "provider-ref";
      const launchId = "active";
      markers.add(`/tmp/rakazo-background-${databaseId}-run-1-${launchId}`);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          databaseId,
          "run-1",
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(databaseId)).toBe(0);
      // ComputerRef.id is providerRef today; probing that path must not see the DB-id marker.
      expect(await probeBackgroundWork(providerRef)).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a completed marker without blocking a later launch",
    async () => {
      const markerId = "computer-relaunch-id";
      const completedMarker = `/tmp/rakazo-background-${markerId}-run-1-completed`;
      const activeMarker = `/tmp/rakazo-background-${markerId}-run-1-active`;
      markers.add(completedMarker);
      markers.add(activeMarker);
      const completed = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "completed",
          "true",
        ],
        { stdio: "ignore" },
      );
      children.push(completed);

      expect(await processExit(completed)).toBe(0);
      expect(await probeBackgroundWork(markerId)).toBe(1);
      expect(existsSync(completedMarker)).toBe(false);

      const active = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "active",
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(active);
      await expect.poll(() => probeBackgroundWork(markerId)).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not run the command when its marker cannot be opened",
    async () => {
      const markerId = "computer-marker-error";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      mkdirSync(marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a pre-existing marker symlink",
    async () => {
      const markerId = "computer-marker-symlink";
      const marker = `/tmp/rakazo-background-${markerId}-run-1-collision`;
      const commandRan = `/tmp/rakazo-background-command-ran-${markerId}`;
      markers.add(marker);
      markers.add(commandRan);
      symlinkSync(commandRan, marker);
      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          markerId,
          "run-1",
          "collision",
          `touch ${commandRan}`,
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      expect(await processExit(launched)).not.toBe(0);
      expect(existsSync(commandRan)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cancel tears down background shell work for that run",
    async () => {
      const computerId = "computer-cancel-id";
      const runId = "run-cancel-1";
      const launchId = "active";
      const marker = `/tmp/rakazo-background-${computerId}-${runId}-${launchId}`;
      markers.add(marker);

      const launched = spawn(
        "bash",
        [
          "-c",
          BACKGROUND_WORK_LAUNCH,
          "rakazo-background-launch",
          computerId,
          runId,
          launchId,
          "exec sleep 30",
        ],
        { stdio: "ignore" },
      );
      children.push(launched);

      await expect.poll(() => probeBackgroundWork(computerId)).toBe(0);

      const launchedDone = processExit(launched);
      const cancel = spawn(
        "bash",
        ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId],
        { stdio: "ignore" },
      );
      children.push(cancel);
      expect(await processExit(cancel)).toBe(0);
      await launchedDone;
      expect(await probeBackgroundWork(computerId)).toBe(1);
    },
  );
});

describe("CANCEL_PRIMARY_BROWSER_WORK", () => {
  it("keeps shell parameter expansions literal", () => {
    expect(CANCEL_COMPUTER_RUN_WORK).toContain(`pid="\${fd#/proc/}"; pid="\${pid%%/*}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -TERM "\${pid#/proc/}"`);
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(`kill -KILL "\${pid#/proc/}"`);
  });

  it("targets the primary profile and matches browser argv0 only", () => {
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain(".browser-profiles/chromium");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("chromium-screen-");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain('argv0=""; IFS= read -r -d "" argv0');
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/chromium|*/chromium-*|chromium|chromium-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).toContain("*/firefox|*/firefox-*|firefox|firefox-*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[c]hromium*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[f]irefox*");
    expect(CANCEL_PRIMARY_BROWSER_WORK).not.toContain("*[g]oogle-chrome*");
  });
});

describe("e2b create options", () => {
  it("pauses on timeout instead of killing the sandbox", () => {
    const opts = e2bCreateOptions("bot-1", "e2b_test");
    expect(opts.lifecycle).toEqual({ onTimeout: "pause", autoResume: false });
    expect(opts.timeoutMs).toBe(sandboxIdleMs());
    expect(opts.metadata.botId).toBe("bot-1");
  });
});

function idleHarness(
  options: {
    backgroundWorkProbeCode?: number;
    backgroundWorkProbeCodes?: number[];
    backgroundWorkProbeFailed?: boolean;
    exportError?: Error;
    providerBackgroundWorkStatus?: "active" | "idle" | "unknown";
  } = {},
) {
  const backgroundWorkProbeCodes = [...(options.backgroundWorkProbeCodes ?? [])];
  const computer = {
    id: "computer-id",
    homeKey: "team-workspace",
    homeRevision: "rev-before",
    providerRef: "computer",
    kind: "e2b",
    screenGeneration: 0,
    maintenanceId: null,
    state: "running",
    spaceId: "workspace",
    userId: "user",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    executionBotId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const prisma = {
    computer: {
      findUnique: vi.fn(async () => ({ ...computer })),
      updateMany: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          return { count: 0 };
        for (const field of [
          "id",
          "state",
          "providerRef",
          "kind",
          "screenGeneration",
          "maintenanceId",
        ]) {
          if (
            field in args.where &&
            args.where[field] !== (computer as Record<string, unknown>)[field]
          )
            return { count: 0 };
        }
        applyData(args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args) => {
        if (args.where.updatedAt && args.where.updatedAt.getTime() !== computer.updatedAt.getTime())
          throw new Error("stale computer lifecycle");
        applyData(args.data);
        return computer;
      }),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null) },
    agentHome: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    bot: {
      findMany: vi.fn().mockResolvedValue([{ id: "bot", thread: { id: "thread" } }]),
    },
  };
  function applyData(data: Record<string, unknown>) {
    const { state, providerRef, screenGeneration } = computer;
    Object.assign(computer, data);
    if (
      (computer.state !== state && !(state === "booting" && computer.state === "running")) ||
      computer.providerRef !== providerRef
    )
      computer.screenGeneration = screenGeneration + 1;
  }
  const sandbox = {
    execute: vi.fn(async function* () {
      const code = backgroundWorkProbeCodes.shift() ?? options.backgroundWorkProbeCode ?? 1;
      if (code === 1 && !options.backgroundWorkProbeFailed) {
        yield { type: "stdout", data: "rakazo-background-idle\n" } as const;
      }
      yield { type: "exit", code } as const;
    }),
    keepAlive: vi.fn().mockResolvedValue(undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield { path: "notes/result.txt", content: new TextEncoder().encode("durable") };
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    ...(options.providerBackgroundWorkStatus
      ? {
          inspectBackgroundWork: vi.fn().mockResolvedValue(options.providerBackgroundWorkStatus),
        }
      : {}),
  };
  const home = {
    commit: vi.fn().mockResolvedValue("rev-checkpoint"),
  };
  const jobs = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const events = { append: vi.fn().mockResolvedValue({}) };
  return {
    computer,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    deps: {
      prisma: prisma as unknown as PrismaClient,
      sandbox: sandbox as unknown as SandboxProvider,
      home: home as unknown as AgentHomeStore,
      jobs: jobs as unknown as JobPublisher,
      events: events as unknown as ThreadEvents,
    },
  };
}

function probeBackgroundWork(markerId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      ["-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", markerId],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function processExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
