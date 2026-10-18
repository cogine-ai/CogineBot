/** Allow only existing setup or a fixed native OAuth kickoff, never an arbitrary redirect. */
export function authDestination(next: string | null): string {
  if (next === "/integrations/setup") return next;
  if (next && /^\/api\/connectors\/oauth\/start\?state=[A-Za-z0-9_-]{43}$/.test(next)) return next;
  return "/app";
}

export function isNativeAuthDestination(path: string): boolean {
  return path.startsWith("/api/connectors/oauth/start?") && authDestination(path) === path;
}
