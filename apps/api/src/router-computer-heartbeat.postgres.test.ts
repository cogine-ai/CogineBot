import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { SandboxDamagedError, WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import {
  ComputerCheckpointChangedError,
  DesktopSandboxProvider,
  LocalAgentHomeStore,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("computer attendance lifecycle compare-and-swap", () => {
  const organizationId = `heartbeat-organization-${randomUUID()}`;
  const spaceId = `heartbeat-space-${randomUUID()}`;
  const actor: Actor = {
    spaceId,
    userId: "heartbeat-viewer",
    email: "heartbeat-viewer@example.test",
    isDeploymentOwner: false,
  };
  let database: ReturnType<typeof createDb>;
  let botId: string;
  let computerId: string;
  let afterSnapshot: (() => Promise<unknown>) | undefined;
  const casCounts: number[] = [];
  const keepAlive = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const stopProvider = vi.fn().mockResolvedValue(undefined);
  const inspectPowerState = vi.fn().mockResolvedValue("unknown");
  const exportWorkspace = vi.fn<() => AsyncIterable<never>>();
  const providerRead = vi.fn().mockResolvedValue(Buffer.from("partial provider contents"));
  const providerWrite = vi.fn().mockResolvedValue(undefined);
  let root: string;
  let home: LocalAgentHomeStore;
  let desktop: DesktopSandboxProvider;
  let heartbeat: () => Promise<unknown>;
  let stopComputer: () => Promise<unknown>;
  let statusComputer: () => Promise<unknown>;
  let recoverComputer: () => Promise<unknown>;
  let downloadComputerFile: () => Promise<unknown>;
  let readComputerFile: () => Promise<unknown>;
  let uploadComputerFile: () => Promise<unknown>;
  let bootComputer: () => Promise<unknown>;
  let switchComputerMode: () => Promise<unknown>;

  beforeAll(async () => {
    database = createDb(databaseUrl!);
    await database.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Heartbeat Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Heartbeat Test" },
    });
    const instrumented = database.prisma.$extends({
      query: {
        bot: {
          async findFirst({ args, query }) {
            const snapshot = await query(args);
            if (snapshot && args.where?.id === botId && afterSnapshot) {
              const change = afterSnapshot;
              afterSnapshot = undefined;
              await change();
            }
            return snapshot;
          },
        },
        computer: {
          async updateMany({ args, query }) {
            const result = await query(args);
            casCounts.push(result.count);
            return result;
          },
        },
      },
    });
    root = await mkdtemp(path.join(tmpdir(), "computer-router-test-"));
    home = new LocalAgentHomeStore(root, database.prisma);
    desktop = new DesktopSandboxProvider({ root });
    const deps = {
      prisma: instrumented as unknown as PrismaClient,
      sandbox: {
        keepAlive,
        exportWorkspace,
        stop: stopProvider,
        inspectPowerState,
        readFile: providerRead,
        writeFile: providerWrite,
        isRunning: desktop.isRunning.bind(desktop),
        provision: desktop.provision.bind(desktop),
        prepare: desktop.prepare.bind(desktop),
        importWorkspace: desktop.importWorkspace.bind(desktop),
        execute: desktop.execute.bind(desktop),
      },
      home,
      jobs: { enqueue, cancel: vi.fn() },
      env: { defaultProvider: "fake", defaultModel: "fake", sandboxProvider: "fake" },
      dataDir: root,
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    heartbeat = () => client.computer.heartbeat({ botId });
    stopComputer = () => client.computer.stop({ botId });
    statusComputer = () => client.computer.status({ botId });
    recoverComputer = () => client.computer.recover({ botId });
    downloadComputerFile = () => client.computer.downloadFile({ botId, path: "sample.bin" });
    readComputerFile = () => client.computer.readFile({ botId, path: "notes.txt" });
    uploadComputerFile = () =>
      client.computer.uploadFile({
        botId,
        path: "notes.txt",
        contentBase64: Buffer.from("upload").toString("base64"),
      });
    bootComputer = () => client.computer.boot({ botId });
    switchComputerMode = () => client.bots.setComputer({ botId, mode: "team" });
  });

  beforeEach(async () => {
    keepAlive.mockClear();
    enqueue.mockClear();
    stopProvider.mockClear();
    inspectPowerState.mockClear();
    exportWorkspace.mockClear();
    providerRead.mockClear();
    providerWrite.mockClear();
    casCounts.length = 0;
    afterSnapshot = undefined;
    botId = `heartbeat-bot-${randomUUID()}`;
    computerId = `heartbeat-computer-${randomUUID()}`;
    await database.prisma.computer.create({
      data: {
        id: computerId,
        spaceId,
        userId: "heartbeat-computer-owner",
        scope: "team",
        scopeKey: computerId,
        homeKey: computerId,
        kind: "e2b",
        providerRef: "heartbeat-provider",
        state: "running",
        controlHolder: "user",
        controlLeaseId: "heartbeat-human-lease",
        controlLeaseExpiresAt: new Date("2030-01-01"),
      },
    });
    await database.prisma.bot.create({
      data: {
        id: botId,
        spaceId,
        userId: actor.userId,
        name: "Heartbeat",
        color: "ink",
        computerId,
      },
    });
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (!database) return;
    await database.prisma.organization.deleteMany({ where: { id: organizationId } });
    await database.prisma.$disconnect();
    await database.pool.end();
  });

  it("keeps an authorized Team view alive without assuming the viewer owns the computer", async () => {
    await expect(heartbeat()).resolves.toEqual({ ok: true });
    expect(casCounts).toEqual([1]);
    expect(keepAlive).toHaveBeenCalledWith(
      {
        id: "heartbeat-provider",
        providerRef: "heartbeat-provider",
        botId: computerId,
        kind: "e2b",
      },
      { onlyIfRunning: true },
    );
    const computer = await database.prisma.computer.findUniqueOrThrow({
      where: { id: computerId },
    });
    expect(computer.controlLeaseId).toBe("heartbeat-human-lease");
    expect(computer.controlLeaseExpiresAt).toEqual(new Date("2030-01-01"));
  });

  it("does not upload after a restore starts between the read and the write claim", async () => {
    const where = { id: computerId };
    await database.prisma.computer.update({ where, data: { controlBotId: botId } });
    afterSnapshot = () =>
      database.prisma.computer.update({ where, data: { restorePending: true } });

    await expect(uploadComputerFile()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(providerWrite).not.toHaveBeenCalled();

    await database.prisma.computer.update({ where, data: { restorePending: false } });
    await expect(uploadComputerFile()).resolves.toEqual({ ok: true });
    expect(providerWrite).toHaveBeenCalledOnce();
  });

  it("keeps the provider running when manual Stop exceeds the workspace save limit", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { controlBotId: botId, homeRevision: "last-saved-revision" },
    });
    exportWorkspace.mockImplementationOnce(async function* () {
      yield await Promise.reject(new WorkspaceTooLargeError("files"));
    });

    await expect(stopComputer()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The computer has too many files to save",
    });
    expect(stopProvider).not.toHaveBeenCalled();
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "running",
      providerRef: "heartbeat-provider",
      homeRevision: "last-saved-revision",
      homeRevisionAt: null,
    });
  });

  it.each(["changed", "foreign lease"] as const)(
    "reports the real Stop conflict after a concurrent %s",
    async (reason) => {
      afterSnapshot = () =>
        reason === "changed"
          ? database.prisma.computer.update({
              where: { id: computerId },
              data: { screenGeneration: { increment: 1 } },
            })
          : database.prisma.computerExecutionLease.create({
              data: {
                computerId,
                botId: "other-bot",
                runId: "other-run",
                expiresAt: new Date("2100-01-01"),
              },
            });

      await expect(stopComputer()).rejects.toMatchObject({
        code: "CONFLICT",
        message:
          reason === "changed"
            ? new ComputerCheckpointChangedError().message
            : "Other Team bots are still using this computer",
      });
      expect(exportWorkspace).not.toHaveBeenCalled();
      expect(stopProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new WorkspaceTooLargeError("files"), "BAD_REQUEST"],
    [new ComputerCheckpointChangedError(), "CONFLICT"],
  ] as const)("reports an actionable workspace error during mode switch", async (error, code) => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        scope: "dedicated",
        homeRevision: "last-saved-revision",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    exportWorkspace.mockImplementationOnce(async function* () {
      yield await Promise.reject(error);
    });

    await expect(switchComputerMode()).rejects.toMatchObject({ code, message: error.message });
    expect(stopProvider).not.toHaveBeenCalled();
    expect(await database.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      computerId,
      computerSwitching: false,
    });
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "running",
      homeRevision: "last-saved-revision",
    });
  });

  it("quarantines an unconfirmed manual Stop and blocks implicit boot", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { restorePending: true, homeRevision: "last-valid" },
    });
    stopProvider.mockImplementationOnce(async () => {
      expect(
        await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
      ).toMatchObject({ state: "suspending", stopRequestedAt: expect.any(Date) });
      throw new Error("provider connection closed after accepting the request");
    });
    await expect(stopComputer()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The computer's stop could not be confirmed.",
    });
    await expect(statusComputer()).resolves.toMatchObject({
      state: "error",
      powerState: "quarantined",
      screenAvailable: false,
      controlHolder: "none",
      takeoverRequested: false,
    });
    await expect(bootComputer()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      providerRef: "heartbeat-provider",
      homeRevision: "last-valid",
      stopRequestedAt: null,
    });
  });

  it("does not abandon a newly issued stop after a long save", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { controlHolder: "none", controlLeaseId: null, controlLeaseExpiresAt: null },
    });
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      exportWorkspace.mockImplementationOnce(() => {
        vi.setSystemTime(start + 6 * 60_000);
        return (async function* () {
          yield* [];
        })();
      });
      stopProvider.mockImplementationOnce(async () => {
        await expect(statusComputer()).resolves.toMatchObject({
          state: "error",
          powerState: "stopping",
        });
        await expect(recoverComputer()).rejects.toMatchObject({ code: "CONFLICT" });
      });
      await expect(stopComputer()).resolves.toMatchObject({ state: "stopped" });
      expect(stopProvider).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloads binary bytes from a paused workspace without calling the provider", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { state: "suspended", controlHolder: "none", controlLeaseId: null },
    });
    const directory = path.join(home.pathFor(computerId), "bots", botId);
    const bytes = Buffer.from([0, 128, 255, 1]);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "sample.bin"), bytes);
    await expect(downloadComputerFile()).resolves.toEqual({
      path: "sample.bin",
      contentBase64: bytes.toString("base64"),
    });
    expect(providerRead).not.toHaveBeenCalled();
  });

  it("does not resume or export a confirmed stopped computer with an unchanged saved home", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        homeRevision: "last-valid",
        homeRevisionAt: new Date(),
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    inspectPowerState.mockResolvedValueOnce("stopped");
    await expect(stopComputer()).resolves.toMatchObject({ state: "stopped" });
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({ homeRevision: "last-valid", providerRef: "heartbeat-provider" });
  });

  it("keeps the prior revision and marks a stopped damaged computer for recovery", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        homeRevision: "last-valid",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });
    exportWorkspace.mockImplementationOnce(async function* () {
      yield await Promise.reject(new SandboxDamagedError());
    });
    await expect(stopComputer()).resolves.toMatchObject({
      state: "error",
      powerState: "needs_recovery",
      screenAvailable: false,
    });
    expect(stopProvider).toHaveBeenCalledOnce();
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      homeRevision: "last-valid",
      providerRef: "heartbeat-provider",
      restorePending: true,
    });
  });

  it("stops a provider with a pending restore without exporting its incomplete workspace", async () => {
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "error",
        controlBotId: botId,
        homeRevision: "last-saved-revision",
        restorePending: true,
      },
    });

    await expect(stopComputer()).resolves.toMatchObject({ state: "stopped" });
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(stopProvider).toHaveBeenCalledOnce();
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "stopped",
      providerRef: "heartbeat-provider",
      homeRevision: "last-saved-revision",
      homeRevisionAt: null,
      restorePending: true,
    });
  });

  it("stops a pending dedicated provider before moving the bot to a Team Computer", async () => {
    await database.prisma.thread.create({ data: { botId, spaceId, userId: actor.userId } });
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        scope: "dedicated",
        state: "error",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        homeRevision: "last-saved-revision",
        restorePending: true,
      },
    });

    await expect(switchComputerMode()).resolves.toMatchObject({ id: botId });
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(stopProvider).toHaveBeenCalledOnce();
    const switched = await database.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      include: { computer: true },
    });
    expect(switched.computer?.scope).toBe("team");
    expect(switched.computerId).not.toBe(computerId);
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      state: "stopped",
      homeRevision: "last-saved-revision",
      restorePending: true,
    });
  });

  it("leaves a concurrently restored dedicated provider running during mode switch", async () => {
    const before = await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        scope: "dedicated",
        state: "error",
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        homeRevision: "last-saved-revision",
        restorePending: true,
      },
    });
    afterSnapshot = () =>
      database.prisma.computer.update({
        where: { id: computerId },
        data: { state: "running", restorePending: false, updatedAt: before.updatedAt },
      });

    await expect(switchComputerMode()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(stopProvider).not.toHaveBeenCalled();
    expect(await database.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({
      computerId,
      computerSwitching: false,
    });
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      providerRef: "heartbeat-provider",
      state: "running",
      restorePending: false,
      homeRevision: "last-saved-revision",
    });
  });

  it("previews the saved home while the live provider still has a pending restore", async () => {
    await home.writeFile(computerId, `bots/${botId}/notes.txt`, "last saved notes", {
      ...actor,
      operationId: "save-test",
      traceId: "save-test",
      signal: new AbortController().signal,
    });
    await database.prisma.computer.update({
      where: { id: computerId },
      data: { restorePending: true },
    });

    await expect(readComputerFile()).resolves.toEqual({
      path: "notes.txt",
      content: "last saved notes",
    });
    expect(providerRead).not.toHaveBeenCalled();
  });

  it("restores a missing Desktop workspace through manual Boot even if its row says running", async () => {
    const context = {
      ...actor,
      botId,
      operationId: "boot-test",
      traceId: "boot-test",
      signal: new AbortController().signal,
    };
    const ref = await desktop.provision(
      { botId: computerId, homePath: home.pathFor(computerId) },
      context,
    );
    await home.writeFile(computerId, `bots/${botId}/notes.txt`, "saved Desktop notes", context);
    await rm(ref.providerRef, { recursive: true });
    await database.prisma.computer.update({
      where: { id: computerId },
      data: {
        kind: "desktop",
        providerRef: ref.providerRef,
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
      },
    });

    await expect(bootComputer()).resolves.toMatchObject({ state: "running" });
    const bytes = await desktop.readFile(ref, `bots/${botId}/notes.txt`, context);
    expect(Buffer.from(bytes).toString()).toBe("saved Desktop notes");
    expect(
      await database.prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
    ).toMatchObject({
      providerRef: ref.providerRef,
      restorePending: false,
    });
  });

  it.each([
    "stop",
    "provider",
    "kind",
    "home",
    "maintenance",
    "computer-generation",
    "bot-switch",
    "bot-switching",
    "bot-generation",
    "archive",
  ])("rejects attendance after a concurrent %s change", async (change) => {
    afterSnapshot = async () => {
      if (change === "bot-switch")
        return database.prisma.bot.update({ where: { id: botId }, data: { computerId: null } });
      if (change === "bot-switching")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { computerSwitching: true },
        });
      if (change === "bot-generation")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { screenGeneration: { increment: 1 } },
        });
      if (change === "archive")
        return database.prisma.bot.update({
          where: { id: botId },
          data: { archivedAt: new Date() },
        });
      return database.prisma.computer.update({
        where: { id: computerId },
        data: {
          ...(change === "stop" ? { state: "suspending" } : {}),
          ...(change === "provider" ? { providerRef: "replacement" } : {}),
          ...(change === "kind" ? { kind: "docker" } : {}),
          ...(change === "home" ? { homeKey: `replacement-${computerId}` } : {}),
          ...(change === "maintenance" ? { maintenanceId: "maintenance" } : {}),
          ...(change === "computer-generation" ? { screenGeneration: { increment: 1 } } : {}),
        },
      });
    };
    await expect(heartbeat()).resolves.toEqual({ ok: true });
    expect(casCounts).toEqual([0]);
    expect(keepAlive).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
