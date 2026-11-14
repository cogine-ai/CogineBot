import type { Routine } from "@rakazo/contracts";
import { isOneShotRoutineCrons } from "@rakazo/core";
import { t } from "./i18n";

export function needsOneShotTime(routine: Routine): boolean {
  return isOneShotRoutineCrons(routine.crons) && !routine.nextRunAt && !routine.lastRunAt;
}

/** Ordinary edits deliberately omit model pins, timezone and external triggers. */
export function routineFields(name: string, prompt: string, crons: string[]) {
  if (!name.trim() || name.trim().length > 80 || !prompt.trim()) {
    throw new Error(t("Add a name and prompt."));
  }
  return { name: name.trim(), prompt: prompt.trim(), crons };
}

export function routineActivation(routine: Routine, runAt: string, now = Date.now()) {
  const active = !routine.active;
  if (!active || !needsOneShotTime(routine)) return { active };
  const parsed = new Date(runAt);
  if (!runAt || !Number.isFinite(parsed.getTime()) || parsed.getTime() <= now) {
    throw new Error(t("Run time must be in the future."));
  }
  return { active, runAt: parsed.toISOString() };
}
