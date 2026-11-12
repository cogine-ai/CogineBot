import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { credentialDigest } from "./credential-digest.js";
import { MessagingInstallations } from "./messaging-installations.js";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const integration =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

integration("Slack workspace installation lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let org: string;
  let owner: Actor;
  let other: Actor;
  let botId: string;
  let otherBotId: string;
  const scope = { id: randomUUID() };
  const workspaceId = `T${scope.id.replaceAll("-", "").toUpperCase()}`;
  const store = new EncryptedSecretStore("synthetic-workspace-key");
  const authorizeUrl = (state: string) => `https://slack.com/oauth/v2/authorize?state=${state}`;
  const exchange = vi.fn(async (code: string) => ({
    workspaceId,
    workspaceName: "Fixture Workspace",
    installerId: "UOWNER",
    providerBotId: "UBOT",
    credential: `fixture-secret-${code}`,
  }));
  let service: MessagingInstallations;

  async function createOwner() {
    const userId = randomUUID();
    const spaceId = randomUUID();
    const email = `${userId}@example.test`;
    await db.prisma.user.create({ data: { id: userId, name: "Fixture", email } });
    await db.prisma.space.create({ data: { id: spaceId, name: "Fixture", organizationId: org } });
    await db.prisma.member.create({
      data: { id: randomUUID(), organizationId: org, userId, role: "owner", createdAt: new Date() },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId: org,
        spaceId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await db.prisma.bot.create({
      data: { userId, spaceId, name: "Fixture Bot", color: "slate" },
    });
    return { actor: { userId, spaceId, email, isDeploymentOwner: false }, botId: bot.id };
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    org = randomUUID();
    await db.prisma.organization.create({
      data: { id: org, name: "Fixture", slug: org, createdAt: new Date() },
    });
    ({ actor: owner, botId } = await createOwner());
    ({ actor: other, botId: otherBotId } = await createOwner());
    service = new MessagingInstallations(db.prisma, store, { authorizeUrl, exchange });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.messagingInstallSession.deleteMany({
        where: { userId: { in: [owner?.userId, other?.userId].filter(Boolean) } },
      });
      const workspace = await db.prisma.messagingInstallation.findFirst({ where: { workspaceId } });
      if (workspace?.credentialId)
        await db.prisma.messagingCredentialCleanup.deleteMany({
          where: { id: workspace.credentialId },
        });
      await db.prisma.messagingInstallation.deleteMany({ where: { workspaceId } });
      if (org) await db.prisma.organization.deleteMany({ where: { id: org } });
      await db.prisma.user.deleteMany({
        where: { id: { in: [owner?.userId, other?.userId].filter(Boolean) } },
      });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function start(
    actor = owner,
    chosen = botId,
    reconnect?: { id: string; expectedRevision: number },
  ) {
    const result = await service.start(actor, chosen, reconnect);
    return { ...result, state: new URL(result.url).searchParams.get("state")! };
  }

  it("binds the state to its initiator, Space and bot, and consumes it once", async () => {
    await expect(start(owner, otherBotId)).rejects.toThrow("Bot or Space is unavailable");
    const attempt = await start();
    const saved = await db.prisma.messagingInstallSession.findUniqueOrThrow({
      where: { id: attempt.attemptId },
    });
    expect(saved).toMatchObject({
      id: credentialDigest(attempt.state),
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId,
    });
    expect(saved.id).not.toBe(attempt.state);
    expect(saved.expiresAt.getTime() - saved.createdAt.getTime()).toBeGreaterThan(599_000);
    await expect(service.complete(other.userId, attempt.state, "forwarded")).rejects.toThrow(
      "Invalid Slack authorization",
    );
    const completed = await Promise.allSettled([
      service.complete(owner.userId, attempt.state, "first"),
      service.complete(owner.userId, attempt.state, "duplicate"),
    ]);
    expect(completed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    await expect(service.attempt(owner, attempt.attemptId)).resolves.toBe("connected");
    await expect(service.attempt(other, attempt.attemptId)).resolves.toBe("expired");
    const row = await service.activeByWorkspace(workspaceId);
    expect(row).toMatchObject({ botId, userId: owner.userId, installerId: "UOWNER" });
    expect(row?.ciphertext).not.toContain("fixture-secret");
    expect(await service.list(other)).toEqual([]);
  });

  it("rejects cancelled and expired callbacks before the provider exchange", async () => {
    const calls = exchange.mock.calls.length;
    const cancelled = await start();
    await service.cancel(owner, cancelled.attemptId);
    await expect(service.complete(owner.userId, cancelled.state, "cancelled")).rejects.toThrow();
    const expired = await start();
    await db.prisma.messagingInstallSession.update({
      where: { id: expired.attemptId },
      data: { expiresAt: new Date(0) },
    });
    await expect(service.complete(owner.userId, expired.state, "expired")).rejects.toThrow(
      "Slack authorization expired",
    );
    expect(exchange).toHaveBeenCalledTimes(calls);
  });

  it("keeps an exclusive workspace binding and refuses stale reconnect revisions", async () => {
    const before = (await service.list(owner))[0]!;
    const foreign = await start(other, otherBotId);
    await expect(service.complete(other.userId, foreign.state, "foreign")).rejects.toThrow(
      "already connected",
    );
    const stale = await start(owner, botId, { id: before.id, expectedRevision: before.revision });
    await service.pause(owner, { id: before.id, expectedRevision: before.revision, paused: true });
    expect(await service.activeById(before.id)).toBeNull();
    await expect(service.complete(owner.userId, stale.state, "stale")).rejects.toThrow(
      "connection changed",
    );
    const paused = (await service.list(owner))[0]!;
    await service.pause(owner, { id: paused.id, expectedRevision: paused.revision, paused: false });
    expect((await service.activeById(paused.id))?.acceptAfter.getTime()).toBeGreaterThanOrEqual(
      Date.now() - 2_000,
    );
  });

  it("checks membership again after exchange before adopting a credential", async () => {
    const row = (await service.list(owner))[0]!;
    const attempt = await start(owner, botId, { id: row.id, expectedRevision: row.revision });
    exchange.mockImplementationOnce(async () => {
      await db.prisma.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
      return {
        workspaceId,
        workspaceName: "Fixture",
        installerId: "UOWNER",
        providerBotId: "UBOT",
        credential: "fixture-archived",
      };
    });
    await expect(service.complete(owner.userId, attempt.state, "archived")).rejects.toThrow(
      "Bot or Space is unavailable",
    );
    expect(await service.activeById(row.id)).toBeNull();
    await db.prisma.bot.update({ where: { id: botId }, data: { archivedAt: null } });
    expect((await service.activeById(row.id))?.revision).toBe(row.revision);
  });

  it("revokes only the current bot grant and removes access before cleanup", async () => {
    const before = (await service.activeByWorkspace(workspaceId))!;
    await service.revoke(workspaceId, new Date(0), [before.providerBotId]);
    await service.revoke(workspaceId, new Date(), ["UOTHER"]);
    expect(await service.activeById(before.id)).not.toBeNull();
    const sameSecond = new Date(Math.floor(before.authorizedAt.getTime() / 1000) * 1000);
    await service.revoke(workspaceId, sameSecond, [before.providerBotId], false);
    expect(await service.activeById(before.id)).toBeNull();
    const revoked = (await service.list(owner))[0]!;
    expect(revoked.status).toBe("revoked");
    expect(
      await db.prisma.messagingCredentialCleanup.findUnique({
        where: { id: before.credentialId! },
      }),
    ).toMatchObject({
      pendingWrite: false,
    });
    const failedDelete = vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("offline"));
    try {
      await service.cleanup();
      const retry = await db.prisma.messagingCredentialCleanup.findUniqueOrThrow({
        where: { id: before.credentialId! },
      });
      expect(retry.attempts).toBe(1);
      await db.prisma.messagingCredentialCleanup.update({
        where: { id: retry.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await new MessagingInstallations(db.prisma, store).cleanup();
      expect(
        await db.prisma.messagingCredentialCleanup.findUnique({
          where: { id: before.credentialId! },
        }),
      ).toBeNull();
    } finally {
      failedDelete.mockRestore();
    }
    await service.remove(owner, { id: revoked.id, expectedRevision: revoked.revision });
    expect(await service.list(owner)).toEqual([]);
  });
  it("releases a workspace after its owner loses membership and a later owner authorizes it", async () => {
    const attempt = await start();
    await expect(service.complete(owner.userId, attempt.state, "renewed")).resolves.toBe(true);
    const original = (await service.activeByWorkspace(workspaceId))!;
    await db.prisma.spaceMember.deleteMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
    });
    expect(await service.activeByWorkspace(workspaceId)).toBeNull();
    await new MessagingInstallations(db.prisma, store).cleanup();
    const released = await db.prisma.messagingInstallation.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(released).toMatchObject({ status: "removed", ciphertext: null });
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(released.acceptAfter.getTime()));
    const successor = await start(other, otherBotId);
    await expect(service.complete(other.userId, successor.state, "successor")).resolves.toBe(true);
    expect(await service.activeByWorkspace(workspaceId)).toMatchObject({
      userId: other.userId,
      botId: otherBotId,
    });
    expect(await service.activeById(original.id)).toBeNull();
  });
});
