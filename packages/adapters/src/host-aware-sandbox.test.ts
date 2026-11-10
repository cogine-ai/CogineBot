import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { confirmComputerStop, inspectComputerPower } from "./computer-power.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createRunSandbox, HostAwareSandbox, sandboxKindForBot } from "./host-aware-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("host-aware sandbox", () => {
  it("retires through the recorded provider when its original configuration is still available", async () => {
    vi.spyOn(E2BSandboxProvider.prototype, "inspectPowerState").mockResolvedValue("stopped");
    const destroyed = vi
      .spyOn(E2BSandboxProvider.prototype, "destroy")
      .mockResolvedValue(undefined);
    const sandbox = createRunSandbox("docker", { e2bApiKey: "synthetic-key" });
    const ref = { id: "old", botId: "bot", kind: "e2b", providerRef: "old" } as const;
    await expect(confirmComputerStop(sandbox, ref, ctx, "destroy")).resolves.toBe("gone");
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(
      ref,
      expect.objectContaining({ spaceId: ctx.spaceId }),
    );
  });

  it("keeps teardown unknown when the original provider is no longer configured", async () => {
    const sandbox = createRunSandbox("docker", {});
    const ref = { id: "old", botId: "bot", kind: "e2b", providerRef: "old" } as const;
    await expect(inspectComputerPower(sandbox, ref, ctx)).resolves.toBe("unknown");
    await expect(confirmComputerStop(sandbox, ref, ctx, "destroy")).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
    });
  });

  it("routes a Docker reference after switching to a configured remote provider", async () => {
    const destroyed = vi
      .spyOn(DockerSandboxProvider.prototype, "destroy")
      .mockResolvedValue(undefined);
    const opts = { supervisorToken: "synthetic-token", supervisorUrl: "http://supervisor.test" };
    const original = createRunSandbox("docker", opts);
    const switched = createRunSandbox("e2b", { ...opts, e2bApiKey: "synthetic-key" });
    const ref = {
      id: "old",
      botId: "bot",
      kind: "docker",
      providerRef: "old",
      providerAuthority: original.providerAuthority?.("docker"),
    } as const;
    await expect(confirmComputerStop(switched, ref, ctx, "destroy")).resolves.toBe("gone");
    expect(destroyed).toHaveBeenCalledOnce();

    const different = createRunSandbox("docker", { ...opts, supervisorUrl: "http://other.test" });
    await expect(confirmComputerStop(different, ref, ctx, "destroy")).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
    });
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it("does not pass emulator references to a live provider", async () => {
    const live = vi.spyOn(E2BSandboxProvider.prototype, "destroy");
    const sandbox = createRunSandbox("e2b-emulator", { e2bApiKey: "synthetic-key" });
    const ref = await sandbox.provision({ botId: "bot", homePath: "/unused" }, ctx);
    await expect(confirmComputerStop(sandbox, ref, ctx, "destroy")).resolves.toBe("gone");
    expect(live).not.toHaveBeenCalled();
  });

  it("keeps an unbound switched reference unknown when a different account cannot find it", async () => {
    vi.spyOn(E2BSandboxProvider.prototype, "inspectPowerState").mockResolvedValue("gone");
    const destroy = vi.spyOn(E2BSandboxProvider.prototype, "destroy");
    const sandbox = createRunSandbox("docker", { e2bApiKey: "synthetic-key" });
    const ref = { id: "old", botId: "bot", kind: "e2b", providerRef: "old" } as const;
    await expect(confirmComputerStop(sandbox, ref, ctx, "destroy")).rejects.toMatchObject({
      name: "SandboxUnsafeStopError",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  const hostRoot = mkdtempSync(path.join(tmpdir(), "rakazo-host-root-"));

  afterAll(() => {
    rmSync(hostRoot, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("exposes and routes page commands through the production Docker wrapper", async () => {
    const result = {
      ok: true,
      url: "https://example.test",
      title: "Page",
      tree: "Page",
      elements: [],
    };
    const pageBrowser = vi
      .spyOn(DockerSandboxProvider.prototype, "pageBrowser")
      .mockResolvedValue(result);
    const sandbox = createRunSandbox("docker", {
      prisma: { deploymentSettings: { findUnique: vi.fn() } } as unknown as PrismaClient,
    });
    const browser = new ComputerBrowserProvider({ sandbox });
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "docker",
    };
    expect(browser.describe().capabilities.page).toBe(true);
    expect(await browser.snapshot(computer, {}, ctx)).toMatchObject({
      title: "Page",
      tree: "Page",
    });
    expect(pageBrowser).toHaveBeenCalledOnce();
    const [routedComputer, request, routedContext] = pageBrowser.mock.calls[0]!;
    expect(routedComputer).toEqual(computer);
    expect(request).toEqual({ command: "snapshot" });
    expect(routedContext).toEqual({ ...ctx, signal: routedContext.signal });
    expect(routedContext.signal).toBeInstanceOf(AbortSignal);
    expect(routedContext.signal.aborted).toBe(false);

    pageBrowser.mockClear();
    const hostResult = await browser.snapshot({ ...computer, kind: "desktop" }, {}, ctx);
    expect(hostResult.fallback).toBe("computer_act");
    expect(pageBrowser).not.toHaveBeenCalled();
  });

  it("propagates Run Stop through the routed page signal without another dispatch", async () => {
    const controller = new AbortController();
    const runContext = { ...ctx, signal: controller.signal };
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let routedSignal!: AbortSignal;
    const pageBrowser = vi.spyOn(DockerSandboxProvider.prototype, "pageBrowser").mockImplementation(
      async (_computer, _request, context) =>
        new Promise((_resolve, reject) => {
          routedSignal = context.signal;
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
          started();
        }),
    );
    const sandbox = createRunSandbox("docker", {
      prisma: { deploymentSettings: { findUnique: vi.fn() } } as unknown as PrismaClient,
    });
    const browser = new ComputerBrowserProvider({ sandbox });
    const computer: ComputerRef = {
      id: "computer",
      providerRef: "computer",
      botId: "home",
      kind: "docker",
    };
    const pending = browser.snapshot(computer, {}, runContext);
    const stopped = new Error("Run was stopped");
    const rejection = expect(pending).rejects.toBe(stopped);
    await ready;
    controller.abort(stopped);
    await rejection;
    expect(routedSignal.aborted).toBe(true);
    expect(routedSignal.reason).toBe(stopped);
    await expect(browser.snapshot(computer, {}, runContext)).rejects.toBe(stopped);
    expect(pageBrowser).toHaveBeenCalledOnce();
  });

  it("does not expose page commands when neither provider supports them", () => {
    const sandbox = new HostAwareSandbox(
      new FakeSandboxProvider(),
      new DesktopSandboxProvider(),
      async () => false,
    );
    expect(sandbox.pageBrowser).toBeUndefined();
  });

  it("lets this-mac cwd run under a host root", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "host", homePath: "/tmp/host-home" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: hostRoot },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("still refuses paths outside home and host roots", async () => {
    const desktop = new DesktopSandboxProvider({ hostRoots: [hostRoot] });
    const computer = await desktop.provision({ botId: "deny", homePath: "/tmp/deny" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/outside this computer's home/i);
    await desktop.destroy(computer, ctx);
  });

  it("reports the selected kind without starting either provider", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const provisionIsolated = vi.spyOn(isolated, "provision");
    const provisionHost = vi.spyOn(host, "provision");
    let enabled = false;
    const sandbox = new HostAwareSandbox(isolated, host, async () => enabled);

    expect(await sandbox.provisionKind()).toBe("fake");
    enabled = true;
    expect(await sandbox.provisionKind()).toBe("desktop");
    expect(provisionIsolated).not.toHaveBeenCalled();
    expect(provisionHost).not.toHaveBeenCalled();
  });

  it("preserves the no-start cleanup option when routing an existing reference", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => true);
    const release = vi.spyOn(isolated, "releaseScreen").mockResolvedValue();
    const provision = vi.spyOn(isolated, "provision");
    const computer: ComputerRef = { id: "old", botId: "home", kind: "fake", providerRef: "old" };
    await sandbox.releaseScreen(computer, ctx, { onlyIfRunning: true });
    expect(release).toHaveBeenCalledWith(computer, ctx, { onlyIfRunning: true });
    expect(provision).not.toHaveBeenCalled();
  });

  it("routes passive attendance to the existing provider without selecting or starting one", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const keepAlive = vi.fn().mockResolvedValue(undefined);
    const selected = vi.fn(async () => true);
    Object.assign(isolated, { keepAlive });
    const sandbox = new HostAwareSandbox(isolated, host, selected);
    const provision = vi.spyOn(isolated, "provision");
    const computer: ComputerRef = { id: "old", botId: "home", kind: "fake", providerRef: "old" };
    await sandbox.keepAlive(computer, { onlyIfRunning: true });
    expect(keepAlive).toHaveBeenCalledWith(computer, { onlyIfRunning: true });
    expect(provision).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });

  it("provisions on the host provider when enabled", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => true);
    const computer = await sandbox.provision({ botId: "switch", homePath: "/tmp/switch" }, ctx);
    expect(computer.kind).toBe("desktop");
    await sandbox.destroy(computer, ctx);
  });

  it("provisions on the isolated provider when this-mac is off", async () => {
    const isolated = new FakeSandboxProvider();
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "iso", homePath: "/tmp/iso" }, ctx);
    expect(computer.kind).toBe("fake");
    await sandbox.destroy(computer, ctx);
  });

  it("maps the Linux bot home cwd onto the desktop home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "alias", homePath: "/tmp/alias" }, ctx);
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "ok"], cwd: "/home/rakazo" },
      ctx,
    )) {
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    await desktop.destroy(computer, ctx);
  });

  it("only switches docker deployments onto this Mac", () => {
    expect(sandboxKindForBot("docker", "this-mac")).toBe("desktop");
    expect(sandboxKindForBot("docker", "docker")).toBe("docker");
    expect(sandboxKindForBot("e2b", "this-mac")).toBe("e2b");
    expect(sandboxKindForBot("fake", "this-mac")).toBe("fake");
  });

  it("forwards pageBrowser to the routed provider", async () => {
    const isolated: SandboxProvider = new FakeSandboxProvider();
    const calls: unknown[] = [];
    isolated.pageBrowser = async (computer, request, context) => {
      calls.push({ computerId: computer.id, request, aborted: context.signal.aborted });
      return { ok: true, url: "https://example.test", title: "Example", tree: "", elements: [] };
    };
    const host = new DesktopSandboxProvider();
    const sandbox = new HostAwareSandbox(isolated, host, async () => false);
    const computer = await sandbox.provision({ botId: "page", homePath: "/tmp/page" }, ctx);
    expect(typeof sandbox.pageBrowser).toBe("function");
    await expect(
      sandbox.pageBrowser!(computer, { command: "snapshot" }, ctx),
    ).resolves.toMatchObject({
      ok: true,
      url: "https://example.test",
    });
    expect(calls).toEqual([
      { computerId: computer.id, request: { command: "snapshot" }, aborted: false },
    ]);
    await sandbox.destroy(computer, ctx);
  });
});
