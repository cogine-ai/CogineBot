import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import {
  createGroupRunTeardownRecovery,
  EncryptedSecretStore,
  LocalArtifactStore,
  withSecretPersistence,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  completeGroupRunTeardownProviderPhase,
  createDb,
  createGroupRepos,
  PAGE_SHARE_SECRET_KIND,
  provisionRuntimeRole,
  rlsBypassKey,
  runAsTenant,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../apps/api/src/app.js";
import { sessionCookieHeader } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;
const origin = "https://page-lifecycle.example.test";
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const scopeOf = ({ userId, spaceId }: Actor) => ({ userId, spaceId });
type Account = { actor: Actor; cookie: string };

postgres("Page links on terminal deletion (isolated PostgreSQL)", () => {
  const login = `page_deletion_${randomBytes(8).toString("hex")}`;
  const store = new EncryptedSecretStore("offline-page-lifecycle-fixture");
  const deleteRef = vi.spyOn(store, "delete");
  const leaseFailure = new SandboxRateLimitError();
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let handles: Awaited<ReturnType<typeof createApp>> | undefined;
  let grantRole: string | undefined;
  let runtimeUrl: string | undefined;
  let dataDir: string | undefined;
  let ownRoles = false;
  let failLeaseRunId: string | undefined;
  const admin = () => owner!.prisma;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw new Error("Page deletion tests require an explicitly isolated harness database");
    }
    owner = createDb(databaseUrl!);
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname=current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    const roles = await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
      [login, grantRole],
    ]);
    expect(roles.rowCount).toBe(0);
    ownRoles = true;
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { rowSecurity: true });
    await expect(verifyRuntimeDatabase(runtime.prisma)).resolves.toMatchObject({
      connectionEnforced: true,
    });
    const instrumented = runtime.prisma.$extends({
      query: {
        computerExecutionLease: {
          async updateMany({ args, query }) {
            const runIds = args.where?.runId;
            if (failLeaseRunId && runIds === failLeaseRunId) {
              // Lose the result of the lease write inside the final transaction.
              // The matching lease and the persisted work must roll back together.
              await query(args);
              throw leaseFailure;
            }
            if (
              failLeaseRunId &&
              typeof runIds === "object" &&
              Array.isArray(runIds.in) &&
              runIds.in.includes(failLeaseRunId)
            )
              throw leaseFailure;
            return query(args);
          },
        },
      },
    });
    dataDir = await mkdtemp(join(tmpdir(), "page-link-deletion-"));
    handles = await createApp({
      prisma: instrumented as typeof runtime.prisma,
      databaseUrl: runtimeUrl,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      secretStore: store,
      webOrigin: origin,
      authUrl: origin,
    });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await clean(async () => handles?.stop());
    await clean(async () => runtime?.prisma.$disconnect());
    await clean(async () => runtime?.pool.end());
    if (owner) {
      if (ownRoles) {
        if (runtimeUrl) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(runtimeUrl!)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${quoted(role)}`);
            await owner!.pool.query(`DROP ROLE ${quoted(role)}`);
          });
        }
      }
      await clean(() => owner!.prisma.$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (dataDir) await clean(() => rm(dataDir!, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, "Page deletion fixture cleanup failed");
  });

  async function raw(cookie: string, route: string, input: unknown, spaceId?: string) {
    return handles!.app.request(`/rpc/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(
    cookie: string,
    route: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const result = await raw(cookie, route, input, spaceId);
    const body = await result.json();
    expect(result.status, `${route} ${JSON.stringify(body)}`).toBe(200);
    return body.json as T;
  }
  async function account(name: string): Promise<Account> {
    const result = await handles!.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${randomUUID()}@example.test`,
        password: "offline-password-123",
        name,
      }),
    });
    expect(result.status).toBe(200);
    const cookie = sessionCookieHeader(result);
    return { cookie, actor: await rpc<Actor>(cookie, "me") };
  }
  function context(actor: Actor): AdapterContext {
    return {
      ...scopeOf(actor),
      operationId: "fixture",
      traceId: "fixture",
      signal: new AbortController().signal,
    };
  }
  function bot({ cookie }: Account, name: string) {
    return rpc<{ id: string; threadId: string }>(cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
  }
  function group({ cookie }: Account, name: string, botIds: string[]) {
    return rpc<{ id: string; threadId: string }>(cookie, "groups/create", { name, botIds });
  }
  async function sharedPage(actor: Actor, botId?: string, groupId?: string) {
    const token = randomBytes(32).toString("base64url");
    const secret = await store.put(token, context(actor));
    const page = await admin().$transaction(async (tx) => {
      await tx.secret.create({
        data: {
          id: secret.id,
          ciphertext: secret.ciphertext,
          kind: PAGE_SHARE_SECRET_KIND,
          ...scopeOf(actor),
        },
      });
      return tx.page.create({
        data: {
          ...scopeOf(actor),
          botId,
          groupId,
          title: "Fixture page",
          visibility: "link",
          shareSecretId: secret.id,
          shareTokenHash: createHash("sha256").update(token).digest("hex"),
          versions: {
            create: { version: 1, title: "Fixture page", source: "source", code: "code" },
          },
        },
      });
    });
    return { page, secret };
  }
  const secretRow = (id: string) => admin().secret.findUnique({ where: { id } });
  const pageRow = (id: string) => admin().page.findUnique({ where: { id } });
  const physicalDeletes = (ref: string) =>
    deleteRef.mock.calls.filter(([deleted]) => deleted === ref);

  it("removes the selected Page token once while preserving a foreign ref alias", async () => {
    const own = await account("Page owner");
    const other = await account("Other owner");
    const { page, secret } = await sharedPage(own.actor);
    const alias = await admin().secret.create({
      data: { ...scopeOf(other.actor), kind: "fixture", ciphertext: secret.ciphertext },
    });
    expect((await raw(other.cookie, "pages/remove", { pageId: page.id })).status).toBe(404);
    expect(await rpc(own.cookie, "pages/remove", { pageId: page.id })).toEqual({ ok: true });
    expect(await pageRow(page.id)).toBeNull();
    expect(await secretRow(secret.id)).toBeNull();
    expect(await secretRow(alias.id)).toMatchObject({ ciphertext: secret.ciphertext });
    expect(physicalDeletes(secret.ciphertext)).toHaveLength(0);
    expect((await raw(own.cookie, "pages/remove", { pageId: page.id })).status).toBe(404);
    const unaliased = await sharedPage(own.actor);
    await rpc(own.cookie, "pages/remove", { pageId: unaliased.page.id });
    expect(physicalDeletes(unaliased.secret.ciphertext)).toHaveLength(1);
  });

  it("archives without revoking and retires only terminal Bot and dissolved group links", async () => {
    const own = await account("Bot owner");
    const target = await bot(own, "Target");
    const partner = await bot(own, "Partner");
    const survivor = await bot(own, "Survivor");
    const ends = await group(own, "Dissolved", [target.id, partner.id]);
    const stays = await group(own, "Surviving", [target.id, partner.id, survivor.id]);
    const personal = await sharedPage(own.actor, target.id);
    const ending = await sharedPage(own.actor, partner.id, ends.id);
    const surviving = await sharedPage(own.actor, target.id, stays.id);
    await rpc(own.cookie, "bots/archive", { botId: target.id });
    for (const { page, secret } of [personal, ending, surviving]) {
      expect(await pageRow(page.id)).toMatchObject({
        visibility: "link",
        shareSecretId: secret.id,
      });
      expect(physicalDeletes(secret.ciphertext)).toHaveLength(0);
    }
    await rpc(own.cookie, "bots/remove", { botId: target.id, deleteMemories: true });
    expect(await pageRow(personal.page.id)).toMatchObject({
      botId: null,
      visibility: "private",
      shareSecretId: null,
      shareTokenHash: null,
    });
    expect(await pageRow(ending.page.id)).toBeNull();
    expect(await pageRow(surviving.page.id)).toMatchObject({
      botId: null,
      groupId: stays.id,
      visibility: "link",
      shareSecretId: surviving.secret.id,
    });
    for (const { secret } of [personal, ending]) {
      expect(await secretRow(secret.id)).toBeNull();
      expect(physicalDeletes(secret.ciphertext)).toHaveLength(1);
    }
    expect(await secretRow(surviving.secret.id)).not.toBeNull();
    expect(physicalDeletes(surviving.secret.ciphertext)).toHaveLength(0);
  });

  it("sweeps files and Pages and recovers a post-delete takeover lease before expiry", async () => {
    const own = await account("Group owner");
    const other = await account("Other member");
    const first = await bot(own, "First");
    const second = await bot(own, "Second");
    const chat = await group(own, "Terminal group", [first.id, second.id]);
    const page = await sharedPage(own.actor, first.id, chat.id);
    const foreignPage = await sharedPage(
      { ...other.actor, spaceId: own.actor.spaceId },
      second.id,
      chat.id,
    );
    await rpc(own.cookie, "groups/archive", { groupId: chat.id });
    expect(await pageRow(page.page.id)).toMatchObject({ visibility: "link" });
    await rpc(own.cookie, "groups/restore", { groupId: chat.id });
    const fileStore = new LocalArtifactStore(dataDir!);
    const adapterContext = context(own.actor);
    const stored = await fileStore.put(
      { name: "fixture.txt", bytes: new Uint8Array([1]), mimeType: "text/plain" },
      adapterContext,
    );
    const failedArtifact = await fileStore.put(
      { name: "cleanup-failure.txt", bytes: new Uint8Array([2]), mimeType: "text/plain" },
      adapterContext,
    );
    await admin().artifact.createMany({
      data: [stored, failedArtifact].map(({ id, hash }) => ({
        ...scopeOf(own.actor),
        botId: first.id,
        groupId: chat.id,
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 1,
        hash,
        storageKey: id,
      })),
    });
    async function seedTakeover(threadId: string) {
      const task = await admin().task.create({
        data: {
          ...scopeOf(own.actor),
          botId: first.id,
          threadId,
          prompt: "fixture",
          status: "running",
        },
      });
      const run = await admin().run.create({
        data: {
          ...scopeOf(own.actor),
          botId: first.id,
          threadId,
          taskId: task.id,
          status: "waiting_takeover",
          trigger: "user",
        },
      });
      const computer = await admin().computer.create({
        data: {
          ...scopeOf(own.actor),
          scopeKey: `fixture:${run.id}`,
          homeKey: `fixture-${run.id}`,
          kind: "fake",
          providerRef: `fixture-${run.id}`,
          state: "running",
        },
      });
      const lease = await admin().computerExecutionLease.create({
        data: {
          computerId: computer.id,
          botId: first.id,
          runId: run.id,
          fence: 1,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return { run, computer, lease };
    }
    const { run, computer, lease } = await seedTakeover(chat.threadId);
    const parallelChat = await group(own, "Parallel terminal group", [first.id, second.id]);
    const deferred = await seedTakeover(parallelChat.threadId);
    const removeFile = LocalArtifactStore.prototype.remove;
    const artifactCleanup = vi
      .spyOn(LocalArtifactStore.prototype, "remove")
      .mockImplementation(async function (this: LocalArtifactStore, id, operation) {
        if (id === failedArtifact.id) throw new Error("Synthetic artifact cleanup failure");
        return removeFile.call(this, id, operation);
      });
    let screenEntered!: () => void;
    let allowScreenRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
      screenEntered = resolve;
    });
    const screenGate = new Promise<void>((resolve) => {
      allowScreenRelease = resolve;
    });
    const execute = vi.spyOn(handles!.sandbox, "execute");
    const releaseScreen = handles!.sandbox.releaseScreen!.bind(handles!.sandbox);
    const screenRelease = vi
      .spyOn(handles!.sandbox, "releaseScreen")
      .mockImplementation(async (...args) => {
        if (args[1].runId === run.id) {
          screenEntered();
          await screenGate;
        }
        await releaseScreen(...args);
      });
    failLeaseRunId = run.id;
    const removing = raw(own.cookie, "groups/remove", { groupId: chat.id });
    let removingParallel: Promise<Response> | undefined;
    let parallelSettled = false;
    try {
      await Promise.race([
        entered,
        removing.then(() => {
          throw new Error("No screen teardown");
        }),
      ]);
      // A separate process can bypass the local slot, but cannot enter the same
      // exact marker's provider phase while the foreground owns its advisory lock.
      const sameMarkerProvider = vi.fn(async () => undefined);
      const sameMarker = await runAsTenant(scopeOf(own.actor), () =>
        completeGroupRunTeardownProviderPhase(
          runtime!.prisma,
          { computerId: computer.id, runId: run.id, ...scopeOf(own.actor) },
          sameMarkerProvider,
        ),
      );
      expect(sameMarker).toBeNull();
      expect(sameMarkerProvider).not.toHaveBeenCalled();

      removingParallel = raw(own.cookie, "groups/remove", { groupId: parallelChat.id });
      const recordParallelSettlement = () => {
        parallelSettled = true;
      };
      void removingParallel.then(recordParallelSettlement, recordParallelSettlement);
      await expect
        .poll(() => admin().chatGroup.findUnique({ where: { id: parallelChat.id } }), {
          timeout: 5_000,
        })
        .toBeNull();
      expect(screenRelease).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: deferred.computer.providerRef }),
        expect.anything(),
        expect.objectContaining({ runId: deferred.run.id }),
      );
      expect(
        await admin().computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } }),
      ).toMatchObject({ expiresAt: lease.expiresAt });
      expect(
        await admin().computerExecutionLease.findUniqueOrThrow({
          where: { id: deferred.lease.id },
        }),
      ).toMatchObject({ expiresAt: deferred.lease.expiresAt });
      await expect(rpc(own.cookie, "bots/list")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: first.id })]),
      );
      expect(parallelSettled).toBe(false);

      allowScreenRelease();
      const [removed, removedParallel] = await Promise.all([removing, removingParallel]);
      expect(removedParallel.status).toBe(200);
      expect(await removedParallel.json()).toMatchObject({ json: { ok: true } });
      expect(removed.status).toBe(429);
      expect((await removed.json()).json).toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: leaseFailure.message,
      });
      expect(screenRelease).toHaveBeenCalledTimes(2);
      expect(screenRelease).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ providerRef: computer.providerRef }),
        expect.objectContaining({ runId: run.id, screenLeaseId: `${run.id}:1` }),
        { onlyIfRunning: true },
      );
      expect(screenRelease).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ providerRef: deferred.computer.providerRef }),
        expect.objectContaining({ runId: deferred.run.id, screenLeaseId: `${deferred.run.id}:1` }),
        { onlyIfRunning: true },
      );
      expect(
        execute.mock.calls.filter(([, , operation]) => operation.runId === deferred.run.id),
      ).toEqual([
        [
          expect.objectContaining({ providerRef: deferred.computer.providerRef }),
          expect.objectContaining({
            argv: expect.arrayContaining([deferred.computer.id, deferred.run.id]),
          }),
          expect.objectContaining({
            runId: deferred.run.id,
            screenLeaseId: `${deferred.run.id}:1`,
          }),
        ],
      ]);
      expect(
        await admin().computerExecutionLease.findUniqueOrThrow({
          where: { id: deferred.lease.id },
        }),
      ).toMatchObject({ runId: deferred.run.id, fence: 1, expiresAt: new Date(0) });
    } finally {
      allowScreenRelease();
      await removing.catch(() => undefined);
      await removingParallel?.catch(() => undefined);
      failLeaseRunId = undefined;
      artifactCleanup.mockRestore();
      execute.mockRestore();
      screenRelease.mockRestore();
    }
    expect(await admin().chatGroup.findUnique({ where: { id: chat.id } })).toBeNull();
    expect(await admin().run.findUnique({ where: { id: run.id } })).toBeNull();
    expect(
      await admin().computerExecutionLease.findUnique({ where: { id: lease.id } }),
    ).toMatchObject({ runId: run.id, expiresAt: lease.expiresAt });
    expect(
      await admin().$queryRaw`
      SELECT "pendingGroupRunTeardowns" -> ${run.id}::text -> 'providerDone' AS done
      FROM computers WHERE id = ${computer.id}
    `,
    ).toEqual([{ done: true }]);
    await expect(fileStore.get(stored.id, adapterContext)).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const removed of [page, foreignPage]) {
      expect(await pageRow(removed.page.id)).toBeNull();
      expect(await secretRow(removed.secret.id)).toBeNull();
      expect(physicalDeletes(removed.secret.ciphertext)).toHaveLength(1);
    }
    expect(
      (await raw(own.cookie, "groups/remove", { groupId: chat.id })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(physicalDeletes(page.secret.ciphertext)).toHaveLength(1);
    expect(physicalDeletes(foreignPage.secret.ciphertext)).toHaveLength(1);

    const retry = createGroupRunTeardownRecovery({
      prisma: runtime!.prisma,
      sandbox: handles!.sandbox,
    });
    const retriedRelease = vi.spyOn(handles!.sandbox, "releaseScreen");
    try {
      await retry.reconcile();
      expect(retriedRelease).not.toHaveBeenCalled();
      expect(
        await admin().computerExecutionLease.findUniqueOrThrow({ where: { id: lease.id } }),
      ).toMatchObject({ runId: run.id, fence: 1, expiresAt: new Date(0) });
      retriedRelease.mockClear();
      await retry.reconcile();
      expect(retriedRelease).not.toHaveBeenCalled();
    } finally {
      retriedRelease.mockRestore();
    }
  });

  it("recovers a failed archive lease after restore without touching a newer Run's lease or screen", async () => {
    const own = await account("Archive recovery");
    const first = await bot(own, "Still owns a lease");
    const second = await bot(own, "Reclaimed a lease");
    const chat = await group(own, "Restored group", [first.id, second.id]);
    const newerThread = await admin().thread.findFirstOrThrow({
      where: { botId: second.id, groupId: null },
    });
    async function createRun(botId: string, threadId: string) {
      const scope = { ...scopeOf(own.actor), botId, threadId };
      const task = await admin().task.create({
        data: { ...scope, prompt: "fixture", status: "running" },
      });
      return admin().run.create({
        data: { ...scope, taskId: task.id, trigger: "user", status: "running" },
      });
    }
    async function attachLease(run: Awaited<ReturnType<typeof createRun>>) {
      const expiresAt = new Date(Date.now() + 60_000);
      const computer = await admin().computer.create({
        data: {
          ...scopeOf(own.actor),
          scopeKey: `fixture:${run.id}`,
          homeKey: `fixture-${run.id}`,
          kind: "fake",
          providerRef: `fixture-${run.id}`,
          state: "running",
          executionRunId: run.id,
          executionBotId: run.botId,
          executionLeaseExpiresAt: expiresAt,
        },
      });
      const lease = await admin().computerExecutionLease.create({
        data: { computerId: computer.id, botId: run.botId, runId: run.id, fence: 1, expiresAt },
      });
      return { computer, lease };
    }
    const retained = await createRun(first.id, chat.threadId);
    const replaced = await createRun(second.id, chat.threadId);
    const old = await attachLease(retained);
    const reclaimed = await attachLease(replaced);
    const screenRelease = vi.spyOn(handles!.sandbox, "releaseScreen");
    try {
      failLeaseRunId = retained.id;
      expect((await raw(own.cookie, "groups/archive", { groupId: chat.id })).status).toBe(429);
      expect(screenRelease).toHaveBeenCalledWith(
        expect.objectContaining({ providerRef: old.computer.providerRef }),
        expect.objectContaining({ runId: retained.id, screenLeaseId: `${retained.id}:1` }),
      );
      failLeaseRunId = undefined;
      await rpc(own.cookie, "groups/restore", { groupId: chat.id });
      const newer = await createRun(second.id, newerThread.id);
      const current = await admin().computerExecutionLease.update({
        where: { id: reclaimed.lease.id },
        data: { runId: newer.id, fence: 2, expiresAt: new Date(Date.now() + 120_000) },
      });
      screenRelease.mockClear();

      await rpc(own.cookie, "groups/remove", { groupId: chat.id });

      expect(await admin().run.findUnique({ where: { id: retained.id } })).toBeNull();
      expect(
        await admin().computerExecutionLease.findUnique({ where: { id: old.lease.id } }),
      ).toMatchObject({ runId: retained.id, expiresAt: new Date(0) });
      expect(await admin().computer.findUnique({ where: { id: old.computer.id } })).toMatchObject({
        executionRunId: null,
      });
      expect(await admin().run.findUnique({ where: { id: newer.id } })).toMatchObject({
        status: "running",
      });
      expect(
        await admin().computerExecutionLease.findUnique({ where: { id: current.id } }),
      ).toMatchObject({ runId: newer.id, fence: current.fence, expiresAt: current.expiresAt });
      expect(screenRelease).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerRef: old.computer.providerRef }),
        expect.objectContaining({ runId: retained.id, screenLeaseId: `${retained.id}:1` }),
        { onlyIfRunning: true },
      );
    } finally {
      failLeaseRunId = undefined;
      screenRelease.mockRestore();
    }
  });

  it.each([false, true])(
    "recovers a deletion interrupted before screen cleanup (successor: %s)",
    async (hasSuccessor) => {
      const own = await account("Stale teardown");
      const first = await bot(own, "First");
      const second = await bot(own, "Second");
      const chat = await group(own, "Deleted group", [first.id, second.id]);
      const scope = { ...scopeOf(own.actor), botId: first.id };
      const task = await admin().task.create({
        data: { ...scope, threadId: chat.threadId, prompt: "Fixture", status: "running" },
      });
      const run = await admin().run.create({
        data: {
          ...scope,
          threadId: chat.threadId,
          taskId: task.id,
          trigger: "user",
          status: "running",
        },
      });
      const expiresAt = new Date(Date.now() + 60_000);
      const computer = await admin().computer.create({
        data: {
          ...scopeOf(own.actor),
          scopeKey: `fixture:${run.id}`,
          homeKey: `fixture-${run.id}`,
          kind: "fake",
          state: "running",
          providerRef: `fixture-${run.id}`,
          executionRunId: run.id,
          executionBotId: first.id,
          executionFence: 3,
          executionLeaseExpiresAt: expiresAt,
        },
      });
      const oldLease = await admin().computerExecutionLease.create({
        data: { computerId: computer.id, botId: first.id, runId: run.id, fence: 3, expiresAt },
      });
      const manualLease = await admin().computerExecutionLease.create({
        data: {
          computerId: computer.id,
          botId: second.id,
          runId: "manual-computer-fixture",
          fence: 5,
          expiresAt,
        },
      });
      // Stop at the committed delete boundary, before any process attempts the teardown.
      await runAsTenant(scopeOf(own.actor), () =>
        createGroupRepos(runtime!.prisma).removeGroup(own.actor, chat.id),
      );
      expect(await admin().run.findUnique({ where: { id: run.id } })).toBeNull();
      const thread = await admin().thread.findFirstOrThrow({
        where: { botId: first.id, groupId: null },
      });
      const nextTask = await admin().task.create({
        data: { ...scope, threadId: thread.id, prompt: "Next", status: "running" },
      });
      const successor = await admin().run.create({
        data: {
          ...scope,
          threadId: thread.id,
          taskId: nextTask.id,
          trigger: "user",
          status: "running",
        },
      });
      const current = hasSuccessor
        ? await admin().computerExecutionLease.update({
            where: { id: oldLease.id },
            data: { runId: successor.id, fence: 4 },
          })
        : oldLease;
      if (hasSuccessor) {
        await admin().computer.update({
          where: { id: computer.id },
          data: { executionRunId: successor.id, executionFence: 4 },
        });
      }
      const screenRelease = vi.spyOn(handles!.sandbox, "releaseScreen");
      const execute = vi.spyOn(handles!.sandbox, "execute");
      try {
        const restarted = createGroupRunTeardownRecovery({
          prisma: runtime!.prisma,
          sandbox: handles!.sandbox,
        });
        await restarted.reconcile();
        if (hasSuccessor) expect(screenRelease).not.toHaveBeenCalled();
        else
          expect(screenRelease).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ providerRef: computer.providerRef }),
            expect.objectContaining({
              runId: run.id,
              screenLeaseId: `${run.id}:3`,
              cancelRunWork: true,
            }),
            { onlyIfRunning: true },
          );
        expect(execute).not.toHaveBeenCalled();
        expect(
          await admin().computerExecutionLease.findUnique({ where: { id: manualLease.id } }),
        ).toEqual(manualLease);
        const settled = await admin().computerExecutionLease.findUniqueOrThrow({
          where: { id: current.id },
        });
        if (hasSuccessor) expect(settled).toEqual(current);
        else expect(settled).toMatchObject({ runId: run.id, fence: 3, expiresAt: new Date(0) });
        expect(await admin().computer.findUnique({ where: { id: computer.id } })).toMatchObject({
          executionRunId: hasSuccessor ? successor.id : null,
          executionFence: hasSuccessor ? 4 : 3,
        });
        expect(
          await admin().$queryRaw`
        SELECT "pendingGroupRunTeardowns" AS pending FROM computers WHERE id = ${computer.id}
      `,
        ).toEqual([{ pending: null }]);
      } finally {
        screenRelease.mockRestore();
        execute.mockRestore();
      }
    },
  );

  it("retires existing Space and account cascades through the production SecretStore wrapper", async () => {
    const own = await account("Terminal account");
    const space = await rpc<{ id: string }>(own.cookie, "spaces/create", {
      name: "Terminal space",
    });
    const inSpace = await sharedPage({ ...own.actor, spaceId: space.id });
    const inAccount = await sharedPage(own.actor);
    await rpc(own.cookie, "spaces/remove", { spaceId: space.id });
    expect(await pageRow(inSpace.page.id)).toBeNull();
    expect(await secretRow(inSpace.secret.id)).toBeNull();
    expect(physicalDeletes(inSpace.secret.ciphertext)).toHaveLength(1);
    expect(await pageRow(inAccount.page.id)).toMatchObject({ visibility: "link" });
    const result = await handles!.app.request("/api/auth/delete-user", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: own.cookie },
      body: JSON.stringify({ password: "offline-password-123" }),
    });
    expect(result.status).toBe(200);
    expect(await admin().user.findUnique({ where: { id: own.actor.userId } })).toBeNull();
    expect(await pageRow(inAccount.page.id)).toBeNull();
    expect(await secretRow(inAccount.secret.id)).toBeNull();
    expect(physicalDeletes(inAccount.secret.ciphertext)).toHaveLength(1);
  });

  it("cleans a deleted link even if the database commit acknowledgement is lost", async () => {
    const own = await account("Lost acknowledgement");
    const { page, secret } = await sharedPage(own.actor);
    const lost = new Error("Synthetic missing commit acknowledgement");
    const base = runtime!.prisma;
    const ack = new Proxy(base, {
      get(target, key, receiver) {
        if (key !== "$transaction") return Reflect.get(target, key, receiver);
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          await base.$transaction(work);
          throw lost;
        };
      },
    });
    const prisma = withSecretPersistence(ack, store);
    await expect(
      runAsTenant(scopeOf(own.actor), () =>
        prisma.secret.deleteMany({
          where: { id: secret.id },
        }),
      ),
    ).rejects.toBe(lost);
    expect(await secretRow(secret.id)).toBeNull();
    expect(await pageRow(page.id)).toMatchObject({ shareSecretId: null });
    expect(physicalDeletes(secret.ciphertext)).toHaveLength(1);
  });
});
