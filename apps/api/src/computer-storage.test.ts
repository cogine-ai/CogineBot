import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ComputerStorageFullError } from "@rakazo/adapter-kit";
import type { Actor, ComputerDiskProbeOutcome } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "workspace",
  userId: "viewer",
  email: "viewer@example.test",
  isDeploymentOwner: false,
};
const available: ComputerDiskProbeOutcome = {
  status: "available",
  data: {
    volume: { totalBytes: 2048, availableBytes: 512, availableInodes: 20 },
    candidates: [{ path: "notes.txt", logicalBytes: 40 }],
    partial: false,
  },
};

function fixture(context = {}) {
  const computer = {
    id: "computer",
    spaceId: actor.spaceId,
    userId: "team-computer-owner",
    scope: "team",
    scopeKey: "team:workspace",
    homeKey: "team-workspace",
    kind: "docker",
    providerRef: "ref",
    state: "running",
    screenGeneration: 1,
    restorePending: false,
    controlHolder: "user",
    controlLeaseId: "active-control",
    controlLeaseExpiresAt: new Date("2099-01-01T00:00:00Z"),
    controlBotId: "selected",
    maintenanceId: null as string | null,
  };
  const bot = { id: "selected", computer, screenGeneration: 1, computerSwitching: false };
  const findFirst = vi.fn().mockResolvedValue(bot);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const getDiskUsage = vi.fn().mockResolvedValue(available);
  const writeFile = vi.fn();
  const forbiddenSideEffect = vi.fn().mockRejectedValue(new Error("unexpected effect"));
  const deps = {
    prisma: { bot: { findFirst }, computer: { updateMany } },
    sandbox: {
      getDiskUsage,
      writeFile,
      provision: forbiddenSideEffect,
      keepAlive: forbiddenSideEffect,
      execute: forbiddenSideEffect,
      listFiles: forbiddenSideEffect,
    },
    jobs: { enqueue },
    billing: { assertAccess: vi.fn() },
    env: { defaultProvider: "fake", defaultModel: "fake", sandboxProvider: "fake" },
  } as unknown as RouterDeps;
  const router = createRouter(deps);
  const client = createRouterClient(router, { context: { actor, ...context } as never });
  return {
    router,
    client,
    deps,
    bot,
    computer,
    findFirst,
    updateMany,
    enqueue,
    getDiskUsage,
    writeFile,
    forbiddenSideEffect,
    diagnose: (expectedTarget?: string) =>
      client.computer.diskUsage({ botId: "selected", expectedTarget }),
    upload: () =>
      client.computer.uploadFile({
        botId: "selected",
        path: "notes.txt",
        contentBase64: "dGVzdA==",
      }),
  };
}

describe("computer storage RPC", () => {
  afterEach(() => vi.useRealTimers());

  it("binds a Team probe to the authorized Bot and keeps it read-only", async () => {
    const f = fixture();
    const result = await f.diagnose();
    expect(result).toEqual({
      botId: "selected",
      target: expect.stringMatching(/^[a-f0-9]{64}$/),
      outcome: available,
    });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "selected", spaceId: "workspace", userId: "viewer", archivedAt: null },
      }),
    );
    expect(f.getDiskUsage).toHaveBeenCalledWith(
      { id: "ref", botId: "team-workspace", providerRef: "ref", kind: "docker" },
      { workspace: { kind: "team", botId: "selected" }, timeoutMs: expect.any(Number) },
      expect.objectContaining({ botId: "selected", signal: expect.any(AbortSignal) }),
    );
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.forbiddenSideEffect).not.toHaveBeenCalled();
    expect(f.deps.billing?.assertAccess).not.toHaveBeenCalled();
  });

  it.each(["stopped", "suspending", "booting", "error"])(
    "does not attach a %s computer",
    async (state) => {
      const f = fixture();
      f.computer.state = state;
      expect((await f.diagnose()).outcome).toEqual({ status: "not_running" });
      expect(f.getDiskUsage).not.toHaveBeenCalled();
    },
  );

  it("requires a matching computer scope and a non-archived owned Bot", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValueOnce(null);
    await expect(f.diagnose()).rejects.toBeDefined();
    f.computer.scopeKey = "team:other";
    await expect(f.diagnose()).rejects.toBeDefined();
    expect(f.getDiskUsage).not.toHaveBeenCalled();
  });

  it("cannot accept a path, provider, workspace, or scan budget from callers", async () => {
    const f = fixture();
    for (const extra of [
      { path: "/" },
      { providerRef: "other" },
      { timeoutMs: 100_000 },
      { workspace: "shared" },
    ]) {
      const response = await new RPCHandler(f.router).handle(
        new Request("https://api.example.test/rpc/computer/diskUsage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { botId: "selected", ...extra } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      expect(response.matched && response.response.status).toBe(400);
    }
    expect(f.getDiskUsage).not.toHaveBeenCalled();
  });

  it("reports unsupported adapters without falling back to execute, attach, or Files", async () => {
    const f = fixture();
    f.computer.kind = "desktop";
    expect((await f.diagnose()).outcome).toEqual({ status: "unsupported" });
    f.computer.kind = "e2b";
    f.deps.sandbox.getDiskUsage = undefined;
    expect((await f.diagnose()).outcome).toEqual({ status: "unsupported" });
    expect(f.getDiskUsage).not.toHaveBeenCalled();
    expect(f.forbiddenSideEffect).not.toHaveBeenCalled();
  });

  it("checks the target before and after the probe", async () => {
    const f = fixture();
    const first = await f.diagnose();
    f.computer.screenGeneration++;
    expect((await f.diagnose(first.target!)).outcome).toEqual({ status: "changed" });
    expect(f.getDiskUsage).toHaveBeenCalledOnce();
    f.getDiskUsage.mockImplementationOnce(async () => {
      f.bot.screenGeneration++;
      return available;
    });
    expect((await f.diagnose()).outcome).toEqual({ status: "changed" });
  });

  it("checks current session permissions before handing out results", async () => {
    const f = fixture({ stillAuthorized: async () => false });
    await expect(f.diagnose()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cancels a stalled provider before returning a timeout", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const f = fixture({ diskUsageDeadline: performance.now() + 25 });
    let signal: AbortSignal | undefined;
    f.getDiskUsage.mockImplementationOnce((_ref, _request, context) => {
      signal = context.signal;
      return new Promise(() => {});
    });
    expect((await f.diagnose()).outcome).toEqual({ status: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(f.findFirst).toHaveBeenCalledOnce();
  });

  it("keeps the real workspace writer's ENOSPC intent bound to the failing computer", async () => {
    const f = fixture();
    f.writeFile.mockImplementationOnce(async (ref) => {
      throw new ComputerStorageFullError(ref);
    });
    const diagnostic = await f.diagnose();
    await expect(f.upload()).rejects.toMatchObject({
      code: "COMPUTER_STORAGE_FULL",
      status: 507,
      data: {
        botId: "selected",
        kind: "computer_storage",
        code: "ENOSPC",
        expectedTarget: diagnostic.target,
      },
    });
    f.writeFile.mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    await expect(f.upload()).rejects.not.toMatchObject({ code: "COMPUTER_STORAGE_FULL" });
  });
});
