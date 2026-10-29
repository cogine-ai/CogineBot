import { randomUUID } from "node:crypto";
import type { BillingSubscriptionSnapshot } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  claimBillingStatusRefresh,
  hasFreshBillingStatus,
  syncBillingSnapshot,
} from "./billing.js";
import { createDb, Prisma } from "./client.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const timeZones = ["UTC", "Asia/Taipei", "America/Los_Angeles"] as const;

async function fixture(timeZone: string) {
  const connection = new URL(process.env.DATABASE_URL!);
  connection.searchParams.set("options", `-c timezone=${timeZone}`);
  const db = createDb(connection.href);
  const organizationId = `billing-zone-${randomUUID()}`;
  const customerId = `customer-${randomUUID()}`;
  try {
    const [setting] = await db.prisma.$queryRaw<[{ zone: string }]>(
      Prisma.sql`SELECT current_setting('TimeZone') AS "zone"`,
    );
    expect(setting.zone).toBe(timeZone);
    await db.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Timezone fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await db.prisma.billingAccount.create({ data: { organizationId, customerId } });
  } catch (error) {
    await db.prisma.organization.deleteMany({ where: { id: organizationId } });
    await db.prisma.$disconnect();
    await db.pool.end();
    throw error;
  }
  return {
    ...db,
    organizationId,
    customerId,
    async close() {
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    },
  };
}

describe.skipIf(!enabled)("billing freshness in non-UTC database sessions", () => {
  for (const timeZone of timeZones) {
    it.each([
      { state: "fresh", syncedAgo: 100, claimedAgo: 500, fresh: true },
      { state: "expired", syncedAgo: 3_000, claimedAgo: 4_000, fresh: false },
      { state: "newer failed claim", syncedAgo: 100, claimedAgo: 0, fresh: false },
      { state: "no snapshot", syncedAgo: null, claimedAgo: null, fresh: false },
    ])(
      `${timeZone} keeps $state independent of session offset`,
      async ({ syncedAgo, claimedAgo, fresh }) => {
        const f = await fixture(timeZone);
        try {
          const [{ now }] = await f.prisma.$queryRaw<[{ now: Date }]>(
            Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`,
          );
          await f.prisma.billingAccount.update({
            where: { organizationId: f.organizationId },
            data: {
              syncedAt: syncedAgo === null ? null : new Date(now.getTime() - syncedAgo),
              statusRefreshStartedAt:
                claimedAgo === null ? null : new Date(now.getTime() - claimedAgo),
            },
          });
          expect(await hasFreshBillingStatus(f.prisma, f.organizationId)).toBe(fresh);
        } finally {
          await f.close();
        }
      },
    );

    it(`${timeZone} preserves the actual claim, failed-attempt and sync clock lifecycle`, async () => {
      const f = await fixture(timeZone);
      try {
        const [{ before }] = await f.prisma.$queryRaw<[{ before: Date }]>(
          Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "before"`,
        );
        await expect(claimBillingStatusRefresh(f.prisma, f.organizationId)).resolves.toMatchObject({
          state: "claimed",
          customerId: f.customerId,
        });
        await expect(claimBillingStatusRefresh(f.prisma, f.organizationId)).resolves.toMatchObject({
          state: "busy",
          retryAfterSeconds: expect.any(Number),
        });
        expect(await hasFreshBillingStatus(f.prisma, f.organizationId)).toBe(false);
        // Use the real database-clock/CAS writer, rather than a timezone-shaped SQL fixture.
        await syncBillingSnapshot(f.prisma, f.customerId, async () => null);
        expect(await hasFreshBillingStatus(f.prisma, f.organizationId)).toBe(true);
        await expect(claimBillingStatusRefresh(f.prisma, f.organizationId)).resolves.toMatchObject({
          state: "fresh",
        });
        const account = await f.prisma.billingAccount.findUniqueOrThrow({
          where: { organizationId: f.organizationId },
        });
        const [{ after }] = await f.prisma.$queryRaw<[{ after: Date }]>(
          Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "after"`,
        );
        for (const timestamp of [account.statusRefreshStartedAt, account.syncedAt]) {
          expect(timestamp!.getTime()).toBeGreaterThanOrEqual(before.getTime());
          expect(timestamp!.getTime()).toBeLessThanOrEqual(after.getTime());
        }
      } finally {
        await f.close();
      }
    });
  }

  it.each(["Asia/Taipei", "America/Los_Angeles"])(
    "%s does not let an older cross-session sync replace a newer snapshot",
    async (timeZone) => {
      const f = await fixture(timeZone);
      const utcConnection = new URL(process.env.DATABASE_URL!);
      utcConnection.searchParams.set("options", "-c timezone=UTC");
      const utc = createDb(utcConnection.href);
      let loaded!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        loaded = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
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
      const olderDb = timeZone === "Asia/Taipei" ? f.prisma : utc.prisma;
      const newerDb = timeZone === "Asia/Taipei" ? utc.prisma : f.prisma;
      const older = syncBillingSnapshot(olderDb, f.customerId, async () => {
        loaded();
        await pending;
        return { ...active, status: "canceled" };
      });
      try {
        await started;
        await syncBillingSnapshot(newerDb, f.customerId, async () => active);
        release();
        await older;
        const account = await f.prisma.billingAccount.findUniqueOrThrow({
          where: { organizationId: f.organizationId },
        });
        expect(account.status).toBe("active");
      } finally {
        release();
        await older;
        await utc.prisma.$disconnect();
        await utc.pool.end();
        await f.close();
      }
    },
  );
});
