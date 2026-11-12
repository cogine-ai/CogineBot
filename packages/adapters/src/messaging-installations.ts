import { randomBytes, randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
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
type Provider = Pick<SlackInstallProvider, "authorizeUrl" | "exchange">;

export class MessagingInstallations {
  constructor(
    private readonly db: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly provider: Provider,
  ) {}

  async start(actor: Actor, botId: string, reconnect?: Revision) {
    return runAsSystem("start Slack workspace authorization", async () => {
      const scope = { userId: actor.userId, spaceId: actor.spaceId, botId };
      await this.requireOwner(this.db, scope);
      const target = reconnect ? await this.owned(this.db, actor, reconnect) : null;
      if (target && target.botId !== botId) throw new Error("Select the connected bot");
      const state = randomBytes(32).toString("base64url");
      const id = credentialDigest(state);
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await this.db.messagingInstallSession.create({
        data: {
          id,
          provider: PROVIDER,
          ...scope,
          expiresAt,
          installationId: target?.id,
          expectedRevision: target?.revision,
        },
      });
      return {
        url: this.provider.authorizeUrl(state),
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

  async complete(userId: string, state: string, code: string | undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || (code?.length ?? 0) > 4096)
      throw new Error("Invalid Slack authorization");
    return runAsSystem("complete Slack workspace authorization", async () => {
      const id = credentialDigest(state);
      const session = await this.db.messagingInstallSession.findUnique({ where: { id } });
      if (!session || session.provider !== PROVIDER || session.userId !== userId)
        throw new Error("Invalid Slack authorization");
      const claimedAt = new Date();
      const claimed = await this.db.messagingInstallSession.updateMany({
        where: { id, userId, consumedAt: null, expiresAt: { gt: claimedAt } },
        data: { consumedAt: claimedAt },
      });
      if (claimed.count !== 1) throw new Error("Slack authorization expired");
      if (!code) return false;
      await this.requireOwner(this.db, session);
      const external = await this.provider.exchange(code);
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
          const consume = await tx.messagingInstallSession.deleteMany({
            where: { id, consumedAt: claimedAt, expiresAt: { gt: new Date() } },
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
            workspaceId: external.workspaceId,
            workspaceName: external.workspaceName,
            installerId: external.installerId,
            providerBotId: external.providerBotId,
            userId: session.userId,
            spaceId: session.spaceId,
            botId: session.botId,
            ciphertext: sealed.ciphertext,
            credentialId,
            authorizedAt: at,
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
        { isolationLevel: "Serializable" },
      );
      return true;
    });
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
        select: { id: true, botId: true, workspaceName: true, revision: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      return rows;
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

  revoke(workspaceId: string, eventAt: Date, revokedBots?: string[]) {
    return runAsSystem("revoke Slack installation from a verified event", () =>
      this.db.$transaction(async (tx) => {
        const row = await tx.messagingInstallation.findUnique({
          where: { provider_workspaceId: { provider: PROVIDER, workspaceId } },
        });
        if (
          row?.ciphertext &&
          eventAt >= row.authorizedAt &&
          (!revokedBots || revokedBots.includes(row.providerBotId))
        )
          await this.disconnect(tx, row, "revoked");
      }),
    );
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

  async cleanup() {
    return runAsSystem("recover Slack credential cleanup", async () => {
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

  private async active(where: Prisma.MessagingInstallationWhereUniqueInput) {
    return runAsSystem("resolve an active Slack installation", async () => {
      const row = await this.db.messagingInstallation.findUnique({ where });
      if (row?.status !== "active" || !row.ciphertext) return null;
      return (await this.hasOwner(this.db, row)) ? row : null;
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

  private async hasOwner(tx: Db, scope: Scope) {
    const [bot, member] = await Promise.all([
      tx.bot.findFirst({
        where: { id: scope.botId, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
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
