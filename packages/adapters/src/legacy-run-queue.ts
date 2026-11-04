import { isDeepStrictEqual } from "node:util";
import { runJobKey } from "@rakazo/adapter-kit";
import { wrapJobPayload } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";
import { takeoverCheckpointOf } from "./takeover-resume.js";

type LegacyJob = {
  id: string;
  key: string | null;
  taskId: number;
  identifier: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  runAt: Date;
  priority: number;
  flags: unknown;
  lastError: string | null;
  revision: number;
  queueId: number | null;
  createdAt: Date;
};

type LegacyRun = {
  id: string;
  spaceId: string;
  status: string;
  leaseFence: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  wakeAt: Date | null;
  checkpoint: string | null;
  createdAt: Date;
  botId: string;
  computerId: string | null;
  controlBotId: string | null;
  controlLeaseId: string | null;
};

export interface LegacyRunQueueResult {
  /** Counts describe the checked plan; changes happened only when applied is true. */
  applied: boolean;
  examined: number;
  created: number;
  retimed: number;
  retasked: number;
  preserved: number;
  humanWaitsSkipped: number;
  terminalSkipped: number;
  blockers: Array<{ runId?: string; reason: string }>;
}

const JOB_COLUMNS = `j.id, j.key, j.task_id AS "taskId", t.identifier, j.payload,
  j.attempts, j.max_attempts AS "maxAttempts", j.locked_at AS "lockedAt",
  j.locked_by AS "lockedBy", j.run_at AS "runAt", j.priority, j.flags,
  j.last_error AS "lastError", j.revision, j.job_queue_id AS "queueId",
  j.created_at AS "createdAt"`;
const RUN_COLUMNS = `r.id, r."spaceId", r.status, r."leaseFence", r."leaseOwner",
  r."leaseExpiresAt" AT TIME ZONE 'UTC' AS "leaseExpiresAt",
  r."wakeAt" AT TIME ZONE 'UTC' AS "wakeAt", r.checkpoint,
  r."createdAt" AT TIME ZONE 'UTC' AS "createdAt", r."botId",
  b."computerId", c."controlBotId", c."controlLeaseId"`;
const RUN_FROM = `FROM runs r
  LEFT JOIN bots b ON b.id = r."botId"
  LEFT JOIN computers c ON c.id = b."computerId"`;
const isDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function payloadRunId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return;
  const direct = payload.runId;
  const nested = isRecord(payload.payload) ? payload.payload.runId : undefined;
  if (direct !== undefined && (typeof direct !== "string" || !direct.length)) return;
  if (nested !== undefined && (typeof nested !== "string" || !nested.length)) return;
  if (direct !== undefined && nested !== undefined && direct !== nested) return;
  return typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
}

async function jobsForKey(client: PoolClient, key: string, lock: boolean) {
  return client.query<LegacyJob>(
    `/* legacy_run_queue */ SELECT ${JOB_COLUMNS}
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE j.key = $1 ${lock ? "FOR UPDATE OF j" : ""}`,
    [key],
  );
}

/**
 * One-off downgrade repair, after all Run writers and both worker versions have
 * been stopped and drained. A database snapshot cannot prove that operational
 * precondition. Check by default; apply rechecks under locks and changes no Run.
 */
