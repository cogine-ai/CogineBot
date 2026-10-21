import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "./client.js";
import type { ReadinessProbe } from "./readiness.js";
import { createReadinessProbe } from "./readiness.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("database readiness (isolated PostgreSQL)", () => {
  let admin: Pool;
  const tag = `readiness-${randomUUID()}`;

  beforeAll(() => {
    admin = new Pool({ connectionString: databaseUrl!, max: 1 });
  });

  afterAll(async () => {
    await admin?.end();
  });

  function taggedUrl(suffix: string) {
    const url = new URL(databaseUrl!);
    url.searchParams.set("application_name", `${tag}-${suffix}`);
    return url;
  }

  async function connections(applicationName: string) {
    const result = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    return Number(result.rows[0]!.count);
  }

  it("reuses one idle backend and removes it on close", async () => {
    const url = taggedUrl("reuse");
    const name = url.searchParams.get("application_name")!;
    const probe = createReadinessProbe(url.toString());
    try {
      await probe.check();
      await probe.check();
      expect(await connections(name)).toBe(1);
      const backend = await admin.query<{ state: string; xact_start: Date | null }>(
        "SELECT state, xact_start FROM pg_stat_activity WHERE application_name = $1",
        [name],
      );
      expect(backend.rows).toEqual([{ state: "idle", xact_start: null }]);
      const closing = probe.close();
      expect(probe.close()).toBe(closing);
      await closing;
      await vi.waitFor(async () => expect(await connections(name)).toBe(0));
      await expect(probe.check()).rejects.toThrow("Readiness probe is closed");
    } finally {
      await probe.close();
    }
  });

  it("does not treat a fully checked-out business pool as a database outage", async () => {
    const businessUrl = taggedUrl("business");
    const business = createPool(businessUrl.toString(), { poolMax: 1 });
    const held = await business.connect();
    const url = taggedUrl("dedicated");
    const probe = createReadinessProbe(url.toString());
    try {
      await probe.check();
      expect(business.totalCount).toBe(1);
      expect(business.idleCount).toBe(0);
      expect(await connections(url.searchParams.get("application_name")!)).toBe(1);
    } finally {
      await probe.close();
      held.release();
      await business.end();
    }
  });

  it("fails on a real PostgreSQL connection limit and recovers after capacity returns", async () => {
    const role = `readiness_${randomUUID().replaceAll("-", "")}`;
    const url = taggedUrl("limited");
    url.username = role;
    url.password = "synthetic";
    let held: Client | undefined;
    let probe: ReadinessProbe | undefined;
    await admin.query(`CREATE ROLE ${role} LOGIN CONNECTION LIMIT 1 PASSWORD 'synthetic'`);
    try {
      held = new Client({ connectionString: url.toString() });
      await held.connect();
      probe = createReadinessProbe(url.toString());
      await expect(probe.check()).rejects.toMatchObject({ code: "53300" });
      await held.end();
      held = undefined;
      await probe.check();
      expect(await connections(url.searchParams.get("application_name")!)).toBe(1);
    } finally {
      await held?.end();
      await probe?.close();
      await admin.query(`DROP ROLE ${role}`);
    }
  });

  it.each(["50", "60000"])(
    "limits the transaction locally and restores session timeout=%s on the next checkout",
    async (timeout) => {
      const url = taggedUrl(`options-${timeout}`);
      url.searchParams.set("options", `-c search_path=public -c statement_timeout=${timeout}`);
      const pool = new Pool({ connectionString: url.toString(), max: 1 });
      const settings =
        "SELECT setting::int AS timeout_ms, current_setting('search_path') AS search_path, pg_backend_pid() AS pid FROM pg_settings WHERE name = 'statement_timeout'";
      try {
        const client = await pool.connect();
        let before: { timeout_ms: number; search_path: string; pid: number };
        try {
          const baseline = await client.query<typeof before>(settings);
          before = baseline.rows[0]!;
          expect(before.timeout_ms).toBe(Number(timeout));
          expect(before.search_path).toBe("public");
          // The wire tests prove the production factory uses one simple-query
          // packet. Inspect the same SET LOCAL transaction here without adding
          // an arbitrary-query seam to that factory.
          const query = {
            text: `BEGIN; SET LOCAL statement_timeout = 1500; ${settings}; COMMIT`,
            query_timeout: 1500,
          };
          const result: unknown = await client.query(query);
          expect(result).toMatchObject([
            { command: "BEGIN" },
            { command: "SET" },
            { command: "SELECT", rows: [{ ...before, timeout_ms: 1500 }] },
            { command: "COMMIT" },
          ]);
          expect(client.getTransactionStatus()).toBe("I");
        } finally {
          client.release();
        }
        const next = await pool.connect();
        try {
          const restored = await next.query<typeof before>(settings);
          expect(restored.rows).toEqual([before]);
          expect(next.getTransactionStatus()).toBe("I");
        } finally {
          next.release();
        }
      } finally {
        await pool.end();
      }
    },
  );
});
