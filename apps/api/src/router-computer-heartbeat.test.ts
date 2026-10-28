import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture() {
  const actor: Actor = {
    spaceId: "space",
    userId: "viewer",
    email: "viewer@example.test",
    isDeploymentOwner: false,
  };
  const computer = {
    id: "computer",
    spaceId: "space",
    userId: "computer-owner",
    screenGeneration: 3,
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "provider",
    homeKey: "home",
    maintenanceId: null,
    controlHolder: "user",
    controlLeaseId: "human-lease",
    controlLeaseExpiresAt: new Date("2030-01-01"),
  };
  const bot = { id: "bot", screenGeneration: 2, computer, thread: null };
  const findFirst = vi.fn().mockResolvedValue(bot);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const keepAlive = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const deps = {
    prisma: { bot: { findFirst }, computer: { updateMany } } as unknown as PrismaClient,
    sandbox: { keepAlive },
    jobs: { enqueue },
    env: { defaultProvider: "fake", defaultModel: "fake", sandboxProvider: "fake" },
    dataDir: "/tmp/heartbeat-test",
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { client, actor, computer, findFirst, updateMany, keepAlive, enqueue };
}

describe("computer attendance heartbeat", () => {
  it("keeps only the same running computer alive without renewing human control", async () => {
    const f = fixture();
    await expect(f.client.computer.heartbeat({ botId: "bot" })).resolves.toEqual({ ok: true });
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot", spaceId: "space", userId: "viewer", archivedAt: null },
      }),
    );
    expect(f.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer",
        spaceId: "space",
        userId: "computer-owner",
        homeKey: "home",
        providerRef: "provider",
        kind: "e2b",
        state: "running",
        maintenanceId: null,
        screenGeneration: 3,
        bots: {
          some: {
            id: "bot",
            spaceId: "space",
            userId: "viewer",
            archivedAt: null,
            computerSwitching: false,
            screenGeneration: 2,
          },
        },
      },
      data: { updatedAt: expect.any(Date) },
    });
    expect(f.keepAlive).toHaveBeenCalledWith(
      { id: "provider", providerRef: "provider", botId: "home", kind: "e2b" },
      { onlyIfRunning: true },
    );
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.computer.controlLeaseId).toBe("human-lease");
    expect(f.computer.controlLeaseExpiresAt).toEqual(new Date("2030-01-01"));
  });

  it("does not keep alive a snapshot rejected by the lifecycle compare-and-swap", async () => {
    const f = fixture();
    f.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.client.computer.heartbeat({ botId: "bot" })).resolves.toEqual({ ok: true });
    expect(f.keepAlive).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(["stopped", "suspending", "booting", "error"])(
    "does not touch a %s computer",
    async (state) => {
      const f = fixture();
      f.computer.state = state;
      await f.client.computer.heartbeat({ botId: "bot" });
      expect(f.updateMany).not.toHaveBeenCalled();
      expect(f.keepAlive).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it("does not touch a computer without a provider reference", async () => {
    const f = fixture();
    f.computer.providerRef = "";
    await f.client.computer.heartbeat({ botId: "bot" });
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.keepAlive).not.toHaveBeenCalled();
  });

  it("does not expose provider failure or fall back to provisioning", async () => {
    const f = fixture();
    f.keepAlive.mockRejectedValueOnce(new Error("Synthetic unavailable provider"));
    await expect(f.client.computer.heartbeat({ botId: "bot" })).resolves.toEqual({ ok: true });
    expect(f.keepAlive).toHaveBeenCalledOnce();
  });

  it("rejects inaccessible bots before touching a computer", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValueOnce(null);
    await expect(f.client.computer.heartbeat({ botId: "bot" })).rejects.toBeDefined();
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.keepAlive).not.toHaveBeenCalled();
  });
});
