import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
  rlsBypassKey,
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
  let grantRole: string;
  let knownGrantRoles: Set<string>;

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
  async function createLogin(name: string, attributes = "", secret = password) {
    allocated.add(name);
    await owner.pool.query(
      "CREATE ROLE " +
        escapeIdentifier(name) +
        " LOGIN PASSWORD " +
        escapeLiteral(secret) +
        " " +
        attributes,
    );
  }

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    grantRole = (
      await owner.pool.query(
        "SELECT 'coginebot_app_' || oid::text AS role FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()",
      )
    ).rows[0].role;
    knownGrantRoles = new Set(
      (await owner.pool.query("SELECT rolname FROM pg_roles")).rows.map((row) => row.rolname),
    );
    createdGroup = !(
      await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [grantRole])
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
    for (const row of (await owner.pool.query("SELECT rolname FROM pg_roles")).rows)
      if (
        !knownGrantRoles.has(row.rolname) &&
        row.rolname !== grantRole &&
        row.rolname.startsWith(`${RUNTIME_ROLE}_`)
      )
        allocated.add(row.rolname);
    for (const name of allocated) {
      if ((await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount) {
        await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(name)}`);
        await owner.pool.query(`DROP ROLE ${escapeIdentifier(name)}`);
      }
    }
    await owner.pool.query(`DROP TABLE IF EXISTS public.${escapeIdentifier(probeTable)}`);
    if (
      createdGroup &&
      (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [grantRole])).rowCount
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
      await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(grantRole)}`);
      await owner.pool.query(`DROP ROLE ${escapeIdentifier(grantRole)}`);
    }
    await close(owner);
  });

  it("creates a restricted login, registers its authenticated key and reports preparation without enforcement", async () => {
    await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).resolves.toBeUndefined();
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

  it.each(["public usage", "delegated table access", "column access", "default grants"] as const)(
    "rejects Pages schema ACL drift from %s",
    async (fixture) => {
      const group = escapeIdentifier(grantRole);
      const queries = {
        "public usage": [
          "GRANT USAGE ON SCHEMA cogine_pages TO PUBLIC",
          "REVOKE USAGE ON SCHEMA cogine_pages FROM PUBLIC",
        ],
        "delegated table access": [
          `GRANT UPDATE ON cogine_pages.pages TO ${group} WITH GRANT OPTION`,
          `REVOKE GRANT OPTION FOR UPDATE ON cogine_pages.pages FROM ${group}`,
        ],
        "column access": [
          `GRANT SELECT (id) ON cogine_pages.pages TO ${group}`,
          `REVOKE SELECT (id) ON cogine_pages.pages FROM ${group}`,
        ],
        "default grants": [
          `ALTER DEFAULT PRIVILEGES IN SCHEMA cogine_pages GRANT SELECT ON TABLES TO ${group}`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA cogine_pages REVOKE SELECT ON TABLES FROM ${group}`,
        ],
      } as const;
      const [grant, revoke] = queries[fixture];
      await owner.pool.query(grant);
      try {
        expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
        await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow(
          "Pages database schema",
        );
      } finally {
        await owner.pool.query(revoke);
      }
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: true });
    },
  );

  it("repairs Pages runtime grants when the namespace ACL is empty", async () => {
    const group = escapeIdentifier(grantRole);
    await owner.pool.query(`REVOKE ALL ON SCHEMA cogine_pages FROM CURRENT_USER, ${group}`);
    try {
      expect(
        (
          await owner.pool.query(
            "SELECT cardinality(nspacl) AS grants FROM pg_namespace WHERE nspname = 'cogine_pages'",
          )
        ).rows,
      ).toEqual([{ grants: 0 }]);
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await provisionRuntimeRole(databaseUrl!, runtimeUrl);
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: true });
    } finally {
      await owner.pool.query("GRANT ALL ON SCHEMA cogine_pages TO CURRENT_USER");
    }
  });

  it("preserves the old login credential until its instances drain", async () => {
    const name = `${login}_rotation`;
    allocated.add(name);
    const originalUrl = urlFor(name, password);
    await provisionRuntimeRole(databaseUrl!, originalUrl);
    const replacement = new URL(originalUrl);
    replacement.password = randomBytes(24).toString("hex");
    const before = await digestCount();
    const verifier = async () =>
      (await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])).rows[0]
        .rolpassword;
    const originalVerifier = await verifier();
    const oldInstance = createDb(originalUrl, { poolMax: 1 });
    try {
      let failure: unknown;
      const retained = await oldInstance.pool.connect();
      try {
        try {
          await provisionRuntimeRole(databaseUrl!, replacement.toString());
        } catch (error) {
          failure = error;
        }
      } finally {
        retained.release(true);
      }
      const reconnects = await oldInstance.pool.query("SELECT 1").then(
        () => true,
        () => false,
      );
      expect(reconnects).toBe(true);
      expect(await verifier()).toBe(originalVerifier);
      expect(await digestCount()).toBe(before);
      expect(failure).toBeDefined();
      const nextLogin = `${login}_replacement`;
      allocated.add(nextLogin);
      const next = createDb(urlFor(nextLogin, replacement.password), { poolMax: 1 });
      try {
        await provisionRuntimeRole(databaseUrl!, urlFor(nextLogin, replacement.password));
        expect((await next.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        expect((await oldInstance.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        expect(await digestCount()).toBe(before + 1);
      } finally {
        await close(next);
      }
    } finally {
      await close(oldInstance);
      await owner.pool.query(
        "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
        [rlsBypassKey(replacement.toString())],
      );
    }
  });

  it("authenticates zero-width-space passwords using the runtime SCRAM mapping", async () => {
    const name = `${login}_unicode`;
    allocated.add(name);
    const url = urlFor(name, "fixture\u200Bpassword");
    await provisionRuntimeRole(databaseUrl!, url);
    for (const secret of ["fixture\u200Bpassword", "fixture password"]) {
      const client = createDb(urlFor(name, secret), { poolMax: 1 });
      try {
        expect((await client.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
      } finally {
        await close(client);
      }
    }
    const removed = createDb(urlFor(name, "fixturepassword"), { poolMax: 1 });
    try {
      await expect(removed.pool.query("SELECT 1")).rejects.toMatchObject({ code: "28P01" });
    } finally {
      await close(removed);
    }
  });

  it.each([
    { label: "private-use", characters: "\uE000\uFB01" },
    { label: "bidirectional", characters: "\u0627\uFB01" },
  ])(
    "authenticates $label normalization passwords through the runtime driver",
    async ({ label, characters }) => {
      const name = `${login}_${label.replaceAll("-", "_")}`;
      allocated.add(name);
      const secret = `fixture-${characters}-password`;
      const url = urlFor(name, secret);
      await provisionRuntimeRole(databaseUrl!, url);
      const client = createDb(url, { poolMax: 1, rowSecurity: true });
      try {
        expect((await client.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        expect(await describeRowSecurity(client.prisma)).toMatchObject({
          prepared: true,
          enforced: false,
        });
      } finally {
        await close(client);
      }
      const incorrect = createDb(urlFor(name, "incorrect-fixture-password"), { poolMax: 1 });
      try {
        await expect(incorrect.pool.query("SELECT 1")).rejects.toMatchObject({ code: "28P01" });
      } finally {
        await close(incorrect);
      }
    },
  );

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

  it("preserves an existing unprovisioned login's authority on wrong-password preparation", async () => {
    const name = `${login}_unprovisioned`;
    const baseline = `${login}_baseline`;
    const secret = randomBytes(24).toString("hex");
    allocated.add(name);
    await owner.pool.query(
      `CREATE ROLE ${escapeIdentifier(name)} LOGIN PASSWORD ${escapeLiteral(secret)}`,
    );
    allocated.add(baseline);
    await owner.pool.query(`CREATE ROLE ${escapeIdentifier(baseline)} NOLOGIN`);
    await owner.pool.query(`GRANT ${escapeIdentifier(baseline)} TO ${escapeIdentifier(name)}`);
    const validUrl = urlFor(name, secret);
    async function authority() {
      const client = createDb(validUrl, { poolMax: 1 });
      try {
        expect((await client.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        const membership = (
          await owner.pool.query(
            "SELECT pg_has_role($1, $2, 'MEMBER') AS managed, pg_has_role($1, $3, 'MEMBER') AS baseline",
            [name, grantRole, baseline],
          )
        ).rows[0];
        const application = await client.pool
          .query(`SELECT * FROM public.${escapeIdentifier(probeTable)}`)
          .then(
            () => true,
            () => false,
          );
        const queue = await client.pool
          .query("SELECT payload FROM graphile_worker._private_jobs")
          .then(
            () => true,
            () => false,
          );
        return { ...membership, application, queue };
      } finally {
        await close(client);
      }
    }
    const before = await authority();
    expect(before).toEqual({ managed: false, baseline: true, application: false, queue: false });
    const verifier = (
      await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])
    ).rows[0].rolpassword;
    const digests = await digestCount();
    await expect(
      provisionRuntimeRole(databaseUrl!, urlFor(name, "incorrect-fixture-password")),
    ).rejects.toMatchObject({ code: "28P01" });
    expect(await digestCount()).toBe(digests);
    expect(
      (await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])).rows[0]
        .rolpassword,
    ).toBe(verifier);
    expect(await authority()).toEqual(before);
    await provisionRuntimeRole(databaseUrl!, validUrl);
    expect(await authority()).toEqual({
      managed: true,
      baseline: true,
      application: true,
      queue: true,
    });
    expect(
      (await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])).rows[0]
        .rolpassword,
    ).toBe(verifier);
  });

  it("requires existing logins to authenticate with CONNECT before adding runtime grants", async () => {
    const name = `${login}_no_connect`;
    await createLogin(name);
    const url = urlFor(name, password);
    const database = (await owner.pool.query("SELECT current_database() AS name")).rows[0].name;
    const databaseName = escapeIdentifier(database);
    const publicConnect = (
      await owner.pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CONNECT') AS allowed",
      )
    ).rows[0].allowed;
    expect(publicConnect).toBe(true);
    const verifier = (
      await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])
    ).rows[0].rolpassword;
    const digests = await digestCount();
    await owner.pool.query(`REVOKE CONNECT ON DATABASE ${databaseName} FROM PUBLIC`);
    try {
      await expect(provisionRuntimeRole(databaseUrl!, url)).rejects.toMatchObject({
        code: "42501",
      });
      expect(
        (await owner.pool.query("SELECT pg_has_role($1,$2,'MEMBER') AS member", [name, grantRole]))
          .rows,
      ).toEqual([{ member: false }]);
      expect(await digestCount()).toBe(digests);
      expect(
        (await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name]))
          .rows[0].rolpassword,
      ).toBe(verifier);
      await owner.pool.query(
        `GRANT CONNECT ON DATABASE ${databaseName} TO ${escapeIdentifier(name)}`,
      );
      await provisionRuntimeRole(databaseUrl!, url);
      const client = createDb(url, { poolMax: 1, rowSecurity: true });
      try {
        expect(await describeRowSecurity(client.prisma)).toMatchObject({
          prepared: true,
          enforced: false,
        });
      } finally {
        await close(client);
      }
    } finally {
      await owner.pool.query(`GRANT CONNECT ON DATABASE ${databaseName} TO PUBLIC`);
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

  it("rejects application-table TRUNCATE authority that bypasses row policies", async () => {
    const table = `public.${escapeIdentifier(probeTable)}`;
    const policy = escapeIdentifier(`deny_probe_${suffix}`);
    await owner.pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await owner.pool.query(`CREATE POLICY ${policy} ON ${table} USING (false)`);
    await owner.pool.query(`GRANT TRUNCATE ON ${table} TO ${escapeIdentifier(login)}`);
    try {
      expect((await runtime!.pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      await runtime!.pool.query(`TRUNCATE ${table}`);
      expect((await owner.pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
        prepared: false,
        enforced: false,
      });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(`REVOKE TRUNCATE ON ${table} FROM ${escapeIdentifier(login)}`);
      await owner.pool.query(`DROP POLICY ${policy} ON ${table}`);
      await owner.pool.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      await owner.pool.query(
        `INSERT INTO ${table} VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET content=excluded.content`,
        ["fixture content"],
      );
    }
  });

  it("rejects unsafe future-table default grants before reporting readiness", async () => {
    const table = `default_acl_probe_${suffix}`;
    const qualified = `public.${escapeIdentifier(table)}`;
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO ${escapeIdentifier(grantRole)}`,
    );
    try {
      const prepared = (await describeRowSecurity(runtime!.prisma)).prepared;
      let rejected = false;
      try {
        await provisionRuntimeRole(databaseUrl!, runtimeUrl);
      } catch {
        rejected = true;
      }
      await owner.pool.query(
        `CREATE TABLE ${qualified}(id integer); INSERT INTO ${qualified} VALUES(1); ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY; CREATE POLICY deny_rows ON ${qualified} USING(false)`,
      );
      expect((await runtime!.pool.query(`SELECT * FROM ${qualified}`)).rows).toEqual([]);
      await runtime!.pool.query(`TRUNCATE ${qualified}`);
      expect(
        (await owner.pool.query(`SELECT count(*)::int AS total FROM ${qualified}`)).rows,
      ).toEqual([{ total: 0 }]);
      expect({ prepared, rejected }).toEqual({ prepared: false, rejected: true });
    } finally {
      await owner.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM ${escapeIdentifier(grantRole)}`,
      );
      await owner.pool.query(`DROP TABLE IF EXISTS ${qualified}`);
    }
  });

  it.each([
    {
      label: "table trigger on login",
      schema: "public",
      objects: "TABLES",
      privilege: "TRIGGER",
      target: "login",
    },
    {
      label: "table references on group",
      schema: "public",
      objects: "TABLES",
      privilege: "REFERENCES",
      target: "group",
    },
    {
      label: "delegable application select",
      schema: "public",
      objects: "TABLES",
      privilege: "SELECT",
      target: "group",
      delegate: true,
      preserve: true,
    },
    {
      label: "application sequence update",
      schema: "public",
      objects: "SEQUENCES",
      privilege: "UPDATE",
      target: "group",
    },
    {
      label: "delegable sequence usage",
      schema: "public",
      objects: "SEQUENCES",
      privilege: "USAGE",
      target: "group",
      delegate: true,
      preserve: true,
    },
    {
      label: "queue truncate",
      schema: "graphile_worker",
      objects: "TABLES",
      privilege: "TRUNCATE",
      target: "group",
    },
    {
      label: "delegable queue execution",
      schema: "graphile_worker",
      objects: "FUNCTIONS",
      privilege: "EXECUTE",
      target: "login",
      delegate: true,
    },
    {
      label: "private table read",
      schema: "cogine_private",
      objects: "TABLES",
      privilege: "SELECT",
      target: "login",
    },
    {
      label: "catalog table read",
      schema: "pg_catalog",
      objects: "TABLES",
      privilege: "SELECT",
      target: "group",
    },
    {
      label: "global table read",
      schema: "",
      objects: "TABLES",
      privilege: "SELECT",
      target: "group",
    },
    {
      label: "global sequence read",
      schema: "",
      objects: "SEQUENCES",
      privilege: "SELECT",
      target: "group",
    },
    {
      label: "future schema usage",
      schema: "",
      objects: "SCHEMAS",
      privilege: "USAGE",
      target: "group",
    },
    {
      label: "public table truncate",
      schema: "public",
      objects: "TABLES",
      privilege: "TRUNCATE",
      target: "public",
    },
    {
      label: "inherited table trigger",
      schema: "public",
      objects: "TABLES",
      privilege: "TRIGGER",
      target: "inherited",
    },
    {
      label: "global function execution",
      schema: "",
      objects: "FUNCTIONS",
      privilege: "EXECUTE",
      target: "group",
    },
    {
      label: "private function execution",
      schema: "cogine_private",
      objects: "FUNCTIONS",
      privilege: "EXECUTE",
      target: "login",
    },
  ])("rejects unsafe default ACL: $label", async (fixture) => {
    const inherited = `${login}_default_inherited`;
    if (fixture.target === "inherited") {
      allocated.add(inherited);
      await owner.pool.query(`CREATE ROLE ${escapeIdentifier(inherited)} NOLOGIN`);
      await owner.pool.query(`GRANT ${escapeIdentifier(inherited)} TO ${escapeIdentifier(login)}`);
    }
    const grantee =
      fixture.target === "public"
        ? "PUBLIC"
        : escapeIdentifier(
            fixture.target === "group"
              ? grantRole
              : fixture.target === "inherited"
                ? inherited
                : login,
          );
    const scope = fixture.schema ? ` IN SCHEMA ${escapeIdentifier(fixture.schema)}` : "";
    const prefix = `ALTER DEFAULT PRIVILEGES${scope}`;
    await owner.pool.query(
      `${prefix} GRANT ${fixture.privilege} ON ${fixture.objects} TO ${grantee}${fixture.delegate ? " WITH GRANT OPTION" : ""}`,
    );
    try {
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
        prepared: false,
        enforced: false,
      });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(
        `${prefix} REVOKE ${fixture.delegate && fixture.preserve ? "GRANT OPTION FOR " : ""}${fixture.privilege} ON ${fixture.objects} FROM ${grantee}`,
      );
      if (fixture.target === "inherited")
        await owner.pool.query(
          `REVOKE ${escapeIdentifier(inherited)} FROM ${escapeIdentifier(login)}`,
        );
    }
    expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
      prepared: true,
      enforced: false,
    });
  });

  it("preserves ordinary function/type defaults and the creator's own ACL", async () => {
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${escapeIdentifier(grantRole)}`,
    );
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO ${escapeIdentifier(login)}`,
    );
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(login)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
    try {
      await provisionRuntimeRole(databaseUrl!, runtimeUrl);
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
        prepared: true,
        enforced: false,
      });
    } finally {
      await owner.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${escapeIdentifier(grantRole)}`,
      );
      await owner.pool.query(
        `ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM ${escapeIdentifier(login)}`,
      );
      await owner.pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(login)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`,
      );
    }
  });

  it("accepts an empty default ACL without an array error", async () => {
    const creator = `${login}_empty_defaults`;
    allocated.add(creator);
    await owner.pool.query(`CREATE ROLE ${escapeIdentifier(creator)} NOLOGIN`);
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(creator)} REVOKE ALL ON FUNCTIONS FROM ${escapeIdentifier(creator)}`,
    );
    expect(
      (
        await owner.pool.query(
          "SELECT cardinality(defaclacl) AS size FROM pg_default_acl WHERE defaclrole=$1::regrole",
          [creator],
        )
      ).rows,
    ).toEqual([{ size: 0 }]);
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({
      prepared: true,
      enforced: false,
    });
  });

  it.each(["public", "graphile_worker", "cogine_private", "pg_catalog"])(
    "rejects function grant options in %s",
    async (schema) => {
      const fn = `${escapeIdentifier(schema)}.${escapeIdentifier(`delegation_probe_${suffix}`)}()`;
      await owner.pool.query(`CREATE FUNCTION ${fn} RETURNS integer LANGUAGE sql AS 'SELECT 7'`);
      await owner.pool.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM PUBLIC`);
      await owner.pool.query(
        `GRANT EXECUTE ON FUNCTION ${fn} TO ${escapeIdentifier(login)} WITH GRANT OPTION`,
      );
      try {
        const prepared = (await describeRowSecurity(runtime!.prisma)).prepared;
        let rejected = false;
        try {
          await provisionRuntimeRole(databaseUrl!, runtimeUrl);
        } catch {
          rejected = true;
        }
        if (schema === "public") {
          const outsider = `${login}_function_outsider`;
          await createLogin(outsider);
          const client = createDb(urlFor(outsider, password), { poolMax: 1 });
          try {
            await expect(client.pool.query(`SELECT ${fn}`)).rejects.toMatchObject({
              code: "42501",
            });
            await runtime!.pool.query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`);
            expect((await client.pool.query(`SELECT ${fn} AS value`)).rows).toEqual([{ value: 7 }]);
          } finally {
            await close(client);
          }
        }
        expect({ prepared, rejected }).toEqual({ prepared: false, rejected: true });
      } finally {
        await owner.pool.query(`DROP FUNCTION ${fn}`);
      }
    },
  );

  it("rejects executable TRIGGER authority on application tables", async () => {
    const table = `public.${escapeIdentifier(probeTable)}`;
    const trigger = escapeIdentifier(`unsafe_trigger_${suffix}`);
    await owner.pool.query(`GRANT TRIGGER ON ${table} TO ${escapeIdentifier(login)}`);
    try {
      await runtime!.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.ensure_default_space_membership()`,
      );
      await expect(
        runtime!.pool.query(`INSERT INTO ${table} VALUES (2, 'fixture')`),
      ).rejects.toThrow();
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
      await owner.pool.query(`REVOKE TRIGGER ON ${table} FROM ${escapeIdentifier(login)}`);
    }
  });

  it("rejects a predefined role that can terminate other runtime sessions", async () => {
    const victimName = `${login}_victim`;
    await createLogin(victimName);
    const victim = createDb(urlFor(victimName, password), { poolMax: 1 });
    await owner.pool.query(`GRANT pg_signal_backend TO ${escapeIdentifier(login)}`);
    const connection = await victim.pool.connect();
    try {
      const pid = (await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const cancelled = await runtime!.pool.query("SELECT pg_cancel_backend($1) AS allowed", [pid]);
      expect(cancelled.rows).toEqual([{ allowed: true }]);
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      connection.release();
      await close(victim);
      await owner.pool.query(`REVOKE pg_signal_backend FROM ${escapeIdentifier(login)}`);
    }
  });

  it("rejects every grantable predefined role installed on the actual server", async () => {
    const roles = (
      await owner.pool.query(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE left(rolname,3)='pg_' AND rolname<>'pg_database_owner' ORDER BY rolname",
      )
    ).rows;
    expect(roles.some((role) => role.rolname === "pg_signal_backend")).toBe(true);
    for (const role of roles) {
      await owner.pool.query(
        `GRANT ${escapeIdentifier(role.rolname)} TO ${escapeIdentifier(login)}`,
      );
      try {
        expect(await describeRowSecurity(runtime!.prisma), role.rolname).toMatchObject({
          prepared: false,
        });
        await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
      } finally {
        await owner.pool.query(
          `REVOKE ${escapeIdentifier(role.rolname)} FROM ${escapeIdentifier(login)}`,
        );
      }
    }
  });

  it("checks maintenance privileges only when supported by the server", async () => {
    const version = Number(
      (await owner.pool.query("SHOW server_version_num")).rows[0].server_version_num,
    );
    if (version < 170000) {
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: true });
      return;
    }
    await owner.pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT MAINTAIN ON TABLES TO ${escapeIdentifier(grantRole)}`,
    );
    try {
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM ${escapeIdentifier(grantRole)}`,
      );
    }
    const table = `public.${escapeIdentifier(probeTable)}`;
    await owner.pool.query(`GRANT MAINTAIN ON ${table} TO ${escapeIdentifier(login)}`);
    try {
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(`REVOKE MAINTAIN ON ${table} FROM ${escapeIdentifier(login)}`);
    }
  });

  it.each(["view", "queue", "PUBLIC table"])(
    "rejects TRIGGER authority through %s",
    async (kind) => {
      const view = `public.${escapeIdentifier(`role_view_${suffix}`)}`;
      if (kind === "view")
        await owner.pool.query(
          `CREATE VIEW ${view} AS SELECT * FROM public.${escapeIdentifier(probeTable)}`,
        );
      const table =
        kind === "queue"
          ? "graphile_worker._private_jobs"
          : kind === "view"
            ? view
            : `public.${escapeIdentifier(probeTable)}`;
      const grantee = kind === "PUBLIC table" ? "PUBLIC" : escapeIdentifier(login);
      await owner.pool.query(`GRANT TRIGGER ON ${table} TO ${grantee}`);
      try {
        expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
        await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
      } finally {
        await owner.pool.query(`REVOKE TRIGGER ON ${table} FROM ${grantee}`);
        if (kind === "view") await owner.pool.query(`DROP VIEW ${view}`);
      }
    },
  );

  it.each([
    "table REFERENCES",
    "column REFERENCES",
    "sequence UPDATE",
    "sequence GRANT OPTION",
    "database CONNECT GRANT OPTION",
    "database TEMP GRANT OPTION",
    "schema GRANT OPTION",
    "queue function GRANT OPTION",
    "parameter SET",
    "parameter ALTER SYSTEM",
    "role ADMIN OPTION",
    "table GRANT OPTION",
    "column GRANT OPTION",
    "catalog SELECT",
    "restricted builtin EXECUTE",
  ])("rejects additional administrative authority: %s", async (kind) => {
    const name = escapeIdentifier(login);
    const table = `public.${escapeIdentifier(probeTable)}`;
    const sequence = `public.${escapeIdentifier(`role_sequence_${suffix}`)}`;
    const database = escapeIdentifier(
      (await owner.pool.query("SELECT current_database() AS name")).rows[0].name,
    );
    const queueFunction = (
      await owner.pool.query(
        "SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='graphile_worker' AND p.proname='add_job' ORDER BY p.oid LIMIT 1",
      )
    ).rows[0].name;
    const setup: Record<string, [string, string]> = {
      "table REFERENCES": [
        `GRANT REFERENCES ON ${table} TO ${name}`,
        `REVOKE REFERENCES ON ${table} FROM ${name}`,
      ],
      "column REFERENCES": [
        `GRANT REFERENCES (id) ON ${table} TO ${name}`,
        `REVOKE REFERENCES (id) ON ${table} FROM ${name}`,
      ],
      "sequence UPDATE": [
        `GRANT UPDATE ON SEQUENCE ${sequence} TO ${name}`,
        `REVOKE UPDATE ON SEQUENCE ${sequence} FROM ${name}`,
      ],
      "sequence GRANT OPTION": [
        `GRANT SELECT ON SEQUENCE ${sequence} TO ${name} WITH GRANT OPTION`,
        `REVOKE SELECT ON SEQUENCE ${sequence} FROM ${name} CASCADE`,
      ],
      "database CONNECT GRANT OPTION": [
        `GRANT CONNECT ON DATABASE ${database} TO ${name} WITH GRANT OPTION`,
        `REVOKE CONNECT ON DATABASE ${database} FROM ${name} CASCADE`,
      ],
      "database TEMP GRANT OPTION": [
        `GRANT TEMPORARY ON DATABASE ${database} TO ${name} WITH GRANT OPTION`,
        `REVOKE TEMPORARY ON DATABASE ${database} FROM ${name} CASCADE`,
      ],
      "schema GRANT OPTION": [
        `GRANT USAGE ON SCHEMA graphile_worker TO ${name} WITH GRANT OPTION`,
        `REVOKE USAGE ON SCHEMA graphile_worker FROM ${name} CASCADE`,
      ],
      "queue function GRANT OPTION": [
        `GRANT EXECUTE ON FUNCTION ${queueFunction} TO ${name} WITH GRANT OPTION`,
        `REVOKE EXECUTE ON FUNCTION ${queueFunction} FROM ${name} CASCADE`,
      ],
      "parameter SET": [
        `GRANT SET ON PARAMETER log_statement TO ${name}`,
        `REVOKE SET ON PARAMETER log_statement FROM ${name}`,
      ],
      "parameter ALTER SYSTEM": [
        `GRANT ALTER SYSTEM ON PARAMETER log_statement TO ${name}`,
        `REVOKE ALTER SYSTEM ON PARAMETER log_statement FROM ${name}`,
      ],
      "role ADMIN OPTION": [
        `GRANT ${escapeIdentifier(grantRole)} TO ${name} WITH ADMIN OPTION`,
        `REVOKE ADMIN OPTION FOR ${escapeIdentifier(grantRole)} FROM ${name} CASCADE`,
      ],
      "table GRANT OPTION": [
        `GRANT SELECT ON ${table} TO ${name} WITH GRANT OPTION`,
        `REVOKE SELECT ON ${table} FROM ${name} CASCADE`,
      ],
      "column GRANT OPTION": [
        `GRANT UPDATE (content) ON ${table} TO ${name} WITH GRANT OPTION`,
        `REVOKE UPDATE (content) ON ${table} FROM ${name} CASCADE`,
      ],
      "catalog SELECT": [
        `GRANT SELECT ON pg_catalog.pg_authid TO ${name}`,
        `REVOKE SELECT ON pg_catalog.pg_authid FROM ${name}`,
      ],
      "restricted builtin EXECUTE": [
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${name}`,
        `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${name}`,
      ],
    };
    if (kind.startsWith("sequence")) await owner.pool.query(`CREATE SEQUENCE ${sequence}`);
    const [grant, revoke] = setup[kind]!;
    await owner.pool.query(grant);
    try {
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await owner.pool.query(revoke);
      if (kind.startsWith("sequence")) await owner.pool.query(`DROP SEQUENCE ${sequence}`);
    }
  });

  it("keeps ineffective catalog-write grants separate from real authority", async () => {
    await owner.pool.query(`GRANT UPDATE ON pg_catalog.pg_authid TO ${escapeIdentifier(login)}`);
    try {
      await expect(
        runtime!.pool.query("UPDATE pg_catalog.pg_authid SET rolsuper=false WHERE false"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: true });
    } finally {
      await owner.pool.query(
        `REVOKE UPDATE ON pg_catalog.pg_authid FROM ${escapeIdentifier(login)}`,
      );
    }
  });

  it("preserves native PUBLIC metadata and ordinary USERSET access", async () => {
    await runtime!.pool.query(
      "UPDATE pg_catalog.pg_settings SET setting=current_setting('application_name') WHERE name='application_name'",
    );
    expect(
      (await runtime!.pool.query("SELECT oid FROM pg_catalog.pg_class LIMIT 1")).rows,
    ).toHaveLength(1);
    expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: true });
  });

  it.each(["PUBLIC builtin EXECUTE", "catalog column SELECT"])(
    "rejects native authority beyond the initial PUBLIC baseline: %s",
    async (kind) => {
      const grant =
        kind === "PUBLIC builtin EXECUTE"
          ? "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC"
          : `GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO ${escapeIdentifier(login)}`;
      const revoke =
        kind === "PUBLIC builtin EXECUTE"
          ? "REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM PUBLIC"
          : `REVOKE SELECT (rolpassword) ON pg_catalog.pg_authid FROM ${escapeIdentifier(login)}`;
      await owner.pool.query(grant);
      try {
        expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
        await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
      } finally {
        await owner.pool.query(revoke);
      }
    },
  );

  it.each(["direct", "inherited"])(
    "rejects later foreign authority on the managed grant role: %s",
    async (mode) => {
      const peerDatabase = `foreign_${mode}_${suffix}`;
      const parent = `${login}_foreign_${mode}`;
      await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(peerDatabase)}`);
      const url = new URL(databaseUrl!);
      url.pathname = `/${peerDatabase}`;
      const peer = createDb(url.toString(), { poolMax: 1 });
      if (mode === "inherited") {
        allocated.add(parent);
        await owner.pool.query(`CREATE ROLE ${escapeIdentifier(parent)} NOLOGIN`);
        await owner.pool.query(
          `GRANT ${escapeIdentifier(parent)} TO ${escapeIdentifier(grantRole)}`,
        );
      }
      const grantee = mode === "inherited" ? parent : grantRole;
      try {
        await peer.pool.query("CREATE TABLE public.foreign_probe(id integer)");
        await peer.pool.query(
          `GRANT SELECT ON public.foreign_probe TO ${escapeIdentifier(grantee)}`,
        );
        await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
        expect(
          (
            await peer.pool.query(
              "SELECT has_table_privilege($1,'public.foreign_probe','SELECT') AS allowed",
              [grantee],
            )
          ).rows,
        ).toEqual([{ allowed: true }]);
        expect(await describeRowSecurity(runtime!.prisma)).toMatchObject({ prepared: false });
      } finally {
        if (mode === "inherited")
          await owner.pool.query(
            `REVOKE ${escapeIdentifier(parent)} FROM ${escapeIdentifier(grantRole)}`,
          );
        await close(peer);
        await owner.pool.query(`DROP DATABASE ${escapeIdentifier(peerDatabase)} WITH (FORCE)`);
      }
    },
  );

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
    const administratorPassword = randomBytes(24).toString("hex");
    await createLogin(
      limited,
      "NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS",
      administratorPassword,
    );
    const administrator = (await owner.pool.query("SELECT current_user AS name")).rows[0]
      .name as string;
    await owner.pool.query(
      `GRANT ${escapeIdentifier(administrator)} TO ${escapeIdentifier(limited)}`,
    );
    expect(
      (await owner.pool.query("SELECT rolcreaterole FROM pg_roles WHERE rolname=$1", [limited]))
        .rows,
    ).toEqual([{ rolcreaterole: false }]);
    await expect(
      provisionRuntimeRole(urlFor(limited, administratorPassword), runtimeUrl),
    ).resolves.toBeUndefined();
    const bad = new URL(runtimeUrl);
    bad.password = "invalid-precreated-fixture-password";
    const before = await digestCount();
    await expect(
      provisionRuntimeRole(urlFor(limited, administratorPassword), bad.toString()),
    ).rejects.toThrow();
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
      "routine.retry": noop,
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
    ).toEqual([undefined, undefined]);
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

  it("isolates application and queue grants between prepared databases on one cluster", async () => {
    const peerDatabase = `isolated_${suffix}`;
    const peerLogin = `${login}_isolated`;
    const secret = randomBytes(24).toString("hex");
    allocated.add(peerLogin);
    await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(peerDatabase)}`);
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.pathname = `/${peerDatabase}`;
    const peerUrl = new URL(urlFor(peerLogin, secret));
    peerUrl.pathname = `/${peerDatabase}`;
    const crossUrl = new URL(runtimeUrl);
    crossUrl.pathname = `/${peerDatabase}`;
    const peerOwner = createDb(ownerUrl.toString(), { poolMax: 1 });
    const peer = createDb(peerUrl.toString(), { poolMax: 1 });
    const cross = createDb(crossUrl.toString(), { poolMax: 1 });
    const reverse = createDb(urlFor(peerLogin, secret), { poolMax: 1 });
    const beforeRoles = new Set(
      (await owner.pool.query("SELECT rolname FROM pg_roles")).rows.map((row) => row.rolname),
    );
    try {
      await peerOwner.pool.query(
        "CREATE SCHEMA cogine_private; REVOKE ALL ON SCHEMA cogine_private FROM PUBLIC; CREATE TABLE cogine_private.rls_bypass_keys(digest bytea PRIMARY KEY); CREATE TABLE public.isolation_probe(id integer PRIMARY KEY); INSERT INTO public.isolation_probe VALUES (7)",
      );
      await migrateJobQueue(ownerUrl.toString());
      await provisionRuntimeRole(ownerUrl.toString(), peerUrl.toString());
      await peerOwner.pool.query(
        "SELECT graphile_worker.add_job('cross-database-fixture', '{\"origin\":\"peer\"}'::json)",
      );
      expect((await peer.pool.query("SELECT id FROM public.isolation_probe")).rows).toEqual([
        { id: 7 },
      ]);
      expect(
        (await peer.pool.query("SELECT count(*)::int AS total FROM graphile_worker._private_jobs"))
          .rows,
      ).toEqual([{ total: 1 }]);
      const appAllowed = await cross.pool.query("SELECT id FROM public.isolation_probe").then(
        () => true,
        () => false,
      );
      const queueAllowed = await cross.pool
        .query("SELECT payload FROM graphile_worker._private_jobs")
        .then(
          () => true,
          () => false,
        );
      const reverseAllowed = await reverse.pool
        .query(`SELECT * FROM public.${escapeIdentifier(probeTable)}`)
        .then(
          () => true,
          () => false,
        );
      expect({ appAllowed, queueAllowed, reverseAllowed }).toEqual({
        appAllowed: false,
        queueAllowed: false,
        reverseAllowed: false,
      });
      await expect(
        cross.pool.query("SELECT digest FROM cogine_private.rls_bypass_keys"),
      ).rejects.toThrow();
    } finally {
      for (const client of [cross, peer, reverse, peerOwner]) await close(client);
      const afterRoles = (await owner.pool.query("SELECT rolname FROM pg_roles")).rows;
      for (const row of afterRoles)
        if (!beforeRoles.has(row.rolname) && row.rolname.startsWith(`${RUNTIME_ROLE}_`))
          allocated.add(row.rolname);
      await owner.pool.query(`DROP DATABASE ${escapeIdentifier(peerDatabase)} WITH (FORCE)`);
    }
  });

  it.each(["1", "0", "01", "4294967296", "99999999999", "custom", "1-extra"])(
    "checks only canonical foreign identities under normal and switched roles: %s",
    async (suffix) => {
      const name = `${RUNTIME_ROLE}_${suffix}`;
      await createLogin(name);
      await owner.pool.query(`GRANT ${escapeIdentifier(grantRole)} TO ${escapeIdentifier(name)}`);
      const url = urlFor(name, password);
      const normal = createDb(url, { poolMax: 1, rowSecurity: true });
      const switchedUrl = new URL(url);
      switchedUrl.searchParams.set("options", `-crole=${grantRole}`);
      const switched = createDb(switchedUrl.toString(), { poolMax: 1, rowSecurity: true });
      try {
        expect(
          (await normal.pool.query("SELECT current_user AS role, session_user AS login")).rows,
        ).toEqual([{ role: name, login: name }]);
        expect(
          (await switched.pool.query("SELECT current_user AS role, session_user AS login")).rows,
        ).toEqual([{ role: grantRole, login: name }]);
        expect(
          (
            await runAsSystem("canonical identity fixture", () =>
              normal.pool.query("SELECT public.app_rls_bypass() AS allowed"),
            )
          ).rows,
        ).toEqual([{ allowed: true }]);
        const prepared = suffix !== "1";
        expect(await describeRowSecurity(normal.prisma)).toMatchObject({
          prepared,
          enforced: false,
        });
        expect(await describeRowSecurity(switched.prisma)).toMatchObject({
          prepared,
          enforced: false,
        });
      } finally {
        await close(normal);
        await close(switched);
      }
    },
  );

  it.each(["managed", "orphan", "ordinary"])(
    "keeps foreign managed recipients from extending their members: %s",
    async (kind) => {
      const database = `recipient_${kind}_${suffix}`;
      await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
      const ownerUrl = new URL(databaseUrl!);
      ownerUrl.pathname = `/${database}`;
      const peerOwner = createDb(ownerUrl.toString(), { poolMax: 1 });
      const victimLogin = `${login}_recipient_${kind}`;
      await createLogin(victimLogin);
      const selectedGroup = kind === "orphan" ? `${RUNTIME_ROLE}_4294967295` : grantRole;
      const groupPassword = randomBytes(24).toString("hex");
      const originalVerifier = (
        await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [grantRole])
      ).rows[0].rolpassword;
      if (kind === "orphan") {
        allocated.add(selectedGroup);
        expect(
          (await owner.pool.query("SELECT 1 FROM pg_database WHERE oid=4294967295::oid")).rowCount,
        ).toBe(0);
        await owner.pool.query(
          `CREATE ROLE ${escapeIdentifier(selectedGroup)} LOGIN PASSWORD ${escapeLiteral(groupPassword)}`,
        );
      } else if (kind === "managed") {
        await owner.pool.query(
          `ALTER ROLE ${escapeIdentifier(selectedGroup)} LOGIN PASSWORD ${escapeLiteral(groupPassword)}`,
        );
      }
      await owner.pool.query(
        `GRANT ${escapeIdentifier(selectedGroup)} TO ${escapeIdentifier(victimLogin)}`,
      );
      const selectedLogin = kind === "ordinary" ? login : selectedGroup;
      const selectedSecret = kind === "ordinary" ? password : groupPassword;
      const selectedUrl = new URL(urlFor(selectedLogin, selectedSecret));
      selectedUrl.pathname = `/${database}`;
      const victimUrl = new URL(urlFor(victimLogin, password));
      victimUrl.pathname = `/${database}`;
      const victim = createDb(victimUrl.toString(), { poolMax: 1 });
      const selected = createDb(selectedUrl.toString(), { poolMax: 1, rowSecurity: true });
      const sourceVictim = createDb(urlFor(victimLogin, password), { poolMax: 1 });
      try {
        await peerOwner.pool.query(
          await readFile(
            new URL(
              "../../db/prisma/migrations/20261105023000_database_context_bypass_guard/migration.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        await peerOwner.pool.query(
          "CREATE TABLE public.recipient_probe(id integer); INSERT INTO public.recipient_probe VALUES(9)",
        );
        await migrateJobQueue(ownerUrl.toString());
        await peerOwner.pool.query(
          "SELECT graphile_worker.add_job('recipient-fixture','{\"source\":\"fixture\"}'::json)",
        );
        const targetGroup = (
          await peerOwner.pool.query(
            "SELECT 'coginebot_app_'||oid::text AS name FROM pg_database WHERE datname=current_database()",
          )
        ).rows[0].name as string;
        allocated.add(targetGroup);
        async function victimAccess() {
          expect((await victim.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
          const application = await victim.pool.query("SELECT id FROM public.recipient_probe").then(
            () => true,
            () => false,
          );
          const queue = await victim.pool
            .query("SELECT payload FROM graphile_worker._private_jobs")
            .then(
              () => true,
              () => false,
            );
          return { application, queue };
        }
        expect(await victimAccess()).toEqual({ application: false, queue: false });
        if (kind !== "orphan")
          expect(
            (await sourceVictim.pool.query(`SELECT id FROM public.${escapeIdentifier(probeTable)}`))
              .rows,
          ).toEqual([{ id: 1 }]);
        const verifier = (
          await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [
            selectedLogin,
          ])
        ).rows[0].rolpassword;
        let failure: unknown;
        try {
          await provisionRuntimeRole(ownerUrl.toString(), selectedUrl.toString());
        } catch (error) {
          failure = error;
        }
        const after = await victimAccess();
        const keys = (
          await peerOwner.pool.query(
            "SELECT count(*)::int AS total FROM cogine_private.rls_bypass_keys",
          )
        ).rows[0].total;
        expect({ accepted: failure === undefined, ...after, keys }).toEqual(
          kind === "ordinary"
            ? { accepted: true, application: false, queue: false, keys: 1 }
            : { accepted: false, application: false, queue: false, keys: 0 },
        );
        if (kind === "ordinary") {
          expect((await selected.pool.query("SELECT id FROM public.recipient_probe")).rows).toEqual(
            [{ id: 9 }],
          );
          expect(await describeRowSecurity(selected.prisma)).toMatchObject({ prepared: true });
        } else {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toContain("privileged");
        }
        expect(
          (
            await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [
              selectedLogin,
            ])
          ).rows[0].rolpassword,
        ).toBe(verifier);
        if (kind !== "orphan")
          expect(
            (await sourceVictim.pool.query(`SELECT id FROM public.${escapeIdentifier(probeTable)}`))
              .rows,
          ).toEqual([{ id: 1 }]);
      } finally {
        for (const client of [victim, selected, sourceVictim, peerOwner]) await close(client);
        await owner.pool.query(`DROP DATABASE ${escapeIdentifier(database)} WITH (FORCE)`);
        if (kind === "managed")
          await owner.pool.query(
            `ALTER ROLE ${escapeIdentifier(grantRole)} NOLOGIN PASSWORD ${originalVerifier === null ? "NULL" : escapeLiteral(originalVerifier)}`,
          );
      }
    },
  );

  it.each(["different", "group"])(
    "limits a precreated LOGIN grant group to its configured identity: %s",
    async (selected) => {
      const database = `login_group_${selected}_${suffix}`;
      await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
      const ownerUrl = new URL(databaseUrl!);
      ownerUrl.pathname = `/${database}`;
      const peer = createDb(ownerUrl.toString(), { poolMax: 1 });
      try {
        await peer.pool.query(
          await readFile(
            new URL(
              "../../db/prisma/migrations/20261105023000_database_context_bypass_guard/migration.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        await peer.pool.query(
          "CREATE TABLE public.group_login_probe(id integer); INSERT INTO public.group_login_probe VALUES(7)",
        );
        await migrateJobQueue(ownerUrl.toString());
        await peer.pool.query(
          "SELECT graphile_worker.add_job('group-login-fixture','{\"source\":\"fixture\"}'::json)",
        );
        const group = (
          await peer.pool.query(
            "SELECT 'coginebot_app_'||oid::text AS name FROM pg_database WHERE datname=current_database()",
          )
        ).rows[0].name as string;
        allocated.add(group);
        const groupPassword = randomBytes(24).toString("hex");
        await peer.pool.query(
          `CREATE ROLE ${escapeIdentifier(group)} LOGIN PASSWORD ${escapeLiteral(groupPassword)}`,
        );
        const selectedLogin = selected === "group" ? group : `${login}_group_peer`;
        allocated.add(selectedLogin);
        const url = (name: string, secret: string) => {
          const u = new URL(ownerUrl);
          u.username = name;
          u.password = secret;
          return u.toString();
        };
        async function access() {
          const holder = createDb(url(group, groupPassword), { poolMax: 1 });
          try {
            expect((await holder.pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
            const application = await holder.pool
              .query("SELECT id FROM public.group_login_probe")
              .then(
                () => true,
                () => false,
              );
            const queue = await holder.pool
              .query("SELECT payload FROM graphile_worker._private_jobs")
              .then(
                () => true,
                () => false,
              );
            return { application, queue };
          } finally {
            await close(holder);
          }
        }
        expect(await access()).toEqual({ application: false, queue: false });
        const verifier = (
          await peer.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [group])
        ).rows[0].rolpassword;
        const runtime = url(selectedLogin, selected === "group" ? groupPassword : password);
        let accepted = false;
        let failure: unknown;
        try {
          await provisionRuntimeRole(ownerUrl.toString(), runtime);
          accepted = true;
        } catch (error) {
          failure = error;
        }
        if (selected === "different") {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toContain("not restricted");
        }
        const after = await access();
        const keys = (
          await peer.pool.query("SELECT count(*)::int AS total FROM cogine_private.rls_bypass_keys")
        ).rows[0].total;
        expect(
          (await peer.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [group]))
            .rows[0].rolpassword,
        ).toBe(verifier);
        expect({ accepted, ...after, keys }).toEqual(
          selected === "group"
            ? { accepted: true, application: true, queue: true, keys: 1 }
            : { accepted: false, application: false, queue: false, keys: 0 },
        );
        if (selected === "group") {
          const client = createDb(runtime, { poolMax: 1, rowSecurity: true });
          try {
            expect(await describeRowSecurity(client.prisma)).toMatchObject({
              prepared: true,
              enforced: false,
            });
          } finally {
            await close(client);
          }
        }
      } finally {
        await close(peer);
        await owner.pool.query(`DROP DATABASE ${escapeIdentifier(database)} WITH (FORCE)`);
      }
    },
  );

  it("rejects a LOGIN grant group under normal and switched execution roles", async () => {
    const verifier = (
      await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [grantRole])
    ).rows[0].rolpassword;
    await owner.pool.query(
      `ALTER ROLE ${escapeIdentifier(grantRole)} LOGIN PASSWORD ${escapeLiteral(randomBytes(24).toString("hex"))}`,
    );
    const url = new URL(runtimeUrl);
    url.searchParams.set("options", `-crole=${grantRole}`);
    const switched = createDb(url.toString(), { poolMax: 1, rowSecurity: true });
    try {
      const normalReady = (await describeRowSecurity(runtime!.prisma)).prepared;
      const switchedReady = (await describeRowSecurity(switched.prisma)).prepared;
      expect({ normalReady, switchedReady }).toEqual({ normalReady: false, switchedReady: false });
      await expect(provisionRuntimeRole(databaseUrl!, runtimeUrl)).rejects.toThrow();
    } finally {
      await close(switched);
      await owner.pool.query(
        `ALTER ROLE ${escapeIdentifier(grantRole)} NOLOGIN PASSWORD ${verifier === null ? "NULL" : escapeLiteral(verifier)}`,
      );
    }
  });

  it("rejects an unsafe grant role before creating another runtime login", async () => {
    const name = `${login}_blocked`;
    allocated.add(name);
    await owner.pool.query(`ALTER ROLE ${escapeIdentifier(grantRole)} BYPASSRLS`);
    try {
      await expect(provisionRuntimeRole(databaseUrl!, urlFor(name, password))).rejects.toThrow();
      expect(
        (await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name])).rowCount,
      ).toBe(0);
    } finally {
      await owner.pool.query(`ALTER ROLE ${escapeIdentifier(grantRole)} NOBYPASSRLS`);
    }
  });

  it("runs the administrative CLI without printing database credentials", async () => {
    // The earlier grant probes are not part of the application policy inventory.
    await owner.pool.query(`DROP TABLE public.${escapeIdentifier(probeTable)}`);
    const result = await promisify(execFile)("pnpm", ["db:migrate"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        DATABASE_URL: runtimeUrl,
        DATABASE_MIGRATION_URL: databaseUrl,
        REALTIME_DATABASE_URL: runtimeUrl,
      },
      timeout: 30_000,
    });
    expect(result.stdout).toContain("Runtime role and system key are ready");
    expect(result.stdout).toContain(
      "This command does not activate table policies or service contexts.",
    );
    expect(result.stdout + result.stderr).not.toContain(password);
    expect(result.stdout + result.stderr).not.toContain(runtimeUrl);
  });

  it("rejects a different runtime database before changing its login or registering a key", async () => {
    const peerDatabase = `role_peer_${suffix}`;
    const name = `${login}_peer`;
    const secret = randomBytes(24).toString("hex");
    allocated.add(name);
    await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(peerDatabase)}`);
    await owner.pool.query(
      `CREATE ROLE ${escapeIdentifier(name)} LOGIN PASSWORD ${escapeLiteral(secret)}`,
    );
    await owner.pool.query(`GRANT ${escapeIdentifier(grantRole)} TO ${escapeIdentifier(name)}`);
    const peerUrl = new URL(urlFor(name, secret));
    peerUrl.pathname = `/${peerDatabase}`;
    const peer = createDb(peerUrl.toString(), { poolMax: 1 });
    const key = await installDbContext(peer.pool)();
    await close(peer);
    const before = await digestCount();
    const verifier = async () =>
      (await owner.pool.query("SELECT rolpassword FROM pg_authid WHERE rolname=$1", [name])).rows[0]
        .rolpassword;
    const originalVerifier = await verifier();
    try {
      let failure: unknown;
      try {
        await provisionRuntimeRole(databaseUrl!, peerUrl.toString());
      } catch (error) {
        failure = error;
      }
      expect(await verifier()).toBe(originalVerifier);
      expect(await digestCount()).toBe(before);
      expect(failure).toBeDefined();
    } finally {
      await owner.pool.query(
        "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
        [key],
      );
      await owner.pool.query(`DROP DATABASE ${escapeIdentifier(peerDatabase)} WITH (FORCE)`);
    }
  });

  it("rejects mismatched CLI targets before applying migrations to an empty owner database", async () => {
    const peerDatabase = `role_cli_peer_${suffix}`;
    await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(peerDatabase)}`);
    const peerUrl = new URL(databaseUrl!);
    peerUrl.pathname = `/${peerDatabase}`;
    const peer = createDb(peerUrl.toString(), { poolMax: 1 });
    try {
      let failure: unknown;
      try {
        await promisify(execFile)("pnpm", ["db:migrate"], {
          cwd: path.resolve(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            DATABASE_URL: runtimeUrl,
            DATABASE_MIGRATION_URL: peerUrl.toString(),
          },
          timeout: 30_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(
        (await peer.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows,
      ).toEqual([]);
      expect(failure).toBeDefined();
      const output = failure as { stdout?: string; stderr?: string };
      expect(output.stderr).toContain("Database preparation failed");
      expect((output.stdout ?? "") + (output.stderr ?? "")).not.toContain(password);
    } finally {
      await close(peer);
      await owner.pool.query(`DROP DATABASE ${escapeIdentifier(peerDatabase)} WITH (FORCE)`);
    }
  });

  it("rejects conflicting migration-driver ports before contacting the other endpoint", async () => {
    let attempts = 0;
    const other = createServer((socket) => {
      attempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      other.once("error", reject);
      other.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = other.address();
      if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
      const migration = new URL(databaseUrl!);
      migration.hostname = "127.0.0.1";
      migration.searchParams.set("port", migration.port);
      migration.port = String(address.port);
      const application = new URL(runtimeUrl);
      application.hostname = "127.0.0.1";
      let failure: unknown;
      try {
        await promisify(execFile)("pnpm", ["db:migrate"], {
          cwd: path.resolve(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            DATABASE_URL: application.toString(),
            DATABASE_MIGRATION_URL: migration.toString(),
          },
          timeout: 30_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(attempts).toBe(0);
      expect(failure).toBeDefined();
      expect((failure as { stderr?: string }).stderr).toContain("Database preparation failed");
    } finally {
      await new Promise<void>((resolve, reject) => {
        other.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects a different migration schema before creating or changing its objects", async () => {
    const shadow = `migration_schema_${suffix}`;
    const migration = new URL(databaseUrl!);
    migration.searchParams.set("schema", shadow);
    try {
      let failure: unknown;
      try {
        await promisify(execFile)("pnpm", ["db:migrate"], {
          cwd: path.resolve(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            DATABASE_URL: runtimeUrl,
            DATABASE_MIGRATION_URL: migration.toString(),
          },
          timeout: 30_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(
        (await owner.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [shadow]))
          .rows,
      ).toEqual([]);
      expect(failure).toBeDefined();
      expect((failure as { stderr?: string }).stderr).toContain(
        "Database preparation requires the migration URL to select the public schema",
      );
      expect((failure as { stderr?: string }).stderr).not.toContain(password);
    } finally {
      await owner.pool.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(shadow)} CASCADE`);
    }
  });

  it.each(["URL", "environment"])(
    "keeps CLI migrations in public with a different owner startup search_path from %s",
    async (source) => {
      const shadow = `migration_path_${suffix}`;
      const peerDatabase = `path_${source.toLowerCase()}_${suffix}`;
      await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(peerDatabase)}`);
      const migration = new URL(databaseUrl!);
      migration.pathname = `/${peerDatabase}`;
      const peer = createDb(migration.toString(), { poolMax: 1 });
      const application = new URL(runtimeUrl);
      application.pathname = `/${peerDatabase}`;
      let prepared: ReturnType<typeof createDb> | undefined;
      await peer.pool.query(`CREATE SCHEMA ${escapeIdentifier(shadow)}`);
      if (source === "URL") migration.searchParams.set("options", `-csearch_path=${shadow},public`);
      try {
        expect(
          (await peer.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows,
        ).toEqual([]);
        await promisify(execFile)("pnpm", ["db:migrate"], {
          cwd: path.resolve(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            DATABASE_URL: application.toString(),
            DATABASE_MIGRATION_URL: migration.toString(),
            REALTIME_DATABASE_URL: application.toString(),
            PGOPTIONS: source === "environment" ? `-csearch_path=${shadow},public` : "",
          },
          timeout: 30_000,
        });
        expect(
          (await peer.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [shadow]))
            .rows,
        ).toEqual([]);
        expect(
          (await peer.pool.query("SELECT to_regclass('public.bots') IS NOT NULL AS ready")).rows,
        ).toEqual([{ ready: true }]);
        prepared = createDb(application.toString(), { poolMax: 1, rowSecurity: true });
        expect(await describeRowSecurity(prepared.prisma)).toMatchObject({ prepared: true });
      } finally {
        if (prepared) await close(prepared);
        await close(peer);
        await owner.pool.query(`DROP DATABASE ${escapeIdentifier(peerDatabase)} WITH (FORCE)`);
      }
    },
  );

  it("rejects a same-name runtime password before migrating a fresh database", async () => {
    const database = `same_login_cli_${suffix}`;
    await owner.pool.query(`CREATE DATABASE ${escapeIdentifier(database)}`);
    const administrator = new URL(databaseUrl!);
    administrator.pathname = `/${database}`;
    const bad = new URL(administrator);
    bad.password = "incorrect-same-name-fixture-password";
    const peer = createDb(administrator.toString(), { poolMax: 1 });
    const digests = await digestCount();
    try {
      let failure: unknown;
      try {
        await promisify(execFile)("pnpm", ["db:migrate"], {
          cwd: path.resolve(import.meta.dirname, "../../.."),
          env: {
            ...process.env,
            DATABASE_URL: bad.toString(),
            DATABASE_MIGRATION_URL: administrator.toString(),
          },
          timeout: 30_000,
        });
      } catch (error) {
        failure = error;
      }
      const tables = (
        await peer.pool.query(
          "SELECT count(*)::int AS total FROM pg_tables WHERE schemaname='public'",
        )
      ).rows[0].total;
      expect({ failed: Boolean(failure), tables }).toEqual({ failed: true, tables: 0 });
      expect((failure as { stderr?: string }).stderr).toContain("Database preparation failed");
      expect(JSON.stringify(failure)).not.toContain("incorrect-same-name-fixture-password");
      expect(await digestCount()).toBe(digests);
    } finally {
      await close(peer);
      await owner.pool.query(`DROP DATABASE ${escapeIdentifier(database)} WITH (FORCE)`);
    }
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
