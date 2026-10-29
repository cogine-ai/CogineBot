import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BillingProvider, BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { createDb, Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const active: BillingSubscriptionSnapshot = {
  subscriptionId: "fixture-subscription",
  subscriptionItemId: "fixture-item",
  priceId: "fixture-price",
  status: "active",
  seats: 1,
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  cancelAtPeriodEnd: false,
  endedAt: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture() {
  const db = createDb(process.env.DATABASE_URL!);
  const id = randomUUID();
  const organizationId = `refresh-org-${id}`,
    userId = `refresh-user-${id}`,
    spaceId = `refresh-space-${id}`;
  const actor: Actor = { userId, spaceId, email: "fixture@example.test", isDeploymentOwner: false };
  const prisma = db.prisma;
  await prisma.user.create({ data: { id: userId, name: "Fixture", email: `${id}@example.test` } });
  await prisma.organization.create({
    data: { id: organizationId, name: "Fixture", slug: id, createdAt: new Date() },
  });
  await prisma.space.create({
    data: { id: spaceId, organizationId, name: "Fixture", isDefault: true },
  });
  await prisma.member.create({
    data: { id: `member-${id}`, organizationId, userId, role: "member", createdAt: new Date() },
  });
  await prisma.spaceMember.createMany({
    data: [
      {
        id: `space-member-${id}`,
        spaceId,
        organizationId,
        userId,
        createdAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  await prisma.billingAccount.create({ data: { organizationId, customerId: `customer-${id}` } });
  const provider = {
    getPrice: vi
      .fn()
      .mockResolvedValue({ amount: 1200, currency: "usd", interval: "month", intervalCount: 1 }),
    getCustomerSubscription: vi
      .fn<() => Promise<BillingSubscriptionSnapshot | null>>()
      .mockResolvedValue(active),
    createCheckout: vi.fn().mockResolvedValue({ url: "https://billing.example.test/checkout" }),
  };
  const service = () =>
    createBillingService({
      prisma,
      provider: provider as unknown as BillingProvider,
      webOrigin: "https://app.example.test",
    });
  const account = () => prisma.billingAccount.findUniqueOrThrow({ where: { organizationId } });
  return {
    prisma,
    actor,
    organizationId,
    provider,
    service,
    account,
    async close() {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await db.pool.end();
    },
  };
}

describe.skipIf(!enabled)("bounded recovery billing pulls (PostgreSQL)", () => {
  it("coalesces member bursts across service instances, releases the DB claim before I/O and uses only a short success window", async () => {
    const f = await fixture();
    const pending = deferred<BillingSubscriptionSnapshot>();
    f.provider.getCustomerSubscription.mockReturnValue(pending.promise);
    const first = f.service(),
      second = f.service();
    try {
      expect((await f.account()).statusRefreshStartedAt).toBeNull();
      const a = Array.from({ length: 12 }, () => first.status(f.actor, { refresh: true }));
      const settledA = Promise.allSettled(a);
      await vi.waitFor(() => expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce());
      const b = Array.from({ length: 12 }, () => second.status(f.actor, { refresh: true }));
      const settledB = await Promise.allSettled(b);
      // The winning provider is pending, but its transaction and advisory lock are gone.
      const lock = await f.prisma.$transaction((tx) =>
        tx.$queryRaw<[{ acquired: boolean }]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${`billing-status:${f.organizationId}`}, 3)) AS "acquired"
      `),
      );
      expect(lock[0].acquired).toBe(true);
      pending.resolve(active);
      const results = [...(await settledA), ...settledB];
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            data: { reason: "billing_unavailable" },
          });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce();
      await first.status(f.actor, { refresh: true });
      await second.status(f.actor, { refresh: true });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce();
      // A successful claim is limited by two seconds, never its 15-second attempt window.
      await f.prisma.$executeRaw(Prisma.sql`UPDATE billing_accounts SET
        "statusRefreshStartedAt" = clock_timestamp() - interval '4 seconds',
        "syncedAt" = clock_timestamp() - interval '3 seconds'
        WHERE "organizationId" = ${f.organizationId}`);
      await second.status(f.actor, { refresh: true });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(active);
      await f.close();
    }
  });

  it("keeps failed attempts retryable without marking success or amplifying a failure burst", async () => {
    const f = await fixture();
    try {
      f.provider.getCustomerSubscription.mockRejectedValue(new Error("provider unavailable"));
      await expect(f.service().status(f.actor, { refresh: true })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_unavailable", retryAfterSeconds: 15 },
      });
      expect((await f.account()).syncedAt).toBeNull();
      await expect(f.service().status(f.actor, { refresh: true })).rejects.toMatchObject({
        data: { reason: "billing_unavailable", retryAfterSeconds: expect.any(Number) },
      });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce();
      await f.prisma.$executeRaw(Prisma.sql`UPDATE billing_accounts SET
        "statusRefreshStartedAt" = clock_timestamp() - interval '16 seconds'
        WHERE "organizationId" = ${f.organizationId}`);
      f.provider.getCustomerSubscription.mockResolvedValue(active);
      await expect(f.service().status(f.actor, { refresh: true })).resolves.toMatchObject({
        access: true,
      });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it("returns a retryable response without waiting for another instance's claim lock", async () => {
    const f = await fixture();
    const acquired = deferred<void>(),
      release = deferred<void>();
    const held = f.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-status:${f.organizationId}`}, 3))::text`,
      );
      acquired.resolve();
      await release.promise;
    });
    try {
      await Promise.race([acquired.promise, held]);
      await expect(f.service().status(f.actor, { refresh: true })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { retryAfterSeconds: 1 },
      });
      expect(f.provider.getCustomerSubscription).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      try {
        await held;
      } finally {
        await f.close();
      }
    }
  });

  it("bounds responses while retaining the real in-flight pull and rejects late overwrite after a forced return sync", async () => {
    const f = await fixture();
    const pending = deferred<BillingSubscriptionSnapshot>();
    const current = f.service();
    const writes: PromiseLike<unknown>[] = [];
    const updateMany = f.prisma.billingAccount.updateMany.bind(f.prisma.billingAccount);
    const trackWrites = vi
      .spyOn(f.prisma.billingAccount, "updateMany")
      .mockImplementation((args) => {
        const write = updateMany(args);
        writes.push(write);
        return write;
      });
    try {
      f.provider.getCustomerSubscription.mockReturnValueOnce(pending.promise);
      const response = current.status(f.actor, { refresh: true });
      await expect(response).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "billing_unavailable", retryAfterSeconds: 5 },
      });
      expect((await f.account()).syncedAt).toBeNull();
      await expect(current.status(f.actor, { refresh: true })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce();
      // Checkout/portal return and webhook pulls bypass recovery admission immediately.
      await f.service().syncForActor(f.actor);
      expect((await f.account()).status).toBe("active");
      const completedWrites = writes.length;
      pending.resolve({ ...active, status: "canceled" });
      await vi.waitFor(() => expect(writes).toHaveLength(completedWrites + 2));
      await Promise.all(writes);
      await expect(current.status(f.actor, { refresh: true })).resolves.toMatchObject({
        access: true,
      });
      expect((await f.account()).status).toBe("active");
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(active);
      trackWrites.mockRestore();
      await f.close();
    }
  });

  it("applies verified payment returns immediately even just after a checkout pre-sync", async () => {
    const f = await fixture();
    try {
      await f.prisma.member.update({
        where: {
          organizationId_userId: { organizationId: f.organizationId, userId: f.actor.userId },
        },
        data: { role: "owner" },
      });
      f.provider.getCustomerSubscription.mockResolvedValue(null);
      await f.service().checkout(f.actor);
      expect(f.provider.createCheckout).toHaveBeenCalledOnce();
      expect((await f.account()).status).toBeNull();
      f.provider.getCustomerSubscription.mockResolvedValue(active);
      await f.service().syncForActor(f.actor);
      await expect(f.service().status(f.actor, { refresh: true })).resolves.toMatchObject({
        access: true,
      });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it("reads a fresh forced return immediately on the same service without discarding its older pull", async () => {
    const f = await fixture();
    const pending = deferred<BillingSubscriptionSnapshot>();
    const current = f.service();
    f.provider.getCustomerSubscription.mockReturnValueOnce(pending.promise);
    const stalled = current.status(f.actor, { refresh: true });
    // Retain the pending response's rejection while the regression exercises the fresh path.
    const settled = stalled.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(f.provider.getCustomerSubscription).toHaveBeenCalledOnce());
      await current.syncForActor(f.actor);
      await expect(current.status(f.actor, { refresh: true })).resolves.toMatchObject({
        access: true,
      });
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      let returned = false;
      const afterExpiry = current.status(f.actor, { refresh: true }).then((status) => {
        returned = true;
        return status;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(returned).toBe(false);
      expect(f.provider.getCustomerSubscription).toHaveBeenCalledTimes(2);
      pending.resolve({ ...active, status: "canceled" });
      await expect(afterExpiry).resolves.toMatchObject({ access: true });
      await expect(stalled).resolves.toMatchObject({ access: true });
      expect((await f.account()).status).toBe("active");
    } finally {
      pending.resolve(active);
      await settled;
      await f.close();
    }
  });

  it("keeps existing snapshots through nullable migration and metadata-only rollback", async () => {
    const f = await fixture();
    try {
      const migration = readFileSync(
        new URL(
          "../../../packages/db/prisma/migrations/20261029190000_billing_status_refresh/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await f.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE billing_refresh_migration_fixture ("organizationId" TEXT, "status" TEXT, "syncedAt" TIMESTAMP(3)) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO billing_refresh_migration_fixture VALUES ('fixture', 'active', '2030-01-01')",
        );
        await tx.$executeRawUnsafe(
          migration.replace('"billing_accounts"', "billing_refresh_migration_fixture"),
        );
        const [migrated] = await tx.$queryRawUnsafe<
          Array<{ status: string; statusRefreshStartedAt: Date | null }>
        >("SELECT * FROM billing_refresh_migration_fixture");
        expect(migrated).toMatchObject({ status: "active", statusRefreshStartedAt: null });
        await tx.$executeRawUnsafe(
          'ALTER TABLE billing_refresh_migration_fixture DROP COLUMN "statusRefreshStartedAt"',
        );
        const [rolledBack] = await tx.$queryRawUnsafe<Array<{ status: string; syncedAt: Date }>>(
          "SELECT * FROM billing_refresh_migration_fixture",
        );
        expect(rolledBack).toMatchObject({ status: "active", syncedAt: new Date("2030-01-01") });
      });
    } finally {
      await f.close();
    }
  });
});
