import type { AgentBackupSource } from "@rakazo/contracts";
import {
  AGENT_BACKUP_MAX_FILES,
  BotPackageRoutineSchema,
  isBackupRoutinePath,
  isValidTimeZone,
} from "@rakazo/contracts";
import { redactSecretText } from "@rakazo/logging/redaction";
import JSON5 from "json5";
import { extractForcedSkillName } from "../agent-skill.js";
import { nextCronDateAcrossStrict } from "../cron.js";

export const backupJobsPath = "cron/jobs.json";
export const isBackupRoutine = isBackupRoutinePath;
type Routine = ReturnType<typeof BotPackageRoutineSchema.parse>;
type Json = Record<string, unknown>;
type Job =
  | { path: string; routine: Routine }
  | { path: string; reason: "routineSchedule" | "routineOwner" };

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const present = (value: unknown) => value !== undefined && value !== null && value !== "";
export const isBackupRoutineOmission = (path: string) =>
  path === backupJobsPath || isBackupRoutine(path);

/** A folder's name is only a label; the exported agent settings provide the binding. */
export function backupWorkspaceAgent(
  config: string | undefined,
  sourcePath: string | undefined,
): string | null {
  if (!config || !sourcePath) return null;
  const absolutePath = (value: unknown) => {
    if (typeof value !== "string") return null;
    const path = value
      .trim()
      .replaceAll("\\", "/")
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "");
    if (
      !/^(?:\/|[a-z]:\/)/i.test(path) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) ||
      /\$\{/.test(path) ||
      /\p{Cc}/u.test(path)
    )
      return null;
    return path;
  };
  const workspace = absolutePath(sourcePath);
  if (!workspace) return null;
  try {
    const root = record(JSON5.parse(config));
    if (Object.hasOwn(root, "$include")) return null;
    const agents = record(root.agents);
    if (
      Object.hasOwn(agents, "$include") ||
      (Object.hasOwn(agents, "list") && Object.hasOwn(agents, "entries"))
    )
      return null;
    const entries = Array.isArray(agents.list)
      ? agents.list.map((value) => {
          const entry = record(value);
          return [text(entry.id), entry] as const;
        })
      : Object.entries(record(agents.entries)).map(([id, entry]) => [id, record(entry)] as const);
    const bindings = entries.map(([id, entry]) => ({
      id,
      path: Object.hasOwn(entry, "$include") ? null : absolutePath(entry.workspace),
    }));
    if (bindings.some(({ path }) => path === null)) return null;
    const matches = bindings.filter(({ path }) => path === workspace);
    const id = matches[0]?.id;
    if (matches.length !== 1 || !id || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) return null;
    return entries.filter(([key]) => key.toLowerCase() === id).length === 1 ? id : null;
  } catch {
    return null;
  }
}

function localHermesDelivery(job: Json): boolean {
  return job.deliver === "local" || (!present(job.deliver) && !present(job.origin));
}

/** Check shared semantics before projecting a paused draft. */
export function validateBackupRoutine(value: unknown): Routine | null {
  try {
    const parsed = BotPackageRoutineSchema.safeParse(value);
    if (
      !parsed.success ||
      Object.keys(record(value)).some(
        (key) => !["name", "prompt", "crons", "timezone"].includes(key),
      )
    )
      return null;
    const routine = parsed.data;
    const cron = routine.crons[0];
    const [, , day, , weekday] = cron?.trim().split(/\s+/) ?? [];
    if (
      routine.crons.length !== 1 ||
      !cron ||
      !routine.prompt.trim() ||
      /\0/.test(routine.name) ||
      /\0/.test(routine.prompt) ||
      !/^[\dA-Za-z*/, -]+$/.test(cron) ||
      // The source parsers differ on combined day-of-month and weekday expressions.
      (day !== "*" && weekday !== "*") ||
      !nextCronDateAcrossStrict(
        routine.crons,
        new Date("2026-01-01T00:00:00Z"),
        routine.timezone,
      ) ||
      extractForcedSkillName(routine.prompt) ||
      /(?:^|[\s(,])@[^\s,.)]/.test(routine.prompt) ||
      redactSecretText(routine.prompt) !== routine.prompt ||
      redactSecretText(routine.name) !== routine.name
    )
      return null;
    return routine;
  } catch {
    return null;
  }
}

export function readBackupRoutine(content: string): Routine | null {
  try {
    return validateBackupRoutine(JSON.parse(content));
  } catch {
    return null;
  }
}

