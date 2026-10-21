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
    "applies the startup statement timeout after conflicting options=%s",
    async (timeout) => {
      const url = taggedUrl(`options-${timeout}`);
      url.searchParams.set("options", `-c search_path=public -c statement_timeout=${timeout}`);
      // The wire tests assert the factory preserves `options` and sends exactly
      // this final startup field. Query settings here to verify server precedence.
      url.searchParams.set("statement_timeout", "1500");
      const client = new Client({ connectionString: url.toString() });
      try {
        await client.connect();
        const result = await client.query<{ timeout: string; search_path: string }>(
          "SELECT current_setting('statement_timeout') AS timeout, current_setting('search_path') AS search_path",
        );
        expect(result.rows[0]).toEqual({ timeout: "1500ms", search_path: "public" });
      } finally {
        await client.end();
      }
    },
  );
});
