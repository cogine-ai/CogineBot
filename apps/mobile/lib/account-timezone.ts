import { detectedTimezone, isValidTimeZone } from "@rakazo/contracts";
import type { MobileMe } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { captureMobileScope, isMobileScopeCurrent } from "./mobile-scope";

export { timezoneOptions } from "@rakazo/contracts";

export function validTimezone(zone: unknown): zone is string {
  return typeof zone === "string" && !!zone && isValidTimeZone(zone);
}

/** A missing or invalid device zone is not an instruction to persist UTC. */
export function deviceTimezone(): string | undefined {
  return detectedTimezone() ?? undefined;
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
    const requestContext = await captureApiRequestContext(null);
    if (!isCurrent() || !isMobileScopeCurrent(owner)) return undefined;
    const next = await rpc<MobileMe>("preferences/adoptTimezone", { timezone }, { requestContext });
    if (!isCurrent() || !isMobileScopeCurrent(owner) || next.userId !== me.userId) return undefined;
    return next.timezone === null || validTimezone(next.timezone) ? next.timezone : undefined;
  } catch {
    // The authenticated account keeps its UTC fallback and can retry on a later read.
    return undefined;
  }
}
