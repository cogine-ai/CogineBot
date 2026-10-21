import { Pool } from "pg";

const CHECK_TIMEOUT_MS = 1500;

export interface ReadinessProbe {
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createReadinessProbe(connectionString: string): ReadinessProbe {
  // pg lets URL parameters override Pool defaults. Append only this probe's
  // timeout, retaining SSL, socket, and other connection options verbatim.
  const fragmentIndex = connectionString.indexOf("#");
  const address = fragmentIndex < 0 ? connectionString : connectionString.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : connectionString.slice(fragmentIndex);
  const probeConnectionString = connectionString.startsWith("/")
    ? connectionString
    : `${address}${address.includes("?") ? "&" : "?"}statement_timeout=${CHECK_TIMEOUT_MS}${fragment}`;
  const pool = new Pool({
    connectionString: probeConnectionString,
    max: 1,
    connectionTimeoutMillis: CHECK_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    statement_timeout: CHECK_TIMEOUT_MS,
    query_timeout: CHECK_TIMEOUT_MS,
    pipeline: false,
  });
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  let closing: Promise<void> | undefined;
  return {
    async check() {
      if (closing) throw new Error("Readiness probe is closed");
      const client = await pool.connect();
      let failed = true;
      try {
        const query = { text: "SELECT 1", query_timeout: CHECK_TIMEOUT_MS };
        await client.query(query);
        failed = false;
      } finally {
        // A query read timeout alone leaves a non-pipelined socket active.
        // Error release removes the client and destroys any active query socket.
        client.release(failed);
      }
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
  };
}
