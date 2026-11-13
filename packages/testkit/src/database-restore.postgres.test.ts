import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import { pageShareTokenFromSlug, SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import type { Pool, PrismaClient } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  databaseRestoreFence,
  JOB_QUEUE_POLICY,
  prepareDatabaseRestore,
  provisionRuntimeRole,
  ROW_SECURITY_POLICIES,
  rlsBypassKey,
  runAsSystem,
  runAsTenant,
  verifyDatabaseRestore,
} from "@rakazo/db";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPageShare } from "../../../apps/api/src/page-shares.js";
import { mountSharedPages } from "../../../apps/api/src/shared-pages.js";
import {
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  migrateJobQueue,
} from "../../adapters/src/wakeup.js";
import {
  expectExactPolicyCatalog,
  expectPhysicalPolicyTables,
  expectRegisteredPolicyTables,
  schemaPolicyTables,
} from "./row-security-expectations.js";

const sourceUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" && sourceUrl ? describe.sequential : describe.skip;
const queueTables = new Set([
  "_private_job_queues",
  "_private_jobs",
  "_private_known_crontabs",
  "_private_tasks",
]);

type Endpoint = { url: string; container?: string };
type CommandResult = { code: number | null; stdout: Buffer; stderr: string };
type Client = Pick<Pool, "query"> & {
  host: string;
  port: number;
  user?: string;
  database?: string;
  password?: unknown;
  connect(): Promise<void>;
  end(): Promise<void>;
};

// Resolve the database package's existing driver without adding a test dependency.
const { Client, escapeIdentifier } = createRequire(
  new URL("../../db/package.json", import.meta.url),
)("pg") as {
  Client: new (options: { connectionString: string }) => Client;
  escapeIdentifier: (value: string) => string;
};
type SharedPagesApp = Parameters<typeof mountSharedPages>[0];
const { Hono } = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "hono",
) as { Hono: new () => SharedPagesApp };
const pageShareFence = new URL("../../../scripts/restore-page-share-fence.sql", import.meta.url);

function isolatedTarget(url: string) {
  const target = new Client({ connectionString: url });
  if (
    !["127.0.0.1", "localhost", "::1"].includes(target.host) ||
    !Number.isInteger(target.port) ||
    target.port <= 1024 ||
    typeof target.database !== "string" ||
    !/^integration_(0|[1-9][0-9]*)$/.test(target.database) ||
    typeof target.user !== "string" ||
    !target.user
  )
    throw new Error("Archive restore tests require explicitly isolated harness databases");
  return target;
}

function credentialUrl(base: string, user: string, password: string) {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.searchParams.delete("user");
  url.searchParams.delete("password");
  return url.toString();
}

async function clientWork<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}

function childProcess(
  command: string,
  args: string[],
  input?: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "pipe", timeout: 120_000 });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        child.kill();
        reject(new Error("The isolated restore command exceeded its output budget"));
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }),
    );
    child.stdin.end(input);
  });
}

function handlers(received: string[]): BackgroundJobHandlers {
  const noop = async () => undefined;
  return {
    "native.source.poll": noop,
    "native.notion.signal": noop,
    "native.discord.signal": noop,
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
    "messaging.deliver": async ({ runId }) => {
      received.push(runId!);
    },
    "cloud_agent.poll": noop,
  };
}

