import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@rakazo/contracts";
import {
  applyRowSecurityPolicies,
  createDb,
  createPool,
  describeRowSecurityPolicies,
  provisionRuntimeRole,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import {
  assertPolicyDatabaseIdentity,
  isolatedPolicyDatabase,
} from "../../../packages/testkit/src/isolated-policy-database.js";
import { createApp } from "./app.js";

const escapeIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const url = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  url
    ? describe.sequential
    : describe.skip;
const migration = await readFile(
  new URL(
    "../../../packages/db/prisma/migrations/20261113000000_mcp_create_requests/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
postgres("MCP receipt protected migration and restricted-role boundaries", () => {
  const suffix = randomBytes(8).toString("hex");
  const role = `receipt_runtime_${suffix}`;
  let group: string;
  let owner: ReturnType<typeof createDb>;
  let runtimeUrl: string;
  let ownerUrl: string;
  const userA = `receipt-a-${suffix}`,
    userB = `receipt-b-${suffix}`;
  const spaceA = `receipt-space-a-${suffix}`,
    spaceB = `receipt-space-b-${suffix}`;
  const org = `receipt-org-${suffix}`;
  async function query(sql: string, values: unknown[] = [], space?: string, user?: string) {
    const pool = createPool(runtimeUrl, { poolMax: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (space)
        await client.query(
          "SELECT set_config('app.space_id',$1,true),set_config('app.user_id',$2,true)",
          [space, user ?? ""],
        );
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
      await pool.end();
    }
  }
  async function recreate() {
    await owner.pool.query("DROP TABLE public.mcp_create_requests");
    await owner.pool.query(migration);
  }
  async function seed() {
    await owner.prisma.mcpCreateRequest.createMany({
      data: [
        { spaceId: spaceA, userId: userA, requestId: "own", serverId: "own-server" },
        {
          spaceId: spaceA,
          userId: userB,
          requestId: "same-space-other-user",
          serverId: "other-server",
        },
        {
          spaceId: spaceB,
          userId: userB,
          requestId: "other-space",
          serverId: "other-space-server",
        },
      ],
    });
  }
  beforeAll(async () => {
    const { url: parsed, database } = isolatedPolicyDatabase(url!);
    ownerUrl = parsed.toString();
    const candidate = createDb(ownerUrl);
    try {
      assertPolicyDatabaseIdentity(
        database,
        (await candidate.pool.query("SELECT current_database() AS database")).rows,
      );
    } catch (error) {
      await candidate.prisma.$disconnect();
      await candidate.pool.end();
      throw error;
    }
    owner = candidate;
    group = `coginebot_app_${(await owner.pool.query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows[0].oid}`;
    parsed.username = role;
    parsed.password = randomBytes(24).toString("hex");
    runtimeUrl = parsed.toString();
    await provisionRuntimeRole(ownerUrl, runtimeUrl);
    await owner.prisma.user.createMany({
      data: [userA, userB].map((id) => ({
        id,
        name: "Receipt fixture",
        email: `${id}@example.test`,
      })),
    });
    await owner.prisma.organization.create({
      data: { id: org, slug: org, name: "Receipt fixture", createdAt: new Date() },
    });
    await owner.prisma.space.createMany({
      data: [spaceA, spaceB].map((id) => ({ id, organizationId: org, name: "Receipt fixture" })),
    });
  });
  afterAll(async () => {
    if (!owner) return;
    await owner.prisma.organization.deleteMany({ where: { id: org } });
    await owner.prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    for (const name of [role, group].filter(Boolean)) {
      await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(name)}`);
      await owner.pool.query(`DROP ROLE ${escapeIdentifier(name)}`);
    }
    await owner.prisma.$disconnect();
    await owner.pool.end();
  });
  it("keeps an unactivated fresh deployment under centralized policy activation", async () => {
    await recreate();
    expect(
      (
        await owner.pool.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='mcp_create_requests' AND indexname='mcp_create_requests_userId_idx'",
        )
      ).rows[0]?.indexdef,
    ).toContain('("userId")');
    expect(
      (
        await owner.pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.mcp_create_requests'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);
    expect(
      (
        await owner.pool.query(
          "SELECT polname FROM pg_policy WHERE polrelid='public.mcp_create_requests'::regclass",
        )
      ).rows,
    ).toEqual([]);
  });
  it("F3: protects the incremental table before an activated deployment's migration commits", async () => {
    await applyRowSecurityPolicies(ownerUrl, runtimeUrl);
    await recreate();
    await seed();
    const runtime = createDb(runtimeUrl, { rowSecurity: true });
    try {
      expect(await describeRowSecurityPolicies(runtime.prisma)).toMatchObject({
        policyInstalled: true,
        connectionEnforced: true,
        guardValid: true,
      });
    } finally {
      await runtime.prisma.$disconnect();
      await runtime.pool.end();
    }
    expect(
      (await query('SELECT "requestId" FROM public.mcp_create_requests', [], spaceA, userA)).rows,
    ).toEqual([{ requestId: "own" }]);

    expect
      .soft(
        (
          await owner.pool.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.mcp_create_requests'::regclass",
          )
        ).rows,
      )
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect
      .soft(
        (
          await owner.pool.query(
            "SELECT polname FROM pg_policy WHERE polrelid='public.mcp_create_requests'::regclass ORDER BY polname",
          )
        ).rows.map((r) => r.polname),
      )
      .toEqual(["mcp_create_requests_system", "mcp_create_requests_tenant"]);
    expect.soft((await query("SELECT * FROM public.mcp_create_requests")).rows).toEqual([]);
    expect
      .soft(
        (
          await query(
            'UPDATE public.mcp_create_requests SET "serverId"=\'forbidden\' WHERE "spaceId"=$1',
            [spaceB],
            spaceA,
            userA,
          )
        ).rowCount,
      )
      .toBe(0);
  });
  it("F4: the installed policy denies another user in the same Space", async () => {
    await applyRowSecurityPolicies(ownerUrl, runtimeUrl);
    expect
      .soft(
        (
          await query(
            'SELECT "requestId" FROM public.mcp_create_requests ORDER BY "requestId"',
            [],
            spaceA,
            userA,
          )
        ).rows,
      )
      .toEqual([{ requestId: "own" }]);
    expect
      .soft(
        (
          await query(
            'UPDATE public.mcp_create_requests SET "serverId"=\'forbidden\' WHERE "userId"=$1',
            [userB],
            spaceA,
            userA,
          )
        ).rowCount,
      )
      .toBe(0);
    expect
      .soft(
        (
          await query(
            'DELETE FROM public.mcp_create_requests WHERE "userId"=$1',
            [userB],
            spaceA,
            userA,
          )
        ).rowCount,
      )
      .toBe(0);
  });
  it("denies unscoped and foreign inserts while allowing scoped receipt writes with no elevated grants", async () => {
    for (const [space, user, targetSpace, targetUser] of [
      [undefined, undefined, spaceA, userA],
      [spaceA, userA, spaceB, userA],
      [spaceA, userA, spaceA, userB],
    ]) {
      await expect(
        query(
          'INSERT INTO public.mcp_create_requests ("spaceId","userId","requestId") VALUES ($1,$2,$3)',
          [targetSpace, targetUser, randomUUID()],
          space,
          user,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(
      (
        await query(
          "UPDATE public.mcp_create_requests SET \"serverId\"='updated' WHERE \"requestId\"='own'",
          [],
          spaceA,
          userA,
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
      has_table_privilege(current_user,c.oid,'SELECT') AS read,has_table_privilege(current_user,c.oid,'INSERT') AS insert,
      has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS delete,
      has_table_privilege(current_user,c.oid,'TRUNCATE,TRIGGER,REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION') AS elevated,
      has_schema_privilege(current_user,'public','CREATE') AS ddl
      FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.mcp_create_requests'::regclass`)
      ).rows,
    ).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        owns: false,
        read: true,
        insert: true,
        update: true,
        delete: true,
        elevated: false,
        ddl: false,
      },
    ]);
    await expect(
      query("ALTER TABLE public.mcp_create_requests ADD COLUMN forbidden text"),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("supports real authenticated creation/readback/cancellation and preserves deletion lifecycle", async () => {
    const runtime = createDb(runtimeUrl, { rowSecurity: true });
    const dir = await mkdtemp(join(tmpdir(), "receipt-protected-app-"));
    const origin = "http://127.0.0.1:5173";
    const app = await createApp({
      prisma: runtime.prisma,
      databaseUrl: runtimeUrl,
      dataDir: dir,
      encryptionKey: "synthetic-receipt-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
    });
    let accountId = "",
      organizationId = "";
    try {
      const signup = await app.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          name: "Receipt fixture",
          email: `${randomUUID()}@example.test`,
          password: "synthetic-fixture-password",
        }),
      });
      expect(signup.status).toBe(200);
      const cookie = sessionCookieHeader(signup);
      async function rpc<T>(procedure: string, input: unknown = {}) {
        const response = await app.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { json: T }).json;
      }
      const actor = await rpc<Actor>("me");
      accountId = actor.userId;
      organizationId = (
        await owner.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } })
      ).organizationId;
      const { requestId } = await rpc<{ requestId: string }>("mcp/servers/newCreateRequest");
      const receipt = await rpc<{ serverId: string }>("mcp/servers/createOnce", {
        requestId,
        config: {
          slug: "protected",
          name: "Protected fixture",
          transport: "stdio",
          command: "fixture",
        },
      });
      expect(await rpc("mcp/servers/creation", { requestId })).toEqual(receipt);
      expect(await rpc("mcp/servers/cancelCreate", { requestId })).toEqual(receipt);
      await rpc("mcp/servers/remove", { id: receipt.serverId });
      expect(await rpc("mcp/servers/creation", { requestId })).toEqual(receipt);
      const canceled = await rpc<{ requestId: string }>("mcp/servers/newCreateRequest");
      expect(await rpc("mcp/servers/cancelCreate", canceled)).toEqual({
        ...canceled,
        serverId: null,
      });
      await owner.prisma.space.delete({ where: { id: actor.spaceId } });
      expect(await owner.prisma.mcpCreateRequest.count({ where: { spaceId: actor.spaceId } })).toBe(
        0,
      );
      await owner.prisma.mcpCreateRequest.create({
        data: { spaceId: spaceA, userId: accountId, requestId: "user-cascade" },
      });
      await owner.prisma.user.delete({ where: { id: accountId } });
      expect(await owner.prisma.mcpCreateRequest.count({ where: { userId: accountId } })).toBe(0);
    } finally {
      await app.stop();
      await runtime.prisma.$disconnect();
      await runtime.pool.end();
      if (organizationId)
        await owner.prisma.organization.deleteMany({ where: { id: organizationId } });
      if (accountId) await owner.prisma.user.deleteMany({ where: { id: accountId } });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
