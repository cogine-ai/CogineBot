import { RPCHandler } from "@orpc/server/fetch";
import type { ScreenRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { openScreenCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(interactive = true) {
  const actor: Actor = {
    spaceId: "space",
    userId: "user",
    email: "user@example.test",
    isDeploymentOwner: true,
  };
  const live = {
    id: "bot",
    screenGeneration: 2,
    thread: { id: "thread" },
    computer: {
      id: "computer",
      spaceId: "space",
      userId: "computer-owner",
      maintenanceId: null as string | null,
      screenGeneration: 3,
      kind: "e2b",
      scope: "team",
      state: "running",
      providerRef: "provider",
      homeKey: "home",
      controlHolder: interactive ? "user" : "none",
      controlLeaseId: interactive ? "human-a" : null,
      controlBotId: interactive ? "bot" : null,
      controlRunId: null,
      controlLeaseExpiresAt: interactive ? new Date(Date.now() + 60_000) : null,
    },
  };
  const entered = deferred<ScreenRequest>();
  const complete = deferred<void>();
  let providerToken: string | undefined;
  const setScreenControl = vi.fn(async (_computer, enabled, _context, token) => {
    if (enabled) providerToken = token;
    else if (providerToken === token) providerToken = undefined;
  });
  const connectScreen = vi.fn(async (_computer, request: ScreenRequest) => {
    entered.resolve(request);
    await complete.promise;
    if (request.interactive) providerToken = request.controlToken;
    return {
      url: `https://screen.example/embed.html?token=${request.controlToken ?? "view"}`,
      close: async () => undefined,
    };
  });
  const findFirst = vi.fn(async () => structuredClone(live));
  const prisma = {
    bot: { findFirst },
    computer: { updateMany: vi.fn() },
    computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    sandbox: { connectScreen, setScreenControl },
    events: {
      finalizeComputerControlRelease: vi.fn(async () => {
        live.computer.controlHolder = "bot";
        live.computer.controlLeaseId = null;
        live.computer.controlBotId = null;
        live.computer.controlLeaseExpiresAt = null;
        return { runId: null };
      }),
    },
    jobs: {
      enqueue: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      sandboxProvider: "e2b",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "test-only-secret",
    },
    dataDir: "/tmp/router-screen-recovery",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (operation = "screenUrl") =>
    (
      await handler.handle(
        new Request(`http://127.0.0.1/rpc/computer/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: "bot" } }),
        }),
        { prefix: "/rpc", context: { actor } },
      )
    ).response;
  return {
    live,
    entered,
    complete,
    call,
    prisma,
    setScreenControl,
    connectScreen,
    providerToken: () => providerToken,
  };
}

describe("screen grant authority after provider recovery", () => {
  it.each(["e2b", "box", "daytona"])(
    "only clears an E2B-specific Gone for the matching %s target",
    async (kind) => {
      const f = fixture(false);
      f.live.computer.kind = kind;
      const failure = new Error("Sandbox is probably not running anymore");
      f.connectScreen.mockRejectedValueOnce(failure);
      vi.mocked(f.prisma.computer.updateMany).mockResolvedValue({ count: 1 });
      const response = await f.call();
      if (kind !== "e2b") {
        expect(response.status).toBe(500);
        expect(f.prisma.computer.updateMany).not.toHaveBeenCalled();
        return;
      }
      expect(response.status).toBe(200);
      expect(f.prisma.computer.updateMany).toHaveBeenCalledWith({
        where: {
          id: "computer",
          spaceId: "space",
          userId: "computer-owner",
          homeKey: "home",
          kind: "e2b",
          state: "running",
          providerRef: "provider",
          screenGeneration: 3,
          maintenanceId: null,
        },
        data: { state: "stopped", providerRef: null },
      });
    },
  );

  it.each([
    "No such file",
    "command not found",
    "file not found",
    "network timeout",
    "HTTP 429 quota exceeded",
  ])("does not clear a target for %s", async (message) => {
    const f = fixture(false);
    f.connectScreen.mockRejectedValueOnce(new Error(message));
    expect((await f.call()).status).toBe(500);
    expect(f.prisma.computer.updateMany).not.toHaveBeenCalled();
  });

  it("revokes a delayed grant after the actual release handler completes", async () => {
    const f = fixture();
    const pending = f.call();
    await f.entered.promise;
    expect((await f.call("release")).status).toBe(200);
    f.complete.resolve();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(f.providerToken()).toBeUndefined();
    expect(f.setScreenControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerRef: "provider" }),
      false,
      expect.objectContaining({ botId: "bot" }),
      "human-a",
    );
  });

  it.each([
    "token",
    "expiry",
    "provider",
    "computer",
    "bot-generation",
    "computer-generation",
    "holder",
    "bot",
    "state",
  ])("rejects a recovered screen after %s authority changes", async (change) => {
    const f = fixture();
    const pending = f.call();
    await f.entered.promise;
    if (change === "token") f.live.computer.controlLeaseId = "human-b";
    if (change === "expiry") f.live.computer.controlLeaseExpiresAt = new Date(0);
    if (change === "provider") f.live.computer.providerRef = "replacement";
    if (change === "computer") f.live.computer.id = "replacement";
    if (change === "bot-generation") f.live.screenGeneration++;
    if (change === "computer-generation") f.live.computer.screenGeneration++;
    if (change === "holder") f.live.computer.controlHolder = "bot";
    if (change === "bot") f.live.computer.controlBotId = "other";
    if (change === "state") f.live.computer.state = "stopped";
    f.complete.resolve();
    expect((await pending).status).toBe(409);
    expect(f.providerToken()).toBe(change.endsWith("generation") ? "human-a" : undefined);
    expect(f.live.computer.controlLeaseId).toBe(change === "token" ? "human-b" : "human-a");
  });

  it("retains the active human lease when the execution fence advances", async () => {
    const f = fixture();
    const pending = f.call();
    await f.entered.promise;
    vi.mocked(f.prisma.computerExecutionLease.findUnique).mockResolvedValue({
      runId: "run",
      fence: 2,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    f.complete.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    const { json } = await response.json();
    const url = new URL(json.url);
    expect(openScreenCapability(url.pathname, "test-only-secret")?.scope.controlLeaseId).toBe(
      "human-a",
    );
    expect(f.setScreenControl).not.toHaveBeenCalled();
  });

  it("does not promote an in-flight watch when control is acquired", async () => {
    const f = fixture(false);
    const pending = f.call();
    expect((await f.entered.promise).interactive).toBe(false);
    f.live.computer.controlHolder = "user";
    f.live.computer.controlLeaseId = "human-b";
    f.live.computer.controlBotId = "bot";
    f.live.computer.controlLeaseExpiresAt = new Date(Date.now() + 60_000);
    f.complete.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    const { json } = await response.json();
    expect(
      openScreenCapability(new URL(json.url).pathname, "test-only-secret")?.target.interactive,
    ).toBe(false);
    expect(f.setScreenControl).not.toHaveBeenCalled();
  });

  it("surfaces cleanup failure and never returns the stale interactive URL", async () => {
    const f = fixture();
    const pending = f.call();
    await f.entered.promise;
    f.live.computer.controlLeaseId = "human-b";
    f.setScreenControl.mockRejectedValue(new Error("control teardown failed"));
    f.complete.resolve();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("https://screen.example");
    expect(f.live.computer.controlLeaseId).toBe("human-b");
  });

  it("does not let delayed old-token cleanup revoke the replacement grant", async () => {
    const f = fixture();
    const pendingA = f.call();
    await f.entered.promise;
    f.live.computer.controlLeaseId = "human-b";
    const cleanupEntered = deferred<void>();
    const cleanupContinue = deferred<void>();
    const revoke = f.setScreenControl.getMockImplementation()!;
    f.setScreenControl.mockImplementationOnce(async (...args) => {
      cleanupEntered.resolve();
      await cleanupContinue.promise;
      return revoke(...args);
    });
    f.complete.resolve();
    await cleanupEntered.promise;
    expect((await f.call()).status).toBe(200);
    expect(f.providerToken()).toBe("human-b");
    cleanupContinue.resolve();
    expect((await pendingA).status).toBe(409);
    expect(f.providerToken()).toBe("human-b");
    expect(f.live.computer.controlLeaseId).toBe("human-b");
  });
});
