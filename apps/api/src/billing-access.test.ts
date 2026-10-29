import { ORPCError } from "@orpc/server";
import type { BillingProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-other",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
function fixture(status: string | null) {
  const membership = vi.fn().mockResolvedValue({ id: "member-1" });
  const owner = vi.fn().mockResolvedValue({ role: "owner" });
  const account = vi
    .fn()
    .mockResolvedValue(status === null ? null : { customerId: "customer-fake", status });
  const provider = {
    getPrice: vi.fn().mockResolvedValue(null),
    createPortal: vi.fn().mockResolvedValue({ url: "https://billing.example.test/portal" }),
    getCustomerSubscription: vi.fn().mockResolvedValue(null),
  };
  const prisma = {
    spaceMember: { findUnique: membership },
    space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "organization-other" }) },
    member: { findUnique: owner, count: vi.fn().mockResolvedValue(1) },
    billingAccount: {
      findUnique: account,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([
      {
        startedAt: new Date("2030-01-01"),
        now: new Date("2030-01-01"),
        acquired: true,
      },
    ]),
  };
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) =>
    callback(prisma),
  );
  return {
    membership,
    owner,
    account,
    prisma,
    provider,
    service: createBillingService({
      prisma: prisma as unknown as PrismaClient,
      provider: provider as unknown as BillingProvider,
      webOrigin: "https://app.example.test",
    }),
  };
}

describe("new work admission", () => {
  it.each(["trialing", "active", "past_due"])(
    "retains stored %s access without a provider lookup",
    async (state) => {
      const f = fixture(state);
      await expect(f.service.assertAccess(actor)).resolves.toBeUndefined();
      expect(f.provider.getPrice).not.toHaveBeenCalled();
      expect(f.provider.getCustomerSubscription).not.toHaveBeenCalled();
      expect(f.membership).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        }),
      );
    },
  );
  it.each([null, "incomplete", "canceled"])(
    "rejects %s with an authoritative payment recovery signal",
    async (state) => {
      const f = fixture(state);
      await expect(f.service.assertAccess(actor)).rejects.toMatchObject({
        code: "PAYMENT_REQUIRED",
        status: 402,
        data: { reason: "subscription_required" },
      });
    },
  );
  it("keeps deployment-owner bypass independent of any provider or membership lookup", async () => {
    const f = fixture(null);
    await f.service.assertAccess({ ...actor, isDeploymentOwner: true });
    expect(f.membership).not.toHaveBeenCalled();
    expect(f.account).not.toHaveBeenCalled();
  });
  it("rechecks revoked Space membership even while organization membership remains", async () => {
    const f = fixture("active");
    f.membership.mockResolvedValue(null);
    await expect(f.service.assertAccess(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.account).not.toHaveBeenCalled();
  });
});

describe("bound billing refresh and return", () => {
  it("coalesces simultaneous recovery refreshes for one organization", async () => {
    const f = fixture("incomplete");
    let release!: () => void;
    const snapshot = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    f.provider.getCustomerSubscription.mockImplementation(() => snapshot);
    const pending = Array.from({ length: 20 }, () => f.service.status(actor, { refresh: true }));
    await vi.waitFor(() => expect(f.provider.getCustomerSubscription).toHaveBeenCalled());
    // All callers share one external read, rather than queueing another after it settles.
    const calls = f.provider.getCustomerSubscription.mock.calls.length;
    release();
    await Promise.all(pending);
    expect(calls).toBe(1);
  });
  it("binds portal return to the initiating Space rather than the browser's default", async () => {
    const f = fixture("incomplete");
    await f.service.portal(actor);
    expect(f.provider.createPortal).toHaveBeenCalledWith({
      customerId: "customer-fake",
      returnUrl: "https://app.example.test/api/v1/billing/return?space=space-other",
    });
  });
  it("does not publish an external URL after owner permission is revoked during creation", async () => {
    const f = fixture("incomplete");
    f.provider.createPortal.mockImplementation(async () => {
      f.owner.mockResolvedValue({ role: "member" });
      return { url: "https://billing.example.test/portal" };
    });
    await expect(f.service.portal(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("pulls the provider before publishing refreshed status", async () => {
    const f = fixture("incomplete");
    f.provider.getCustomerSubscription.mockImplementation(async () => {
      f.account.mockResolvedValue({ customerId: "customer-fake", status: "active" });
      return null;
    });
    await expect(f.service.status(actor, { refresh: true })).resolves.toMatchObject({
      access: true,
      state: "active",
    });
    expect(f.provider.getCustomerSubscription).toHaveBeenCalledWith("customer-fake");
  });
  it("reports refresh unavailability rather than fabricating unpaid or active status", async () => {
    const f = fixture("incomplete");
    f.provider.getCustomerSubscription.mockRejectedValue(new Error("offline"));
    await expect(f.service.status(actor, { refresh: true })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_unavailable" },
    });
  });
  it("does not turn a provider authentication error into a rejected application session", async () => {
    const f = fixture("incomplete");
    f.provider.getCustomerSubscription.mockRejectedValue(new ORPCError("UNAUTHORIZED"));
    await expect(f.service.status(actor, { refresh: true })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "billing_unavailable" },
    });
  });
  it("rechecks Space membership after the provider answers", async () => {
    const f = fixture("incomplete");
    f.provider.getCustomerSubscription.mockImplementation(async () => {
      f.membership.mockResolvedValue(null);
      return null;
    });
    await expect(f.service.status(actor, { refresh: true })).rejects.toBeInstanceOf(ORPCError);
  });
});

it("publishes the current owner role after refresh rather than the role captured before provider IO", async () => {
  const f = fixture("incomplete");
  f.provider.getCustomerSubscription.mockImplementation(async () => {
    f.owner.mockResolvedValue({ role: "member" });
    return null;
  });
  await expect(f.service.status(actor, { refresh: true })).resolves.toMatchObject({
    canManage: false,
  });
});

it("withholds status when Space membership is revoked during price lookup", async () => {
  const f = fixture("incomplete");
  f.provider.getPrice.mockImplementation(async () => {
    f.membership.mockResolvedValue(null);
    return { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 };
  });
  await expect(f.service.status(actor)).rejects.toMatchObject({ status: 403 });
});

it("withholds status when membership is revoked while the seat count is read", async () => {
  const f = fixture("incomplete");
  f.prisma.member.count.mockImplementation(async () => {
    f.membership.mockResolvedValue(null);
    return 1;
  });
  await expect(f.service.status(actor)).rejects.toMatchObject({ status: 403 });
});
