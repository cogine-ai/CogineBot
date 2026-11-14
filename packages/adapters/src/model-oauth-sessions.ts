import { setTimeout as delay } from "node:timers/promises";
import type { ModelCredential } from "@rakazo/contracts";
import { ModelCredentialSchema } from "@rakazo/contracts";
import {
  newestModelCredentialOrder,
  Prisma,
  type PrismaClient,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";

export type ModelOAuthActor = { userId: string; spaceId: string };
export type ModelOAuthRef = ModelOAuthActor & { id: string };
export type ModelOAuthLease = ModelOAuthRef & { leaseOwner: string };
export type ModelOAuthProvider = { userId: string; provider: string };

export const MODEL_OAUTH_LEASE_RENEW_MS = 10_000;
const LEASE_MS = 30_000;
const RESULT_TTL_MS = 60 * 60_000;

export const MODEL_OAUTH_NOT_FOUND = "Sign-in session not found. Start sign-in again.";
export const MODEL_OAUTH_INTERRUPTED = "Sign-in was interrupted. Start sign-in again.";
const FAILED = "Subscription sign-in failed. Start sign-in again.";

export class ModelOAuthSaveInProgress extends Error {}

/** Poll only while another process has a live save claim; never hold its locks while waiting. */
export async function waitForModelOAuthSave<T>(operation: () => Promise<T>, signal?: AbortSignal) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ModelOAuthSaveInProgress) || Date.now() >= deadline) throw error;
      await delay(100, undefined, { signal });
    }
  }
}

