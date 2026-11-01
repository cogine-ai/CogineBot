import { PlatformModelForbiddenError } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { canUsePlatformModel, platformModelAuthorization } from "./platform-model-access.js";

function authorityFixture() {
  const state: {
    user: { email: string; emailVerified: boolean } | null;
    ownerUserId: string | null;
  } = { user: { email: "member@allowed.test", emailVerified: true }, ownerUserId: "owner" };
  const user = { findUnique: vi.fn(async () => state.user) };
  const deploymentSettings = {
    findUnique: vi.fn(async () => ({ ownerUserId: state.ownerUserId })),
  };
  return {
    state,
    user,
    deploymentSettings,
    prisma: { user, deploymentSettings } as unknown as Parameters<typeof canUsePlatformModel>[0],
  };
}

describe("platform model access", () => {
  it.each([undefined, []])(
    "does not read account state for an unrestricted policy (%j)",
    async (policy) => {
      const f = authorityFixture();
      await expect(canUsePlatformModel(f.prisma, policy, "user")).resolves.toBe(true);
      expect(platformModelAuthorization(f.prisma, policy, "user")).toBeUndefined();
      expect(f.user.findUnique).not.toHaveBeenCalled();
      expect(f.deploymentSettings.findUnique).not.toHaveBeenCalled();
    },
  );

  it("reads the selected user's current proof and the stored deployment owner", async () => {
    const f = authorityFixture();
    await expect(canUsePlatformModel(f.prisma, ["@allowed.test"], "user")).resolves.toBe(true);
    expect(f.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user" },
      select: { email: true, emailVerified: true },
    });
    expect(f.deploymentSettings.findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
  });

  it("admits a stored owner without mailbox proof and rejects a missing user even with the owner ID", async () => {
    const f = authorityFixture();
    f.state.user = { email: "owner@messaging.invalid", emailVerified: false };
    f.state.ownerUserId = "user";
    await expect(canUsePlatformModel(f.prisma, "owner_only", "user")).resolves.toBe(true);
    f.state.user = null;
    await expect(canUsePlatformModel(f.prisma, "owner_only", "user")).resolves.toBe(false);
  });

  it("rechecks authority before every request rather than retaining an earlier grant", async () => {
    const f = authorityFixture();
    const authorize = platformModelAuthorization(f.prisma, ["@allowed.test"], "user")!;
    await expect(authorize()).resolves.toBeUndefined();
    f.state.user!.emailVerified = false;
    await expect(authorize()).rejects.toBeInstanceOf(PlatformModelForbiddenError);
    f.state.user = { email: "member@allowed.test.attacker.invalid", emailVerified: true };
    await expect(authorize()).rejects.toMatchObject({ code: "platform_model_forbidden" });
    f.state.ownerUserId = "user";
    await expect(authorize()).resolves.toBeUndefined();
    f.state.ownerUserId = "different-owner";
    await expect(authorize()).rejects.toBeInstanceOf(PlatformModelForbiddenError);
  });

  it("does not convert an account lookup failure into permission", async () => {
    const f = authorityFixture();
    const failure = new Error("Synthetic account lookup unavailable");
    f.user.findUnique.mockRejectedValueOnce(failure);
    await expect(canUsePlatformModel(f.prisma, ["@allowed.test"], "user")).rejects.toBe(failure);
  });
});
