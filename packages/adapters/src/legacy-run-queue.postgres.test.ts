import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { createJobCorrelation, JOB_CORRELATION_VERSION, unwrapJobPayload } from "@rakazo/logging";
import type { WorkerUtils } from "graphile-worker";
import { makeWorkerUtils } from "graphile-worker";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildLegacyRunQueue } from "./legacy-run-queue.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const now = new Date("2030-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000);
type Report = Awaited<ReturnType<typeof rebuildLegacyRunQueue>>;
type Ledger = Record<string, unknown>;

describePostgres("rebuilding legacy Run deliveries (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let utils: WorkerUtils;
  let identity: {
    organizationId: string;
    userId: string;
    spaceId: string;
    botId: string;
    threadId: string;
  };
  let ownedKeys: Set<string>;
  let ownedJobIds: Set<string>;
  let missingSchemaProof: {
    schemaBefore: string | null;
    report: Report;
    countsBefore: number[];
    countsAfter: number[];
  };

  const applicationCounts = async () => [
    await prisma.run.count(),
    await prisma.task.count(),
    await prisma.externalEffect.count(),
    await prisma.message.count(),
    await prisma.event.count(),
  ];

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    const { rows } = await db.pool.query<{ schema: string | null }>(
      "select to_regclass('graphile_worker._private_jobs')::text as schema",
    );
    // This suite must use a fresh application-migrated clone. Never remove an
    // existing queue schema to manufacture the missing-schema branch.
    expect(rows[0]?.schema).toBeNull();
    const countsBefore = await applicationCounts();
    const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    const countsAfter = await applicationCounts();
    missingSchemaProof = {
      schemaBefore: rows[0]!.schema,
      report,
      countsBefore,
      countsAfter,
    };
    expect(report.applied).toBe(false);
    expect(report.blockers).toEqual([{ reason: "queue_schema_unavailable" }]);
    expect(countsAfter).toEqual(countsBefore);
    utils = await makeWorkerUtils({ pgPool: db.pool });
  });

  beforeEach(async () => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    identity = { organizationId, userId, spaceId, botId: "", threadId: "" };
    ownedKeys = new Set();
    ownedJobIds = new Set();
    await prisma.user.create({
      data: { id: userId, name: "Fixture", email: userId + "@example.test" },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    const bot = await prisma.bot.create({
      data: {
        spaceId,
        userId,
        name: "Rollback Fixture",
        color: "slate",
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    if (!bot.thread) throw new Error("fixture thread missing");
    identity = { organizationId, userId, spaceId, botId: bot.id, threadId: bot.thread.id };
  });

  afterEach(async () => {
    if (!identity || !prisma) return;
    try {
      // Only this case's known jobs and canonical Run keys are test-owned.
      await db.pool.query(
        "delete from graphile_worker._private_jobs where id = any($1::bigint[]) or key = any($2::text[])",
        [[...ownedJobIds], [...ownedKeys]],
      );
    } finally {
      await prisma.organization.deleteMany({ where: { id: identity.organizationId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
    }
  });

  afterAll(async () => {
    try {
      await utils?.release();
    } finally {
      await prisma?.$disconnect();
      await db?.pool.end();
    }
  });

  async function createRun(data: Partial<Prisma.RunUncheckedCreateInput> = {}) {
    const { userId, spaceId } = identity;
    const botId = data.botId ?? identity.botId;
    const threadId = data.threadId ?? identity.threadId;
    const task = await prisma.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "queued" },
    });
    const run = await prisma.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        status: "queued",
        trigger: "user",
        ...data,
      },
    });
    ownedKeys.add("run:" + run.id);
    return run;
  }

  async function addJob(
    runId: string,
    options: { task?: string; key?: string | null; runAt?: Date; nested?: boolean } = {},
  ) {
    const key = options.key === undefined ? "run:" + runId : options.key;
    if (key) ownedKeys.add(key);
    const payload = options.nested
      ? { v: JOB_CORRELATION_VERSION, correlation: createJobCorrelation(), payload: { runId } }
      : { runId };
    const job = await utils.addJob(options.task ?? "run.continue", payload, {
      jobKey: key ?? undefined,
      runAt: options.runAt ?? now,
      maxAttempts: 7,
      priority: 3,
      flags: ["fixture-preserve"],
    });
    ownedJobIds.add(job.id);
    await db.pool.query(
      "update graphile_worker._private_jobs set attempts = 2, last_error = $2 where id = $1::bigint",
      [job.id, "synthetic prior failure"],
    );
    return job;
  }

  async function jobs(): Promise<Ledger[]> {
    const { rows } = await db.pool.query<Ledger>(
      "select jobs.*, tasks.identifier as task_identifier from graphile_worker._private_jobs jobs join graphile_worker._private_tasks tasks on tasks.id = jobs.task_id order by jobs.id",
    );
    return rows;
  }

  async function jobFor(runId: string): Promise<Ledger> {
    const found = (await jobs()).filter((job) => job.key === "run:" + runId);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  async function queueSnapshot() {
    return {
      jobs: await jobs(),
      tasks: (await db.pool.query("select * from graphile_worker._private_tasks order by id")).rows,
      queues: (await db.pool.query("select * from graphile_worker._private_job_queues order by id"))
        .rows,
    };
  }

  async function businessSnapshot() {
    const { spaceId, userId } = identity;
    return {
      space: await prisma.space.findUniqueOrThrow({ where: { id: spaceId } }),
      user: await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      runs: await prisma.run.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      tasks: await prisma.task.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
      credentials: await prisma.userModelCredential.findMany({
        where: { userId },
        orderBy: { id: "asc" },
      }),
      secrets: await prisma.secret.findMany({ where: { userId }, orderBy: { id: "asc" } }),
      effects: await prisma.externalEffect.findMany({ where: { spaceId }, orderBy: { id: "asc" } }),
    };
  }

  const without = (row: Ledger, fields: readonly string[]) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
  const hasBlocker = (report: Report, runId: string) => {
    expect(report.applied).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ runId, reason: expect.any(String) }),
    );
  };

  // Each observer either returns the original query Promise unchanged, or
  // deliberately injects the one read failure named by its negative case.
  function tapPool(
    observe: (sql: string, forward: () => unknown, client: PoolClient) => unknown,
  ): Pool {
    return new Proxy(db.pool, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "connect") return typeof value === "function" ? value.bind(target) : value;
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              const member = Reflect.get(connection, key, connection);
              if (key !== "query")
                return typeof member === "function" ? member.bind(connection) : member;
              return (...args: unknown[]) => {
                const input = args[0];
                const sql =
                  typeof input === "string"
                    ? input
                    : input && typeof input === "object" && "text" in input
                      ? String(input.text)
                      : "";
                return observe(sql, () => Reflect.apply(member, connection, args), connection);
              };
            },
          });
        };
      },
    });
  }

  it("creates one missing canonical delivery and is idempotent for the same Run", async () => {
    const run = await createRun();
    const before = await businessSnapshot();
    const first = await rebuildLegacyRunQueue(db.pool, { apply: true, now, batchSize: 1 });
    expect(first).toMatchObject({ applied: true, examined: 1, created: 1, blockers: [] });
    const delivery = await jobFor(run.id);
    expect(delivery.task_identifier).toBe("run.continue");
    expect(delivery.run_at).toEqual(now);
    expect(unwrapJobPayload(delivery.payload).payload).toEqual({ runId: run.id });
    const second = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    expect(second).toMatchObject({
      applied: true,
      created: 0,
      retimed: 0,
      retasked: 0,
      preserved: 1,
      blockers: [],
    });
    expect(await jobFor(run.id)).toEqual(delivery);
    expect(await businessSnapshot()).toEqual(before);
  });

  it("preserves future wake and later backoff without resetting the existing ledger", async () => {
    const missing = await createRun({ wakeAt: at(60) });
    const earlier = await createRun({ wakeAt: at(60) });
    const later = await createRun({ wakeAt: at(60) });
    await addJob(earlier.id, { nested: true, runAt: at(10) });
    await addJob(later.id, { nested: true, runAt: at(90) });
    const beforeEarlier = await jobFor(earlier.id);
    const beforeLater = await jobFor(later.id);
    const business = await businessSnapshot();
    const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now, batchSize: 1 });
    expect(report).toMatchObject({
      applied: true,
      created: 1,
      retimed: 1,
      preserved: 1,
      blockers: [],
    });
    expect((await jobFor(missing.id)).run_at).toEqual(at(60));
    const afterEarlier = await jobFor(earlier.id);
    expect(afterEarlier.run_at).toEqual(at(60));
    expect(without(afterEarlier, ["run_at", "updated_at"])).toEqual(
      without(beforeEarlier, ["run_at", "updated_at"]),
    );
    expect(await jobFor(later.id)).toEqual(beforeLater);
    expect(await businessSnapshot()).toEqual(business);
  });

  it("retasks an unlocked interactive row in place with its identity and retry ledger intact", async () => {
    const run = await createRun({ wakeAt: at(60) });
    await addJob(run.id, { task: "run.interactive", nested: true, runAt: at(90) });
    const before = await jobFor(run.id);
    const business = await businessSnapshot();
    const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    expect(report).toMatchObject({
      applied: true,
      created: 0,
      retimed: 0,
      retasked: 1,
      blockers: [],
    });
    const after = await jobFor(run.id);
    expect(after.task_identifier).toBe("run.continue");
    expect(without(after, ["task_id", "task_identifier", "updated_at"])).toEqual(
      without(before, ["task_id", "task_identifier", "updated_at"]),
    );
    expect(await businessSnapshot()).toEqual(business);
  });

  it.each(["wrong payload", "foreign task", "earlier unkeyed duplicate"] as const)(
    "blocks the whole batch for a %s instead of missing an earlier delivery",
    async (variant) => {
      await createRun();
      const run = await createRun({ wakeAt: at(60) });
      if (variant === "wrong payload") {
        await addJob("different-run", { key: "run:" + run.id, nested: true });
      } else if (variant === "foreign task") {
        await addJob(run.id, { task: "computer.sleep" });
      } else {
        await addJob(run.id, { nested: true, runAt: at(60) });
        await addJob(run.id, { key: null, runAt: now });
      }
      const before = await queueSnapshot();
      const business = await businessSnapshot();
      const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now, batchSize: 1 });
      hasBlocker(report, run.id);
      expect(report.examined).toBe(2);
      expect(await queueSnapshot()).toEqual(before);
      expect(await businessSnapshot()).toEqual(business);
    },
  );

  it.each(["locked", "exhausted"] as const)(
    "blocks a %s delivery without resetting it or partially filling missing work",
    async (variant) => {
      await createRun();
      const run = await createRun();
      const job = await addJob(run.id);
      if (variant === "locked") {
        await db.pool.query(
          "update graphile_worker._private_jobs set locked_at = $2, locked_by = $3 where id = $1::bigint",
          [job.id, now, "synthetic-owned-worker"],
        );
      } else {
        await db.pool.query(
          "update graphile_worker._private_jobs set attempts = max_attempts where id = $1::bigint",
          [job.id],
        );
      }
      const before = await queueSnapshot();
      const business = await businessSnapshot();
      const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now, batchSize: 1 });
      hasBlocker(report, run.id);
      expect(report.created).toBe(1);
      expect(await queueSnapshot()).toEqual(before);
      expect(await businessSnapshot()).toEqual(business);
    },
  );

  it("never guesses input answers and only queues released explicit takeover continuations", async () => {
    const input = await createRun({ status: "waiting_input" });
    const inputWithWake = await createRun({ status: "waiting_input", wakeAt: at(60) });
    const takeoverWithoutWake = await createRun({
      status: "waiting_takeover",
      checkpoint: "takeover",
    });
    const unknownTakeover = await createRun({
      status: "waiting_takeover",
      wakeAt: at(60),
      checkpoint: "other",
    });
    const released = await createRun({
      status: "waiting_takeover",
      wakeAt: at(60),
      checkpoint: "takeover",
    });
    const skipped = await createRun({
      status: "waiting_takeover",
      wakeAt: at(-10),
      checkpoint: "takeover-skipped",
    });
    const held: Awaited<ReturnType<typeof createRun>>[] = [];
    for (const expiresAt of [at(60), at(-60)]) {
      const { userId, spaceId } = identity;
      const bot = await prisma.bot.create({
        data: {
          userId,
          spaceId,
          name: "Held Fixture",
          color: "slate",
          thread: { create: { userId, spaceId } },
        },
        include: { thread: true },
      });
      if (!bot.thread) throw new Error("fixture held thread missing");
      const run = await createRun({
        status: "waiting_takeover",
        wakeAt: at(60),
        checkpoint: "takeover",
        botId: bot.id,
        threadId: bot.thread.id,
      });
      const computer = await prisma.computer.create({
        data: {
          userId,
          spaceId,
          kind: "fake",
          homeKey: randomUUID(),
          scopeKey: randomUUID(),
          controlHolder: "user",
          controlBotId: bot.id,
          controlRunId: run.id,
          controlLeaseId: randomUUID(),
          controlLeaseExpiresAt: expiresAt,
        },
      });
      await prisma.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
      held.push(run);
    }
    const unconfirmed = [inputWithWake, unknownTakeover, ...held];
    const beforeUnconfirmed = await businessSnapshot();
    const queueBeforeUnconfirmed = await queueSnapshot();
    const denied = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    expect(denied).toMatchObject({ applied: false, created: 2, humanWaitsSkipped: 2 });
    expect(denied.blockers).toHaveLength(4);
    for (const run of unconfirmed) {
      expect(denied.blockers).toContainEqual({ runId: run.id, reason: "unconfirmed_human_resume" });
    }
    expect(await queueSnapshot()).toEqual(queueBeforeUnconfirmed);
    expect(await businessSnapshot()).toEqual(beforeUnconfirmed);
    // End only these synthetic invalid fixture candidates, without inventing an
    // answer or letting the repair leaf change their state.
    expect(
      (
        await prisma.run.updateMany({
          where: {
            id: { in: unconfirmed.map((run) => run.id) },
            spaceId: identity.spaceId,
            userId: identity.userId,
          },
          data: { status: "cancelled" },
        })
      ).count,
    ).toBe(4);
    const business = await businessSnapshot();
    const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    expect(report).toMatchObject({ applied: true, created: 2, humanWaitsSkipped: 2, blockers: [] });
    expect((await jobFor(released.id)).run_at).toEqual(at(60));
    expect((await jobFor(skipped.id)).run_at).toEqual(now);
    const skippedIds = [input, inputWithWake, takeoverWithoutWake, unknownTakeover, ...held].map(
      (run) => run.id,
    );
    expect(
      (await jobs()).filter((job) => skippedIds.some((id) => job.key === "run:" + id)),
    ).toEqual([]);
    expect(await businessSnapshot()).toEqual(business);
    await addJob(input.id);
    const beforeBlocked = await queueSnapshot();
    const blocked = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    hasBlocker(blocked, input.id);
    expect(await queueSnapshot()).toEqual(beforeBlocked);
    expect(await businessSnapshot()).toEqual(business);
  });

  it("skips terminal runs, blocks live or unknown leases, and preserves an expired Run when filling its job", async () => {
    const terminal = await createRun({ status: "completed" });
    const failed = await createRun({ status: "failed" });
    const cancelled = await createRun({ status: "cancelled" });
    await addJob(terminal.id);
    const terminalDelivery = await jobFor(terminal.id);
    const active = await createRun({ status: "running", leaseOwner: "live-worker" });
    const expired = await createRun({
      status: "running",
      leaseOwner: "old-worker",
      leaseFence: 7,
      leaseExpiresAt: at(-60),
      wakeAt: at(60),
    });
    for (const leaseExpiresAt of [null, at(60)]) {
      await prisma.run.update({ where: { id: active.id }, data: { leaseExpiresAt } });
      const business = await businessSnapshot();
      const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
      hasBlocker(report, active.id);
      expect(report.terminalSkipped).toBe(1);
      expect(await jobs()).toEqual([terminalDelivery]);
      expect(await businessSnapshot()).toEqual(business);
    }
    await prisma.run.update({ where: { id: active.id }, data: { status: "cancelled" } });
    const business = await businessSnapshot();
    const report = await rebuildLegacyRunQueue(db.pool, { apply: true, now });
    expect(report).toMatchObject({ applied: true, created: 1, terminalSkipped: 1, blockers: [] });
    expect((await jobFor(expired.id)).run_at).toEqual(at(60));
    expect(await jobFor(terminal.id)).toEqual(terminalDelivery);
    expect(
      (await jobs()).filter((job) =>
        [failed.id, cancelled.id, active.id].some((id) => job.key === "run:" + id),
      ),
    ).toEqual([]);
    expect(await prisma.run.findUniqueOrThrow({ where: { id: expired.id } })).toEqual(expired);
    expect(await businessSnapshot()).toEqual(business);
  });

  it("rolls back with 40001 when cancellation wins the actual Run lock", async () => {
    const run = await createRun();
    const cancelling = await db.pool.connect();
    let submitted = false;
    const observed = tapPool((sql, forward) => {
      const result = forward();
      if (
        sql.includes("legacy_run_queue") &&
        /\bfrom\s+(?:"runs"|runs)(?:\s|$)/i.test(sql) &&
        /\bfor\s+update\b/i.test(sql)
      )
        submitted = true;
      return result;
    });
    let operation: Promise<unknown> | undefined;
    try {
      await cancelling.query("BEGIN");
      await cancelling.query("select id from runs where id = $1 for update", [run.id]);
      operation = rebuildLegacyRunQueue(observed, { apply: true, now }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(submitted).toBe(true), { timeout: 5_000, interval: 10 });
      await cancelling.query("update runs set status = 'cancelled' where id = $1", [run.id]);
      await cancelling.query("COMMIT");
      expect(await operation).toMatchObject({ code: "40001" });
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "cancelled",
      );
      expect(await jobs()).toEqual([]);
      expect(await prisma.externalEffect.count({ where: { runId: run.id } })).toBe(0);
    } finally {
      await cancelling.query("ROLLBACK").catch(() => undefined);
      cancelling.release();
      await operation;
    }
  });

  it("checks without mutation, preserves every application field under a nonUTC session, and rolls back read failures", async () => {
    expect(missingSchemaProof).toMatchObject({
      schemaBefore: null,
      report: { applied: false, blockers: [{ reason: "queue_schema_unavailable" }] },
    });
    expect(missingSchemaProof.countsAfter).toEqual(missingSchemaProof.countsBefore);
    const secret = await prisma.secret.create({
      data: {
        userId: identity.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "synthetic-ciphertext",
      },
    });
    const credential = await prisma.userModelCredential.create({
      data: { userId: identity.userId, provider: "fixture", label: "Fixture", secretId: secret.id },
    });
    const run = await createRun({
      trigger: "routine",
      origin: "human",
      modelProvider: "fixture",
      modelId: "fixture-model",
      modelCredentialId: credential.id,
      modelPinned: true,
      thinkingLevel: "high",
      checkpoint: "takeover",
      wakeAt: at(60),
    });
    await prisma.externalEffect.create({
      data: {
        runId: run.id,
        spaceId: identity.spaceId,
        idempotencyKey: JSON.stringify(["fixture-completed", run.id]),
        kind: "write_file",
        status: "completed",
        request: { path: "/workspace/fixture.txt" },
        result: { written: true },
      },
    });
    const business = await businessSnapshot();
    const queue = await queueSnapshot();
    const check = await rebuildLegacyRunQueue(db.pool, { now });
    expect(check).toMatchObject({ applied: false, created: 1, blockers: [] });
    expect(await queueSnapshot()).toEqual(queue);
    expect(await businessSnapshot()).toEqual(business);
    const failure = new Error("synthetic queue preflight read failure");
    let faulted = false;
    let rollbacks = 0;
    const failing = tapPool((sql, forward) => {
      if (/\brollback\b/i.test(sql)) rollbacks++;
      if (
        !faulted &&
        sql.includes("legacy_run_queue") &&
        /\bfrom\s+(?:"runs"|runs)(?:\s|$)/i.test(sql)
      ) {
        faulted = true;
        throw failure;
      }
      return forward();
    });
    await expect(rebuildLegacyRunQueue(failing, { apply: true, now })).rejects.toBe(failure);
    expect(faulted).toBe(true);
    expect(rollbacks).toBe(1);
    expect(await queueSnapshot()).toEqual(queue);
    expect(await businessSnapshot()).toEqual(business);
    const nonUtc = new Pool({
      connectionString: databaseUrl!,
      max: 2,
      options: "-c timezone=America/New_York",
    });
    try {
      expect(
        (await nonUtc.query<{ timezone: string }>("select current_setting('TimeZone') as timezone"))
          .rows[0]?.timezone,
      ).toBe("America/New_York");
      const applied = await rebuildLegacyRunQueue(nonUtc, { apply: true, now });
      expect(applied).toMatchObject({ applied: true, created: 1, blockers: [] });
      expect((await jobFor(run.id)).run_at).toEqual(at(60));
      expect(await businessSnapshot()).toEqual(business);
    } finally {
      await nonUtc.end();
    }
  });
});
