/** Destructive policy fixtures accept only the runner's explicitly isolated loopback database. */
export function isolatedPolicyDatabase(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fail = () => new Error("Requires isolated policy harness database");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw fail();
  }
  const database = url.pathname.slice(1);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !Number.isInteger(Number(url.port)) ||
    Number(url.port) <= 1024 ||
    !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
    // pg accepts connection overrides in query parameters; fixtures need none.
    url.search !== "" ||
    url.hash !== "" ||
    env.VERIFY_DATABASE !== "1" ||
    env.VERIFY_ROW_SECURITY_POLICIES !== "harness_isolated" ||
    env.VERIFY_ROW_SECURITY_POLICIES_DATABASE !== database ||
    env.VERIFY_ISOLATED_DATABASE !== database
  )
    throw fail();
  // pg-connection-string retains URL brackets in hostname. Supply the validated
  // IPv6 literal explicitly so pg connects to loopback rather than resolving "[::1]".
  if (url.hostname === "[::1]") url.searchParams.set("host", "::1");
  return { url, database };
}

/** Check the connected identity before any fixture mutation, not just the parsed URL. */
export function assertPolicyDatabaseIdentity(expected: string, rows: { database: string }[]) {
  if (rows.length !== 1 || rows[0]?.database !== expected)
    throw new Error("Connected database does not match the isolated policy fixture");
}