// Bookkeeping fields can be left behind. Unsupported execution, authority, and
// scheduling fields must be reviewed separately before this job can be migrated.
const openClawFields = new Set([
  "id",
  "agentId",
  "name",
  "displayName",
  "description",
  "enabled",
  "createdAtMs",
  "updatedAtMs",
  "state",
  "schedule",
  "payload",
  "wakeMode",
  "sessionTarget",
  "delivery",
  "deleteAfterRun",
  "failureAlert",
  "configRevision",
  "nextRunAtMs",
  "lastRunAtMs",
  "lastRunStatus",
  "lastRunError",
  "lastDelivered",
  "lastDeliveryStatus",
  "lastDeliveryError",
  "deliverySuppressionReason",
  "lastFailureNotificationDelivered",
  "lastFailureNotificationDeliveryStatus",
  "lastFailureNotificationDeliveryError",
]);
const hermesFields = new Set([
  "id",
  "name",
  "prompt",
  "schedule",
  "schedule_display",
  "enabled",
  "state",
  "paused_at",
  "paused_reason",
  "created_at",
  "next_run_at",
  "last_run_at",
  "last_status",
  "last_error",
  "last_delivery_error",
  "last_delivery_unverified",
  "last_failure",
  "failure_streak",
  "deliver",
  "origin",
  "no_agent",
  "repeat",
  "skills",
  "skill",
  "model",
  "provider",
  "base_url",
  "script",
  "monitor_script",
  "monitor_url",
  "monitor_state",
  "context_from",
  "enabled_toolsets",
  "workdir",
  "timezone",
]);

// The source skips nonexistent local times and resolves folds differently from
// the Bot scheduler. Keep this source's auto-import to zones with fixed offsets.
const fixedOpenClawZones = new Set([
  "UTC",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Tokyo",
]);

function openClawFixedOffset(zone: string): boolean {
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  return (
    fixedOpenClawZones.has(canonical) ||
    canonical === "Asia/Calcutta" ||
    /^Etc\/GMT(?:[+-]\d{1,2})?$/.test(canonical)
  );
}

function jobRoutine(source: AgentBackupSource, job: Json): Routine | null {
  const schedule = record(job.schedule);
  const cron = text(schedule.expr);
  if (
    schedule.kind !== "cron" ||
    Object.keys(schedule).some(
      (key) =>
        !(
          source === "openclaw" ? ["kind", "expr", "tz", "staggerMs"] : ["kind", "expr", "display"]
        ).includes(key),
    )
  )
    return null;
  const fields = source === "openclaw" ? openClawFields : hermesFields;
  if (Object.keys(job).some((key) => !fields.has(key))) return null;
  const payload = record(job.payload);
  if (source === "openclaw") {
    const [minute, hour] = cron.split(/\s+/);
    const implicitStagger =
      minute === "0" && hour?.split(",").some((field) => field.startsWith("*"));
    if (
      payload.kind !== "agentTurn" ||
      (schedule.staggerMs === undefined ? implicitStagger : schedule.staggerMs !== 0) ||
      Object.keys(payload).some((key) => !["kind", "message"].includes(key)) ||
      job.sessionTarget !== "isolated" ||
      (job.wakeMode !== undefined && job.wakeMode !== "now") ||
      record(job.delivery).mode !== "none" ||
      Object.keys(record(job.delivery)).length !== 1 ||
      (present(job.deleteAfterRun) && job.deleteAfterRun !== false) ||
      (present(job.failureAlert) && job.failureAlert !== false)
    )
      return null;
  } else if (
    [
      "skill",
      "model",
      "provider",
      "base_url",
      "script",
      "monitor_script",
      "monitor_url",
      "monitor_state",
      "context_from",
      "enabled_toolsets",
      "workdir",
    ].some((key) => present(job[key])) ||
    (job.skills !== undefined && (!Array.isArray(job.skills) || job.skills.length > 0)) ||
    (job.no_agent !== undefined && job.no_agent !== false) ||
    !localHermesDelivery(job) ||
    (present(job.repeat) &&
      (!Object.hasOwn(record(job.repeat), "times") || record(job.repeat).times !== null))
  )
    return null;
  const zone = source === "openclaw" ? schedule.tz : job.timezone;
  // A backup without a known source timezone cannot preserve a wall-clock schedule.
  if (
    typeof zone !== "string" ||
    !isValidTimeZone(zone) ||
    (source === "openclaw" && !openClawFixedOffset(zone))
  )
    return null;
  const prompt = text(source === "openclaw" ? payload.message : job.prompt);
  if (prompt.startsWith("__openclaw")) return null;
  const name = text(job.name) || text(job.displayName) || "Routine";
  return validateBackupRoutine({ name, prompt, crons: [cron], timezone: zone });
}

/** Read only the selected agent's jobs. The raw job store never becomes a preview file. */
export function projectBackupJobs(
  source: AgentBackupSource,
  content: string,
  agentId: string | null,
): Job[] {
  let jobs: unknown;
  try {
    jobs = record(JSON.parse(content.replace(/^\uFEFF/, ""))).jobs;
  } catch {
    return [{ path: backupJobsPath, reason: "routineSchedule" }];
  }
  if (!Array.isArray(jobs) || jobs.length > AGENT_BACKUP_MAX_FILES)
    return [{ path: backupJobsPath, reason: "routineSchedule" }];
  if (source === "openclaw" && agentId === null)
    return [{ path: backupJobsPath, reason: "routineOwner" }];
  return jobs.flatMap((value, index): Job[] => {
    const job = record(value);
    const path = `cron/routine-${index + 1}.json`;
    if (source === "openclaw" && job.agentId !== agentId)
      return typeof job.agentId !== "string" || !job.agentId
        ? [{ path, reason: "routineOwner" as const }]
        : [];
    const routine = jobRoutine(source, job);
    return [routine ? { path, routine } : { path, reason: "routineSchedule" as const }];
  });
}
