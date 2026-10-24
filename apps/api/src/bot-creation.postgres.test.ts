import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, ModelCredential, Space } from "@rakazo/contracts";
import {
  BOT_CREATION_NOT_WRITTEN_REASON,
  BOT_TEMPLATES,
  botTemplateDraft,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { createApp } from "./app.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";

describePostgres("bot creation intent HTTP acceptance", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let database: ReturnType<typeof createDb>;
  let model: Awaited<ReturnType<typeof startModelEmulator>>;
  let dataDir: string;
  let cookie: string;
  let actor: { userId: string; spaceId: string };
  const enqueue = vi.fn(async (_job: { name: string; payload: unknown }) => undefined);
  let failRunCreate = false;
  const runErrors: Array<{ code?: unknown; meta?: unknown }> = [];
  const lifecycleQueryErrors: Array<{ code?: unknown; meta?: unknown }> = [];
  const requestKind = new AsyncLocalStorage<"intro" | "archive" | "switch">();
  let afterIntroRead: (() => Promise<void>) | undefined;
  let afterArchiveSnapshot: (() => Promise<void>) | undefined;
  let beforeIntentLock: ((kind: "intro" | "archive") => void) | undefined;
  let afterSwitchComputerLock: (() => Promise<void>) | undefined;
  let afterArchiveIntentLock: (() => void) | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bot-creation-acceptance-"));
    model = await startModelEmulator({ steps: [], apiKey: "offline-creation-key" });
    database = createDb(process.env.DATABASE_URL!);
    const instrumented = database.prisma.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          const kind = requestKind.getStore();
          const sql = args as { sql?: string; strings?: readonly string[] };
          const text = sql.sql ?? sql.strings?.join("") ?? "";
          const intentLock = /pg_advisory_xact_lock\(hashtextextended\([\s\S]*, 2\)\)/.test(text);
          if (
            !model &&
            operation === "$queryRaw" &&
            (kind === "intro" || kind === "archive") &&
            intentLock
          )
            beforeIntentLock?.(kind);
          const result = await query(args).catch((error: { code?: unknown; meta?: unknown }) => {
            if (kind === "archive" || kind === "switch")
              lifecycleQueryErrors.push({ code: error.code, meta: error.meta });
            throw error;
          });
          if (!model && operation === "$queryRaw") {
            if (kind === "archive" && intentLock) afterArchiveIntentLock?.();
            if (kind === "switch" && /FROM computers[\s\S]*FOR UPDATE/.test(text))
              await afterSwitchComputerLock?.();
          }
          return result;
        },
        bot: {
          async findFirst({ args, query }) {
            const result = await query(args);
            if (requestKind.getStore() === "intro" && args.where?.spawnKey)
              await afterIntroRead?.();
            return result;
          },
        },
        run: {
          async findMany({ args, query }) {
            const result = await query(args);
            if (requestKind.getStore() === "archive" && args.where?.botId)
              await afterArchiveSnapshot?.();
            return result;
          },
          async create({ args, query }) {
            if (failRunCreate) throw new Error("Synthetic Run persistence unavailable");
            try {
              return await query(args);
            } catch (error) {
              runErrors.push(error as { code?: unknown; meta?: unknown });
              throw error;
            }
          },
        },
      },
    });
    handles = await createApp({
      prisma: instrumented as unknown as PrismaClient,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-creation-encryption-key",
      webOrigin: origin,
      authUrl: origin,
    });
    const originalEnqueue = handles.jobs.enqueue.bind(handles.jobs);
    vi.spyOn(handles.jobs, "enqueue").mockImplementation(async (job) => {
      if (job.name === "run.continue") return enqueue(job);
      return originalEnqueue(job);
    });
    cookie = await signup();
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    actor = { userId: me.userId, spaceId: me.spaceId };
    const credential = await rpc<ModelCredential>(cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: "offline-creation-key",
      contextWindow: 160_000,
      maxTokens: 4096,
    });
    await rpc(cookie, "models/setDefault", {
      provider: model.model.provider,
      modelId: model.model.id,
      modelCredentialId: credential.id,
      expectedRevision: credential.connectionRevision,
    });
  });

  afterAll(async () => {
    await handles?.stop();
    await database?.prisma.$disconnect();
    await database?.pool.end();
    model?.assertComplete();
    await model?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function signup() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `creation-${randomUUID()}@example.test`,
        password: "password12",
        name: "Creation tester",
      }),
    });
    expect(response.ok).toBe(true);
    return sessionCookieHeader(response);
  }

  async function raw(session: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: session,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(session: string, procedure: string, input: unknown = {}, spaceId?: string) {
    const response = await raw(session, procedure, input, spaceId);
    const body = await response.text();
    if (!response.ok) throw new Error(`${procedure}: ${response.status} ${body}`);
    return (JSON.parse(body) as { json: T }).json;
  }
  function input(spawnKey = `bot-create:${randomUUID()}`) {
    return {
      name: "Creation fixture",
      title: "Public role",
      description: "Public description",
      instructions: "  Raw execution rules\n\n",
      notifyOnFinish: true,
      computerMode: "team" as const,
      spawnKey,
    };
  }
  function runs(botId: string) {
    return database.prisma.run.findMany({ where: { botId, trigger: "created" } });
  }
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function botWithoutIntro(
    draft: Omit<ReturnType<typeof input>, "computerMode"> & { computerMode: "team" | "dedicated" },
  ) {
    failRunCreate = true;
    try {
      return await rpc<Bot>(cookie, "bots/create", draft);
    } finally {
      failRunCreate = false;
    }
  }
  async function expectArchivedWithCancelledIntro(botId: string) {
    const archived = await database.prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    expect(archived.archivedAt).not.toBeNull();
    const intro = await runs(botId);
    expect(intro).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(intro[0]!.completedAt!.getTime()).toBeGreaterThanOrEqual(intro[0]!.createdAt.getTime());
    const task = await database.prisma.task.findUniqueOrThrow({ where: { id: intro[0]!.taskId! } });
    expect(task).toMatchObject({ status: "cancelled" });
    const requestCount = model.requests.length;
    await handles.executor.continueRun(intro[0]!.id, "offline-late-worker");
    expect(await database.prisma.attempt.count({ where: { runId: intro[0]!.id } })).toBe(0);
    expect(model.requests).toHaveLength(requestCount);
    expect(await runs(botId)).toEqual(intro);
    expect(await database.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
    expect(await database.prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toEqual(archived);
  }

  it("cancels the intro when its active read precedes archival", async () => {
    const draft = input();
    const bot = await botWithoutIntro(draft);
    const read = signal();
    const releaseRead = signal();
    const archiveLock = signal();
    afterIntroRead = async () => {
      read.resolve();
      await releaseRead.promise;
    };
    beforeIntentLock = (kind) => {
      if (kind === "archive") archiveLock.resolve();
    };
    const replay = requestKind.run("intro", () => rpc<Bot>(cookie, "bots/create", draft));
    let archive: Promise<unknown> | undefined;
    try {
      await read.promise;
      archive = requestKind.run("archive", () => rpc(cookie, "bots/archive", { botId: bot.id }));
      // A cooperating archiver waits for the intro's creation mutex. Without that
      // protocol it commits first, exposing the stale active read deterministically.
      await Promise.race([archive, archiveLock.promise]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseRead.resolve();
      await Promise.all([replay, archive]);
      await expectArchivedWithCancelledIntro(bot.id);
    } finally {
      releaseRead.resolve();
      afterIntroRead = undefined;
      beforeIntentLock = undefined;
      await Promise.allSettled([replay, ...(archive ? [archive] : [])]);
    }
  });

  it("takes the archive snapshot before allowing a competing intro", async () => {
    const draft = input();
    const bot = await botWithoutIntro(draft);
    const snapshot = signal();
    const releaseSnapshot = signal();
    const introLock = signal();
    afterArchiveSnapshot = async () => {
      snapshot.resolve();
      await releaseSnapshot.promise;
    };
    beforeIntentLock = (kind) => {
      if (kind === "intro") introLock.resolve();
    };
    const archive = requestKind.run("archive", () =>
      rpc(cookie, "bots/archive", { botId: bot.id }),
    );
    let replay: Promise<Bot> | undefined;
    try {
      await snapshot.promise;
      replay = requestKind.run("intro", () => rpc<Bot>(cookie, "bots/create", draft));
      // Before serialization, the intro commits after the now-stale snapshot.
      // With serialization it must wait for the archiver that owns the creation mutex.
      await Promise.race([replay, introLock.promise]);
      releaseSnapshot.resolve();
      await Promise.all([archive, replay]);
      expect(
        (await database.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).archivedAt,
      ).not.toBeNull();
      expect(await runs(bot.id)).toEqual([]);
      expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(0);
    } finally {
      releaseSnapshot.resolve();
      afterArchiveSnapshot = undefined;
      beforeIntentLock = undefined;
      await Promise.allSettled([archive, ...(replay ? [replay] : [])]);
    }
  });

  it("archives while an existing Task creation holds the Bot foreign-key lock", async () => {
    const bot = await rpc<Bot>(cookie, "bots/create", input());
    const inserted = signal();
    const release = signal();
    const task = database.prisma.$transaction(async (tx) => {
      await tx.task.create({
        data: {
          ...actor,
          botId: bot.id,
          threadId: bot.threadId,
          prompt: "Foreign-key lock compatibility probe",
          status: "queued",
        },
      });
      inserted.resolve();
      await release.promise;
    });
    try {
      await inserted.promise;
      await rpc(cookie, "bots/archive", { botId: bot.id });
      await expectArchivedWithCancelledIntro(bot.id);
    } finally {
      release.resolve();
      await task;
    }
  });

  it("archives a stopped private computer while its mode switch holds the Computer lock", async () => {
    const bot = await botWithoutIntro({ ...input(), computerMode: "dedicated" });
    const stored = await database.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    expect(stored.computer).toMatchObject({
      scope: "dedicated",
      state: "stopped",
      maintenanceId: null,
    });
    expect(stored.computerSwitching).toBe(false);
    const computerLocked = signal();
    const releaseComputer = signal();
    const archiveLocked = signal();
    const errorsBefore = lifecycleQueryErrors.length;
    afterSwitchComputerLock = async () => {
      computerLocked.resolve();
      await releaseComputer.promise;
    };
    afterArchiveIntentLock = () => archiveLocked.resolve();
    const switching = requestKind.run("switch", () =>
      raw(cookie, "bots/setComputer", { botId: bot.id, mode: "team" }),
    );
    let archive: Promise<Response> | undefined;
    try {
      await computerLocked.promise;
      archive = requestKind.run("archive", () => raw(cookie, "bots/archive", { botId: bot.id }));
      await archiveLocked.promise;
      releaseComputer.resolve();
      const [switched, archived] = await Promise.all([switching, archive]);
      expect(lifecycleQueryErrors.slice(errorsBefore)).toEqual([]);
      expect({ switch: switched.status, archive: archived.status }).toEqual({
        switch: 200,
        archive: 200,
      });
      const current = await database.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        include: { computer: true },
      });
      expect(current).toMatchObject({ computerSwitching: false, computer: { scope: "team" } });
      expect(current.archivedAt).not.toBeNull();
      expect(await runs(bot.id)).toEqual([]);
    } finally {
      releaseComputer.resolve();
      afterSwitchComputerLock = undefined;
      afterArchiveIntentLock = undefined;
      await Promise.allSettled([switching, ...(archive ? [archive] : [])]);
    }
  });

  it.each(["creation-intent", "legacy"] as const)(
    "preserves the %s quota-rejected creation error and rollback contract",
    async (kind) => {
      await rpc<Bot>(cookie, "bots/create", input());
      const draft = {
        ...input(kind === "legacy" ? `legacy-quota:${randomUUID()}` : undefined),
        computerMode: "dedicated",
      };
      const counts = () =>
        Promise.all([
          database.prisma.bot.count({ where: actor }),
          database.prisma.thread.count({ where: actor }),
          database.prisma.task.count({ where: actor }),
          database.prisma.run.count({ where: actor }),
          database.prisma.computer.count({ where: actor }),
          database.prisma.browserProfile.count({ where: actor }),
          database.prisma.memoryDocument.count({ where: actor }),
        ]);
      const before = await counts();
      const calls = enqueue.mock.calls.length;
      const limit = process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
      process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
      try {
        const response = await raw(cookie, "bots/create", draft);
        expect(response.status).toBe(400);
        const error = (await response.json()) as {
          json: { code: string; data?: { reason?: string } };
        };
        expect(error.json.code).toBe("BAD_REQUEST");
        if (kind === "creation-intent")
          expect(error.json.data?.reason).toBe(BOT_CREATION_NOT_WRITTEN_REASON);
        else expect(error.json.data?.reason).toBeUndefined();
        expect(await counts()).toEqual(before);
        expect(
          await database.prisma.bot.findUnique({
            where: { spaceId_spawnKey: { spaceId: actor.spaceId, spawnKey: draft.spawnKey } },
          }),
        ).toBeNull();
        expect(enqueue.mock.calls).toHaveLength(calls);
      } finally {
        if (limit === undefined) delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
        else process.env.SANDBOX_MAX_COMPUTERS_PER_USER = limit;
      }
    },
  );

  it("recovers an existing creation receipt when quota blocks its missing team Computer", async () => {
    const space = await rpc<Space>(cookie, "spaces/create", { name: "Quota receipt recovery" });
    const draft = { ...input(), computerMode: "dedicated" };
    const original = await rpc<Bot>(cookie, "bots/create", draft, space.id);
    const intro = await runs(original.id);
    expect(intro).toHaveLength(1);
    const teamKey = `team:${space.id}`;
    const team = await database.prisma.computer.findUniqueOrThrow({ where: { scopeKey: teamKey } });
    expect(await database.prisma.bot.count({ where: { computerId: team.id } })).toBe(0);
    await database.prisma.computer.delete({ where: { id: team.id } });
    const calls = enqueue.mock.calls.length;
    const limit = process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    try {
      const recovered = await rpc<Bot>(cookie, "bots/create", draft, space.id);
      expect(recovered.id).toBe(original.id);
      expect(recovered.archivedAt).toBeNull();
      expect(await runs(original.id)).toEqual(intro);
      expect(await database.prisma.task.count({ where: { botId: original.id } })).toBe(1);
      expect(
        await database.prisma.computer.findUnique({ where: { scopeKey: teamKey } }),
      ).toBeNull();
      expect(enqueue.mock.calls.slice(calls)).toContainEqual([
        expect.objectContaining({ payload: { runId: intro[0]!.id } }),
      ]);
    } finally {
      if (limit === undefined) delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
      else process.env.SANDBOX_MAX_COMPUTERS_PER_USER = limit;
    }
  });

  it("uses the real Run nonce constraint and rolls back its failed Task", async () => {
    const bot = await rpc<Bot>(cookie, "bots/create", input());
    const first = (await runs(bot.id))[0]!;
    const nonce = `constraint-check:${randomUUID()}`;
    await database.prisma.run.update({ where: { id: first.id }, data: { clientNonce: nonce } });
    let failure: { code?: unknown; meta?: unknown } | undefined;
    try {
      await handles.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            ...actor,
            botId: bot.id,
            threadId: bot.threadId,
            prompt: "Probe",
            status: "queued",
          },
        });
        return tx.run.create({
          data: {
            ...actor,
            botId: bot.id,
            threadId: bot.threadId,
            taskId: task.id,
            status: "queued",
            trigger: "created",
            clientNonce: nonce,
          },
        });
      });
    } catch (error) {
      failure = error as { code?: unknown; meta?: unknown };
    }
    expect(failure?.code).toBe("P2002");
    expect(failure?.meta).toMatchObject({
      modelName: "Run",
      driverAdapterError: {
        cause: { originalCode: "23505", constraint: { index: "runs_spaceId_clientNonce_key" } },
      },
    });
    expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(1);
  });

  it("recovers one Bot and one intro after a lost creation receipt", async () => {
    const draft = input();
    const original = await rpc<Bot>(cookie, "bots/create", draft);
    const recovered = await rpc<Bot>(cookie, "bots/create", draft);
    expect(recovered.id).toBe(original.id);
    expect(
      await database.prisma.bot.count({
        where: { spaceId: actor.spaceId, spawnKey: draft.spawnKey },
      }),
    ).toBe(1);
    expect(await runs(original.id)).toHaveLength(1);
    expect(await database.prisma.task.count({ where: { botId: original.id } })).toBe(1);
  });

  it("keeps concurrent retries on one Bot, Task, and intro Run", async () => {
    const draft = input();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => rpc<Bot>(cookie, "bots/create", draft)),
    );
    expect(new Set(receipts.map((bot) => bot.id)).size).toBe(1);
    expect(await runs(receipts[0]!.id)).toHaveLength(1);
    expect(await database.prisma.task.count({ where: { botId: receipts[0]!.id } })).toBe(1);
  });

  it("recovers the same archived creation without restoring or recreating it", async () => {
    const draft = input();
    const original = await rpc<Bot>(cookie, "bots/create", draft);
    await rpc(cookie, "bots/archive", { botId: original.id });
    const archived = await database.prisma.bot.findUniqueOrThrow({ where: { id: original.id } });
    const recovered = await rpc<Bot>(cookie, "bots/create", draft);
    expect(recovered.id).toBe(original.id);
    expect(recovered.archivedAt).toBe(archived.archivedAt!.toISOString());
    expect(
      (await database.prisma.bot.findUniqueOrThrow({ where: { id: original.id } })).spawnKey,
    ).toBe(draft.spawnKey);
    expect(
      await database.prisma.bot.count({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: draft.name,
          spawnKey: draft.spawnKey,
        },
      }),
    ).toBe(1);
    expect(await runs(original.id)).toHaveLength(1);
  });
  it.each([
    "running",
    "leased",
    "completed",
    "failed",
    "cancelled",
    "waiting_input",
    "waiting_takeover",
  ])("does not reopen or awaken a %s intro when its creation is replayed", async (status) => {
    const draft = input();
    const bot = await rpc<Bot>(cookie, "bots/create", draft);
    const first = (await runs(bot.id))[0]!;
    await database.prisma.run.update({ where: { id: first.id }, data: { status } });
    const calls = enqueue.mock.calls.length;
    const replay = await rpc<Bot>(cookie, "bots/create", draft);
    expect(replay.id).toBe(bot.id);
    expect(await runs(bot.id)).toEqual([expect.objectContaining({ id: first.id, status })]);
    expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(1);
    expect(enqueue.mock.calls.slice(calls)).not.toContainEqual([
      expect.objectContaining({ payload: { runId: first.id } }),
    ]);
  });

  it("awakens the same queued Run after a missed queue delivery", async () => {
    enqueue.mockRejectedValueOnce(new Error("Synthetic wake unavailable"));
    const draft = input();
    const bot = await rpc<Bot>(cookie, "bots/create", draft);
    const first = (await runs(bot.id))[0]!;
    expect(first.status).toBe("queued");
    const calls = enqueue.mock.calls.length;
    expect((await rpc<Bot>(cookie, "bots/create", draft)).id).toBe(bot.id);
    expect(await runs(bot.id)).toHaveLength(1);
    expect(enqueue.mock.calls.slice(calls)).toContainEqual([
      expect.objectContaining({ payload: { runId: first.id }, replaceKey: `run:${first.id}` }),
    ]);
  });

  it("does not orphan a Task when Run persistence fails", async () => {
    const draft = input();
    failRunCreate = true;
    let bot: Bot;
    try {
      bot = await rpc<Bot>(cookie, "bots/create", draft);
    } finally {
      failRunCreate = false;
    }
    expect(await runs(bot.id)).toHaveLength(0);
    expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(0);
    expect((await rpc<Bot>(cookie, "bots/create", draft)).id).toBe(bot.id);
    expect(await runs(bot.id)).toHaveLength(1);
    expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(1);
  });

  it("keeps historical onboarding archive keys and unkeyed creation behavior", async () => {
    const draft = input("onboarding:first");
    const original = await rpc<Bot>(cookie, "bots/create", draft);
    expect((await rpc<Bot>(cookie, "bots/create", draft)).id).toBe(original.id);
    expect(await runs(original.id)).toHaveLength(2);
    await rpc(cookie, "bots/archive", { botId: original.id });
    const recreated = await rpc<Bot>(cookie, "bots/create", draft);
    expect(recreated.id).not.toBe(original.id);
    expect(recreated.archivedAt).toBeNull();
    expect(
      (await database.prisma.bot.findUniqueOrThrow({ where: { id: original.id } })).spawnKey,
    ).toBeNull();
    const unkeyed = { ...input(), spawnKey: undefined };
    const first = await rpc<Bot>(cookie, "bots/create", unkeyed);
    const second = await rpc<Bot>(cookie, "bots/create", unkeyed);
    expect(second.id).not.toBe(first.id);
    expect(await runs(first.id)).toHaveLength(1);
    expect(await runs(second.id)).toHaveLength(1);
  });

  it("does not apply a replay's changed fields to the original Bot", async () => {
    const draft = input();
    const original = await rpc<Bot>(cookie, "bots/create", draft);
    const replay = await rpc<Bot>(cookie, "bots/create", {
      ...draft,
      name: "Unconfirmed newer name",
      instructions: "Unconfirmed newer instructions",
    });
    expect(replay).toMatchObject({
      id: original.id,
      name: draft.name,
      instructions: draft.instructions,
    });
    expect(await runs(original.id)).toHaveLength(1);
  });

  it("isolates the same creation key across Spaces and authenticated owners", async () => {
    const draft = input();
    const original = await rpc<Bot>(cookie, "bots/create", draft);
    const otherSession = await signup();
    const otherActor = await rpc<{ userId: string; spaceId: string }>(otherSession, "me");
    const other = await rpc<Bot>(otherSession, "bots/create", draft);
    expect(other.id).not.toBe(original.id);
    expect(other.spaceId).toBe(otherActor.spaceId);
    expect(await runs(other.id)).toHaveLength(0);
    const originalSpace = await database.prisma.space.findUniqueOrThrow({
      where: { id: actor.spaceId },
    });
    await database.prisma.member.create({
      data: {
        id: randomUUID(),
        userId: otherActor.userId,
        organizationId: originalSpace.organizationId,
        role: "member",
        createdAt: new Date(),
      },
    });
    expect(
      await database.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: actor.spaceId, userId: otherActor.userId } },
      }),
    ).not.toBeNull();
    expect((await raw(otherSession, "bots/create", draft, actor.spaceId)).ok).toBe(false);
    const space = await rpc<Space>(cookie, "spaces/create", { name: "Second creation Space" });
    const inOtherSpace = await rpc<Bot>(cookie, "bots/create", draft, space.id);
    expect(inOtherSpace.id).not.toBe(original.id);
    expect(inOtherSpace.spaceId).toBe(space.id);
    expect(
      (await database.prisma.bot.findUniqueOrThrow({ where: { id: original.id } })).userId,
    ).toBe(actor.userId);
  });

  it.each(["botId", "threadId", "userId", "trigger"] as const)(
    "does not awaken a nonce collision with a different %s",
    async (field) => {
      const draft = input();
      const bot = await rpc<Bot>(cookie, "bots/create", draft);
      const companion = await rpc<Bot>(cookie, "bots/create", input());
      const first = (await runs(bot.id))[0]!;
      const value = {
        botId: companion.id,
        threadId: companion.threadId,
        userId: "another-owner",
        trigger: "user",
      }[field];
      await database.prisma.run.update({ where: { id: first.id }, data: { [field]: value } });
      const calls = enqueue.mock.calls.length;
      expect((await rpc<Bot>(cookie, "bots/create", draft)).id).toBe(bot.id);
      expect(await database.prisma.run.count({ where: { clientNonce: first.clientNonce } })).toBe(
        1,
      );
      expect(await database.prisma.task.count({ where: { botId: bot.id } })).toBe(1);
      expect(enqueue.mock.calls.slice(calls)).not.toContainEqual([
        expect.objectContaining({ payload: { runId: first.id } }),
      ]);
    },
  );

  it.each(BOT_TEMPLATES)(
    "persists edited $templateId fields independently through the real API",
    async (template) => {
      const draft = {
        ...botTemplateDraft(template),
        name: `${template.name} 编辑`,
        description: `${template.description} 公开描述补充。`,
        instructions: ` \n${template.instructions}\n追加：仅处理本次提供的材料。\n\t `,
      };
      const bot = await rpc<Bot>(cookie, "bots/create", { ...draft, spawnKey: input().spawnKey });
      const stored = await database.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const { computerMode, ...storedFields } = draft;
      expect(stored).toMatchObject(storedFields);
      expect(
        (await database.prisma.computer.findUniqueOrThrow({ where: { id: stored.computerId! } }))
          .scope,
      ).toBe(computerMode);
      expect(await rpc(cookie, "bots/get", { botId: bot.id })).toMatchObject(draft);
      expect(
        await database.prisma.message.count({ where: { threadId: bot.threadId, role: "user" } }),
      ).toBe(0);
      expect(await database.prisma.routine.count({ where: { botId: bot.id } })).toBe(0);
      const intro = (await runs(bot.id))[0]!;
      expect(
        (await database.prisma.task.findUniqueOrThrow({ where: { id: intro.taskId } })).prompt,
      ).not.toContain(template.examplePrompt);
    },
  );
});
