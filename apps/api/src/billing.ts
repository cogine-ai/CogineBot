import { ORPCError } from "@orpc/server";
import type { BillingPrice, BillingProvider } from "@rakazo/adapter-kit";
import type { Actor, BillingStatus } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  billingAccountForOrganization,
  claimBillingStatusRefresh,
  createBillingAccount,
  hasBillingAccess,
  organizationForMember,
  organizationSeatCount,
  ownedBillingAccounts,
  syncBillingSnapshot,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export const TRIAL_DAYS = 7;
const PRICE_CACHE_MS = 60 * 60 * 1000;
export const BILLING_STATUS_RESPONSE_TIMEOUT_MS = 10_000;
/** Stripe returns here after checkout; served by the API through the web origin. */
export const BILLING_RETURN_PATH = "/api/v1/billing/return";

/** Product-side billing: access rules, checkout, and pull-based sync from the provider. */
export interface BillingService {
  status(actor: Actor, options?: { refresh?: boolean }): Promise<BillingStatus>;
  /** Admit new user work using the stored subscription, without contacting the provider. */
  assertAccess(actor: Actor): Promise<void>;
  checkout(actor: Actor): Promise<{ url: string }>;
  portal(actor: Actor): Promise<{ url: string }>;
  /** Re-fetches the customer's subscription from the provider and overwrites the stored snapshot. */
  sync(customerId: string): Promise<void>;
  /** Syncs the actor's organization, e.g. on return from checkout before the webhook lands. */
  syncForActor(actor: Actor): Promise<void>;
  /** Pushes the organization's member count to the provider. Call when members change. */
  syncSeats(organizationId: string): Promise<void>;
  cancelForDeletedUser(userId: string): Promise<void>;
}

