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
  const stagedCredentials = new Set<string>();
  const authorizeUrl = (state: string) => `https://slack.com/oauth/v2/authorize?state=${state}`;
  const exchange = vi.fn(async (code: string) => ({
    workspaceId,
    appId: "AFIXTURE",
    workspaceName: "Fixture Workspace",
    installerId: "UOWNER",
    providerBotId: "UBOT",
    credential: `fixture-secret-${code}`,
  }));
  const verifyGrant = vi.fn(async () => true);
  const provider = { authorizeUrl, exchange, clientId: "fixture-client", verifyGrant };
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
    const prepareWrite = store.prepareWrite.bind(store);
    vi.spyOn(store, "prepareWrite").mockImplementation((id) => {
      stagedCredentials.add(id);
      return prepareWrite(id);
    });
    db = createDb(databaseUrl!);
    org = randomUUID();
    await db.prisma.organization.create({
      data: { id: org, name: "Fixture", slug: org, createdAt: new Date() },
    });
    ({ actor: owner, botId } = await createOwner());
    ({ actor: other, botId: otherBotId } = await createOwner());
    service = new MessagingInstallations(db.prisma, store, provider);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.messagingInstallSession.deleteMany({
        where: { userId: { in: [owner?.userId, other?.userId].filter(Boolean) } },
      });
      await db.prisma.messagingCredentialCleanup.deleteMany({
        where: { id: { in: [...stagedCredentials] } },
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
    const changedApp = new MessagingInstallations(db.prisma, store, {
      ...provider,
      clientId: "replacement-app",
    });
    expect(await changedApp.activeByWorkspace(workspaceId)).toBeNull();
    expect((await changedApp.list(owner))[0]?.status).toBe("revoked");
  });

  it("keeps native callbacks bound to the initiating authenticated user and Space", async () => {
    const before = await service.activeByWorkspace(workspaceId);
    const issued = await service.start(
      owner,
      botId,
      { id: before!.id, expectedRevision: before!.revision },
      "mobile",
    );
    const state = new URL(issued.url).searchParams.get("state")!;
    expect(state).toMatch(/^m\.[A-Za-z0-9_-]{43}$/);
    const url = new URL((await service.mobileCallback(state, "native-code"))!);
    expect(url.protocol).toBe("coginebot:");
    expect(url.host).toBe("slack-workspaces");
    expect(url.searchParams.get("state")).toBe(state);
    const calls = exchange.mock.calls.length;
    await expect(service.completeMobile(other, state, "native-code")).rejects.toThrow();
    await expect(
      service.completeMobile({ ...owner, spaceId: other.spaceId }, state, "native-code"),
    ).rejects.toThrow();
    expect(exchange).toHaveBeenCalledTimes(calls);
    await expect(service.completeMobile(owner, state, "native-code")).resolves.toBe(true);
    await expect(service.completeMobile(owner, state, "replayed")).rejects.toThrow();
    expect(exchange).toHaveBeenCalledTimes(calls + 1);
    expect(await service.attempt(owner, issued.attemptId)).toBe("connected");
    expect(await service.mobileCallback(state, "replayed")).toBeNull();
    // Retire this test's replaced credential before later cleanup-failure assertions.
    await service.cleanup();
  });

  it("cannot relabel a Web attempt as native and handles native cancellation without exchange", async () => {
    const web = await start();
    expect(await service.mobileCallback(`m.${web.state}`, "code")).toBeNull();
    await expect(service.completeMobile(owner, web.state, "code")).rejects.toThrow();
    const native = await service.start(owner, botId, undefined, "mobile");
    const state = new URL(native.url).searchParams.get("state")!;
    const calls = exchange.mock.calls.length;
    expect(
      new URL((await service.mobileCallback(state, undefined))!).searchParams.has("code"),
    ).toBe(false);
    await expect(service.completeMobile(owner, state, undefined)).resolves.toBe(false);
    expect(exchange).toHaveBeenCalledTimes(calls);
    expect(await service.attempt(owner, native.attemptId)).toBe("cancelled");
    await service.cancel(owner, web.attemptId);
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

  it("applies a signed revocation that arrives while the first grant is being adopted", async () => {
    const firstWorkspace = `T${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const attempt = await start();
    exchange.mockResolvedValueOnce({
      workspaceId: firstWorkspace,
      appId: "AFIXTURE",
      workspaceName: "Concurrent fixture",
      installerId: "UOWNER",
      providerBotId: "UBOT",
      credential: "fixture-concurrent",
    });
    let entered!: () => void;
    let finishCheck!: (active: boolean) => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const check = new Promise<boolean>((resolve) => {
      finishCheck = resolve;
    });
    verifyGrant
      .mockImplementationOnce(async () => {
        entered();
        return check;
      })
      .mockResolvedValueOnce(false);
    const completed = service.complete(owner.userId, attempt.state, "concurrent");
    let revoking: Promise<void> | undefined;
    let cleanupId: string | undefined;
    try {
      expect(await Promise.race([checking, completed])).toBeUndefined();
      cleanupId = [...stagedCredentials].at(-1);
      revoking = service.revoke({
        workspaceId: firstWorkspace,
        appId: "AFIXTURE",
        at: new Date(),
        precise: true,
      });
      await vi.waitFor(async () => {
        const locks = await db.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting",
        );
        expect(locks.rows[0]?.waiting).toBe(true);
      });
      finishCheck(true);
      await expect(completed).resolves.toBe(true);
      await revoking;
      expect(await service.activeByWorkspace(firstWorkspace)).toBeNull();
      expect(
        await db.prisma.messagingInstallation.findFirst({
          where: { workspaceId: firstWorkspace },
        }),
      ).toMatchObject({ status: "revoked", ciphertext: null });
    } finally {
      finishCheck(true);
      await Promise.allSettled([completed, revoking]);
      await db.prisma.messagingInstallation.deleteMany({ where: { workspaceId: firstWorkspace } });
      if (cleanupId)
        await db.prisma.messagingCredentialCleanup.deleteMany({ where: { id: cleanupId } });
    }
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
        appId: "AFIXTURE",
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

  it("does not adopt a grant revoked while its credential was being written", async () => {
    const before = (await service.activeByWorkspace(workspaceId))!;
    const attempt = await start(owner, botId, { id: before.id, expectedRevision: before.revision });
    verifyGrant.mockResolvedValueOnce(false);
    await expect(
      service.complete(owner.userId, attempt.state, "revoked-during-write"),
    ).rejects.toThrow("authorization is no longer active");
    expect(await service.attempt(owner, attempt.attemptId)).toBe("failed");
    expect(await service.activeByWorkspace(workspaceId)).toMatchObject({
      revision: before.revision,
    });
    expect(
      await db.prisma.messagingCredentialCleanup.findFirst({
        where: { id: [...stagedCredentials].at(-1), pendingWrite: true },
      }),
    ).not.toBeNull();
  });

  it("revokes only the current bot grant and removes access before cleanup", async () => {
    const before = (await service.activeByWorkspace(workspaceId))!;
    const baseEvent = {
      workspaceId,
      appId: before.appId,
      botUsers: [before.providerBotId],
      precise: true,
    };
    await service.revoke({ ...baseEvent, at: new Date(0) });
    await service.revoke({ ...baseEvent, at: new Date(), botUsers: ["UOTHER"] });
    expect(await service.activeById(before.id)).not.toBeNull();
    const sameSecond = new Date(Math.floor(before.authorizedAt.getTime() / 1000) * 1000);
    verifyGrant.mockResolvedValueOnce(true);
    await service.revoke({ ...baseEvent, at: sameSecond, precise: false });
    expect(await service.activeById(before.id)).not.toBeNull();
    verifyGrant.mockResolvedValueOnce(false);
    await service.revoke({ ...baseEvent, at: sameSecond, precise: false });
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
