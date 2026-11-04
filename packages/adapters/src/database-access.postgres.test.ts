import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { NativeDiscordSignalJobSchema } from "@rakazo/contracts";
import {
  createDb,
  describeRowSecurity,
  installDbContext,
  JOB_QUEUE_POLICY,
  provisionRuntimeRole,
  RUNTIME_ROLE,
  runAsSystem,
} from "@rakazo/db";
import { escapeIdentifier, escapeLiteral } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost, migrateJobQueue } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("runtime role preparation (isolated PostgreSQL)", () => {
  const suffix = randomBytes(8).toString("hex");
  const login = `cogine_role_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const allocated = new Set<string>([login]);
  const probeTable = `role_probe_${suffix}`;
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb> | undefined;
  let runtimeUrl: string;
  let createdGroup = false;

  function urlFor(name: string, secret: string) {
    const url = new URL(databaseUrl!);
    url.username = name;
    url.password = secret;
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    return url.toString();
  }
  async function close(client: ReturnType<typeof createDb>) {
    try {
      await client.prisma.$disconnect();
    } finally {
      await client.pool.end();
    }
  }
  async function digestCount() {
    return Number(
      (await owner.pool.query("SELECT count(*) AS total FROM cogine_private.rls_bypass_keys"))
        .rows[0].total,
    );
  }
  function environment(values: Record<string, string | undefined>) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    const apply = (entries: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    apply(values);
    return () => apply(previous);
  }
  async function createLogin(name: string, attributes = "") {
    allocated.add(name);
    await owner.pool.query(
      "CREATE ROLE " +
        escapeIdentifier(name) +
        " LOGIN PASSWORD " +
        escapeLiteral(password) +
        " " +
        attributes,
    );
  }

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    createdGroup = !(
      await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE])
    ).rowCount;
    runtimeUrl = urlFor(login, password);
    await owner.pool.query(
      "CREATE TABLE public." +
        escapeIdentifier(probeTable) +
        " (id integer PRIMARY KEY, content text NOT NULL)",
    );
    await migrateJobQueue(databaseUrl!);
  });
  afterAll(async () => {
    if (runtime) await close(runtime);
    if (!owner) return;
    for (const name of allocated) {
      if ((await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount) {
        await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(name)}`);
        await owner.pool.query(`DROP ROLE ${escapeIdentifier(name)}`);
      }
    }
    await owner.pool.query(`DROP TABLE IF EXISTS public.${escapeIdentifier(probeTable)}`);
    if (
      createdGroup &&
      (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE])).rowCount
    ) {
      const policies = await owner.pool.query(
        "SELECT n.nspname, c.relname, p.polname FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE p.polname=$1",
        [JOB_QUEUE_POLICY],
      );
      for (const policy of policies.rows)
        await owner.pool.query(
          "DROP POLICY " +
            escapeIdentifier(policy.polname) +
            " ON " +
            escapeIdentifier(policy.nspname) +
            "." +
            escapeIdentifier(policy.relname),
        );
      await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(RUNTIME_ROLE)}`);
      await owner.pool.query(`DROP ROLE ${escapeIdentifier(RUNTIME_ROLE)}`);
    }
    await close(owner);
  });

  it("creates a restricted login, registers its authenticated key and reports preparation without enforcement", async () => {
    expect(await provisionRuntimeRole(databaseUrl!, runtimeUrl)).toEqual({});
    expect(
      (await owner.pool.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [login])).rows,
    ).toEqual([{ rolname: login }]);
    runtime = createDb(runtimeUrl, { poolMax: 6, rowSecurity: true });
    expect(
      (
        await runtime.pool.query(
          "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=session_user",
        )
      ).rows,
    ).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
      },
    ]);
    expect(await describeRowSecurity(runtime.prisma)).toMatchObject({
      prepared: true,
      enforced: false,
      role: login,
    });
    expect(
      (
        await runAsSystem("runtime preparation fixture", () =>
          runtime!.pool.query("SELECT app_rls_bypass() AS allowed"),
        )
      ).rows,
    ).toEqual([{ allowed: true }]);
    expect((await runtime.pool.query("SELECT app_rls_bypass() AS allowed")).rows).toEqual([
      { allowed: false },
    ]);
    await runtime.pool.query(`INSERT INTO public.${escapeIdentifier(probeTable)} VALUES (1, $1)`, [
      "fixture content",
    ]);
    expect(
      (await runtime.pool.query(`SELECT content FROM public.${escapeIdentifier(probeTable)}`)).rows,
    ).toEqual([{ content: "fixture content" }]);
  });

  it("is idempotent and preserves registered digests used by existing pools", async () => {
    await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys(digest) VALUES (sha256(convert_to($1,'UTF8'))) ON CONFLICT DO NOTHING",
      [`fixture old active key ${suffix}`],
    );
    const before = await digestCount();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    expect(await digestCount()).toBe(before);
  });

  it("uses PGPASSWORD from successful runtime authentication", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const restore = environment({ PGPASSWORD: password });
    try {
      const before = await digestCount();
      await provisionRuntimeRole(databaseUrl!, url.toString());
      expect(await digestCount()).toBe(before);
    } finally {
      restore();
    }
  });

  it("uses an isolated password file and leaves no fixture secret file", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const folder = await mkdtemp(path.join(tmpdir(), "role-auth-"));
    const file = path.join(folder, "pgpass");
    const escapeField = (value: string) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
    await writeFile(
      file,
      [url.hostname, url.port, url.pathname.slice(1), login, password].map(escapeField).join(":") +
        "\n",
      { mode: 0o600 },
    );
    const restore = environment({ PGPASSWORD: undefined, PGPASSFILE: file });
    try {
      const before = await digestCount();
      await provisionRuntimeRole(databaseUrl!, url.toString());
      expect(await digestCount()).toBe(before);
    } finally {
      restore();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("preserves the registry on failed authentication", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const before = await digestCount();
    const restore = environment({ PGPASSWORD: "wrong-fixture-password" });
    try {
      await expect(provisionRuntimeRole(databaseUrl!, url.toString())).rejects.toThrow();
      expect(await digestCount()).toBe(before);
    } finally {
      restore();
    }
  });

  it("denies private registry, migration-ledger mutation and schema DDL", async () => {
    await expect(
      runtime!.pool.query("SELECT digest FROM cogine_private.rls_bypass_keys"),
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query('DELETE FROM public."_prisma_migrations" WHERE false'),
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query(
        `CREATE TABLE public.${escapeIdentifier(`denied_${suffix}`)}(id integer)`,
      ),
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query(`CREATE SCHEMA ${escapeIdentifier(`denied_${suffix}`)}`),
    ).rejects.toThrow();
    await expect(
      runtime!.pool.query(
        `ALTER TABLE public.${escapeIdentifier(probeTable)} ADD COLUMN denied integer`,
      ),
    ).rejects.toThrow();
  });

  it("does not change a preexisting privileged login", async () => {
    const unsafe = `${login}_admin`;
    await createLogin(unsafe, "SUPERUSER");
    const before = await digestCount();
    await expect(provisionRuntimeRole(databaseUrl!, urlFor(unsafe, password))).rejects.toThrow();
    expect(
      (await owner.pool.query("SELECT rolsuper FROM pg_roles WHERE rolname=$1", [unsafe])).rows,
    ).toEqual([{ rolsuper: true }]);
    expect(await digestCount()).toBe(before);
  });

  it("rejects inherited privileged memberships without removing them", async () => {
    const unsafe = `${login}_readall`;
    await createLogin(unsafe);
    await owner.pool.query(`GRANT pg_read_all_data TO ${escapeIdentifier(unsafe)}`);
    await expect(provisionRuntimeRole(databaseUrl!, urlFor(unsafe, password))).rejects.toThrow();
    expect(
      (
        await owner.pool.query("SELECT pg_has_role($1,'pg_read_all_data','MEMBER') AS member", [
          unsafe,
        ])
      ).rows,
    ).toEqual([{ member: true }]);
  });

  it("rejects direct protected-column and CREATE privileges", async () => {
    await owner.pool.query(
      `GRANT SELECT(digest) ON cogine_private.rls_bypass_keys TO ${escapeIdentifier(login)}`,
    );
    try {
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(
        `REVOKE SELECT(digest) ON cogine_private.rls_bypass_keys FROM ${escapeIdentifier(login)}`,
      );
    }
    await owner.pool.query(`GRANT CREATE ON SCHEMA public TO ${escapeIdentifier(login)}`);
    try {
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(`REVOKE CREATE ON SCHEMA public FROM ${escapeIdentifier(login)}`);
    }
    const database = (await owner.pool.query("SELECT current_database() AS name")).rows[0]
      .name as string;
    await owner.pool.query(
      `GRANT CREATE ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(login)}`,
    );
    try {
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(
        `REVOKE CREATE ON DATABASE ${escapeIdentifier(database)} FROM ${escapeIdentifier(login)}`,
      );
    }
    expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
      prepared: true,
      enforced: false,
    });
  });

  it("does not report a NOINHERIT login ready when it cannot use the runtime group", async () => {
    const isolated = `${login}_noinherit`;
    await createLogin(isolated, "NOINHERIT");
    await expect(provisionRuntimeRole(databaseUrl!, urlFor(isolated, password))).rejects.toThrow();
    const client = createDb(urlFor(isolated, password), { poolMax: 1, rowSecurity: true });
    try {
      expect(await describeRowSecurity(client.prisma)).toMatchObject({
        prepared: false,
        enforced: false,
      });
    } finally {
      await close(client);
    }
    expect(
      (await owner.pool.query("SELECT rolinherit FROM pg_roles WHERE rolname=$1", [isolated])).rows,
    ).toEqual([{ rolinherit: false }]);
  });

  it("checks the effective execution role selected by connection options", async () => {
    const lower = `${login}_lower`;
    await createLogin(lower);
    await owner.pool.query(`GRANT ${escapeIdentifier(lower)} TO ${escapeIdentifier(login)}`);
    const url = new URL(runtimeUrl);
    url.searchParams.set("options", `-crole=${lower}`);
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      expect(
        (await client.pool.query("SELECT current_user AS current, session_user AS session")).rows,
      ).toEqual([{ current: lower, session: login }]);
      expect(await describeRowSecurity(client.prisma)).toMatchObject({
        prepared: false,
        enforced: false,
      });
      await expect(provisionRuntimeRole(databaseUrl!, url.toString())).rejects.toThrow();
    } finally {
      await close(client);
      await owner.pool.query(`REVOKE ${escapeIdentifier(lower)} FROM ${escapeIdentifier(login)}`);
    }
  });

  it("does not let a privileged session claim readiness by selecting a restricted role", async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-crole=${login}`);
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    const key = await installDbContext(client.pool)();
    const inserted = await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys(digest) VALUES (sha256(convert_to($1,'UTF8'))) ON CONFLICT DO NOTHING RETURNING digest",
      [key],
    );
    try {
      expect(await describeRowSecurity(client.prisma)).toMatchObject({
        prepared: false,
        enforced: false,
      });
    } finally {
      await close(client);
      if (inserted.rowCount)
        await owner.pool.query(
          "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
          [key],
        );
    }
  });

  it("supports a pregranted login when the migration session cannot create roles", async () => {
    const limited = `${login}_migrator`;
    await createLogin(limited, "NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS");
    const administrator = (await owner.pool.query("SELECT current_user AS name")).rows[0]
      .name as string;
    await owner.pool.query(
      `GRANT ${escapeIdentifier(administrator)} TO ${escapeIdentifier(limited)}`,
    );
    expect(
      (await owner.pool.query("SELECT rolcreaterole FROM pg_roles WHERE rolname=$1", [limited]))
        .rows,
    ).toEqual([{ rolcreaterole: false }]);
    expect(await provisionRuntimeRole(urlFor(limited, password), runtimeUrl)).toEqual({});
    const bad = new URL(runtimeUrl);
    bad.password = "invalid-precreated-fixture-password";
    const before = await digestCount();
    await expect(provisionRuntimeRole(urlFor(limited, password), bad.toString())).rejects.toThrow();
    expect(await digestCount()).toBe(before);
  });

  it("schema-qualifies migration revocation under a shadowed owner search_path", async () => {
    const shadow = `role_shadow_${suffix}`;
    await owner.pool.query(`CREATE SCHEMA ${escapeIdentifier(shadow)}`);
    await owner.pool.query(
      `CREATE TABLE ${escapeIdentifier(shadow)}."_prisma_migrations"(id text)`,
    );
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-csearch_path=${shadow},public`);
    try {
      await provisionRuntimeRole(url.toString(), runtimeUrl);
      expect(
        (
          await owner.pool.query(
            "SELECT has_table_privilege($1,'public._prisma_migrations','INSERT') AS allowed",
            [login],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
    } finally {
      await owner.pool.query(`DROP SCHEMA ${escapeIdentifier(shadow)} CASCADE`);
    }
  });

  it("probes the public guard despite a runtime search_path shadow function", async () => {
    const shadow = `guard_shadow_${suffix}`;
    await owner.pool.query(`CREATE SCHEMA ${escapeIdentifier(shadow)}`);
    await owner.pool.query(
      `CREATE FUNCTION ${escapeIdentifier(shadow)}.app_rls_bypass() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false'`,
    );
    await owner.pool.query(
      `GRANT USAGE ON SCHEMA ${escapeIdentifier(shadow)} TO ${escapeIdentifier(login)}`,
    );
    const url = new URL(runtimeUrl);
    url.searchParams.set("options", `-csearch_path=${shadow},public`);
    const client = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      expect(
        (
          await runAsSystem("fixture shadowed guard", () =>
            client.pool.query("SELECT app_rls_bypass() AS allowed"),
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      expect(await describeRowSecurity(client.prisma)).toMatchObject({
        prepared: true,
        enforced: false,
      });
    } finally {
      await close(client);
      await owner.pool.query(`DROP SCHEMA ${escapeIdentifier(shadow)} CASCADE`);
    }
  });

  it("starts the real publisher and worker as the restricted runtime without DDL", async () => {
    const publisher = new GraphileJobPublisher(runtime!.pool);
    const host = new GraphileJobWorkerHost(runtime!.pool, { concurrency: 1, pollInterval: 25 });
    const received: unknown[] = [];
    const noop = async () => undefined;
    const handlers: BackgroundJobHandlers = {
      "native.source.poll": noop,
      "native.notion.signal": noop,
      "native.discord.signal": async (payload) => {
        received.push(payload);
      },
      "native.slack.signal": noop,
      "native.slack.lifecycle": noop,
      "run.continue": noop,
      "routine.wakeup": noop,
      "computer.update": noop,
      "computer.sleep": noop,
      "computer.control-expire": noop,
      "skill.teaching-expire": noop,
      "history.compact": noop,
      "messaging.deliver": noop,
      "cloud_agent.poll": noop,
    };
    const payload = NativeDiscordSignalJobSchema.parse({
      triggerId: "fixture-trigger",
      triggerVersion: 1,
      userId: "fixture-user",
      spaceId: "fixture-space",
      configId: "fixture-config",
      configRevision: 1,
      connectionId: "fixture-connection",
      authorizationRevision: "fixture-revision",
      grantId: "fixture-grant",
      authGeneration: 1,
      interaction: {
        id: "123456",
        applicationId: "123457",
        guildId: "123458",
        channelId: "123459",
        commandId: "123460",
        commandName: "fixture",
        userId: "123461",
        options: [{ name: "text", type: 3, value: "normalized fixture event content" }],
      },
    });
    try {
      await host.start(handlers);
      await publisher.enqueue({ name: "native.discord.signal", payload });
      await vi.waitFor(() => expect(received).toEqual([payload]), {
        timeout: 10_000,
        interval: 25,
      });
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  it("serializes concurrent preparation of the same new login", async () => {
    const name = `${login}_concurrent`;
    allocated.add(name);
    const url = urlFor(name, password);
    expect(
      await Promise.all([
        provisionRuntimeRole(databaseUrl!, url),
        provisionRuntimeRole(databaseUrl!, url),
      ]),
    ).toEqual([{}, {}]);
    const client = createDb(url, { poolMax: 1, rowSecurity: true });
    try {
      expect(await describeRowSecurity(client.prisma)).toMatchObject({
        prepared: true,
        enforced: false,
      });
    } finally {
      await close(client);
    }
  });

  it("rejects an unsafe grant role before creating another runtime login", async () => {
    const name = `${login}_blocked`;
    allocated.add(name);
    await owner.pool.query(`ALTER ROLE ${escapeIdentifier(RUNTIME_ROLE)} BYPASSRLS`);
    try {
      await expect(provisionRuntimeRole(databaseUrl!, urlFor(name, password))).rejects.toThrow();
      expect(
        (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount,
      ).toBe(0);
    } finally {
      await owner.pool.query(`ALTER ROLE ${escapeIdentifier(RUNTIME_ROLE)} NOBYPASSRLS`);
    }
  });

  it("runs the administrative CLI without printing database credentials", async () => {
    const result = await promisify(execFile)("pnpm", ["db:migrate"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, DATABASE_URL: runtimeUrl, DATABASE_MIGRATION_URL: databaseUrl },
      timeout: 30_000,
    });
    expect(result.stdout).toContain("Runtime role and system key are ready");
    expect(result.stdout).toContain("not activated");
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(result.stdout + result.stderr).not.toContain(runtimeUrl);
  });

  it("keeps the shared-login migration path explicit without claiming preparation", async () => {
    const result = await promisify(execFile)("pnpm", ["db:migrate"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_MIGRATION_URL: databaseUrl },
      timeout: 30_000,
    });
    expect(result.stderr).toContain("not enforced");
    expect(result.stdout).not.toContain("Runtime role and system key are ready");
    expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
      prepared: true,
      enforced: false,
    });
  });

  it("fails the CLI on invalid effective credentials while preserving the registry", async () => {
    const url = new URL(runtimeUrl);
    url.password = "";
    const before = await digestCount();
    let failed: unknown;
    try {
      await promisify(execFile)("pnpm", ["db:migrate"], {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          DATABASE_MIGRATION_URL: databaseUrl,
          PGPASSWORD: "invalid-fixture-cli-password",
        },
        timeout: 30_000,
      });
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeDefined();
    const output = failed as { stdout?: string; stderr?: string };
    expect((output.stdout ?? "") + (output.stderr ?? "")).not.toContain(
      "invalid-fixture-cli-password",
    );
    expect((output.stdout ?? "") + (output.stderr ?? "")).not.toContain(password);
    expect(await digestCount()).toBe(before);
  });
});