export function createBillingService(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  /** The session cookie lives on the web origin, which also proxies /api to this server. */
  webOrigin: string;
}): BillingService {
  const { prisma, provider } = deps;
  const appUrl = `${deps.webOrigin}/app`;
  const returnUrl = (actor: Actor) => {
    const url = new URL(BILLING_RETURN_PATH, deps.webOrigin);
    url.searchParams.set("space", actor.spaceId);
    return url.href;
  };
  let cachedPrice: { value: BillingPrice; expiresAt: number } | undefined;
  const statusRefreshes = new Map<string, { promise: Promise<void>; startedAt: number }>();

  const unavailable = (retryAfterSeconds: number) =>
    new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Could not refresh billing",
      data: { reason: "billing_unavailable", retryAfterSeconds },
    });

  async function refreshStatus(organizationId: string): Promise<void> {
    let pending = statusRefreshes.get(organizationId);
    if (!pending) {
      const promise = (async () => {
        const claim = await claimBillingStatusRefresh(prisma, organizationId);
        if (claim.state === "busy") throw unavailable(claim.retryAfterSeconds);
        if (claim.state === "claimed") await sync(claim.customerId);
      })().finally(() => {
        if (statusRefreshes.get(organizationId)?.promise === promise)
          statusRefreshes.delete(organizationId);
      });
      pending = { promise, startedAt: performance.now() };
      statusRefreshes.set(organizationId, pending);
    }
    const remaining = BILLING_STATUS_RESPONSE_TIMEOUT_MS - (performance.now() - pending.startedAt);
    if (remaining <= 0) throw unavailable(5);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable(5)), remaining);
        }),
      ]);
    } catch (error) {
      if (
        error instanceof ORPCError &&
        error.code === "SERVICE_UNAVAILABLE" &&
        typeof error.data === "object" &&
        error.data !== null &&
        "reason" in error.data &&
        error.data.reason === "billing_unavailable"
      )
        throw error;
      throw unavailable(15);
    } finally {
      clearTimeout(timer);
    }
  }

  async function price(): Promise<BillingPrice | null> {
    if (cachedPrice && cachedPrice.expiresAt > Date.now()) return cachedPrice.value;
    try {
      const value = await provider.getPrice();
      cachedPrice = { value, expiresAt: Date.now() + PRICE_CACHE_MS };
      return value;
    } catch (error) {
      getLogger().error("billing price lookup failed", error);
      return null;
    }
  }

  async function organization(actor: Actor) {
    const membership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
      select: { id: true },
    });
    if (!membership) throw new ORPCError("FORBIDDEN");
    const found = await organizationForMember(prisma, {
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    if (!found) throw new ORPCError("FORBIDDEN");
    return found;
  }

  async function managedOrganization(actor: Actor) {
    const found = await organization(actor);
    if (!found.isOwner) throw new ORPCError("FORBIDDEN");
    return found;
  }

  async function sync(customerId: string): Promise<void> {
    const written = await syncBillingSnapshot(prisma, customerId, () =>
      provider.getCustomerSubscription(customerId),
    );
    if (!written)
      getLogger().warn("billing sync for unknown customer", { "billing.customer_id": customerId });
  }

  return {
    async assertAccess(actor) {
      if (actor.isDeploymentOwner) return;
      const { organizationId } = await organization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!hasBillingAccess(account?.status ?? null))
        throw new ORPCError("PAYMENT_REQUIRED", {
          status: 402,
          message: "Subscription required",
          data: { reason: "subscription_required" },
        });
    },

    async status(actor, options) {
      if (actor.isDeploymentOwner) {
        return {
          access: true,
          canManage: false,
          trialAvailable: false,
          trialDays: TRIAL_DAYS,
          state: "none",
          price: null,
          seats: 0,
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          cancelAtPeriodEnd: false,
          hasCustomer: false,
        };
      }
      const { organizationId } = await organization(actor);
      if (options?.refresh) {
        const stored = await billingAccountForOrganization(prisma, organizationId);
        if (stored) {
          await refreshStatus(organizationId);
        }
        // A membership revoked while the provider answered must not publish its status.
        await organization(actor);
      }
      const [account, currentPrice] = await Promise.all([
        billingAccountForOrganization(prisma, organizationId),
        price(),
      ]);
      const status = account?.status ?? null;
      const seats = account?.seats ?? (await organizationSeatCount(prisma, organizationId));
      const current = await organization(actor);
      if (current.organizationId !== organizationId) throw new ORPCError("FORBIDDEN");
      return {
        access: hasBillingAccess(status),
        canManage: current.isOwner,
        trialAvailable: !account?.subscribedAt,
        trialDays: TRIAL_DAYS,
        state: (status ?? "none") as BillingStatus["state"],
        price: currentPrice,
        seats,
        trialEndsAt: account?.trialEndsAt?.toISOString() ?? null,
        currentPeriodEndsAt: account?.currentPeriodEndsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: account?.cancelAtPeriodEnd ?? false,
        hasCustomer: Boolean(account),
      };
    },

    async checkout(actor) {
      const { organizationId } = await managedOrganization(actor);
      let account = await billingAccountForOrganization(prisma, organizationId);
      if (account) {
        // Decide from the provider, not a snapshot a missed webhook may have left stale.
        await sync(account.customerId);
        account = await billingAccountForOrganization(prisma, organizationId);
      }
      if (hasBillingAccess(account?.status ?? null)) {
        throw new ORPCError("CONFLICT", { message: "Already subscribed" });
      }
      if (!account) {
        const { customerId } = await provider.createCustomer({
          email: actor.email,
          organizationId,
        });
        account = await createBillingAccount(prisma, { organizationId, customerId });
      }
      const result = await provider.createCheckout({
        customerId: account.customerId,
        seats: await organizationSeatCount(prisma, organizationId),
        ...(account.subscribedAt ? {} : { trialDays: TRIAL_DAYS }),
        successUrl: returnUrl(actor),
        cancelUrl: appUrl,
      });
      await managedOrganization(actor);
      return result;
    },

    async portal(actor) {
      const { organizationId } = await managedOrganization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account) throw new ORPCError("NOT_FOUND", { message: "No billing account" });
      const result = await provider.createPortal({
        customerId: account.customerId,
        returnUrl: returnUrl(actor),
      });
      await managedOrganization(actor);
      return result;
    },

    sync,

    async syncForActor(actor) {
      const { organizationId } = await organization(actor);
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (account) await sync(account.customerId);
    },

    async syncSeats(organizationId) {
      const account = await billingAccountForOrganization(prisma, organizationId);
      if (!account?.subscriptionItemId) return;
      const seats = await organizationSeatCount(prisma, organizationId);
      if (account.seats === seats) return;
      await provider.updateSeats(account.subscriptionItemId, seats);
      await sync(account.customerId);
    },

    async cancelForDeletedUser(userId) {
      for (const account of await ownedBillingAccounts(prisma, userId)) {
        await provider.cancelCustomerSubscriptions(account.customerId);
        await sync(account.customerId);
      }
    },
  };
}
