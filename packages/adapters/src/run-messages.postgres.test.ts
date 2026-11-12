import { randomUUID } from "node:crypto";
import {
  botSettingsSelect,
  botSettingsVersions,
  createDb,
  createThreadEvents,
  createThreadMessage,
  lockSpaceModelSelection,
  RunHistoryWriteError,
  selectSpaceModelPreference,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutorDeps } from "./executor.js";
import { appendToolCompletionAudit } from "./executor.js";
import { OWN_BOT_SETTINGS_CHANGED } from "./own-bot-settings.js";
import { commitOwnBotSettings } from "./own-bot-settings-write.js";
import { persistMessageInTransaction, publishMessage, withRunLease } from "./run-messages.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("attempt history isolation (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let base: ExecutorDeps;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const userId = randomUUID();
  const organizationId = randomUUID();
  const spaceId = randomUUID();

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    await db.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await db.prisma.member.create({
      data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: new Date() },
    });
    await db.prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    await db.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId,
        spaceId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    const bot = await db.prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "Fixture",
        color: "slate",
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    identity = { userId, spaceId, botId: bot.id, threadId: bot.thread!.id };
    base = { prisma: db.prisma, events: createThreadEvents(db.prisma) } as ExecutorDeps;
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function createRun(owner = "worker-a") {
    const task = await db.prisma.task.create({
      data: { ...identity, prompt: "Fixture", status: "running" },
    });
    return db.prisma.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: owner,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  it("rejects a superseded direct message without changing sequences or first response", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: "worker-b", leaseFence: 2 },
    });
    const thread = await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } });
    await expect(
      publishMessage(deps, run, "bot", [{ kind: "text", text: "stale" }]),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } })).toEqual(
      thread,
    );
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
  });

  it("keeps concurrent attempt dependencies isolated instead of mutating their shared factory", async () => {
    const [a, b] = await Promise.all([createRun("worker-a"), createRun("worker-b")]);
    const aDeps = withRunLease(base, a.id, { owner: "worker-a", fence: 1 });
    const bDeps = withRunLease(base, b.id, { owner: "worker-b", fence: 1 });
    expect(base.runLease).toBeUndefined();
    expect(base.events).not.toBe(aDeps.events);
    await Promise.all([
      publishMessage(aDeps, a, "bot", [{ kind: "text", text: "reply A" }]),
      publishMessage(bDeps, b, "bot", [{ kind: "text", text: "reply B" }]),
    ]);
    await db.prisma.run.update({
      where: { id: a.id },
      data: { leaseFence: 2, leaseOwner: "new-a" },
    });
    await expect(
      aDeps.events.append({
        ...identity,
        runId: a.id,
        type: "thread.progress",
        payload: { streaming: true, delta: "stale A" },
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await bDeps.events.append({
      ...identity,
      runId: b.id,
      type: "thread.progress",
      payload: { streaming: true, delta: "still B" },
    });
    expect(await db.prisma.event.count({ where: { runId: b.id } })).toBe(2);
  });

  it("allows an audit after the same attempt paused but fences it out after a new claim", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    await appendToolCompletionAudit(
      deps,
      { ...identity, runId: run.id },
      {
        name: "ask_user",
        executionId: "paused-tool",
        durationMs: 1,
        result: { paused: true },
        paused: true,
      },
    );
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "agent.tool.completed" } }),
    ).toBe(1);
    await db.prisma.run.update({
      where: { id: run.id },
      data: { status: "running", leaseOwner: "worker-b", leaseFence: 2 },
    });
    await expect(
      deps.events.append({
        ...identity,
        runId: run.id,
        type: "thread.progress",
        payload: { activity: true, text: "stale audit" },
      }),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(1);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
  });

  it("rolls back the direct message, its event, and first-response timestamp together", async () => {
    const run = await createRun();
    const lease = { owner: "worker-a", fence: 1 };
    await expect(
      db.prisma.$transaction(async (tx) => {
        await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [{ kind: "text", text: "rolled back" }],
          undefined,
          undefined,
          false,
          lease,
        );
        throw new Error("fixture transaction rollback");
      }),
    ).rejects.toThrow("fixture transaction rollback");
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toBeNull();
    const deps = withRunLease(base, run.id, lease);
    await publishMessage(deps, run, "bot", [{ kind: "text", text: "committed" }]);
    const stamped = (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
      .firstResponseAt;
    expect(stamped).toBeInstanceOf(Date);
    await publishMessage(deps, run, "bot", [{ kind: "text", text: "later" }]);
    expect(
      (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).firstResponseAt,
    ).toEqual(stamped);
  });

  it("rejects a cancelled run even when the old owner and fence still match", async () => {
    const run = await createRun();
    const deps = withRunLease(base, run.id, { owner: "worker-a", fence: 1 });
    await db.prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await expect(
      publishMessage(deps, run, "bot", [{ kind: "text", text: "late" }]),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
  });
  async function approvedSettings() {
    const run = await createRun();
    const source = await createThreadMessage(db.prisma, {
      threadId: run.threadId,
      role: "user",
      authorUserId: run.userId,
      blocks: [{ kind: "text", text: "Use a short checklist." }],
    });
    const scoped = await db.prisma.run.update({
      where: { id: run.id },
      data: { sourceMessageId: source.id },
    });
    const bot = await db.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
    const request = {
      kind: "own-bot-settings" as const,
      runId: run.id,
      userId: run.userId,
      spaceId: run.spaceId,
      botId: run.botId,
      botName: bot.name,
      revision: bot.settingsRevision,
      before: { instructions: bot.instructions },
      after: { instructions: `Instructions ${run.id}` },
    };
    const effect = await db.prisma.externalEffect.create({
      data: {
        runId: run.id,
        spaceId: run.spaceId,
        kind: "update_bot",
        idempotencyKey: randomUUID(),
        status: "approved",
        request,
      },
    });
    return { bot, effect, run: scoped, request };
  }

  it("commits settings, history, card and approval receipt once across concurrent replay", async () => {
    const { bot, effect, run, request } = await approvedSettings();
    const commit = () =>
      commitOwnBotSettings({
        prisma: db.prisma,
        run,
        effectId: effect.id,
        request,
        secrets: [],
        lease: { owner: "worker-a", fence: 1 },
        signal: new AbortController().signal,
        rulesBlock: async () => false,
        notify: async () => {},
      });
    const results = await Promise.all([commit(), commit()]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, revision: bot.settingsRevision + 1 });
    const ordinary = await db.prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
    expect(ordinary).not.toHaveProperty("settingsHistory");
    const thread = await db.prisma.thread.findUniqueOrThrow({
      where: { id: run.threadId },
      include: { bot: true },
    });
    expect(thread.bot).toMatchObject({ id: run.botId });
    expect(thread.bot).not.toHaveProperty("settingsHistory");
    const saved = await db.prisma.bot.findUniqueOrThrow({
      where: { id: run.botId },
      select: botSettingsSelect,
    });
    expect(saved.instructions).toBe(request.after.instructions);
    expect(botSettingsVersions(saved)[0]).toMatchObject({
      before: request.before,
      after: request.after,
    });
    expect(await db.prisma.message.count({ where: { runId: run.id, role: "bot" } })).toBe(1);
    expect(await db.prisma.externalEffect.findUnique({ where: { id: effect.id } })).toMatchObject({
      status: "completed",
      result: results[0],
    });
  });

  it("rolls back an interrupted settlement and commits the same approved request once on retry", async () => {
    const { bot, effect, run, request } = await approvedSettings();
    const { settingsHistory } = await db.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { settingsHistory: true },
    });
    const interrupted = db.prisma.$extends({
      query: {
        externalEffect: {
          async updateMany({ args, query }) {
            if (args.where?.id === effect.id && args.data.status === "completed")
              throw new Error("fixture interruption before approval receipt");
            return query(args);
          },
        },
      },
    });
    const commit = (prisma = db.prisma) =>
      commitOwnBotSettings({
        prisma,
        run,
        effectId: effect.id,
        request,
        secrets: [],
        lease: { owner: "worker-a", fence: 1 },
        signal: new AbortController().signal,
        rulesBlock: async () => false,
        notify: async () => {},
      });
    await expect(commit(interrupted as unknown as typeof db.prisma)).rejects.toThrow(
      "fixture interruption before approval receipt",
    );
    const unchanged = await db.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: botSettingsSelect,
    });
    expect(unchanged).toMatchObject({
      instructions: bot.instructions,
      settingsRevision: bot.settingsRevision,
      settingsHistory,
    });
    expect(await db.prisma.message.count({ where: { runId: run.id, role: "bot" } })).toBe(0);
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.externalEffect.findUnique({ where: { id: effect.id } })).toMatchObject({
      status: "approved",
    });

    const saved = await commit();
    expect(saved).toMatchObject({ ok: true, revision: bot.settingsRevision + 1 });
    await expect(commit()).resolves.toEqual(saved);
    expect(await db.prisma.message.count({ where: { runId: run.id, role: "bot" } })).toBe(1);
    expect(await db.prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
      instructions: request.after.instructions,
      settingsRevision: bot.settingsRevision + 1,
    });
  });

  it.each(["inherited", "preference-only"] as const)(
    "rechecks the %s Space model after a concurrent default selection",
    async (selection) => {
      const { effect, run, request: seed } = await approvedSettings();
      const secret = await db.prisma.secret.create({
        data: { userId, kind: "model", ciphertext: "synthetic-settings-binding" },
      });
      const credential = await db.prisma.userModelCredential.create({
        data: { userId, provider: "openai-compatible", label: "Fixture", secretId: secret.id },
      });
      const before = {
        modelProvider: credential.provider,
        modelId: "explicit",
        modelCredentialId: credential.id,
      };
      const bot = await db.prisma.bot.update({ where: { id: run.botId }, data: before });
      await selectSpaceModelPreference(db.prisma, run, credential.id, "shown-default");
      const request = {
        ...seed,
        revision: bot.settingsRevision,
        before,
        after:
          selection === "inherited"
            ? { modelProvider: null, modelId: null, modelCredentialId: null }
            : { ...before, modelId: "shown-default" },
        modelConnection: {
          id: credential.id,
          label: credential.label,
          revision: credential.connectionRevision,
          usesSpaceDefault: selection === "inherited",
          ...(selection === "inherited"
            ? { spaceDefaultModel: "shown-default" }
            : { requiredSpacePreferenceModel: "shown-default" }),
        },
      };
      await db.prisma.externalEffect.update({ where: { id: effect.id }, data: { request } });
      let release = () => {};
      let writing: (pid: number) => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const changing = new Promise<number>((resolve) => {
        writing = resolve;
      });
      const change = db.prisma.$transaction(async (tx) => {
        await lockSpaceModelSelection(tx, run, "write");
        await selectSpaceModelPreference(tx, run, credential.id, "different-default");
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        writing(backend!.pid);
        await hold;
      });
      const blocker = await changing;
      const commit = commitOwnBotSettings({
        prisma: db.prisma,
        run,
        effectId: effect.id,
        request,
        secrets: [],
        lease: { owner: "worker-a", fence: 1 },
        signal: new AbortController().signal,
        rulesBlock: async () => false,
        notify: async () => {},
      });
      try {
        await expect
          .poll(
            async () => {
              const result = await db.pool.query<{ waiting: boolean }>(
                `SELECT EXISTS (
                SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory' AND NOT granted AND $1 = ANY(pg_blocking_pids(pid))
              ) AS waiting`,
                [blocker],
              );
              return result.rows[0]?.waiting;
            },
            { timeout: 3_000 },
          )
          .toBe(true);
      } finally {
        release();
        await change;
        await commit;
      }
      await expect(commit).resolves.toMatchObject({
        error: expect.stringContaining("connection changed"),
        unchanged: true,
      });
      expect(await db.prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
        ...before,
        settingsRevision: bot.settingsRevision,
      });
    },
  );

  it("rejects an ABA edit between the displayed proposal and commit", async () => {
    const { bot, effect, run, request } = await approvedSettings();
    await db.prisma.bot.update({ where: { id: bot.id }, data: { instructions: "Other device" } });
    await db.prisma.bot.update({ where: { id: bot.id }, data: { instructions: bot.instructions } });
    await expect(
      commitOwnBotSettings({
        prisma: db.prisma,
        run,
        effectId: effect.id,
        request,
        secrets: [],
        lease: { owner: "worker-a", fence: 1 },
        signal: new AbortController().signal,
        rulesBlock: async () => false,
        notify: async () => {},
      }),
    ).resolves.toMatchObject({ error: OWN_BOT_SETTINGS_CHANGED, unchanged: true });
    expect(await db.prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
      instructions: bot.instructions,
      settingsRevision: bot.settingsRevision + 2,
    });
  });

  it.each([
    ["stopped", { status: "cancelled" }],
    ["expired lease", { leaseExpiresAt: new Date(0) }],
    ["superseded lease", { leaseFence: 2 }],
    ["outside steering", { receivedOutsideMessage: true }],
    ["peer origin", { origin: "bot_peer" }],
  ] as const)("rejects %s before a settings write", async (_case, patch) => {
    const { bot, effect, run, request } = await approvedSettings();
    await db.prisma.run.update({ where: { id: run.id }, data: patch });
    await expect(
      commitOwnBotSettings({
        prisma: db.prisma,
        run,
        effectId: effect.id,
        request,
        secrets: [],
        lease: { owner: "worker-a", fence: 1 },
        signal: new AbortController().signal,
        rulesBlock: async () => false,
        notify: async () => {},
      }),
    ).resolves.toMatchObject({ unchanged: true });
    expect(await db.prisma.bot.findUnique({ where: { id: bot.id } })).toMatchObject({
      instructions: bot.instructions,
      settingsRevision: bot.settingsRevision,
    });
    expect(await db.prisma.message.count({ where: { runId: run.id, role: "bot" } })).toBe(0);
  });
});
