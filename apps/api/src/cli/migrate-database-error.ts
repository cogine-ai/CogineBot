const advice =
  "Check the administrator connection, runtime role grants, and credential configuration.";
const fallback = `Database preparation failed. ${advice}\n`;
const safeCommandErrors = new Set([
  "Administrator and runtime database credentials must use distinct passwords",
  "DATABASE_URL is required",
  "Database preparation requires migration and runtime URLs to use the same host, port, and database",
  "The migration URL target must match both database clients; use an explicit database path and matching host and port",
  "Database preparation requires the migration URL to select the public schema",
  "DATABASE_URL must name the runtime login",
  "The authenticated runtime role is not restricted",
  "The authenticated session role is unavailable",
  "The authenticated session role is not restricted",
  "The runtime execution and session roles must inherit their required runtime grants",
  "The configured runtime role is privileged or owns application data; it was not changed",
  "Could not resolve the database runtime grant role",
  "The database runtime grant role has authority in another database; it was not changed",
  "The runtime grant role is not restricted",
  "A new runtime login requires an explicit password; precreate it when using external credential resolution",
  "Runtime role preparation failed",
  "Use db:restore prepare or db:restore verify",
  "Stop database writers before verifying the restored database",
  "The restore runtime grant role must be an unused restricted NOLOGIN role",
  "A selected runtime credential is required",
  "The restored database role, policies, or system guard are not ready",
  "The restored database has authority outside the selected owner and runtime roles",
  "The restored database contains system keys outside the selected credential inventory",
  "Protected system database access requires an authenticated password",
  "Protected database access requires an authenticated password",
  "Database authentication changed; create a new pool and register its key",
]);
const safeStatusErrors = new Map<string, string>([
  ["could not read the runtime role", "Could not read the runtime role"],
  ["is a superuser", "The runtime role is a superuser"],
  ["has BYPASSRLS", "The runtime role has BYPASSRLS"],
  [
    "has database or role administration privileges",
    "The runtime role has database or role administration privileges",
  ],
  [
    "owns protected database objects or belongs to their owner role",
    "The runtime role owns protected database objects or belongs to their owner role",
  ],
  [
    "has inherited or additional protected database privileges",
    "The runtime role has inherited or additional protected database privileges",
  ],
  [
    "the execution role does not inherit runtime grants",
    "The execution role does not inherit runtime grants",
  ],
  [
    "could not read the authenticated session role",
    "Could not read the authenticated session role",
  ],
  [
    "the session role does not inherit runtime grants",
    "The session role does not inherit runtime grants",
  ],
  ["the system key is not registered", "The system key is not registered"],
]);

function safeCommandMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  if (safeCommandErrors.has(message)) return message;
  const statusHint = safeStatusErrors.get(message);
  if (statusHint) return statusHint;
  const creation =
    /^Could not create coginebot_app_([1-9][0-9]{0,9}); precreate a restricted runtime grant role or use a migration role with CREATEROLE$/.exec(
      message,
    );
  const managed =
    /^The migration role cannot create or change the runtime login\. Precreate a LOGIN NOBYPASSRLS role and grant coginebot_app_([1-9][0-9]{0,9}), then retry\.$/.exec(
      message,
    );
  const match = creation ?? managed;
  if (!match || Number(match[1]) > 4294967295) return undefined;
  const role = `coginebot_app_${match[1]}`;
  const safe = creation
    ? `Could not create ${role}; precreate a restricted runtime grant role or use a migration role with CREATEROLE`
    : `The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant ${role}, then retry.`;
  return message === safe ? safe : undefined;
}

/** Keep exact command hints and validated SQLSTATEs while hiding all other error text. */
export function formatDatabasePreparationFailure(error: unknown): string {
  try {
    const hasCode = error !== null && typeof error === "object" && "code" in error;
    const code = hasCode ? error.code : undefined;
    const sqlState =
      typeof code === "string" && code.length === 5 && /^[0-9A-Z]{5}$/.test(code)
        ? ` (${code})`
        : "";
    const rawMessage = !hasCode && error instanceof Error ? error.message : undefined;
    const message = safeCommandMessage(rawMessage);
    const hint = message ? ` ${message}${message.endsWith(".") ? "" : "."}` : "";
    return `Database preparation failed${sqlState}.${hint} ${advice}\n`;
  } catch {
    return fallback;
  }
}