postgres("custom archive recovery into a different cluster and database identity", () => {
  const suffix = randomBytes(8).toString("hex");
  const id = (name: string) => `restore-${name}-${suffix}`;
  const sourceLogin = `restore_source_${suffix}`;
  const targetLogin = `restore_target_${suffix}`;
  const alternateLogin = `restore_alternate_${suffix}`;
  const foreignRole = `restore_foreign_${suffix}`;
  const applicationPassword = randomBytes(24).toString("hex");
  const alternatePassword = randomBytes(24).toString("hex");
  let nativeBin: string | undefined;
  let source: Endpoint;
  let target: Endpoint;
  let originalTargetUrl: string;
  let targetContainer: StartedPostgreSqlContainer | undefined;
  let sourceOwner: ReturnType<typeof createDb> | undefined;
  let sourceRuntimeUrl: string;
  let targetRuntimeUrl: string;
  let sourceGroup: string;
  let targetGroup: string;
  let sourceGroupCreated = false;
  let targetGroupOwned = false;
  let foreignRoleOwned = false;
  let extraDatabase: string | undefined;
  let directory: string | undefined;
  let tocPath: string;
  let archive: Buffer;
  let restored = false;
  let archivedShareToken: string;
  let archivedShareSecretId: string;
  let ordinaryCiphertext: string;
  const pageTitle = "Synthetic restored Page a";
  const secrets = new EncryptedSecretStore(randomBytes(32).toString("hex"));
  const actor = {
    userId: id("user-a"),
    spaceId: id("space-a"),
    email: `a-${suffix}@example.test`,
    isDeploymentOwner: false,
  };

  function sharing(prisma: PrismaClient) {
    const anonymous = new Hono();
    mountSharedPages(anonymous, prisma, { enabled: true });
    const deps = {
      prisma: withSecretPersistence(prisma, secrets),
      secrets,
      env: { webOrigin: "https://pages.example.test" },
      pageSharingEnabled: true,
    };
    return {
      read: (token: string) => anonymous.request(`${SHARED_PAGE_PATH_PREFIX}${token}`),
      publish: () =>
        runAsTenant(actor, () =>
          setPageShare(deps, actor, {
            pageId: id("page-a"),
            visibility: "link",
            expectedTitle: pageTitle,
            expectedVersion: 2,
          }),
        ),
      revoke: () =>
        runAsTenant(actor, () =>
          setPageShare(deps, actor, { pageId: id("page-a"), visibility: "private" }),
        ),
    };
  }

  async function tool(
    endpoint: Endpoint,
    name: "pg_dump" | "pg_restore" | "psql",
    args: string[],
    input?: Buffer,
    connect = true,
  ) {
    const login = isolatedTarget(endpoint.url);
    const connection = connect ? ["-U", login.user!, "-d", login.database!] : [];
    if (nativeBin)
      return childProcess(
        path.join(nativeBin, name),
        [...args, ...(connect ? ["-h", login.host, "-p", String(login.port), ...connection] : [])],
        input,
        { ...process.env, PGPASSWORD: typeof login.password === "string" ? login.password : "" },
      );
    if (!endpoint.container) throw new Error("The isolated PostgreSQL container is unavailable");
    return childProcess(
      "docker",
      ["exec", "-i", endpoint.container, name, ...args, ...connection],
      input,
    );
  }

  async function successful(result: Promise<CommandResult>) {
    const completed = await result;
    expect(completed.stderr).not.toContain("ERROR:");
    expect(completed.code).toBe(0);
    return completed.stdout;
  }

  async function targetWork<T>(work: (client: Client) => Promise<T>) {
    return clientWork(target.url, work);
  }

  async function verify(urls = [targetRuntimeUrl]) {
    return verifyDatabaseRestore(target.url, urls);
  }

  async function restoreTarget() {
    if (restored) return;
    await prepareDatabaseRestore(target.url, [targetRuntimeUrl]);
    const toc = (
      await successful(tool(target, "pg_restore", ["--list"], archive, false))
    ).toString();
    let deferred = 0;
    const filtered = toc
      .split("\n")
      .filter((line) => {
        const policy = line.match(
          /^\d+;\s+\d+\s+\d+\s+POLICY\s+graphile_worker\s+(\S+)\s+coginebot_app_queue(?:\s|$)/,
        );
        if (!policy) return true;
        expect(queueTables.has(policy[1]!)).toBe(true);
        deferred++;
        return false;
      })
      .join("\n");
    expect(deferred).toBe(4);
    const policies = (value: string) => value.split("\n").filter((line) => /\sPOLICY\s/.test(line));
    expect(policies(filtered)).toHaveLength(policies(toc).length - 4);
    expect(filtered.split("\n").filter((line) => /\sROW SECURITY\s/.test(line))).toEqual(
      toc.split("\n").filter((line) => /\sROW SECURITY\s/.test(line)),
    );
    if (nativeBin) await writeFile(tocPath, filtered, { mode: 0o600 });
    else
      await successful(
        childProcess(
          "docker",
          ["exec", "-i", target.container!, "sh", "-c", 'umask 077; cat > "$1"', "sh", tocPath],
          Buffer.from(filtered),
        ),
      );
    const sql = await successful(
      tool(
        target,
        "pg_restore",
        ["--no-owner", "--no-privileges", "--use-list", tocPath, "--file=-"],
        archive,
        false,
      ),
    );
    expect(sql.length).toBeGreaterThan(0);
    const authority = await databaseRestoreFence(target.url, [targetRuntimeUrl]);
    expect(authority).toContain("restore_authority_fence");
    const transfer = await readFile(
      new URL("../../../scripts/restore-transfer-fence.sql", import.meta.url),
      "utf8",
    );
    const pages = await readFile(pageShareFence, "utf8");
    await successful(
      tool(
        target,
        "psql",
        [
          "-X",
          "--set=ON_ERROR_STOP=on",
          "--single-transaction",
          "--file=-",
          "--command",
          `${authority}\n${transfer}${pages}`,
        ],
        sql,
      ),
    );
    await migrateJobQueue(target.url);
    await provisionRuntimeRole(target.url, targetRuntimeUrl);
    const status = await verify();
    expect(status).toMatchObject({
      expectedTables: schemaPolicyTables.length,
      connectionEnforced: true,
    });
    expect(status.problems).toEqual([]);
    await targetWork(async (client) => {
      await expectPhysicalPolicyTables((sql) => client.query(sql));
      expectExactPolicyCatalog(
        (
          await client.query(
            "SELECT n.nspname AS schema,c.relname AS table,p.polname AS policy FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cogine_pages')",
          )
        ).rows,
      );
    });
    restored = true;
  }

  beforeAll(async () => {
    const sourceIdentity = isolatedTarget(sourceUrl!);
    if (
      process.env.VERIFY_ROW_SECURITY_POLICIES !== "harness_isolated" ||
      process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE !== sourceIdentity.database
    )
      throw new Error("Archive restore tests require the isolated policy harness opt-in");
    const bin = process.env.VERIFY_RESTORE_PG_BIN;
    const targetUrl = process.env.VERIFY_RESTORE_TARGET_URL;
    if (bin !== undefined || targetUrl !== undefined) {
      if (!bin?.trim() || !targetUrl?.trim() || !path.isAbsolute(bin))
        throw new Error(
          "Native restore fixtures require both an absolute binary directory and a target URL",
        );
      nativeBin = bin;
      originalTargetUrl = targetUrl;
      isolatedTarget(originalTargetUrl);
      source = { url: sourceUrl! };
      target = { url: originalTargetUrl };
      directory = await mkdtemp(path.join(tmpdir(), "database-restore-fixture-"));
      tocPath = path.join(directory, "restore.list");
    } else {
      const sourceContainer = process.env.VERIFY_POSTGRES_CONTAINER_ID;
      if (!sourceContainer || !/^[a-f0-9]{12,64}$/i.test(sourceContainer))
        throw new Error(
          "The restore suite requires its isolated source PostgreSQL container identity",
        );
      source = { url: sourceUrl!, container: sourceContainer };
      targetContainer = await new PostgreSqlContainer("postgres:16-alpine")
        .withDatabase(
          `integration_${900_000_000 + (randomBytes(4).readUInt32BE() % 1_000_000_000)}`,
        )
        .withUsername("restore_owner")
        .withPassword(randomBytes(24).toString("hex"))
        .start();
      originalTargetUrl = targetContainer.getConnectionUri();
      isolatedTarget(originalTargetUrl);
      target = { url: originalTargetUrl, container: targetContainer.getId() };
      tocPath = `/tmp/database-restore-${suffix}.list`;
    }
    sourceOwner = createDb(source.url);
    expectRegisteredPolicyTables(ROW_SECURITY_POLICIES);
    await expectPhysicalPolicyTables((sql) => sourceOwner.pool.query(sql));
    const sourceOid = Number(
      (await sourceOwner.pool.query("SELECT oid FROM pg_database WHERE datname=current_database()"))
        .rows[0].oid,
    );
    const sourceSystem = (
      await sourceOwner.pool.query("SELECT system_identifier::text AS id FROM pg_control_system()")
    ).rows[0].id;
    const targetSystem = await targetWork(
      async (client) =>
        (await client.query("SELECT system_identifier::text AS id FROM pg_control_system()"))
          .rows[0].id,
    );
    expect(targetSystem).not.toBe(sourceSystem);
    let targetOid = await targetWork(async (client) =>
      Number(
        (await client.query("SELECT oid FROM pg_database WHERE datname=current_database()")).rows[0]
          .oid,
      ),
    );
    if (targetOid === sourceOid) {
      const database = `integration_${900_000_000 + (randomBytes(4).readUInt32BE() % 1_000_000_000)}`;
      await targetWork((client) =>
        client.query(`CREATE DATABASE ${escapeIdentifier(database)} TEMPLATE template0`),
      );
      extraDatabase = database;
      const url = new URL(target.url);
      url.pathname = `/${extraDatabase}`;
      url.searchParams.delete("dbname");
      url.searchParams.delete("database");
      target.url = url.toString();
      isolatedTarget(target.url);
      targetOid = await targetWork(async (client) =>
        Number(
          (await client.query("SELECT oid FROM pg_database WHERE datname=current_database()"))
            .rows[0].oid,
        ),
      );
    }
    expect(targetOid).not.toBe(sourceOid);
    expect(
      (
        await targetWork((client) =>
          client.query(
            `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','graphile_worker','cogine_private','cogine_pages') AND c.relkind IN ('r','p')`,
          ),
        )
      ).rows,
    ).toEqual([]);
    sourceGroup = `coginebot_app_${sourceOid}`;
    targetGroup = `coginebot_app_${targetOid}`;
    sourceGroupCreated = !(
      await sourceOwner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [sourceGroup])
    ).rowCount;
    expect(
      (
        await targetWork((client) =>
          client.query("SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])", [
            [sourceGroup, targetGroup],
          ]),
        )
      ).rows,
    ).toEqual([]);
    targetGroupOwned = true;
    sourceRuntimeUrl = credentialUrl(source.url, sourceLogin, applicationPassword);
    targetRuntimeUrl = credentialUrl(target.url, targetLogin, applicationPassword);
    const organization = id("organization");
    await sourceOwner.prisma.user.createMany({
      data: ["a", "b"].map((name) => ({
        id: id(`user-${name}`),
        name: "Synthetic restore user",
        email: `${name}-${suffix}@example.test`,
      })),
    });
    await sourceOwner.prisma.organization.create({
      data: {
        id: organization,
        slug: organization,
        name: "Synthetic restore organization",
        createdAt: new Date(),
      },
    });
    for (const name of ["a", "b"]) {
      const userId = id(`user-${name}`);
      const spaceId = id(`space-${name}`);
      await sourceOwner.prisma.member.create({
        data: {
          id: id(`member-${name}`),
          userId,
          organizationId: organization,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await sourceOwner.prisma.space.create({
        data: { id: spaceId, organizationId: organization, name: "Synthetic restore Space" },
      });
      await sourceOwner.prisma.spaceMember.create({
        data: {
          id: id(`space-member-${name}`),
          spaceId,
          organizationId: organization,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await sourceOwner.prisma.bot.create({
        data: {
          id: id(`bot-${name}`),
          spaceId,
          userId,
          name: "Synthetic restore Bot",
          color: "gray",
        },
      });
      await sourceOwner.prisma.thread.create({
        data: {
          id: id(`thread-${name}`),
          spaceId,
          userId,
          botId: id(`bot-${name}`),
          nextMessageSeq: 1,
        },
      });
      await sourceOwner.prisma.message.create({
        data: {
          id: id(`message-${name}`),
          threadId: id(`thread-${name}`),
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: name === "a" ? "Synthetic α" : "合成乙" }],
        },
      });
      const title = `Synthetic restored Page ${name}`;
      const currentVersion = name === "a" ? 2 : 1;
      await sourceOwner.prisma.page.create({
        data: {
          id: id(`page-${name}`),
          userId,
          spaceId,
          botId: id(`bot-${name}`),
          title,
          currentVersion,
          versions: {
            create: Array.from({ length: currentVersion }, (_, index) => ({
              id: id(`page-version-${name}-${index + 1}`),
              version: index + 1,
              title,
              source: `source-${name}-${index + 1}`,
              code: `code-${name}-${index + 1}`,
            })),
          },
        },
      });
    }
    expect(sourceIdentity.user).not.toBe(sourceLogin);
    await migrateJobQueue(source.url);
    await provisionRuntimeRole(source.url, sourceRuntimeUrl);
    expect(await applyRowSecurityPolicies(source.url, sourceRuntimeUrl)).toMatchObject({
      expectedTables: schemaPolicyTables.length,
      connectionEnforced: true,
    });
    expectExactPolicyCatalog(
      (
        await sourceOwner.pool.query(
          "SELECT n.nspname AS schema,c.relname AS table,p.polname AS policy FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','cogine_pages')",
        )
      ).rows,
    );
    const sourceRuntime = createDb(sourceRuntimeUrl, { rowSecurity: true });
    const publisher = new GraphileJobPublisher(sourceRuntime.pool);
    try {
      await publisher.enqueue(messagingDeliverJob(id("persisted-job")));
      const ordinary = await secrets.put(
        "synthetic ordinary credential",
        {
          userId: actor.userId,
          spaceId: actor.spaceId,
          operationId: id("ordinary-secret"),
          traceId: id("ordinary-secret"),
          signal: new AbortController().signal,
        },
        { recordId: id("ordinary-secret") },
      );
      ordinaryCiphertext = ordinary.ciphertext;
      await sourceOwner.prisma.secret.create({
        data: {
          id: id("ordinary-secret"),
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: "mcp",
          ciphertext: ordinaryCiphertext,
        },
      });
      const sourceShare = sharing(sourceRuntime.prisma);
      const published = await sourceShare.publish();
      archivedShareToken = pageShareTokenFromSlug(new URL(published.shareUrl!).pathname)!;
      archivedShareSecretId = published.generation!;
      const live = await sourceShare.read(archivedShareToken);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ title: pageTitle, version: 2, code: "code-a-2" });
      archive = await successful(
        tool(source, "pg_dump", ["--format=custom", "--no-owner", "--no-privileges"]),
      );
      expect(archive.subarray(0, 5).toString()).toBe("PGDMP");
      await sourceShare.revoke();
      expect((await sourceShare.read(archivedShareToken)).status).toBe(404);
    } finally {
      await publisher.close();
      await sourceRuntime.prisma.$disconnect();
      await sourceRuntime.pool.end();
    }
  }, 180_000);

  async function dropRole(client: Client, role: string) {
    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) return;
    const policies = await client.query<{ schema: string; table: string; policy: string }>(
      `SELECT n.nspname AS schema,c.relname AS table,p.polname AS policy FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE p.polname=$1 AND $2::regrole::oid=ANY(p.polroles)`,
      [JOB_QUEUE_POLICY, role],
    );
    for (const policy of policies.rows)
      await client.query(
        `DROP POLICY ${escapeIdentifier(policy.policy)} ON ${escapeIdentifier(policy.schema)}.${escapeIdentifier(policy.table)}`,
      );
    await client.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
    await client.query(`DROP ROLE ${escapeIdentifier(role)}`);
  }

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (target)
      await cleanup(() =>
        targetWork(async (client) => {
          if (foreignRoleOwned) await dropRole(client, foreignRole);
          await dropRole(client, alternateLogin);
          await dropRole(client, targetLogin);
          if (targetGroupOwned) await dropRole(client, targetGroup);
        }),
      );
    if (sourceOwner) {
      await cleanup(() =>
        clientWork(source.url, async (client) => {
          await dropRole(client, sourceLogin);
          if (sourceGroupCreated) await dropRole(client, sourceGroup);
        }),
      );
      await cleanup(() => sourceOwner!.prisma.$disconnect());
      await cleanup(() => sourceOwner!.pool.end());
    }
    if (extraDatabase)
      await cleanup(() =>
        clientWork(originalTargetUrl, async (client) => {
          expect(
            (
              await client.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
                [extraDatabase],
              )
            ).rows,
          ).toEqual([]);
          await client.query(`DROP DATABASE ${escapeIdentifier(extraDatabase!)}`);
        }),
      );
    if (directory) await cleanup(() => rm(directory!, { recursive: true }));
    if (targetContainer) await cleanup(() => targetContainer!.stop());
    if (failures.length)
      throw new AggregateError(failures, "Archive restore fixture cleanup failed");
  }, 60_000);

  it("refuses the original archive's missing policy role and rolls back every restored table", async () => {
    const result = await tool(
      target,
      "pg_restore",
      ["--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error"],
      archive,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(sourceGroup);
    expect(result.stderr).toMatch(/role .* does not exist/);
    expect(
      (
        await targetWork((client) =>
          client.query(
            `SELECT to_regclass('public.messages') AS messages,to_regclass('graphile_worker.migrations') AS queue,to_regclass('cogine_private.rls_bypass_keys') AS keys`,
          ),
        )
      ).rows,
    ).toEqual([{ messages: null, queue: null, keys: null }]);
  }, 120_000);

  it("supports archives with no Pages, private-only Pages and links predating share revisions", async () => {
    const fence = await readFile(pageShareFence, "utf8");
    await targetWork(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(fence);
        await client.query(`
          CREATE SCHEMA cogine_pages;
          CREATE TABLE cogine_pages.pages (
            id text PRIMARY KEY, "userId" text, "spaceId" text, visibility text
          );
          INSERT INTO cogine_pages.pages VALUES
            ('private', 'owner', 'space', 'private');
        `);
        await client.query(fence);
        expect((await client.query("SELECT visibility FROM cogine_pages.pages")).rows).toEqual([
          { visibility: "private" },
        ]);

        await client.query(`
          CREATE TABLE public.secrets (
            id text PRIMARY KEY, "userId" text, "spaceId" text, kind text
          );
          INSERT INTO public.secrets VALUES
            ('linked', 'owner', 'space', 'page_share'),
            ('other-scope', 'owner', 'another-space', 'page_share'),
            ('ordinary', 'owner', 'space', 'mcp'),
            ('orphan', 'owner', 'space', 'page_share');
          ALTER TABLE cogine_pages.pages
            ADD COLUMN "shareTokenHash" text,
            ADD COLUMN "shareSecretId" text REFERENCES public.secrets(id) ON DELETE SET NULL;
          INSERT INTO cogine_pages.pages VALUES
            ('shared', 'owner', 'space', 'link', 'hash', 'linked'),
            ('foreign-ref', 'owner', 'space', 'link', 'foreign-hash', 'other-scope'),
            ('ordinary-ref', 'owner', 'space', 'private', NULL, 'ordinary'),
            ('hash-only', 'owner', 'space', 'private', 'orphan-hash', NULL);
        `);
        await client.query(fence);
        expect(
          (
            await client.query(`
              SELECT id, visibility, "shareTokenHash", "shareSecretId"
              FROM cogine_pages.pages ORDER BY id
            `)
          ).rows,
        ).toEqual(
          ["foreign-ref", "hash-only", "ordinary-ref", "private", "shared"].map((id) => ({
            id,
            visibility: "private",
            shareTokenHash: null,
            shareSecretId: null,
          })),
        );
        expect((await client.query("SELECT id FROM public.secrets ORDER BY id")).rows).toEqual(
          ["ordinary", "orphan", "other-scope"].map((id) => ({ id })),
        );
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("rolls back the entire import if a Page archive contains an incomplete share schema", async () => {
    const result = await tool(
      target,
      "psql",
      [
        "-X",
        "--set=ON_ERROR_STOP=on",
        "--single-transaction",
        "--file=-",
        "--command",
        await readFile(pageShareFence, "utf8"),
      ],
      Buffer.from(`
        CREATE SCHEMA cogine_pages;
        CREATE TABLE cogine_pages.pages (id text PRIMARY KEY, "shareTokenHash" text);
      `),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("incomplete share schema");
    expect(
      (
        await targetWork((client) =>
          client.query("SELECT to_regnamespace('cogine_pages') AS schema"),
        )
      ).rows,
    ).toEqual([{ schema: null }]);
  });

  it("refuses foreign default table privileges before any restored application table is committed", async () => {
    const migrationOwner = await targetWork(
      async (client) =>
        (await client.query<{ role: string }>("SELECT current_user AS role")).rows[0]!.role,
    );
    let granted = false;
    try {
      await targetWork(async (client) => {
        await client.query(`CREATE ROLE ${escapeIdentifier(foreignRole)} NOLOGIN`);
        foreignRoleOwned = true;
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(migrationOwner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${escapeIdentifier(foreignRole)}`,
        );
        granted = true;
      });
      await expect(prepareDatabaseRestore(target.url, [targetRuntimeUrl])).rejects.toThrow(
        "The restored database has authority outside the selected owner and runtime roles",
      );
      expect(
        (
          await targetWork((client) =>
            client.query(
              "SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",
              [foreignRole],
            ),
          )
        ).rows,
      ).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }]);
      expect(
        (
          await targetWork((client) =>
            client.query(
              `SELECT EXISTS (
                SELECT 1 FROM pg_default_acl d
                JOIN pg_namespace n ON n.oid=d.defaclnamespace
                CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                JOIN pg_roles r ON r.oid=a.grantee
                WHERE d.defaclrole=$1::regrole AND d.defaclobjtype='r'
                  AND n.nspname='public' AND r.rolname=$2 AND a.privilege_type='SELECT'
              ) AS retained`,
              [migrationOwner, foreignRole],
            ),
          )
        ).rows,
      ).toEqual([{ retained: true }]);
      expect(
        (
          await targetWork((client) =>
            client.query(
              `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname IN ('public','graphile_worker','cogine_private','cogine_pages') AND c.relkind IN ('r','p')`,
            ),
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await targetWork(async (client) => {
        if (granted)
          await client.query(
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${escapeIdentifier(migrationOwner)} IN SCHEMA public REVOKE SELECT ON TABLES FROM ${escapeIdentifier(foreignRole)}`,
          );
        if (foreignRoleOwned) {
          await client.query(`DROP ROLE ${escapeIdentifier(foreignRole)}`);
          foreignRoleOwned = false;
        }
      });
    }
    await expect(prepareDatabaseRestore(target.url, [targetRuntimeUrl])).resolves.toBeUndefined();
  }, 20_000);

  it("rejects a login-enabled restore grant role without silently repairing it", async () => {
    await prepareDatabaseRestore(target.url);
    await targetWork((client) => client.query(`ALTER ROLE ${escapeIdentifier(targetGroup)} LOGIN`));
    try {
      await expect(prepareDatabaseRestore(target.url)).rejects.toThrow(
        "The restore runtime grant role must be an unused restricted NOLOGIN role",
      );
      expect(
        (
          await targetWork((client) =>
            client.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [targetGroup]),
          )
        ).rows,
      ).toEqual([{ rolcanlogin: true }]);
    } finally {
      await targetWork((client) =>
        client.query(`ALTER ROLE ${escapeIdentifier(targetGroup)} NOLOGIN`),
      );
    }
    await expect(prepareDatabaseRestore(target.url)).resolves.toBeUndefined();
  }, 20_000);

  it("restores tenant content, authenticated system access and queued work before accepting the destination", async () => {
    await restoreTarget();
    const runtime = createDb(targetRuntimeUrl, { poolMax: 6, rowSecurity: true });
    const received: string[] = [];
    const publisher = new GraphileJobPublisher(runtime.pool);
    const host = new GraphileJobWorkerHost(runtime.pool, { concurrency: 1, pollInterval: 25 });
    try {
      const targetShare = sharing(runtime.prisma);
      expect((await targetShare.read(archivedShareToken)).status).toBe(404);
      for (const name of ["a", "b"])
        await runAsTenant(
          { userId: id(`user-${name}`), spaceId: id(`space-${name}`) },
          async () => {
            const rows = await runtime.prisma.message.findMany({
              select: { id: true, blocks: true },
            });
            expect(rows).toEqual([
              {
                id: id(`message-${name}`),
                blocks: [{ kind: "text", text: name === "a" ? "Synthetic α" : "合成乙" }],
              },
            ]);
            expect(
              await runtime.prisma.message.findMany({
                where: { threadId: id(`thread-${name === "a" ? "b" : "a"}`) },
              }),
            ).toEqual([]);
            expect(
              await runtime.prisma.page.findMany({
                select: {
                  id: true,
                  title: true,
                  botId: true,
                  currentVersion: true,
                  visibility: true,
                  shareRevision: true,
                  shareTokenHash: true,
                  shareSecretId: true,
                  versions: {
                    orderBy: { version: "asc" },
                    select: { id: true, version: true, source: true, code: true },
                  },
                },
              }),
            ).toEqual([
              {
                id: id(`page-${name}`),
                title: `Synthetic restored Page ${name}`,
                botId: id(`bot-${name}`),
                currentVersion: name === "a" ? 2 : 1,
                visibility: "private",
                shareRevision: name === "a" ? 1 : 0,
                shareTokenHash: null,
                shareSecretId: null,
                versions: Array.from({ length: name === "a" ? 2 : 1 }, (_, index) => ({
                  id: id(`page-version-${name}-${index + 1}`),
                  version: index + 1,
                  source: `source-${name}-${index + 1}`,
                  code: `code-${name}-${index + 1}`,
                })),
              },
            ]);
          },
        );
      await runAsTenant(actor, async () => {
        expect(
          await runtime.prisma.secret.findUnique({ where: { id: archivedShareSecretId } }),
        ).toBeNull();
        const ordinary = await runtime.prisma.secret.findUniqueOrThrow({
          where: { id: id("ordinary-secret") },
        });
        expect(ordinary.ciphertext).toBe(ordinaryCiphertext);
        expect(await secrets.load(ordinary.ciphertext, ordinary.id)).toBe(
          "synthetic ordinary credential",
        );
      });
      const published = await targetShare.publish();
      const freshToken = pageShareTokenFromSlug(new URL(published.shareUrl!).pathname)!;
      expect(published.generation).not.toBe(archivedShareSecretId);
      expect(freshToken).not.toBe(archivedShareToken);
      expect((await targetShare.read(freshToken)).status).toBe(200);
      expect((await targetShare.read(archivedShareToken)).status).toBe(404);
      expect((await runtime.pool.query("SELECT id FROM public.messages")).rows).toEqual([]);
      expect((await runtime.pool.query("SELECT id FROM cogine_pages.page_versions")).rows).toEqual(
        [],
      );
      expect(
        await runAsSystem("verify restored synthetic content", () =>
          runtime.prisma.message.count(),
        ),
      ).toBe(2);
      for (const key of ["", "invalid-synthetic-key"])
        await clientWork(targetRuntimeUrl, async (client) => {
          await client.query(
            "SELECT set_config('app.rls_bypass','on',false),set_config('app.rls_bypass_key',$1,false)",
            [key],
          );
          expect((await client.query("SELECT public.app_rls_bypass() AS allowed")).rows).toEqual([
            { allowed: false },
          ]);
          expect((await client.query("SELECT id FROM public.messages")).rows).toEqual([]);
        });
      await host.start(handlers(received));
      await vi.waitFor(() => expect(received).toEqual([id("persisted-job")]), {
        timeout: 10_000,
        interval: 25,
      });
      await publisher.enqueue(messagingDeliverJob(id("fresh-job")));
      await vi.waitFor(() => expect(received).toEqual([id("persisted-job"), id("fresh-job")]), {
        timeout: 10_000,
        interval: 25,
      });
    } finally {
      await host.stop();
      await publisher.close();
      await runtime.prisma.$disconnect();
      await runtime.pool.end();
    }
    expect(await verify()).toMatchObject({
      expectedTables: schemaPolicyTables.length,
      connectionEnforced: true,
    });
  }, 120_000);

  it("rejects an extra system key without deleting it or the selected credential", async () => {
    await restoreTarget();
    const digest = createHash("sha256").update(id("unselected-key")).digest("hex");
    await targetWork((client) =>
      client.query("INSERT INTO cogine_private.rls_bypass_keys(digest) VALUES(decode($1,'hex'))", [
        digest,
      ]),
    );
    try {
      await expect(verify()).rejects.toThrow(
        "The restored database contains system keys outside the selected credential inventory",
      );
      expect(
        Number(
          (
            await targetWork((client) =>
              client.query("SELECT count(*) AS count FROM cogine_private.rls_bypass_keys"),
            )
          ).rows[0].count,
        ),
      ).toBe(2);
    } finally {
      await targetWork((client) =>
        client.query("DELETE FROM cogine_private.rls_bypass_keys WHERE digest=decode($1,'hex')", [
          digest,
        ]),
      );
    }
    expect(await verify()).toMatchObject({ connectionEnforced: true });
  }, 20_000);

  it("requires an explicit inventory when a second runtime credential is prepared", async () => {
    await restoreTarget();
    const alternateUrl = credentialUrl(target.url, alternateLogin, alternatePassword);
    const digest = createHash("sha256").update(rlsBypassKey(alternateUrl)).digest("hex");
    await provisionRuntimeRole(target.url, alternateUrl);
    try {
      await expect(verify()).rejects.toThrow(
        /outside the selected (owner and runtime roles|credential inventory)/,
      );
      expect(await verify([targetRuntimeUrl, alternateUrl])).toMatchObject({
        expectedTables: schemaPolicyTables.length,
        connectionEnforced: true,
      });
    } finally {
      await targetWork(async (client) => {
        await dropRole(client, alternateLogin);
        await client.query(
          "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=decode($1,'hex')",
          [digest],
        );
      });
    }
    expect(await verify()).toMatchObject({ connectionEnforced: true });
  }, 30_000);

  it("rejects partially disabled application policies before accepting the destination", async () => {
    await restoreTarget();
    await targetWork((client) =>
      client.query("ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY"),
    );
    try {
      await expect(verify()).rejects.toThrow(
        "The restored database role, policies, or system guard are not ready",
      );
    } finally {
      await targetWork((client) =>
        client.query("ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY"),
      );
    }
    expect(await verify()).toMatchObject({ connectionEnforced: true });
  }, 20_000);

  it("requires the other database clients to be drained before verification", async () => {
    await restoreTarget();
    const writer = new Client({ connectionString: targetRuntimeUrl });
    try {
      await writer.connect();
      await writer.query("SELECT 1");
      await expect(verify()).rejects.toThrow(
        "Stop database writers before verifying the restored database",
      );
    } finally {
      await writer.end();
    }
    expect(await verify()).toMatchObject({ connectionEnforced: true });
  }, 20_000);
});
