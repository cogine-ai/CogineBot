import { randomBytes, randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { credentialDigest } from "./credential-digest.js";
import { reconcileSecretWrite } from "./secret-store-factory.js";
import type { SlackInstallProvider } from "./slack-install-provider.js";

const PROVIDER = "slack";
const SESSION_TTL_MS = 10 * 60_000;
const CLEANUP_LEASE_MS = 5 * 60_000;
const MAX_CLEANUP_ATTEMPTS = 20;

type Scope = Pick<Actor, "userId" | "spaceId"> & { botId: string };
type Revision = { id: string; expectedRevision: number };
export type WorkspaceInstallation = NonNullable<
  Awaited<ReturnType<PrismaClient["messagingInstallation"]["findUnique"]>>
>;
type Db = Prisma.TransactionClient;
type Provider = Pick<
  SlackInstallProvider,
  "authorizeUrl" | "exchange" | "clientId" | "verifyGrant"
>;

export class MessagingInstallations {
  constructor(
    private readonly db: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly provider?: Provider,
  ) {}

  get available() {
    return Boolean(this.provider);
  }

  async start(actor: Actor, botId: string, reconnect?: Revision, returnTo?: "mobile") {
    const provider = this.provider;
    if (!provider) throw new Error("Slack installation is unavailable");
    return runAsSystem("start Slack workspace authorization", async () => {
      const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
      await this.requireOwner(this.db, scope);
      const target = reconnect ? await this.owned(this.db, actor, reconnect) : null;
      if (target && target.botId !== botId) throw new Error("Select the connected bot");
      const state = `${returnTo === "mobile" ? "m." : ""}${randomBytes(32).toString("base64url")}`;
      const id = credentialDigest(state);
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await this.db.messagingInstallSession.create({
        data: {
          id,
          provider: PROVIDER,
          clientId: provider.clientId,
          ...scope,
          expiresAt,
          installationId: target?.id,
          expectedRevision: target?.revision,
        },
      });
      return {
        url: provider.authorizeUrl(state),
        attemptId: id,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async cancel(actor: Actor, attemptId: string) {
    await runAsSystem("cancel Slack workspace authorization", () =>
      this.db.messagingInstallSession.deleteMany({
        where: { id: attemptId, provider: PROVIDER, userId: actor.userId, spaceId: actor.spaceId },
      }),
    );
  }

  /** The prefix is covered by the stored digest; it cannot convert a Web attempt to native. */
  async mobileCallback(state: string, code: string | undefined) {
    if (!/^m\.[A-Za-z0-9_-]{43}$/.test(state) || (code?.length ?? 0) > 4096) return null;
    return runAsSystem("resolve native Slack authorization callback", async () => {
      const row = await this.db.messagingInstallSession.findUnique({
        where: { id: credentialDigest(state) },
      });
      if (
        !row ||
        row.provider !== PROVIDER ||
        row.clientId !== this.provider?.clientId ||
        row.consumedAt ||
        row.expiresAt <= new Date()
      )
        return null;
      const url = new URL("coginebot://slack-workspaces");
      url.searchParams.set("state", state);
      if (code) url.searchParams.set("code", code);
      return url.href;
    });
  }

  /** Native completion requires the initiating App's authenticated user AND Space. */
  async completeMobile(actor: Actor, state: string, code: string | undefined) {
    if (!/^m\.[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid Slack authorization");
    const owned = await runAsSystem("verify native Slack authorization owner", () =>
      this.db.messagingInstallSession.findFirst({
        where: {
          id: credentialDigest(state),
          userId: actor.userId,
          spaceId: actor.spaceId,
          provider: PROVIDER,
        },
        select: { id: true },
      }),
    );
    if (!owned) throw new Error("Invalid Slack authorization");
    return this.complete(actor.userId, state, code);
  }

  async complete(userId: string, state: string, code: string | undefined) {
    const provider = this.provider;
    if (!provider) throw new Error("Slack installation is unavailable");
    if (!/^(?:m\.)?[A-Za-z0-9_-]{43}$/.test(state) || (code?.length ?? 0) > 4096)
      throw new Error("Invalid Slack authorization");
    return runAsSystem("complete Slack workspace authorization", async () => {
      const id = credentialDigest(state);
      const session = await this.db.messagingInstallSession.findUnique({ where: { id } });
      if (
        !session ||
        session.provider !== PROVIDER ||
        session.clientId !== provider.clientId ||
        session.userId !== userId
      )
        throw new Error("Invalid Slack authorization");
      const claimedAt = new Date();
      const claimed = await this.db.messagingInstallSession.updateMany({
        where: { id, userId, consumedAt: null, expiresAt: { gt: claimedAt } },
        data: { consumedAt: claimedAt },
      });
      if (claimed.count !== 1) throw new Error("Slack authorization expired");
      if (!code) {
        await this.db.messagingInstallSession.updateMany({
          where: { id, consumedAt: claimedAt },
          data: { outcome: "cancelled" },
        });
        return false;
      }
      try {
        await this.requireOwner(this.db, session);
        const authorizedAt = new Date();
        const external = await provider.exchange(code);
        const credentialId = randomUUID();
        const recoveryRef = this.secrets.prepareWrite?.(credentialId);
        if (!recoveryRef) throw new Error("Workspace credential storage is unavailable");
        const staged = await this.db.messagingCredentialCleanup.create({
          data: {
            id: credentialId,
            ref: recoveryRef,
            pendingWrite: true,
            nextAttemptAt: new Date(Date.now() + CLEANUP_LEASE_MS),
          },
        });
        const sealed = await this.secrets.put(
          external.credential,
          {
            operationId: credentialId,
            traceId: credentialId,
            spaceId: session.spaceId,
            userId,
            signal: AbortSignal.timeout(10_000),
          },
          { recordId: credentialId, recoveryRef },
        );
        await this.db.$transaction(
          async (tx) => {
            // Revocation must see this adoption or precede the live grant check.
            await this.lockWorkspace(tx, external.workspaceId);
            if (
              !(await provider.verifyGrant(
                external.credential,
                external.workspaceId,
                external.providerBotId,
              ))
            )
              throw new Error("Slack authorization is no longer active");
            const consume = await tx.messagingInstallSession.updateMany({
              where: { id, consumedAt: claimedAt, expiresAt: { gt: new Date() }, outcome: null },
              data: { outcome: "connected" },
            });
            if (consume.count !== 1) throw new Error("Slack authorization expired");
            await this.requireOwner(tx, session);
            const old = await tx.messagingInstallation.findUnique({
              where: {
                provider_workspaceId: { provider: PROVIDER, workspaceId: external.workspaceId },
              },
            });
            const at = new Date();
            const data = {
              provider: PROVIDER,
              appId: external.appId,
              clientId: provider.clientId,
              workspaceId: external.workspaceId,
              workspaceName: external.workspaceName,
              installerId: external.installerId,
              installerName: external.installerName ?? null,
              providerBotId: external.providerBotId,
              userId: session.userId,
              spaceId: session.spaceId,
              botId: session.botId,
              ciphertext: sealed.ciphertext,
              credentialId,
              authorizedAt,
              acceptAfter: at,
              status: "active",
            };
            if (session.installationId) {
              if (
                !old ||
                old.id !== session.installationId ||
                old.revision !== session.expectedRevision ||
                old.userId !== session.userId ||
                old.spaceId !== session.spaceId ||
                old.botId !== session.botId ||
                old.status === "removed"
              )
                throw new Error("Workspace connection changed");
              const updated = await tx.messagingInstallation.updateMany({
                where: { id: old.id, revision: old.revision, ciphertext: old.ciphertext },
                data: { ...data, revision: { increment: 1 } },
              });
              if (updated.count !== 1) throw new Error("Workspace connection changed");
              await this.retire(tx, old);
            } else if (old) {
              if (old.status !== "removed" || old.acceptAfter >= session.createdAt)
                throw new Error("Workspace is already connected");
              const updated = await tx.messagingInstallation.updateMany({
                where: { id: old.id, revision: old.revision, status: "removed" },
                data: { ...data, id: randomUUID(), revision: 1 },
              });
              if (updated.count !== 1) throw new Error("Workspace connection changed");
            } else {
              await tx.messagingInstallation.create({ data: { id: randomUUID(), ...data } });
            }
            const adopted = await tx.messagingCredentialCleanup.deleteMany({
              where: { id: credentialId, pendingWrite: true, nextAttemptAt: staged.nextAttemptAt },
            });
            if (adopted.count !== 1) throw new Error("Workspace credential write expired");
          },
          { isolationLevel: "Serializable", timeout: 15_000 },
        );
      } catch (error) {
        await this.db.messagingInstallSession.updateMany({
          where: { id, consumedAt: claimedAt, outcome: null },
          data: { outcome: "failed" },
        });
        throw error;
      }
      return true;
    });
  }

  async attempt(actor: Actor, id: string) {
    return runAsSystem("check a user's Slack authorization attempt", async () => {
      const row = await this.db.messagingInstallSession.findFirst({
        where: { id, provider: PROVIDER, userId: actor.userId, spaceId: actor.spaceId },
        select: { outcome: true, expiresAt: true },
      });
      if (row?.outcome === "connected" || row?.outcome === "cancelled" || row?.outcome === "failed")
        return row.outcome;
      return !row || row.expiresAt <= new Date() ? ("expired" as const) : ("pending" as const);
    });
  }

  async hasOwned(actor: Actor) {
    return runAsSystem("check owned Slack connections", async () =>
      Boolean(
        await this.db.messagingInstallation.findFirst({
          where: {
            provider: PROVIDER,
            userId: actor.userId,
            spaceId: actor.spaceId,
            status: { not: "removed" },
          },
          select: { id: true },
        }),
      ),
    );
  }

  async list(actor: Actor) {
    return runAsSystem("list owned Slack installations", async () => {
      const rows = await this.db.messagingInstallation.findMany({
        where: {
          provider: PROVIDER,
          userId: actor.userId,
          spaceId: actor.spaceId,
          status: { not: "removed" },
        },
        select: {
          id: true,
          botId: true,
          workspaceName: true,
          installerName: true,
          clientId: true,
          revision: true,
          status: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return Promise.all(
        rows.map(async ({ clientId, ...row }) => ({
          ...row,
          status: !(await this.hasOwner(this.db, {
            userId: actor.userId,
            spaceId: actor.spaceId,
            botId: row.botId,
          }))
            ? "unavailable"
            : this.provider && this.provider.clientId !== clientId
              ? "revoked"
              : row.status,
        })),
      );
    });
  }

  pause(actor: Actor, input: Revision & { paused: boolean }) {
    return runAsSystem("change Slack installation availability", async () => {
      const row = await this.owned(this.db, actor, input);
      await this.requireOwner(this.db, row);
      if (row.status !== "active" && row.status !== "paused")
        throw new Error("Reconnect Slack to change availability");
      const status = input.paused ? "paused" : "active";
      if (row.status === status) return;
      const changed = await this.db.messagingInstallation.updateMany({
        where: { id: row.id, revision: row.revision, ciphertext: row.ciphertext },
        data: { status, acceptAfter: new Date(), revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new Error("Workspace connection changed");
    });
  }

  remove(actor: Actor, input: Revision) {
    return runAsSystem("remove owned Slack installation", () =>
      this.db.$transaction(async (tx) => {
        const row = await this.owned(tx, actor, input);
        await this.disconnect(tx, row, "removed");
        await tx.messagingInstallSession.deleteMany({
          where: { userId: row.userId, spaceId: row.spaceId, botId: row.botId, provider: PROVIDER },
        });
      }),
    );
  }

  revoke(event: {
    workspaceId: string;
    appId: string;
    at: Date;
    precise: boolean;
    botUsers?: string[];
  }) {
    const provider = this.provider;
    if (!provider) return Promise.resolve();
    return runAsSystem("revoke Slack installation from a verified event", () =>
      this.db.$transaction(
        async (tx) => {
          await this.lockWorkspace(tx, event.workspaceId);
          const row = await tx.messagingInstallation.findUnique({
            where: { provider_workspaceId: { provider: PROVIDER, workspaceId: event.workspaceId } },
          });
          if (
            !row?.ciphertext ||
            row.appId !== event.appId ||
            row.clientId !== provider.clientId ||
            (event.botUsers && !event.botUsers.includes(row.providerBotId))
          )
            return;
          const cutoff = event.precise
            ? row.authorizedAt.getTime()
            : Math.floor(row.authorizedAt.getTime() / 1000) * 1000;
          if (event.at.getTime() < cutoff) return;
          // Events can occur during token exchange or storage. Whole-second events
          // can also overlap the previous grant during a reconnect.
          if (
            event.at <= row.acceptAfter &&
            (await provider.verifyGrant(
              await this.credential(row),
              row.workspaceId,
              row.providerBotId,
            ))
          )
            return;
          await this.disconnect(tx, row, "revoked");
        },
        { isolationLevel: "ReadCommitted", timeout: 20_000 },
      ),
    );
  }

  private async lockWorkspace(tx: Db, workspaceId: string) {
    await tx.$queryRaw`
      SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`slack-install:${workspaceId}`}, 0))
    `;
  }

  revokeRejectedCredential(installation: WorkspaceInstallation) {
    return runAsSystem("revoke a rejected Slack bot credential", () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.messagingInstallation.findUnique({
          where: { id: installation.id },
        });
        if (row?.revision === installation.revision && row.ciphertext === installation.ciphertext)
          await this.disconnect(tx, row, "revoked");
      }),
    );
  }

  activeByWorkspace(workspaceId: string) {
    return this.active({ provider_workspaceId: { provider: PROVIDER, workspaceId } });
  }

  activeById(id: string) {
    return this.active({ id });
  }

  async activeTargets() {
    return runAsSystem("resume Slack installations", () =>
      this.db.messagingInstallation.findMany({
        where: { provider: PROVIDER, status: "active" },
        select: { id: true, botId: true, spaceId: true, userId: true },
      }),
    );
  }

  async credential(row: WorkspaceInstallation) {
    if (!row.ciphertext || !row.credentialId)
      throw new Error("Workspace credential is unavailable");
    return this.secrets.load(row.ciphertext, {
      recordId: row.credentialId,
      signal: AbortSignal.timeout(10_000),
    });
  }

  async retryExhaustedCleanup(dryRun: boolean) {
    const where = { attempts: { gte: MAX_CLEANUP_ATTEMPTS } };
    return runAsSystem("rearm exhausted Slack credential cleanup", async () => {
      if (dryRun) return this.db.messagingCredentialCleanup.count({ where });
      const { count } = await this.db.messagingCredentialCleanup.updateMany({
        where,
        data: { attempts: 0, nextAttemptAt: new Date() },
      });
      await this.cleanup();
      return count;
    });
  }

  async cleanup() {
    return runAsSystem("recover Slack credential cleanup", async () => {
      await this.retireOrphaned();
      const now = new Date();
      await this.db.messagingInstallSession.deleteMany({ where: { expiresAt: { lt: now } } });
      const candidates = await this.db.messagingCredentialCleanup.findMany({
        where: { nextAttemptAt: { lte: now }, attempts: { lt: MAX_CLEANUP_ATTEMPTS } },
        orderBy: { nextAttemptAt: "asc" },
        take: 20,
      });
      for (const row of candidates) {
        const lease = new Date(Date.now() + CLEANUP_LEASE_MS);
        const locked = await this.db.messagingCredentialCleanup.updateMany({
          where: { id: row.id, nextAttemptAt: row.nextAttemptAt },
          data: { nextAttemptAt: lease, attempts: { increment: 1 } },
        });
        if (locked.count !== 1) continue;
        try {
          const result = row.pendingWrite
            ? await reconcileSecretWrite(this.secrets, row.ref, row.id)
            : { state: "found" as const, ref: row.ref };
          if (result.state === "unknown") throw new Error("Credential write could not be verified");
          if (result.state === "found") {
            const live = await this.db.messagingInstallation.findFirst({
              where: { OR: [{ credentialId: row.id }, { ciphertext: result.ref }] },
              select: { id: true },
            });
            if (!live)
              await this.secrets.delete(result.ref, {
                recordId: row.id,
                signal: AbortSignal.timeout(10_000),
              });
          }
          await this.db.messagingCredentialCleanup.deleteMany({
            where: { id: row.id, nextAttemptAt: lease },
          });
        } catch {
          if (row.attempts + 1 === MAX_CLEANUP_ATTEMPTS)
            getLogger().error("Slack credential cleanup exhausted its retries");
        }
      }
    });
  }

  private async retireOrphaned() {
    const candidates = await this.db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT i.id FROM public.messaging_installations i
        WHERE i.provider = ${PROVIDER} AND i.status <> 'removed'
          AND (
            NOT EXISTS (
              SELECT 1 FROM public.bots b WHERE b.id = i."botId"
                AND b."userId" = i."userId" AND b."spaceId" = i."spaceId"
            )
            OR NOT EXISTS (
              SELECT 1 FROM public.space_members m
                WHERE m."spaceId" = i."spaceId" AND m."userId" = i."userId"
            )
          )
        ORDER BY i.id LIMIT 20`,
    );
    for (const { id } of candidates) {
      await this.db.$transaction(
        async (tx) => {
          const row = await tx.messagingInstallation.findUnique({ where: { id } });
          if (!row || row.status === "removed" || (await this.hasOwner(tx, row, true))) return;
          await this.disconnect(tx, row, "removed");
          await tx.messagingInstallSession.deleteMany({
            where: {
              userId: row.userId,
              spaceId: row.spaceId,
              botId: row.botId,
              provider: PROVIDER,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    }
  }

  private async active(where: Prisma.MessagingInstallationWhereUniqueInput) {
    return runAsSystem("resolve an active Slack installation", async () => {
      const row = await this.db.messagingInstallation.findUnique({ where });
      if (row?.status !== "active" || !row.ciphertext || row.clientId !== this.provider?.clientId)
        return null;
      return (await this.hasOwner(this.db, row)) ? row : null;
    });
  }

  isCurrent(row: WorkspaceInstallation) {
    return runAsSystem("verify current Slack installation", async () => {
      const [result] = await this.db.$queryRaw<Array<{ active: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM public.messaging_installations i
          JOIN public.bots b ON b.id = i."botId"
          JOIN public.space_members m ON m."spaceId" = i."spaceId" AND m."userId" = i."userId"
          WHERE i.id = ${row.id} AND i.status = 'active'
            AND i.revision = ${row.revision} AND i.ciphertext = ${row.ciphertext}
            AND i."clientId" = ${this.provider?.clientId ?? null}
            AND b."spaceId" = i."spaceId" AND b."userId" = i."userId" AND b."archivedAt" IS NULL
        ) AS active
      `;
      return result?.active === true;
    });
  }

  private async owned(tx: Db, actor: Actor, input: Revision) {
    const row = await tx.messagingInstallation.findFirst({
      where: {
        id: input.id,
        revision: input.expectedRevision,
        provider: PROVIDER,
        userId: actor.userId,
        spaceId: actor.spaceId,
        status: { not: "removed" },
      },
    });
    if (!row) throw new Error("Workspace connection changed");
    return row;
  }

  private async hasOwner(tx: Db, scope: Scope, includeArchived = false) {
    const [bot, member] = await Promise.all([
      tx.bot.findFirst({
        where: {
          id: scope.botId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        select: { id: true },
      }),
      tx.spaceMember.findFirst({
        where: { spaceId: scope.spaceId, userId: scope.userId },
        select: { id: true },
      }),
    ]);
    return Boolean(bot && member);
  }

  private async requireOwner(tx: Db, scope: Scope) {
    if (!(await this.hasOwner(tx, scope))) throw new Error("Bot or Space is unavailable");
  }

  private async disconnect(tx: Db, row: WorkspaceInstallation, status: "removed" | "revoked") {
    const changed = await tx.messagingInstallation.updateMany({
      where: { id: row.id, revision: row.revision, ciphertext: row.ciphertext },
      data: {
        status,
        ciphertext: null,
        credentialId: null,
        acceptAfter: new Date(),
        revision: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new Error("Workspace connection changed");
    await this.retire(tx, row);
  }

  private async retire(tx: Db, row: WorkspaceInstallation) {
    if (!row.credentialId || !row.ciphertext) return;
    await tx.messagingCredentialCleanup.create({
      data: {
        id: row.credentialId,
        ref: row.ciphertext,
        pendingWrite: false,
        nextAttemptAt: new Date(),
      },
    });
  }
}