/** Model credentials are account-wide. This lock also exists before the first credential row. */
export async function lockModelOAuthProvider(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  { userId, provider }: ModelOAuthProvider,
) {
  const key = JSON.stringify(["model-oauth-provider", userId, provider]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

function leaseEnd() {
  return new Date(Date.now() + LEASE_MS);
}

function resultExpiry() {
  return new Date(Date.now() + RESULT_TTL_MS);
}

function rowOf({ id, userId, spaceId }: ModelOAuthRef) {
  return { id, userId, spaceId };
}

function ownedLease({ id, userId, spaceId, leaseOwner }: ModelOAuthLease) {
  return { id, userId, spaceId, leaseOwner, leaseExpiresAt: { gt: new Date() } };
}

const cleared = {
  leaseOwner: null,
  leaseExpiresAt: null,
  handoffCiphertext: null,
};

export class ModelOAuthSessions {
  constructor(private readonly prisma: PrismaClient) {}

  /** Bound the maintenance work a shutdown drains, including time spent waiting
   * for a table or row lock. The settings do not affect credential saves. */
  private maintenance<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        return operation(tx);
      },
      { maxWait: 1_000, timeout: 3_000 },
    );
  }

  private async lockLeaseRow(tx: Prisma.TransactionClient, ref: ModelOAuthLease) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cogine_model_auth.model_oauth_sessions
      WHERE id = ${ref.id} AND "userId" = ${ref.userId} AND "spaceId" = ${ref.spaceId}
        AND "leaseOwner" = ${ref.leaseOwner} FOR UPDATE
    `;
    return rows.length === 1;
  }

  async clearExpired(): Promise<void> {
    await runAsSystem("expire model sign-in state and encrypted handoffs", () =>
      this.maintenance(
        (tx) => tx.$executeRaw`
        WITH expired AS (
          SELECT id FROM cogine_model_auth.model_oauth_sessions
          WHERE "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          ORDER BY "expiresAt" LIMIT 500 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM cogine_model_auth.model_oauth_sessions s USING expired WHERE s.id = expired.id
      `,
      ),
    );
  }

  async register(
    input: ModelOAuthRef &
      ModelOAuthProvider & {
        modelId?: string;
        thinkingLevel?: string | null;
        label?: string;
        leaseOwner?: string;
        expiresAt: Date;
      },
  ) {
    return runAsTenant(input, () =>
      this.prisma.$transaction(
        async (tx) => {
          await lockModelOAuthProvider(tx, input);
          const scope = { userId: input.userId, spaceId: input.spaceId, provider: input.provider };
          const current = await tx.userModelCredential.findFirst({
            where: { userId: input.userId, provider: input.provider },
            orderBy: newestModelCredentialOrder,
            select: { id: true, connectionRevision: true },
          });
          await tx.modelOAuthSession.deleteMany({
            where: { ...scope, expiresAt: { lte: new Date() } },
          });
          await this.cancelBeforeSave(tx, { ...scope, status: { in: ["pending", "saving"] } });
          return tx.modelOAuthSession.create({
            data: {
              ...input,
              hasThinkingLevel: input.thinkingLevel !== undefined,
              leaseExpiresAt: input.leaseOwner ? leaseEnd() : null,
              credentialId: current?.id,
              credentialRevision: current?.connectionRevision,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      ),
    );
  }

  /** Read the durable record even on the server that originally started the login. */
  async read(ref: ModelOAuthRef) {
    return runAsTenant(ref, () =>
      this.prisma.modelOAuthSession.findFirst({
        where: { ...rowOf(ref), expiresAt: { gt: new Date() } },
      }),
    );
  }

  async publishHandoff(ref: ModelOAuthLease, handoffCiphertext: string): Promise<boolean> {
    return runAsTenant(ref, async () => {
      const published = await this.prisma.modelOAuthSession.updateMany({
        where: { ...ownedLease(ref), status: "pending", expiresAt: { gt: new Date() } },
        data: { ...cleared, handoffCiphertext },
      });
      return published.count === 1;
    });
  }

  async setProviderExpiry(ref: ModelOAuthLease, expiresAt: Date) {
    return runAsTenant(ref, () =>
      this.prisma.modelOAuthSession.updateMany({
        where: { ...ownedLease(ref), status: "pending", expiresAt: { gt: expiresAt } },
        data: { expiresAt },
      }),
    );
  }

  async consume(ref: ModelOAuthRef, status: "connected" | "failed") {
    return runAsTenant(ref, async () => {
      const consumed = await this.prisma.modelOAuthSession.deleteMany({
        where: { ...rowOf(ref), status, expiresAt: { gt: new Date() } },
      });
      return consumed.count === 1;
    });
  }

  async claimExchange(ref: ModelOAuthRef, leaseOwner: string): Promise<boolean> {
    return runAsTenant(ref, async () => {
      const result = await this.prisma.modelOAuthSession.updateMany({
        where: {
          ...rowOf(ref),
          status: "pending",
          leaseOwner: null,
          handoffCiphertext: { not: null },
          expiresAt: { gt: new Date() },
        },
        data: { handoffCiphertext: null, leaseOwner, leaseExpiresAt: leaseEnd() },
      });
      return result.count === 1;
    });
  }

  async renew(ref: ModelOAuthLease): Promise<boolean> {
    return runAsTenant(ref, async () => {
      const result = await this.maintenance(async (tx) => {
        // Acquire the row before checking the deadline. A heartbeat queued
        // before expiry must not revive the lease after the lock is released.
        if (!(await this.lockLeaseRow(tx, ref))) return { count: 0 };
        return tx.modelOAuthSession.updateMany({
          where: {
            ...ownedLease(ref),
            status: { in: ["pending", "saving"] },
            expiresAt: { gt: new Date() },
          },
          data: { leaseExpiresAt: leaseEnd() },
        });
      });
      return result.count === 1;
    });
  }

  async markSaving(ref: ModelOAuthLease & ModelOAuthProvider): Promise<boolean> {
    return runAsTenant(ref, () =>
      this.prisma.$transaction(
        async (tx) => {
          await lockModelOAuthProvider(tx, ref);
          if (!(await this.lockLeaseRow(tx, ref))) return false;
          const result = await tx.modelOAuthSession.updateMany({
            where: {
              ...ownedLease(ref),
              provider: ref.provider,
              status: "pending",
              expiresAt: { gt: new Date() },
            },
            data: { status: "saving", leaseExpiresAt: leaseEnd(), expiresAt: resultExpiry() },
          });
          return result.count === 1;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      ),
    );
  }

  async fail(ref: ModelOAuthLease, error = FAILED) {
    await runAsTenant(ref, () =>
      this.maintenance((tx) =>
        tx.modelOAuthSession.updateMany({
          where: {
            id: ref.id,
            userId: ref.userId,
            spaceId: ref.spaceId,
            leaseOwner: ref.leaseOwner,
            status: { in: ["pending", "saving"] },
          },
          data: { ...cleared, status: "failed", error, expiresAt: resultExpiry() },
        }),
      ),
    );
  }

  /** Once written, the receipt and credential commit together. Any late or cancelled
   * owner must roll back its credential transaction rather than publish a result. */
  async recordConnected(
    tx: Prisma.TransactionClient,
    ref: ModelOAuthLease,
    result: ModelCredential,
  ) {
    const saved = await tx.modelOAuthSession.updateMany({
      where: { ...ownedLease(ref), status: "saving", expiresAt: { gt: new Date() } },
      data: {
        ...cleared,
        status: "connected",
        result: ModelCredentialSchema.parse(result),
        credentialId: result.id,
        credentialRevision: result.connectionRevision,
        expiresAt: resultExpiry(),
      },
    });
    if (saved.count !== 1) throw new Error(MODEL_OAUTH_INTERRUPTED);
  }

  private async assertActiveSpace(tx: Prisma.TransactionClient, ref: ModelOAuthLease) {
    const spaces = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM spaces WHERE id = ${ref.spaceId} AND "deletingAt" IS NULL FOR SHARE
    `;
    if (spaces.length !== 1) throw new Error(MODEL_OAUTH_INTERRUPTED);
    const members = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM space_members
      WHERE "spaceId" = ${ref.spaceId} AND "userId" = ${ref.userId} FOR KEY SHARE
    `;
    if (members.length !== 1) throw new Error(MODEL_OAUTH_INTERRUPTED);
  }

  async assertSaving(tx: Prisma.TransactionClient, ref: ModelOAuthLease) {
    await this.assertActiveSpace(tx, ref);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM cogine_model_auth.model_oauth_sessions
      WHERE id = ${ref.id} AND "userId" = ${ref.userId} AND "spaceId" = ${ref.spaceId}
        AND status = 'saving' AND "leaseOwner" = ${ref.leaseOwner}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error(MODEL_OAUTH_INTERRUPTED);
  }

  async assertPending(tx: Prisma.TransactionClient, ref: ModelOAuthLease) {
    await this.assertActiveSpace(tx, ref);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM cogine_model_auth.model_oauth_sessions
      WHERE id = ${ref.id} AND "userId" = ${ref.userId} AND "spaceId" = ${ref.spaceId}
        AND status = 'pending' AND "leaseOwner" = ${ref.leaseOwner}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE
    `;
    if (rows.length !== 1) throw new Error(MODEL_OAUTH_INTERRUPTED);
  }

  async cancel(ref: ModelOAuthRef) {
    return runAsTenant(ref, () =>
      this.prisma.$transaction(
        async (tx) => {
          const row = await tx.modelOAuthSession.findFirst({
            where: rowOf(ref),
            select: { provider: true },
          });
          if (!row) return;
          await lockModelOAuthProvider(tx, { ...ref, provider: row.provider });
          await this.cancelBeforeSave(tx, { ...rowOf(ref), status: { in: ["pending", "saving"] } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      ),
    );
  }

  /** In the disconnect transaction, after taking the provider lock and validating
   * the credential, retire the corresponding login attempts across Spaces. */
  async cancelBeforeSave(tx: Prisma.TransactionClient, scope: Prisma.ModelOAuthSessionWhereInput) {
    // First write/lock all matching sessions. If an already claimed save exists,
    // rollback and let the caller wait outside its transaction and credential locks.
    const now = new Date();
    await tx.modelOAuthSession.updateMany({
      where: {
        AND: [
          scope,
          {
            OR: [
              { status: { not: "saving" } },
              { leaseExpiresAt: { lte: now } },
              { expiresAt: { lte: now } },
            ],
          },
        ],
      },
      data: {
        ...cleared,
        status: "failed",
        result: Prisma.DbNull,
        error: MODEL_OAUTH_INTERRUPTED,
        expiresAt: resultExpiry(),
      },
    });
    if (
      await tx.modelOAuthSession.findFirst({
        where: {
          AND: [scope, { status: "saving", leaseExpiresAt: { gt: now }, expiresAt: { gt: now } }],
        },
        select: { id: true },
      })
    )
      throw new ModelOAuthSaveInProgress();
  }
}
