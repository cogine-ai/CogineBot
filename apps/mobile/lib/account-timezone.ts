import type { MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { captureMobileScope, isMobileScopeCurrent } from "./mobile-scope";

export function validTimezone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || /^[+-]/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A missing or invalid device zone is not an instruction to persist UTC. */
export function deviceTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimezone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

export function timezoneOptions(current: string): string[] {
  const zones = new Set<string>(["UTC", current]);
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      for (const zone of Intl.supportedValuesOf("timeZone")) zones.add(zone);
    }
  } catch {
    // Older native runtimes can still offer UTC and the accepted/device zone.
  }
  return [...zones].sort((a, b) => a.localeCompare(b));
}

/** Run only after an authenticated Me read; the server owns unset-only CAS. */
export async function adoptDeviceTimezone(
  me: MobileMe,
  isCurrent: () => boolean,
): Promise<string | null | undefined> {
  if (me.timezone !== null || !isCurrent()) return undefined;
  const timezone = deviceTimezone();
  if (!timezone) return undefined;
  const owner = captureMobileScope();
  try {
    const requestContext = await captureApiRequestContext();
    if (!isCurrent() || !isMobileScopeCurrent(owner)) return undefined;
    const next = await rpc<MobileMe>("preferences/adoptTimezone", { timezone }, { requestContext });
    if (!isCurrent() || !isMobileScopeCurrent(owner) || next.userId !== me.userId) return undefined;
    return next.timezone === null || validTimezone(next.timezone) ? next.timezone : undefined;
  } catch {
    // The authenticated account keeps its UTC fallback and can retry on a later read.
    return undefined;
  }
}
