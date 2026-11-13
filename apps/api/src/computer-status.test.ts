import { createRunSandbox } from "@rakazo/adapters";
import { ComputerStatusSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { executionBlocksUserTakeover, toComputerStatus } from "./computer-status.js";

describe("toComputerStatus", () => {
  it("only marks control that is bound to a waiting run as a requested takeover", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "user",
      controlBotId: "bot-1",
      controlRunId: "run-1",
      homeRevision: "revision-1",
    };

    expect(toComputerStatus("bot-1", computer).takeoverRequested).toBe(true);
    expect(toComputerStatus("bot-1", { ...computer, controlRunId: null }).takeoverRequested).toBe(
      false,
    );
  });

  it("keeps a computer-free thread stopped even with old control or maintenance state", () => {
    const status = toComputerStatus(
      "bot-1",
      {
        kind: "none",
        state: "running",
        scope: "dedicated",
        controlHolder: "user",
        controlBotId: "bot-1",
        controlRunId: "run-1",
        maintenanceId: "old-update",
        stopRequestedAt: new Date(0),
        homeRevision: "r1",
      },
      "Previous bot",
    );
    expect(ComputerStatusSchema.parse(status)).toMatchObject({
      kind: "none",
      mode: "dedicated",
      state: "stopped",
      screenAvailable: false,
      terminalAvailable: false,
      canUpdate: false,
      controlHolder: "none",
      controlBotId: null,
      takeoverRequested: false,
      busyBotName: null,
      homeRevision: "r1",
    });
    expect(status.powerState).toBeUndefined();
  });

  it("passes through the busy bot name when takeover is blocked", () => {
    const computer = {
      kind: "fake",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "revision-1",
    };
    expect(toComputerStatus("bot-1", computer).busyBotName).toBeNull();
    expect(toComputerStatus("bot-1", computer, "Writer").busyBotName).toBe("Writer");
  });

  it.each([
    ["suspending", false, new Date(), "stopping"],
    ["suspending", true, new Date(0), "quarantined"],
    ["needs_recovery", false, new Date(), "needs_recovery"],
    ["quarantined", false, new Date(), "quarantined"],
  ])(
    "reports %s without exposing its screen or stale control",
    (state, stopRequestedAt, updatedAt, expected) => {
      expect(
        toComputerStatus("bot-1", {
          kind: "e2b",
          state,
          stopRequestedAt: stopRequestedAt ? updatedAt : null,
          scope: "team",
          controlHolder: "user",
          controlBotId: "bot-1",
          controlRunId: "run-1",
          homeRevision: "r1",
          maintenanceId: "old-maintenance",
        }),
      ).toMatchObject({
        state: "error",
        powerState: expected,
        screenAvailable: false,
        controlHolder: "none",
        takeoverRequested: false,
        canUpdate: false,
        homeRevision: "r1",
      });
    },
  );

  it("blocks recovery for unavailable provider settings and clears the block when restored", () => {
    const original = createRunSandbox("e2b", { e2bApiKey: "fixture-original" });
    const changed = createRunSandbox("e2b", { e2bApiKey: "fixture-changed" });
    const computer = {
      kind: "e2b",
      providerRef: "old-computer",
      providerAuthority: original.providerAuthority?.("e2b"),
      homeKey: "home",
      state: "running",
      scope: "team",
      controlHolder: "none",
      homeRevision: "r1",
    };
    expect(toComputerStatus("bot-1", computer, null, changed)).toMatchObject({
      state: "error",
      powerState: "quarantined",
      screenAvailable: false,
      recoveryBlocked: true,
    });
    expect(toComputerStatus("bot-1", computer, null, original).recoveryBlocked).toBeUndefined();
    expect(toComputerStatus("bot-1", computer, null, original).requiresExplicitWake).toBe(true);
    expect(toComputerStatus("bot-1", computer, null, changed).requiresExplicitWake).toBeUndefined();
  });

  it("only projects recent progress for the current save and exposes failure while running", () => {
    const now = new Date();
    const computer = {
      kind: "e2b",
      state: "suspending",
      scope: "team",
      controlHolder: "none",
      homeRevision: "last-valid",
      updatedAt: now,
      workspaceSaveProgress: {
        claimAt: now.toISOString(),
        observedAt: now.toISOString(),
        progress: { files: 2, bytes: 137 },
      },
      workspaceSaveFailure: { reason: "disk_space" },
    };
    expect(toComputerStatus("bot", computer)).toMatchObject({
      powerState: "stopping",
      workspaceSaveProgress: { files: 2, bytes: 137 },
    });
    expect(
      toComputerStatus("bot", { ...computer, updatedAt: new Date(0) }).workspaceSaveProgress,
    ).toBeUndefined();
    expect(
      toComputerStatus("bot", {
        ...computer,
        workspaceSaveProgress: {
          ...computer.workspaceSaveProgress,
          observedAt: new Date(0).toISOString(),
        },
      }).workspaceSaveProgress,
    ).toBeUndefined();
    expect(
      toComputerStatus("bot", { ...computer, stopRequestedAt: now }).workspaceSaveProgress,
    ).toBeUndefined();
    expect(toComputerStatus("bot", computer).workspaceSaveFailure).toBeUndefined();
    expect(toComputerStatus("bot", { ...computer, state: "running" })).toMatchObject({
      state: "running",
      workspaceSaveFailure: "disk_space",
    });
    expect(
      toComputerStatus("bot", { ...computer, state: "quarantined" }).workspaceSaveFailure,
    ).toBeUndefined();
  });

  it("hides update on desktop computers", () => {
    expect(
      toComputerStatus("bot-1", {
        kind: "desktop",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(false);
    expect(
      toComputerStatus("bot-1", {
        kind: "e2b",
        state: "running",
        scope: "team",
        controlHolder: "none",
        homeRevision: "r1",
      }).canUpdate,
    ).toBe(true);
  });
});

describe("executionBlocksUserTakeover", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("allows takeover when there is no execution lease", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: false,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(false);
  });

  it("allows takeover while the run is waiting for the user", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "waiting_takeover",
        now,
      }),
    ).toBe(false);
  });

  it("allows takeover while the waiting run continues for a chat message", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
        takeoverRequested: true,
      }),
    ).toBe(false);
  });

  it("allows takeover when the quota wait has released its execution lease", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "waiting_limit",
        now,
      }),
    ).toBe(false);
  });

  it("blocks takeover for an active lease or active run", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "running",
        now,
      }),
    ).toBe(true);
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now + 60_000),
        runStatus: "completed",
        now,
      }),
    ).toBe(true);
  });

  it("allows takeover when both the lease and run are inactive", () => {
    expect(
      executionBlocksUserTakeover({
        hasLease: true,
        leaseExpiresAt: new Date(now - 1),
        runStatus: "completed",
        now,
      }),
    ).toBe(false);
  });
});
