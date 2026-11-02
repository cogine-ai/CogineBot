import { parseDeploymentTransferPage } from "@rakazo/core";

/** Allow only protected product flows or a fixed native OAuth kickoff. */
export function authDestination(next: string | null): string {
  if (next === "/integrations/setup") return next;
  if (next && /^\/api\/connectors\/oauth\/start\?state=[A-Za-z0-9_-]{43}$/.test(next)) return next;
  if (next && parseDeploymentTransferPage(next)) return next;
  return "/app";
}

export function isTransferAuthDestination(path: string): boolean {
  return parseDeploymentTransferPage(path) !== null;
}

export function isNativeAuthDestination(path: string): boolean {
  return path.startsWith("/api/connectors/oauth/start?") && authDestination(path) === path;
}
