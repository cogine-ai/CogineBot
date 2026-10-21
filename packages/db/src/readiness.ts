import { Pool } from "pg";

const CHECK_TIMEOUT_MS = 1500;

export interface ReadinessProbe {
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createReadinessProbe(connectionString: string): ReadinessProbe {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: CHECK_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
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
        // Transaction-local settings also work through proxies that reject
        // extra startup parameters. One query deadline covers the whole batch.
        const query = {
          text: "BEGIN; SET LOCAL statement_timeout = 1500; SELECT 1; COMMIT",
          query_timeout: CHECK_TIMEOUT_MS,
        };
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