export async function rebuildLegacyRunQueue(
  pool: Pick<Pool, "connect">,
  options: { apply?: boolean; batchSize?: number; now?: Date } = {},
): Promise<LegacyRunQueueResult> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid batch size");
  if (options.now !== undefined && !isDate(options.now)) throw new Error("Invalid queue clock");
  const result: LegacyRunQueueResult = {
    applied: false,
    examined: 0,
    created: 0,
    retimed: 0,
    retasked: 0,
    preserved: 0,
    humanWaitsSkipped: 0,
    terminalSkipped: 0,
    blockers: [],
  };
  const blocked = new Set<string>();
  const block = (reason: string, runId?: string) => {
    const key = JSON.stringify([runId, reason]);
    if (!blocked.has(key)) {
      blocked.add(key);
      result.blockers.push({ ...(runId ? { runId } : {}), reason });
    }
  };
  const client = await pool.connect();
  let inTransaction = false;
  let destroy = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    inTransaction = true;
    const schema = await client.query<{ available: boolean }>(`SELECT
      to_regclass('graphile_worker._private_jobs') IS NOT NULL
      AND to_regclass('graphile_worker._private_tasks') IS NOT NULL
      AND to_regprocedure('graphile_worker.add_job(text,json,text,timestamp with time zone,integer,text,integer,text[],text)') IS NOT NULL
      AS available`);
    if (!schema.rows[0]?.available) {
      block("queue_schema_unavailable");
      await client.query("ROLLBACK");
      inTransaction = false;
      return result;
    }
    const now = options.now
      ? new Date(options.now.getTime())
      : (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]?.at;
    if (!isDate(now)) throw new Error("Queue clock unavailable");
    // Audit every legacy delivery, including unkeyed duplicates that an old
    // worker could otherwise execute before the canonical future delivery.
    const { rows: deliveries } = await client.query<LegacyJob>(`SELECT ${JOB_COLUMNS}
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier IN ('run.continue', 'run.interactive') OR j.key LIKE 'run:%'`);
    const jobs = new Map<string, LegacyJob>();
    const referencedRuns = new Set<string>();
    for (const job of deliveries) {
      const id = payloadRunId(job.payload);
      const keyedId = job.key?.startsWith("run:") ? job.key.slice(4) : undefined;
      if (id) referencedRuns.add(id);
      if (keyedId) referencedRuns.add(keyedId);
      if (!id || job.key !== runJobKey(id)) {
        block("noncanonical_run_delivery", keyedId || id);
      } else if (job.identifier !== "run.continue" && job.identifier !== "run.interactive") {
        block("unexpected_run_task", id);
      } else if (jobs.has(id)) {
        block("duplicate_run_delivery", id);
      } else {
        jobs.set(id, job);
      }
    }

    const plans: Array<{ run: LegacyRun; job?: LegacyJob; due: Date }> = [];
    const seen = new Set<string>();
    let cursor: { at: Date; id: string } | undefined;
    while (true) {
      const page = await client.query<LegacyRun>(
        `/* legacy_run_queue */ SELECT ${RUN_COLUMNS} ${RUN_FROM}
        WHERE (r.status NOT IN ('completed','failed','cancelled') OR r.id = ANY($4::text[]))
          AND ($1::timestamptz IS NULL OR (r."createdAt", r.id) > ($1::timestamptz AT TIME ZONE 'UTC', $2::text))
        ORDER BY r."createdAt", r.id LIMIT $3`,
        [cursor?.at ?? null, cursor?.id ?? null, batchSize, [...referencedRuns]],
      );
      for (let run of page.rows) {
        seen.add(run.id);
        result.examined += 1;
        if (options.apply) {
          // Keep the existing computer-before-Run control lock order for a
          // released takeover; even an expired user lease must finish releasing.
          if (run.status === "waiting_takeover" && run.computerId) {
            await client.query("SELECT id FROM computers WHERE id = $1 FOR UPDATE", [
              run.computerId,
            ]);
          }
          const locked = await client.query<LegacyRun>(
            `/* legacy_run_queue */ SELECT ${RUN_COLUMNS} ${RUN_FROM} WHERE r.id = $1 AND r."spaceId" = $2 FOR UPDATE OF r`,
            [run.id, run.spaceId],
          );
          const current = locked.rows[0];
          if (
            !current ||
            current.status !== run.status ||
            current.leaseFence !== run.leaseFence ||
            current.leaseOwner !== run.leaseOwner ||
            current.checkpoint !== run.checkpoint ||
            current.wakeAt?.getTime() !== run.wakeAt?.getTime()
          ) {
            block("run_changed", run.id);
            continue;
          }
          run = current;
        }
        if (
          !isDate(run.createdAt) ||
          (run.wakeAt !== null && !isDate(run.wakeAt)) ||
          (run.leaseExpiresAt !== null && !isDate(run.leaseExpiresAt))
        ) {
          block("invalid_run_timestamp", run.id);
          continue;
        }
        let job = jobs.get(run.id);
        if (["completed", "failed", "cancelled"].includes(run.status)) {
          result.terminalSkipped += 1;
          continue;
        }
        if (run.status === "waiting_input" || run.status === "waiting_takeover") {
          if (run.wakeAt === null) {
            result.humanWaitsSkipped += 1;
            if (job) block("human_wait_has_delivery", run.id);
            continue;
          }
          if (
            run.status === "waiting_input" ||
            !takeoverCheckpointOf(run.checkpoint) ||
            (run.controlLeaseId !== null && run.controlBotId === run.botId)
          ) {
            block("unconfirmed_human_resume", run.id);
            continue;
          }
        } else if (run.status === "leased" || run.status === "running") {
          if (run.leaseExpiresAt === null || run.leaseExpiresAt > now) {
            block("active_run", run.id);
            continue;
          }
        } else if (run.status !== "queued") {
          block("unsupported_run_status", run.id);
          continue;
        }
        if (job && options.apply) {
          const lockedJob = (await jobsForKey(client, runJobKey(run.id), true)).rows[0];
          if (
            !lockedJob ||
            lockedJob.id !== job.id ||
            lockedJob.taskId !== job.taskId ||
            lockedJob.attempts !== job.attempts ||
            lockedJob.maxAttempts !== job.maxAttempts ||
            !isDeepStrictEqual(lockedJob.payload, job.payload)
          ) {
            block("job_changed", run.id);
            continue;
          }
          job = lockedJob;
        }
        if (job && (job.lockedAt !== null || job.lockedBy !== null)) {
          block("locked_run_delivery", run.id);
          continue;
        }
        if (
          job &&
          (!Number.isSafeInteger(job.attempts) ||
            !Number.isSafeInteger(job.maxAttempts) ||
            job.attempts < 0 ||
            job.attempts >= job.maxAttempts ||
            !isDate(job.runAt) ||
            !isDate(job.createdAt))
        ) {
          block("exhausted_or_invalid_delivery", run.id);
          continue;
        }
        const due = new Date(Math.max(now.getTime(), run.wakeAt?.getTime() ?? now.getTime()));
        if (!job) result.created += 1;
        else {
          const retime = run.wakeAt !== null && job.runAt < run.wakeAt;
          const retask = job.identifier === "run.interactive";
          if (retime) result.retimed += 1;
          if (retask) result.retasked += 1;
          if (!retime && !retask) result.preserved += 1;
        }
        plans.push({ run, job, due });
      }
      const last = page.rows.at(-1);
      if (page.rows.length < batchSize || !last) break;
      if (!isDate(last.createdAt)) throw new Error("Invalid run pagination timestamp");
      cursor = { at: last.createdAt, id: last.id };
    }
    for (const id of referencedRuns) if (!seen.has(id)) block("orphan_run_delivery", id);
    if (!options.apply || result.blockers.length) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return result;
    }
    const createdPayloads = new Map<string, unknown>();
    for (const { run, job, due } of plans) {
      const key = runJobKey(run.id);
      if (!job) {
        const payload = wrapJobPayload({ runId: run.id });
        // unsafe_dedupe cannot reset a delivery inserted by a racing publisher.
        // A collision is detected below and rolls the entire conversion back.
        await client.query(
          `SELECT * FROM graphile_worker.add_job(
          identifier => 'run.continue'::text, payload => $1::json,
          queue_name => NULL::text, run_at => $2::timestamptz,
          max_attempts => NULL::int, job_key => $3::text,
          priority => NULL::int, flags => NULL::text[], job_key_mode => 'unsafe_dedupe'::text)`,
          [JSON.stringify(payload), due, key],
        );
        const created = (await jobsForKey(client, key, true)).rows[0];
        if (
          created?.identifier !== "run.continue" ||
          created.attempts !== 0 ||
          created.lockedAt !== null ||
          created.lockedBy !== null ||
          !isDeepStrictEqual(created.payload, payload) ||
          !isDate(created.runAt) ||
          created.runAt.getTime() !== due.getTime()
        )
          throw new Error("Legacy run queue changed during creation");
        createdPayloads.set(run.id, payload);
      } else {
        let taskId = job.taskId;
        if (job.identifier === "run.interactive") {
          await client.query(
            "INSERT INTO graphile_worker._private_tasks (identifier) VALUES ('run.continue') ON CONFLICT DO NOTHING",
          );
          const target = await client.query<{ id: number }>(
            "SELECT id FROM graphile_worker._private_tasks WHERE identifier = 'run.continue'",
          );
          if (!target.rows[0]) throw new Error("Legacy run task unavailable");
          taskId = target.rows[0].id;
        }
        if (taskId !== job.taskId || (run.wakeAt !== null && run.wakeAt > job.runAt)) {
          const changed = await client.query(
            `UPDATE graphile_worker._private_jobs
            SET task_id = $1, run_at = GREATEST(run_at, COALESCE($2::timestamptz, run_at))
            WHERE id = $3 AND key = $4 AND task_id = $5 AND attempts = $6 AND max_attempts = $7
              AND locked_at IS NULL AND locked_by IS NULL RETURNING id`,
            [taskId, run.wakeAt, job.id, key, job.taskId, job.attempts, job.maxAttempts],
          );
          if (changed.rowCount !== 1) throw new Error("Legacy run queue changed during repair");
        }
      }
    }
    for (const { run, job, due } of plans) {
      const actual = (await jobsForKey(client, runJobKey(run.id), true)).rows[0];
      const expectedAt = job
        ? Math.max(job.runAt.getTime(), run.wakeAt?.getTime() ?? job.runAt.getTime())
        : due.getTime();
      if (
        actual?.identifier !== "run.continue" ||
        actual.lockedAt !== null ||
        actual.lockedBy !== null ||
        !isDate(actual.runAt) ||
        actual.runAt.getTime() !== expectedAt ||
        !isDeepStrictEqual(actual.payload, job ? job.payload : createdPayloads.get(run.id))
      ) {
        throw new Error("Legacy run queue readback failed");
      }
      if (
        job &&
        (actual.id !== job.id ||
          actual.attempts !== job.attempts ||
          actual.maxAttempts !== job.maxAttempts ||
          actual.priority !== job.priority ||
          actual.lastError !== job.lastError ||
          actual.revision !== job.revision ||
          actual.queueId !== job.queueId ||
          actual.createdAt.getTime() !== job.createdAt.getTime() ||
          !isDeepStrictEqual(actual.flags, job.flags))
      ) {
        throw new Error("Legacy run queue budget changed during repair");
      }
    }
    await client.query("COMMIT");
    inTransaction = false;
    result.applied = true;
    return result;
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK").catch(() => {
        destroy = true;
      });
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
