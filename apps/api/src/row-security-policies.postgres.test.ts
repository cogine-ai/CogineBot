import { randomBytes } from "node:crypto";
import type { Prisma, RowSecurityPolicyStatus } from "@rakazo/db";
import {
  applyRowSecurityPolicies,
  createDb,
  currentDbContext,
  describeRowSecurity,
  describeRowSecurityPolicies,
  issueMessagingLinkCode,
  listTicketComments,
  provisionRuntimeRole,
  redeemMessagingLinkCode,
  renameSpaceForMember,
  runAsSystem,
  runAsSystemInTransaction,
  runAsTenant,
  scramSha256Verifier,
  toTicketCommentDto,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROW_SECURITY_POLICIES } from "../../../packages/db/src/row-security-policies.js";

const databaseUrl = process.env.DATABASE_URL;
// DDL below uses only generated fixture identifiers and synthetic SCRAM values.
const escapeIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const escapeLiteral = (value: string) =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;

// The integration harness gives this file its own database. These are the
// production policies, without the permissive canary policies used elsewhere.
postgres("complete database policies (isolated PostgreSQL)", () => {
  const suffix = randomBytes(10).toString("hex");
  const role = `policy_runtime_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const id = (name: string) => `policy-${name}-${suffix}`;
  const userA = id("user-a");
  const userB = id("user-b");
  const orgA = id("org-a");
  const orgB = id("org-b");
  const spaceA = id("space-a");
  const spaceB = id("space-b");
  const spaceC = id("space-c");
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb> | undefined;
  let runtimeUrl: string;
  let groupRole: string | undefined;
  let beforePolicies: RowSecurityPolicyStatus;
  let installed: RowSecurityPolicyStatus;

  const inA = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId: spaceA, userId: userA }, fn);
  function databaseCodes(error: unknown, seen = new Set<object>()): string[] {
    if (!error || typeof error !== "object" || seen.has(error)) return [];
    seen.add(error);
    const record = error as Record<string, unknown>;
    const codes = [record.code, record.originalCode].filter(
      (code): code is string => typeof code === "string",
    );
    for (const key of ["cause", "meta", "driverAdapterError"])
      codes.push(...databaseCodes(record[key], seen));
    return codes;
  }
  async function rejectedByPolicy(operation: Promise<unknown>): Promise<void> {
    let failure: unknown;
    try {
      await operation;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(databaseCodes(failure)).toContain("42501");
  }
  const ids = (table: string) =>
    runtime!.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public.${escapeIdentifier(table)} ORDER BY id`,
    );
  const catalog = async () =>
    (
      await owner.pool.query(
        "SELECT c.relname, c.relrowsecurity, p.polname, p.polcmd, p.polpermissive, " +
          "p.polroles::text, pg_get_expr(p.polqual,p.polrelid) AS qualifier, " +
          "pg_get_expr(p.polwithcheck,p.polrelid) AS write_check " +
          "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace " +
          "LEFT JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid " +
          "WHERE n.nspname='public' AND c.relname=ANY($1::text[]) " +
          "ORDER BY c.relname,p.polname",
        [ROW_SECURITY_POLICIES.map(({ table }) => table)],
      )
    ).rows;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const expectedDatabase = process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE;
    const databaseName = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(databaseName) ||
      databaseName !== expectedDatabase
    )
      throw new Error("Row-policy tests require the explicitly isolated harness database");
    owner = createDb(databaseUrl!);
    url.username = role;
    url.password = password;
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    const database = await owner.pool.query<{ oid: number; name: string }>(
      "SELECT oid,datname AS name FROM pg_catalog.pg_database WHERE datname=current_database()",
    );
    expect(database.rows[0]?.name).toBe(expectedDatabase);
    groupRole = `coginebot_app_${database.rows[0]!.oid}`;
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    beforePolicies = await describeRowSecurityPolicies(runtime.prisma);

    await owner.prisma.user.createMany({
      data: [
        { id: userA, name: "Policy A", email: `${id("a")}@example.test` },
        { id: userB, name: "Policy B", email: `${id("b")}@example.test` },
      ],
    });
    await owner.prisma.organization.createMany({
      data: [orgA, orgB].map((organization) => ({
        id: organization,
        slug: organization,
        name: "Policy fixture",
        createdAt: new Date(),
      })),
    });
    await owner.prisma.member.createMany({
      data: [
        { id: id("member-a"), organizationId: orgA, userId: userA, role: "owner" },
        { id: id("member-b"), organizationId: orgB, userId: userB, role: "owner" },
        { id: id("member-shared"), organizationId: orgA, userId: userB, role: "member" },
      ].map((member) => ({ ...member, createdAt: new Date() })),
    });
    await owner.prisma.space.createMany({
      data: [
        { id: spaceA, organizationId: orgA, name: "A", isDefault: true },
        { id: spaceC, organizationId: orgA, name: "C" },
        { id: spaceB, organizationId: orgB, name: "B", isDefault: true },
      ],
    });
    await owner.prisma.spaceMember.createMany({
      data: [
        {
          id: id("membership-a"),
          spaceId: spaceA,
          organizationId: orgA,
          userId: userA,
          role: "owner",
        },
        {
          id: id("membership-c"),
          spaceId: spaceC,
          organizationId: orgA,
          userId: userA,
          role: "owner",
        },
        {
          id: id("membership-b"),
          spaceId: spaceB,
          organizationId: orgB,
          userId: userB,
          role: "owner",
        },
        {
          id: id("membership-shared"),
          spaceId: spaceA,
          organizationId: orgA,
          userId: userB,
          role: "member",
        },
      ].map((membership) => ({ ...membership, createdAt: new Date() })),
    });
    for (const [side, spaceId, userId] of [
      ["a", spaceA, userA],
      ["b", spaceB, userB],
      ["c", spaceC, userA],
    ]) {
      await owner.prisma.memoryDocument.create({
        data: {
          id: id(`document-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          scope: "isolated",
          path: "MEMORY.md",
          content: "Synthetic memory",
          revisions: {
            create: { id: id(`revision-${side}`), revision: 1, content: "Synthetic revision" },
          },
        },
      });
    }
    await owner.prisma.userModelCredential.createMany({
      data: [
        {
          id: id("credential-a"),
          userId: userA,
          provider: "fixture",
          label: "A",
          secretId: id("ref-a"),
        },
        {
          id: id("credential-b"),
          userId: userB,
          provider: "fixture",
          label: "B",
          secretId: id("ref-b"),
        },
      ],
    });
    await owner.prisma.secret.createMany({
      data: [
        { id: id("account-secret-a"), userId: userA, kind: "model", ciphertext: "synthetic-a" },
        { id: id("account-secret-b"), userId: userB, kind: "voice", ciphertext: "synthetic-b" },
        {
          id: id("space-secret-a"),
          userId: userB,
          spaceId: spaceA,
          kind: "fixture",
          ciphertext: "synthetic-space",
        },
      ],
    });
    await owner.prisma.nativeAppConfig.create({
      data: {
        id: id("config"),
        appId: "fixture",
        label: "Synthetic config",
        ownership: "deployment",
        credentialKind: "oauth",
        callbackUri: "https://example.test/callback",
      },
    });
    for (const [side, spaceId, userId] of [
      ["a", spaceA, userA],
      ["b", spaceB, userB],
    ]) {
      await owner.prisma.bot.create({
        data: {
          id: id(`bot-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          name: "Fixture",
          color: "ink",
        },
      });
      await owner.prisma.thread.create({
        data: {
          id: id(`thread-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          botId: id(`bot-${side}`),
        },
      });
      await owner.prisma.message.create({
        data: {
          id: id(`message-${side}`),
          threadId: id(`thread-${side}`),
          seq: 1,
          role: "assistant",
          blocks: [],
        },
      });
      await owner.prisma.task.create({
        data: {
          id: id(`task-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          botId: id(`bot-${side}`),
          threadId: id(`thread-${side}`),
          prompt: "Synthetic",
          status: "running",
        },
      });
      await owner.prisma.run.create({
        data: {
          id: id(`run-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          botId: id(`bot-${side}`),
          threadId: id(`thread-${side}`),
          taskId: id(`task-${side}`),
          status: "running",
          trigger: "human",
        },
      });
      await owner.prisma.routine.create({
        data: {
          id: id(`routine-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          botId: id(`bot-${side}`),
          name: "Synthetic",
          prompt: "Synthetic",
          crons: [],
        },
      });
      await owner.prisma.nativeOAuthGrant.create({
        data: {
          id: id(`grant-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          configId: id("config"),
          configRevision: 1,
          authority: "fixture",
          subject: id(`subject-${side}`),
        },
      });
      await owner.prisma.connection.create({
        data: {
          id: id(`connection-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          connectorId: "native",
          provider: "fixture",
          displayName: "Synthetic",
          status: "connected",
          oauthGrantId: id(`grant-${side}`),
          nativeConfigId: id("config"),
          nativeConfigRevision: 1,
        },
      });
      await owner.prisma.botPackageImport.create({
        data: {
          id: id(`import-${side}`),
          spaceId: spaceId!,
          userId: userId!,
          clientNonce: id(`nonce-${side}`),
        },
      });
    }
    await owner.prisma.botPackageComponent.createMany({
      data: [
        {
          id: id("component-a"),
          importId: id("import-a"),
          botId: id("bot-a"),
          key: "a",
          kind: "skill",
          name: "A",
        },
        {
          id: id("component-b"),
          importId: id("import-b"),
          botId: id("bot-b"),
          key: "b",
          kind: "skill",
          name: "B",
        },
        {
          id: id("component-mixed"),
          importId: id("import-a"),
          botId: id("bot-b"),
          key: "mixed",
          kind: "skill",
          name: "Mixed",
        },
      ],
    });
    await owner.prisma.bot.create({
      data: {
        id: id("shared-bot"),
        spaceId: spaceA,
        userId: userB,
        name: "Shared fixture",
        color: "ink",
      },
    });
    await owner.prisma.steeringMessage.createMany({
      data: [
        {
          id: id("steering-a"),
          messageId: id("message-a"),
          botId: id("bot-a"),
          userId: userA,
          runId: id("run-a"),
        },
        { id: id("steering-mixed"), messageId: id("message-b"), botId: id("bot-a"), userId: userA },
      ],
    });
    await owner.prisma.externalEffect.createMany({
      data: [
        {
          id: id("checkpoint-a"),
          spaceId: spaceA,
          runId: id("run-a"),
          kind: "runtime_checkpoint",
          idempotencyKey: id("effect-a"),
          status: "prepared",
          request: {},
        },
        {
          id: id("checkpoint-mixed"),
          spaceId: spaceA,
          runId: id("run-b"),
          kind: "runtime_checkpoint",
          idempotencyKey: id("effect-mixed"),
          status: "prepared",
          request: {},
        },
      ],
    });
    await owner.prisma.nativeOAuthSession.createMany({
      data: [
        {
          id: id("session-a"),
          stateHash: id("state-a"),
          spaceId: spaceA,
          userId: userA,
          connectionId: id("connection-a"),
          configId: id("config"),
          configRevision: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: id("session-mixed"),
          stateHash: id("state-mixed"),
          spaceId: spaceA,
          userId: userA,
          connectionId: id("connection-b"),
          configId: id("config"),
          configRevision: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });
    await owner.prisma.nativeRoutineTrigger.createMany({
      data: [
        {
          id: id("trigger-a"),
          routineId: id("routine-a"),
          connectionId: id("connection-a"),
          grantId: id("grant-a"),
        },
        {
          id: id("trigger-mixed"),
          routineId: id("routine-a"),
          connectionId: id("connection-b"),
          grantId: id("grant-b"),
        },
      ].map((trigger) => ({
        ...trigger,
        authorizationRevision: "synthetic",
        authGeneration: 1,
        configId: id("config"),
        configRevision: 1,
        kind: "calendar.event_changed",
        resourceType: "fixture",
        resourceId: "fixture",
        spec: {},
      })),
    });
    installed = await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      for (const name of [role, groupRole].filter((name): name is string => Boolean(name))) {
        await cleanup(async () => {
          const exists = await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [name]);
          if (exists.rowCount) {
            await owner.pool.query(`DROP OWNED BY ${escapeIdentifier(name)}`);
            await owner.pool.query(`DROP ROLE ${escapeIdentifier(name)}`);
          }
        });
      }
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Policy fixture cleanup failed");
  });

  it("installs the exact schema-wide policy set for a real restricted connection", async () => {
    expect(beforePolicies.policyInstalled).toBe(false);
    expect(installed).toMatchObject({
      expectedTables: ROW_SECURITY_POLICIES.length,
      policyInstalled: true,
      policyEnabled: true,
      connectionEnforced: true,
      deploymentEnforced: false,
      guardValid: true,
      legacyPolicyCount: 0,
    });
    expect(installed.tables).toHaveLength(ROW_SECURITY_POLICIES.length);
    expect(
      installed.tables.every(
        (table) => table.present && table.enabled && table.active && table.policyMatch,
      ),
    ).toBe(true);
    const actualRole = await runtime!.prisma.$queryRawUnsafe<
      Array<{ superuser: boolean; bypass: boolean; owns: boolean }>
    >(
      "SELECT r.rolsuper AS superuser,r.rolbypassrls AS bypass," +
        "pg_has_role(r.oid,c.relowner,'MEMBER') AS owns " +
        "FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.memory_documents'::regclass",
    );
    expect(actualRole).toEqual([{ superuser: false, bypass: false, owns: false }]);
    const snapshot = await catalog();
    expect(snapshot).toHaveLength(154);
    expect(
      snapshot.every(
        (policy) => policy.polpermissive && policy.polcmd === "*" && policy.polroles === "{0}",
      ),
    ).toBe(true);
  });

  it("keeps connection proof separate from deployment activation and makes status read-only", async () => {
    const before = await catalog();
    const preparation = await describeRowSecurity(runtime!.prisma);
    expect(preparation).toMatchObject({ prepared: true, enforced: false });
    const contexts: Array<ReturnType<typeof currentDbContext>> = [];
    const checked = new Proxy(runtime!.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            contexts.push(currentDbContext());
            return callback(tx);
          });
      },
    });
    const expected = {
      policyInstalled: true,
      connectionEnforced: true,
      deploymentEnforced: false,
    };
    expect(await describeRowSecurityPolicies(checked)).toMatchObject(expected);
    expect(currentDbContext()).toBeUndefined();
    await inA(async () => {
      expect(await describeRowSecurityPolicies(checked)).toMatchObject(expected);
      expect(currentDbContext()).toEqual({ kind: "tenant", spaceId: spaceA, userId: userA });
      expect(await ids("memory_documents")).toEqual([{ id: id("document-a") }]);
      expect(await runtime!.prisma.nativeAppConfig.count()).toBe(0);
    });
    const reason = "inspect a synthetic policy status from an existing system caller";
    await runAsSystem(reason, async () => {
      expect(await describeRowSecurityPolicies(checked)).toMatchObject(expected);
      expect(currentDbContext()).toEqual({ kind: "system", reason });
    });
    expect(contexts).toEqual([
      undefined,
      { kind: "tenant", spaceId: spaceA, userId: userA },
      { kind: "system", reason },
    ]);
    expect(currentDbContext()).toBeUndefined();
    expect(await ids("memory_documents")).toEqual([]);
    expect(await catalog()).toEqual(before);
  });

  it("preserves direct-Space and shared-Space reads without exposing another Space", async () => {
    expect(await ids("memory_documents")).toEqual([]);
    expect(await inA(() => ids("memory_documents"))).toEqual([{ id: id("document-a") }]);
    expect(await inA(() => ids("memory_revisions"))).toEqual([{ id: id("revision-a") }]);
    expect(await inA(() => ids("bots"))).toEqual(
      [{ id: id("bot-a") }, { id: id("shared-bot") }].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      await runAsTenant({ spaceId: spaceC, userId: userA }, () => ids("memory_documents")),
    ).toEqual([{ id: id("document-c") }]);
    expect(
      await runtime!.prisma.memoryDocument.findUnique({ where: { id: id("document-b") } }),
    ).toBeNull();
  });

  it("rejects foreign raw writes and foreign parent links while permitting an authorized revision", async () => {
    await rejectedByPolicy(
      inA(() =>
        runtime!.prisma.$executeRawUnsafe(
          'INSERT INTO memory_documents(id,"spaceId","userId",scope,path,content,"updatedAt") VALUES ($1,$2,$3,$4,$5,$6,now())',
          id("forged-document"),
          spaceB,
          userA,
          "isolated",
          "FORGED.md",
          "Synthetic",
        ),
      ),
    );
    expect(
      await inA(() =>
        runtime!.prisma.$executeRawUnsafe(
          "UPDATE memory_documents SET content=$1 WHERE id=$2",
          "Changed",
          id("document-b"),
        ),
      ),
    ).toBe(0);
    await rejectedByPolicy(
      inA(() =>
        runtime!.prisma.memoryRevision.create({
          data: { documentId: id("document-b"), revision: 2, content: "Foreign" },
        }),
      ),
    );
    await inA(() =>
      runtime!.prisma.memoryRevision.create({
        data: {
          id: id("authorized-revision"),
          documentId: id("document-a"),
          revision: 2,
          content: "Authorized",
        },
      }),
    );
    expect((await inA(() => ids("memory_revisions"))).map((row) => row.id)).toContain(
      id("authorized-revision"),
    );
    expect(await inA(() => ids("bot_package_components"))).toEqual([{ id: id("component-a") }]);
    await inA(() =>
      runtime!.prisma.botPackageComponent.create({
        data: {
          importId: id("import-a"),
          botId: id("bot-a"),
          key: "authorized",
          kind: "skill",
          name: "Authorized",
        },
      }),
    );
    await rejectedByPolicy(
      inA(() =>
        runtime!.prisma.botPackageComponent.create({
          data: {
            importId: id("import-a"),
            botId: id("bot-b"),
            key: "forged",
            kind: "skill",
            name: "Foreign",
          },
        }),
      ),
    );
  });

  it("keeps account membership across selected Spaces without recursive policies", async () => {
    expect(await inA(() => ids("spaces"))).toEqual(
      [{ id: spaceA }, { id: spaceC }].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await inA(() => ids("space_members"))).toEqual(
      [{ id: id("membership-a") }, { id: id("membership-c") }].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    expect(await inA(() => ids("organization"))).toEqual([{ id: orgA }]);
    expect(await inA(() => ids("user"))).toEqual([{ id: userA }]);
    expect(
      await inA(() =>
        renameSpaceForMember(runtime!.prisma, {
          currentSpaceId: spaceA,
          spaceId: spaceC,
          userId: userA,
          name: "Renamed",
        }),
      ),
    ).toEqual({ id: spaceC, name: "Renamed" });
    await expect(
      inA(() =>
        renameSpaceForMember(runtime!.prisma, {
          currentSpaceId: spaceA,
          spaceId: spaceB,
          userId: userA,
          name: "Denied",
        }),
      ),
    ).rejects.toThrow();
  });

  it("separates account credentials and Space secrets from system-only configuration", async () => {
    expect(await inA(() => ids("user_model_credentials"))).toEqual([{ id: id("credential-a") }]);
    expect(await inA(() => ids("secrets"))).toEqual(
      [{ id: id("account-secret-a") }, { id: id("space-secret-a") }].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    expect(await inA(() => ids("native_app_configs"))).toEqual([]);
    expect(
      await runAsSystem("read synthetic deployment metadata", () => ids("native_app_configs")),
    ).toEqual([{ id: id("config") }]);
    await expect(
      inA(() =>
        runtime!.prisma.userModelCredential.update({
          where: { id: id("credential-b") },
          data: { label: "Denied" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("requires coherent local parents for steering, checkpoint and native authorization rows", async () => {
    expect(await inA(() => ids("steering_messages"))).toEqual([{ id: id("steering-a") }]);
    expect(await inA(() => ids("external_effects"))).toEqual([{ id: id("checkpoint-a") }]);
    expect(await inA(() => ids("native_oauth_sessions"))).toEqual([{ id: id("session-a") }]);
    expect(await inA(() => ids("native_oauth_grants"))).toEqual([{ id: id("grant-a") }]);
    expect(await inA(() => ids("native_routine_triggers"))).toEqual([{ id: id("trigger-a") }]);
    await inA(() =>
      runtime!.prisma.externalEffect.create({
        data: {
          spaceId: spaceA,
          runId: id("run-a"),
          kind: "runtime_checkpoint",
          idempotencyKey: id("authorized-effect"),
          status: "prepared",
          request: {},
        },
      }),
    );
    await rejectedByPolicy(
      inA(() =>
        runtime!.prisma.externalEffect.create({
          data: {
            spaceId: spaceA,
            runId: id("run-b"),
            kind: "runtime_checkpoint",
            idempotencyKey: id("forged-effect"),
            status: "prepared",
            request: {},
          },
        }),
      ),
    );
    await inA(() =>
      runtime!.prisma.nativeRoutineTrigger.create({
        data: {
          routineId: id("routine-a"),
          connectionId: id("connection-a"),
          grantId: id("grant-a"),
          authorizationRevision: "synthetic",
          authGeneration: 1,
          configId: id("config"),
          configRevision: 1,
          kind: "calendar.event_changed",
          resourceType: "fixture",
          resourceId: "fixture",
          spec: {},
        },
      }),
    );
    await rejectedByPolicy(
      inA(() =>
        runtime!.prisma.nativeRoutineTrigger.create({
          data: {
            routineId: id("routine-a"),
            connectionId: id("connection-b"),
            grantId: id("grant-b"),
            authorizationRevision: "synthetic",
            authGeneration: 1,
            configId: id("config"),
            configRevision: 1,
            kind: "calendar.event_changed",
            resourceType: "fixture",
            resourceId: "fixture",
            spec: {},
          },
        }),
      ),
    );
  });

  async function createLinkBots(label: string) {
    const a = id(`${label}-a`);
    const c = id(`${label}-c`);
    await owner.prisma.bot.createMany({
      data: [
        { id: a, spaceId: spaceA, userId: userA, name: "Link fixture", color: "ink" },
        { id: c, spaceId: spaceC, userId: userA, name: "Link fixture", color: "ink" },
      ],
    });
    return { a, c };
  }

  it("supersedes messaging link codes across Spaces and redeems only the current code once", async () => {
    const bots = await createLinkBots("link-sequential");
    const checked = new Proxy(runtime!.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const result = await callback(tx);
            expect(currentDbContext()?.kind).toBe("tenant");
            expect(await tx.user.findMany({ select: { id: true } })).toEqual([{ id: userA }]);
            expect(await tx.nativeAppConfig.count()).toBe(0);
            return result;
          });
      },
    });
    const old = await inA(() =>
      issueMessagingLinkCode(checked, { userId: userA, spaceId: spaceA, botId: bots.a }),
    );
    const current = await runAsTenant({ spaceId: spaceC, userId: userA }, () =>
      issueMessagingLinkCode(checked, { userId: userA, spaceId: spaceC, botId: bots.c }),
    );
    expect(
      await owner.prisma.messagingLinkCode.findMany({
        where: { userId: userA },
        select: { code: true, spaceId: true },
      }),
    ).toEqual([{ code: current.code, spaceId: spaceC }]);
    const redeem = (code: string) =>
      runAsSystem("redeem a synthetic inbound link code", () =>
        redeemMessagingLinkCode(runtime!.prisma, {
          code,
          provider: "fixture",
          address: id("link-address"),
          dmThreadId: null,
        }),
      );
    expect(await redeem(old.code)).toBeNull();
    expect(await redeem(current.code)).toMatchObject({
      userId: userA,
      spaceId: spaceC,
      botId: bots.c,
    });
    expect(await redeem(current.code)).toBeNull();
  });

  it("serializes concurrent messaging link codes across Spaces without deleting another user's code", async () => {
    const bots = await createLinkBots("link-concurrent");
    const other = await runAsTenant({ spaceId: spaceB, userId: userB }, () =>
      issueMessagingLinkCode(runtime!.prisma, {
        userId: userB,
        spaceId: spaceB,
        botId: id("bot-b"),
      }),
    );
    const peer = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    let holdFirst!: () => void;
    let firstReady!: () => void;
    const held = new Promise<void>((resolve) => {
      firstReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      holdFirst = resolve;
    });
    const firstClient = new Proxy(runtime!.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const result = await callback(tx);
            firstReady();
            await released;
            return result;
          });
      },
    });
    const first = inA(() =>
      issueMessagingLinkCode(firstClient, { userId: userA, spaceId: spaceA, botId: bots.a }),
    );
    let second: ReturnType<typeof issueMessagingLinkCode> | undefined;
    try {
      await Promise.race([
        held,
        first.then(() => {
          throw new Error("Expected the first issuance transaction to pause");
        }),
      ]);
      second = runAsTenant({ spaceId: spaceC, userId: userA }, () =>
        issueMessagingLinkCode(peer.prisma, { userId: userA, spaceId: spaceC, botId: bots.c }),
      );
      void second.catch(() => undefined);
      await expect
        .poll(
          async () => {
            const waiting = await owner.pool.query<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1 " +
                "AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock%') AS waiting",
              [role],
            );
            return waiting.rows[0]?.waiting;
          },
          { timeout: 2_000, interval: 10 },
        )
        .toBe(true);
      holdFirst();
      const codes = await Promise.all([first, second]);
      const active = await owner.prisma.messagingLinkCode.findMany({
        where: { userId: userA },
        select: { code: true },
      });
      expect(active).toHaveLength(1);
      expect(codes.map(({ code }) => code)).toContain(active[0]!.code);
      expect(
        await owner.prisma.messagingLinkCode.findUnique({ where: { code: other.code } }),
      ).toMatchObject({ userId: userB, spaceId: spaceB });
    } finally {
      holdFirst();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await peer.prisma.$disconnect();
      await peer.pool.end();
    }
  });

  it("rolls back supersession when a messaging link code cannot be created in tenant scope", async () => {
    const bots = await createLinkBots("link-rollback");
    const previous = await inA(() =>
      issueMessagingLinkCode(runtime!.prisma, { userId: userA, spaceId: spaceA, botId: bots.a }),
    );
    await rejectedByPolicy(
      inA(() =>
        issueMessagingLinkCode(runtime!.prisma, {
          userId: userA,
          spaceId: spaceB,
          botId: id("bot-b"),
        }),
      ),
    );
    expect(
      await owner.prisma.messagingLinkCode.findMany({
        where: { userId: userA },
        select: { code: true, spaceId: true },
      }),
    ).toEqual([{ code: previous.code, spaceId: spaceA }]);
    expect(await inA(() => runtime!.prisma.nativeAppConfig.count())).toBe(0);
  });

  it("preserves DM identity movement and source-message group ownership without interpreting provider thread IDs", async () => {
    await owner.prisma.messagingIdentity.create({
      data: {
        id: id("identity"),
        provider: "fixture",
        address: id("address"),
        userId: userA,
        spaceId: spaceA,
        botId: id("bot-a"),
      },
    });
    await owner.prisma.messagingOutbound.createMany({
      data: [
        {
          id: id("outbound-dm"),
          idempotencyKey: id("out-dm"),
          kind: "dm",
          identityId: id("identity"),
          sourceMessageId: id("message-a"),
          body: "Synthetic DM",
        },
        {
          id: id("outbound-group"),
          idempotencyKey: id("out-group"),
          kind: "group",
          sourceMessageId: id("message-a"),
          threadId: "opaque-provider-thread",
          body: "Synthetic group",
        },
        {
          id: id("outbound-unresolved"),
          idempotencyKey: id("out-unresolved"),
          kind: "group",
          threadId: id("message-a"),
          body: "Synthetic unresolved parent",
        },
      ],
    });
    const expected = [{ id: id("outbound-dm") }, { id: id("outbound-group") }];
    expect(await inA(() => ids("messaging_outbound"))).toEqual(expected);
    expect(
      await runAsTenant({ spaceId: spaceB, userId: userB }, () => ids("messaging_outbound")),
    ).toEqual([]);
    await owner.prisma.bot.create({
      data: {
        id: id("bot-c"),
        spaceId: spaceC,
        userId: userA,
        name: "Moved destination",
        color: "ink",
      },
    });
    await owner.prisma.messagingIdentity.update({
      where: { id: id("identity") },
      data: { spaceId: spaceC, botId: id("bot-c") },
    });
    expect(await inA(() => ids("messaging_outbound"))).toEqual(expected);
    expect(
      await runAsTenant({ spaceId: spaceC, userId: userA }, () => ids("messaging_outbound")),
    ).toEqual([{ id: id("outbound-dm") }]);
    expect(
      await runAsSystem("read synthetic outbox metadata", () => ids("messaging_outbound")),
    ).toHaveLength(3);
  });

  it("projects only visible comment authors at root and on a held transaction", async () => {
    for (const [side, spaceId] of [
      ["a", spaceA],
      ["b", spaceB],
    ]) {
      await owner.prisma.board.create({ data: { id: id(`board-${side}`), spaceId: spaceId! } });
      await owner.prisma.ticket.create({
        data: {
          id: id(`ticket-${side}`),
          spaceId: spaceId!,
          boardId: id(`board-${side}`),
          number: 1,
          title: "Synthetic",
        },
      });
    }
    await owner.prisma.ticketComment.createMany({
      data: [
        {
          id: id("comment-person"),
          spaceId: spaceA,
          ticketId: id("ticket-a"),
          authorUserId: userB,
          body: "Person",
        },
        {
          id: id("comment-bot"),
          spaceId: spaceA,
          ticketId: id("ticket-a"),
          authorBotId: id("bot-a"),
          body: "Bot",
        },
        {
          id: id("comment-deleted"),
          spaceId: spaceA,
          ticketId: id("ticket-a"),
          body: "Deleted author",
        },
        {
          id: id("comment-foreign"),
          spaceId: spaceB,
          ticketId: id("ticket-b"),
          authorUserId: userB,
          body: "Foreign",
        },
      ],
    });
    const check = (rows: Awaited<ReturnType<typeof listTicketComments>>) => {
      const comments = rows.map(toTicketCommentDto);
      expect(comments).toHaveLength(3);
      expect(comments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ body: "Person", authorName: "Policy B" }),
          expect.objectContaining({ body: "Bot", authorName: "Fixture" }),
          expect.objectContaining({ body: "Deleted author", authorName: null }),
        ]),
      );
      expect(JSON.stringify(comments)).not.toContain("example.test");
      expect(JSON.stringify(comments)).not.toContain("Foreign");
    };
    check(await inA(() => listTicketComments(runtime!.prisma, spaceA, id("ticket-a"))));
    expect(await inA(() => listTicketComments(runtime!.prisma, spaceB, id("ticket-b")))).toEqual(
      [],
    );
    await inA(() =>
      runtime!.prisma.$transaction(async (tx) => {
        check(await listTicketComments(tx, spaceA, id("ticket-a")));
        expect(await tx.user.findMany({ select: { id: true } })).toEqual([{ id: userA }]);
        expect(await tx.nativeAppConfig.count()).toBe(0);
      }),
    );
    expect(runtime!.pool.waitingCount).toBe(0);
  });

  it("preserves authorized plugin-owner names without widening member or outsider access", async () => {
    const { createPluginInstallsService } = await import("./plugin-installs.js");
    const { EncryptedSecretStore } = await import("../../../packages/adapters/src/secrets.js");
    await owner.prisma.capabilityInstall.createMany({
      data: [
        { id: id("install-a"), spaceId: spaceA, userId: userA, clientNonce: id("install-nonce-a") },
        {
          id: id("install-member"),
          spaceId: spaceA,
          userId: userB,
          clientNonce: id("install-nonce-b"),
        },
        {
          id: id("install-foreign"),
          spaceId: spaceB,
          userId: userB,
          clientNonce: id("install-nonce-foreign"),
        },
      ].map((install) => ({
        ...install,
        kind: "plugin",
        name: "Synthetic",
        source: "https://github.com/fixture/plugin",
        version: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
        requestBinding: "c".repeat(64),
      })),
    });
    let checkedTransactions = 0;
    const checked = new Proxy(runtime!.prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const context = currentDbContext();
            expect(context?.kind).toBe("tenant");
            const result = await callback(tx);
            const userId = context?.kind === "tenant" ? context.userId : "";
            expect(await tx.user.findMany({ select: { id: true } })).toEqual([{ id: userId }]);
            expect(await tx.nativeAppConfig.count()).toBe(0);
            checkedTransactions++;
            return result;
          });
      },
    });
    const service = createPluginInstallsService({
      prisma: checked,
      secrets: new EncryptedSecretStore("synthetic-policy-fixture-key"),
      pluginRead: async () => {
        throw new Error("Unexpected plugin fetch");
      },
      assertEndpoint: async () => {
        throw new Error("Unexpected endpoint access");
      },
      uninstall: async () => {
        throw new Error("Unexpected uninstall");
      },
    });
    const contextA = {
      actor: { spaceId: spaceA, userId: userA, email: "a@example.test", isDeploymentOwner: false },
    };
    const listing = await inA(() => service.list(contextA));
    expect(listing.owned.map(({ id }) => id)).toEqual([id("install-a")]);
    expect(listing.managed).toEqual([
      expect.objectContaining({
        receipt: expect.objectContaining({ id: id("install-member") }),
        ownerName: "Policy B",
      }),
    ]);
    expect(
      await runAsTenant({ spaceId: spaceA, userId: userB }, () =>
        service.list({
          actor: {
            spaceId: spaceA,
            userId: userB,
            email: "b@example.test",
            isDeploymentOwner: false,
          },
        }),
      ),
    ).toMatchObject({
      owned: [expect.objectContaining({ id: id("install-member") })],
      managed: [],
    });
    await expect(
      inA(() =>
        service.list({
          actor: {
            spaceId: spaceB,
            userId: userA,
            email: "a@example.test",
            isDeploymentOwner: false,
          },
        }),
      ),
    ).rejects.toThrow();
    try {
      await owner.prisma.spaceMember.update({
        where: { spaceId_userId: { spaceId: spaceA, userId: userA } },
        data: { role: "member" },
      });
      expect(await inA(() => service.list(contextA))).toMatchObject({
        owned: [expect.objectContaining({ id: id("install-a") })],
        managed: [],
      });
    } finally {
      await owner.prisma.spaceMember.update({
        where: { spaceId_userId: { spaceId: spaceA, userId: userA } },
        data: { role: "owner" },
      });
    }
    expect(checkedTransactions).toBe(3);
    expect(runtime!.pool.waitingCount).toBe(0);
  });

  it("restores tenant authority after a named system step on a one-connection transaction", async () => {
    await inA(() =>
      runtime!.prisma.$transaction(async (tx) => {
        const documents = () =>
          tx.memoryDocument.findMany({ select: { id: true }, orderBy: { id: "asc" } });
        expect(await documents()).toEqual([{ id: id("document-a") }]);
        await runAsSystemInTransaction(tx, "read synthetic cross-Space metadata", async () => {
          expect(await documents()).toHaveLength(3);
          expect(await tx.nativeAppConfig.count()).toBe(1);
        });
        expect(await documents()).toEqual([{ id: id("document-a") }]);
        expect(await tx.nativeAppConfig.count()).toBe(0);
      }),
    );
    expect(await ids("memory_documents")).toEqual([]);
    expect(runtime!.pool.waitingCount).toBe(0);
  });

  it("preserves cross-Space owned messaging metadata, opaque peers and atomic confirmation", async () => {
    const { createRouter } = await import("./router.js");
    const { RPCHandler } = await import("@orpc/server/fetch");
    const myBot = id("rpc-bot-a");
    const peerBot = id("rpc-bot-b");
    const myIdentity = id("rpc-identity-a");
    const peerIdentity = id("rpc-identity-b");
    const incoming = id("rpc-incoming");
    const outgoing = id("rpc-outgoing");
    const unrelated = id("rpc-unrelated");
    await owner.prisma.bot.createMany({
      data: [
        { id: myBot, spaceId: spaceC, userId: userA, name: "Owned other Space", color: "ink" },
        { id: peerBot, spaceId: spaceB, userId: userB, name: "Remote fixture", color: "ink" },
      ],
    });
    await owner.prisma.messagingIdentity.createMany({
      data: [
        {
          id: myIdentity,
          provider: "sendblue",
          address: id("rpc-address-a"),
          userId: userA,
          spaceId: spaceC,
          botId: myBot,
        },
        {
          id: peerIdentity,
          provider: "sendblue",
          address: id("rpc-address-b"),
          userId: userB,
          spaceId: spaceB,
          botId: peerBot,
        },
      ],
    });
    await owner.prisma.messagingChannel.create({
      data: {
        id: id("rpc-channel"),
        provider: "sendblue",
        threadId: id("rpc-thread"),
        name: "Synthetic group",
      },
    });
    await owner.prisma.messagingChannelMember.createMany({
      data: [
        {
          id: id("rpc-membership-a"),
          channelId: id("rpc-channel"),
          address: id("rpc-address-a"),
          identityId: myIdentity,
          status: "invited",
        },
        {
          id: id("rpc-membership-b"),
          channelId: id("rpc-channel"),
          address: id("rpc-address-b"),
          identityId: peerIdentity,
          status: "invited",
        },
      ],
    });
    await owner.prisma.agentConnection.createMany({
      data: [
        { id: incoming, requesterBotId: peerBot, targetBotId: myBot, status: "pending" },
        { id: outgoing, requesterBotId: myBot, targetBotId: peerBot, status: "pending" },
        {
          id: unrelated,
          requesterBotId: peerBot,
          targetBotId: id("rpc-other-target"),
          status: "pending",
        },
      ],
    });
    const inviteKey = `connect:${peerBot}:${myBot}`;
    const confirmationKey = `command:connected:${incoming}`;
    await owner.prisma.messagingOutbound.create({
      data: {
        idempotencyKey: inviteKey,
        kind: "dm",
        identityId: myIdentity,
        body: "Synthetic pending invitation",
      },
    });
    const enqueueObservations: Array<{ status: string; confirmed: boolean }> = [];
    const enqueue = async () => {
      const [connection, confirmation] = await Promise.all([
        owner.prisma.agentConnection.findUniqueOrThrow({ where: { id: incoming } }),
        owner.prisma.messagingOutbound.findUnique({ where: { idempotencyKey: confirmationKey } }),
      ]);
      enqueueObservations.push({ status: connection.status, confirmed: confirmation !== null });
    };
    const deps = {
      prisma: runtime!.prisma,
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "synthetic-policy-secret",
        sandboxProvider: "fake",
      },
      messaging: { enabled: true, providers: ["sendblue"], openSignup: false },
      dataDir: "unused-policy-fixture",
    } as unknown as Parameters<typeof createRouter>[0];
    const handler = new RPCHandler(createRouter(deps));
    const actor = {
      userId: userA,
      spaceId: spaceA,
      email: "a@example.test",
      isDeploymentOwner: false,
    };
    const call = async (path: string, body: unknown = {}) =>
      inA(async () => {
        const { response } = await handler.handle(
          new Request(`http://127.0.0.1/rpc/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: body }),
          }),
          { prefix: "/rpc", context: { actor } },
        );
        if (!response) throw new Error("Synthetic RPC path was not matched");
        return response;
      });
    const linkBots = await createLinkBots("link-rpc");
    const sharedForeignBot = id("link-rpc-shared-foreign");
    await owner.prisma.bot.create({
      data: { id: sharedForeignBot, spaceId: spaceA, userId: userB, name: "Foreign", color: "ink" },
    });
    const issued = await call("messaging/link/start", { botId: linkBots.a });
    expect(issued.status).toBe(200);
    const issuedBody = (await issued.json()).json as { code: string };
    expect(issuedBody.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect((await call("messaging/link/start", { botId: linkBots.c })).status).toBe(404);
    expect((await call("messaging/link/start", { botId: sharedForeignBot })).status).toBe(404);
    try {
      await owner.prisma.bot.update({
        where: { id: linkBots.a },
        data: { archivedAt: new Date() },
      });
      expect((await call("messaging/link/start", { botId: linkBots.a })).status).toBe(404);
    } finally {
      await owner.prisma.bot.update({ where: { id: linkBots.a }, data: { archivedAt: null } });
    }
    await owner.prisma.messagingIdentity.create({
      data: {
        provider: "fixture",
        address: id("link-rpc-address"),
        userId: userA,
        spaceId: spaceA,
        botId: linkBots.a,
      },
    });
    expect((await call("messaging/link/start", { botId: linkBots.a })).status).toBe(400);
    expect(
      await owner.prisma.messagingLinkCode.findMany({
        where: { userId: userA },
        select: { code: true },
      }),
    ).toEqual([{ code: issuedBody.code.replaceAll("-", "") }]);
    const channels = await call("messaging/channels/list");
    expect(channels.status).toBe(200);
    expect(await channels.json()).toMatchObject({
      json: [
        expect.objectContaining({
          id: id("rpc-membership-a"),
          name: "Synthetic group",
          memberCount: 2,
        }),
      ],
    });
    expect(
      (
        await call("messaging/channels/respond", {
          membershipId: id("rpc-membership-b"),
          accept: true,
        })
      ).status,
    ).toBe(404);
    const acceptedChannel = await call("messaging/channels/respond", {
      membershipId: id("rpc-membership-a"),
      accept: true,
    });
    expect(acceptedChannel.status).toBe(200);
    expect(await acceptedChannel.json()).toMatchObject({ json: { status: "approved" } });
    const listed = await call("messaging/connections/list");
    expect(listed.status).toBe(200);
    const connections = (await listed.json()).json as Array<Record<string, unknown>>;
    expect(connections.find(({ id }) => id === incoming)).toMatchObject({
      peerBotName: "Remote fixture",
      peerOwnerLabel: "Policy",
      incoming: true,
      status: "pending",
    });
    expect(connections.find(({ id }) => id === outgoing)).toMatchObject({
      peerBotName: "agent",
      peerOwnerLabel: "owner",
      incoming: false,
      status: "pending",
    });
    expect(connections.some(({ id }) => id === unrelated)).toBe(false);
    expect(
      (await call("messaging/connections/respond", { connectionId: unrelated, accept: true }))
        .status,
    ).toBe(404);
    expect(
      (await call("messaging/connections/respond", { connectionId: outgoing, accept: true }))
        .status,
    ).toBe(404);
    expect(
      (await call("messaging/connections/respond", { connectionId: incoming, accept: true }))
        .status,
    ).toBe(200);
    expect(enqueueObservations).toEqual([{ status: "approved", confirmed: true }]);
    const confirmation = await owner.prisma.messagingOutbound.findUniqueOrThrow({
      where: { idempotencyKey: confirmationKey },
    });
    expect(confirmation.identityId).toBe(peerIdentity);
    expect(
      (await call("messaging/connections/respond", { connectionId: incoming, accept: true }))
        .status,
    ).toBe(404);
    expect(enqueueObservations).toHaveLength(1);
    expect((await call("messaging/connections/revoke", { connectionId: unrelated })).status).toBe(
      404,
    );
    expect((await call("messaging/connections/revoke", { connectionId: incoming })).status).toBe(
      200,
    );
    expect(
      await owner.prisma.agentConnection.findUnique({ where: { id: incoming } }),
    ).toMatchObject({ status: "revoked" });
    expect(
      await owner.prisma.messagingOutbound.findUnique({ where: { idempotencyKey: inviteKey } }),
    ).toBeNull();
    expect(
      (await call("messaging/channels/leave", { membershipId: id("rpc-membership-a") })).status,
    ).toBe(200);
    expect(
      (
        await call("messaging/channels/respond", {
          membershipId: id("rpc-membership-a"),
          accept: true,
        })
      ).status,
    ).toBe(404);
    expect(await inA(() => runtime!.prisma.user.findMany({ select: { id: true } }))).toEqual([
      { id: userA },
    ]);
    expect(runtime!.pool.waitingCount).toBe(0);
  }, 60_000);

  it("does not grant a system scope for plain flags, empty or wrong keys, or cleared versions", async () => {
    for (const key of ["", "synthetic-wrong-key"]) {
      await inA(() =>
        runtime!.prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            "SELECT set_config('app.rls_bypass','on',true),set_config('app.rls_bypass_key',$1,true),set_config('app.rls_version','',true)",
            key,
          );
          expect(await tx.$queryRawUnsafe("SELECT public.app_rls_bypass() AS allowed")).toEqual([
            { allowed: false },
          ]);
          expect(await tx.memoryDocument.findMany({ select: { id: true } })).toEqual([
            { id: id("document-a") },
          ]);
          expect(await tx.nativeAppConfig.count()).toBe(0);
        }),
      );
    }
  });

  it("detects changed qualifiers, write checks, roles and disabled tables at unchanged policy counts", async () => {
    for (const change of [
      "ALTER POLICY memory_documents_tenant ON public.memory_documents USING (true)",
      "ALTER POLICY memory_documents_system ON public.memory_documents WITH CHECK (true)",
      "ALTER POLICY memory_documents_tenant ON public.memory_documents TO " +
        escapeIdentifier(role),
    ]) {
      try {
        await owner.pool.query(change);
        const state = await describeRowSecurityPolicies(runtime!.prisma);
        expect((await catalog()).length).toBe(154);
        expect(state.policyInstalled).toBe(false);
        expect(state.connectionEnforced).toBe(false);
        expect(state.tables.find(({ table }) => table === "memory_documents")?.policyMatch).toBe(
          false,
        );
      } finally {
        await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
      }
    }
    try {
      await owner.pool.query("ALTER TABLE public.memory_documents DISABLE ROW LEVEL SECURITY");
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        policyInstalled: true,
        policyEnabled: false,
        connectionEnforced: false,
        deploymentEnforced: false,
      });
    } finally {
      await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    }
  }, 120_000);

  it("blocks an extra permissive policy and an unclassified application table without changing either", async () => {
    const extraPolicy = `policy_fixture_extra_${suffix}`;
    try {
      await owner.pool.query(
        "CREATE POLICY " +
          escapeIdentifier(extraPolicy) +
          " ON public.memory_documents USING (true)",
      );
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        policyInstalled: false,
        connectionEnforced: false,
      });
      const before = await catalog();
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow();
      expect(await catalog()).toEqual(before);
    } finally {
      await owner.pool.query(
        `DROP POLICY IF EXISTS ${escapeIdentifier(extraPolicy)} ON public.memory_documents`,
      );
    }
    const extraTable = `policy_fixture_unclassified_${suffix}`;
    try {
      await owner.pool.query(
        `CREATE TABLE public.${escapeIdentifier(extraTable)} (id text PRIMARY KEY)`,
      );
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        policyInstalled: false,
        connectionEnforced: false,
      });
      const before = await catalog();
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow();
      expect(await catalog()).toEqual(before);
      expect(
        (
          await owner.pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [
            `public.${extraTable}`,
          ])
        ).rows,
      ).toEqual([{ present: true }]);
    } finally {
      await owner.pool.query(`DROP TABLE IF EXISTS public.${escapeIdentifier(extraTable)}`);
    }
  }, 120_000);

  it("requires the strict guard implementation and private-key ACL rather than only a successful system probe", async () => {
    const original = (
      await owner.pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef('public.app_rls_bypass()'::regprocedure) AS definition",
      )
    ).rows[0]!.definition;
    try {
      await owner.pool.query(
        "CREATE OR REPLACE FUNCTION public.app_rls_bypass() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER " +
          "SET search_path=pg_catalog,pg_temp AS 'SELECT true'",
      );
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        guardValid: false,
        connectionEnforced: false,
      });
      const before = await catalog();
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow();
      expect(await catalog()).toEqual(before);
    } finally {
      await owner.pool.query(original);
    }
    try {
      await owner.pool.query(`GRANT USAGE ON SCHEMA cogine_private TO ${escapeIdentifier(role)}`);
      await owner.pool.query(
        `GRANT SELECT(digest) ON cogine_private.rls_bypass_keys TO ${escapeIdentifier(role)}`,
      );
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        connectionEnforced: false,
        problems: expect.arrayContaining(["runtime-not-prepared"]),
      });
      const before = await catalog();
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow();
      expect(await catalog()).toEqual(before);
    } finally {
      await owner.pool.query(
        `REVOKE SELECT(digest) ON cogine_private.rls_bypass_keys FROM ${escapeIdentifier(role)}`,
      );
      await owner.pool.query(
        `REVOKE USAGE ON SCHEMA cogine_private FROM ${escapeIdentifier(role)}`,
      );
    }
    expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
      guardValid: true,
      connectionEnforced: true,
    });
  }, 120_000);

  it("retires the recognized previous-release and plain-flag policies and is idempotent", async () => {
    await owner.pool.query(
      "CREATE FUNCTION public.app_rls_version() RETURNS integer LANGUAGE sql STABLE " +
        "AS 'SELECT COALESCE(NULLIF(current_setting(''app.rls_version'',true),''''),''0'')::integer'",
    );
    await owner.pool.query(
      "CREATE POLICY memory_documents_previous_release ON public.memory_documents USING (public.app_rls_version() < 2)",
    );
    await owner.pool.query(
      "ALTER POLICY memory_documents_system ON public.memory_documents USING (current_setting('app.rls_bypass',true)='on')",
    );
    expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
      policyInstalled: false,
      connectionEnforced: false,
      legacyPolicyCount: 1,
    });
    expect(await applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).toMatchObject({
      policyInstalled: true,
      connectionEnforced: true,
      legacyPolicyCount: 0,
      deploymentEnforced: false,
    });
    expect(
      (
        await owner.pool.query(
          "SELECT to_regprocedure('public.app_rls_version()') IS NULL AS retired",
        )
      ).rows,
    ).toEqual([{ retired: true }]);
    const before = await catalog();
    const trigger = `policy_reject_noop_${suffix}`;
    const fn = `policy_reject_noop_fn_${suffix}`;
    try {
      await owner.pool.query(
        "CREATE FUNCTION public." +
          escapeIdentifier(fn) +
          "() RETURNS event_trigger LANGUAGE plpgsql AS $policy_fault$ " +
          "BEGIN RAISE EXCEPTION 'A matching policy installation must not ALTER tables'; END; $policy_fault$",
      );
      await owner.pool.query(
        "CREATE EVENT TRIGGER " +
          escapeIdentifier(trigger) +
          " ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public." +
          escapeIdentifier(fn) +
          "()",
      );
      await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
      expect(await catalog()).toEqual(before);
    } finally {
      await owner.pool.query(`DROP EVENT TRIGGER IF EXISTS ${escapeIdentifier(trigger)}`);
      await owner.pool.query(`DROP FUNCTION IF EXISTS public.${escapeIdentifier(fn)}()`);
    }
  }, 120_000);

  it("rolls back earlier table enablement when a later administrative DDL operation fails", async () => {
    const trigger = `policy_fail_ddl_${suffix}`;
    const fn = `policy_fail_ddl_fn_${suffix}`;
    await owner.pool.query("ALTER TABLE public.ai_data_consents DISABLE ROW LEVEL SECURITY");
    await owner.pool.query(
      "ALTER TABLE public.native_slack_event_inbox DISABLE ROW LEVEL SECURITY",
    );
    const before = await catalog();
    try {
      await owner.pool.query(
        "CREATE FUNCTION public." +
          escapeIdentifier(fn) +
          "() RETURNS event_trigger LANGUAGE plpgsql AS $policy_fault$ " +
          "DECLARE command record; BEGIN " +
          "FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP " +
          "IF command.object_identity='public.native_slack_event_inbox' THEN " +
          "RAISE EXCEPTION 'Synthetic policy DDL failure'; END IF; END LOOP; END; $policy_fault$",
      );
      await owner.pool.query(
        "CREATE EVENT TRIGGER " +
          escapeIdentifier(trigger) +
          " ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public." +
          escapeIdentifier(fn) +
          "()",
      );
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow();
      expect(await catalog()).toEqual(before);
    } finally {
      await owner.pool.query(`DROP EVENT TRIGGER IF EXISTS ${escapeIdentifier(trigger)}`);
      await owner.pool.query(`DROP FUNCTION IF EXISTS public.${escapeIdentifier(fn)}()`);
      await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    }
    expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
      policyEnabled: true,
      connectionEnforced: true,
    });
  }, 120_000);

  it("reports committed installation when a fresh runtime login fails after commit", async () => {
    const trigger = `policy_login_fault_${suffix}`;
    const fn = `policy_login_fault_fn_${suffix}`;
    const otherVerifier = scramSha256Verifier(randomBytes(24).toString("hex"));
    await owner.pool.query(
      "ALTER TABLE public.native_slack_event_inbox DISABLE ROW LEVEL SECURITY",
    );
    try {
      await owner.pool.query(
        "CREATE FUNCTION public." +
          escapeIdentifier(fn) +
          "() RETURNS event_trigger LANGUAGE plpgsql AS $policy_fault$ " +
          "DECLARE command record; BEGIN " +
          "FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP " +
          "IF command.object_identity='public.native_slack_event_inbox' THEN " +
          "ALTER ROLE " +
          escapeIdentifier(role) +
          " PASSWORD " +
          escapeLiteral(otherVerifier) +
          "; END IF; END LOOP; END; $policy_fault$",
      );
      await owner.pool.query(
        "CREATE EVENT TRIGGER " +
          escapeIdentifier(trigger) +
          " ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public." +
          escapeIdentifier(fn) +
          "()",
      );
      await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow(
        /committed/i,
      );
      const committed = await catalog();
      expect(committed.every((table) => table.relrowsecurity)).toBe(true);
      expect(committed).toHaveLength(154);
    } finally {
      await owner.pool.query(`DROP EVENT TRIGGER IF EXISTS ${escapeIdentifier(trigger)}`);
      await owner.pool.query(`DROP FUNCTION IF EXISTS public.${escapeIdentifier(fn)}()`);
      await owner.pool.query(
        "ALTER ROLE " +
          escapeIdentifier(role) +
          " PASSWORD " +
          escapeLiteral(scramSha256Verifier(password)),
      );
    }
    const fresh = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    try {
      expect(await describeRowSecurityPolicies(fresh.prisma)).toMatchObject({
        connectionEnforced: true,
        deploymentEnforced: false,
      });
    } finally {
      await fresh.prisma.$disconnect();
      await fresh.pool.end();
    }
  }, 120_000);
  it.each([false, true])(
    "keeps a failed COMMIT acknowledgement uncertain (server executed: %s)",
    async (serverExecuted) => {
      await owner.pool.query(
        "ALTER TABLE public.native_slack_event_inbox DISABLE ROW LEVEL SECURITY",
      );
      const probe = await owner.pool.connect();
      const ownerLogin = Reflect.get(probe, "user");
      const prototype = Object.getPrototypeOf(probe);
      const originalQuery = Reflect.get(prototype, "query");
      probe.release();
      let injected = false;
      const transport = vi.spyOn(prototype, "query").mockImplementation(function (
        this: object,
        ...args: unknown[]
      ) {
        if (
          !injected &&
          Reflect.get(this, "user") === ownerLogin &&
          typeof args[0] === "string" &&
          args[0].trim().toUpperCase() === "COMMIT"
        ) {
          injected = true;
          const fault = () => {
            throw new Error("Synthetic COMMIT acknowledgement loss");
          };
          return serverExecuted
            ? Promise.resolve(Reflect.apply(originalQuery, this, args)).then(fault)
            : Promise.reject(new Error("Synthetic COMMIT transport failure before send"));
        }
        return Reflect.apply(originalQuery, this, args);
      });
      try {
        await expect(applyRowSecurityPolicies(databaseUrl!, runtimeUrl)).rejects.toThrow(
          "Database policy commit outcome is uncertain; policies may have committed",
        );
        expect(injected).toBe(true);
        const result = await owner.pool.query<{ enabled: boolean }>(
          "SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='public.native_slack_event_inbox'::regclass",
        );
        expect(result.rows).toEqual([{ enabled: serverExecuted }]);
      } finally {
        transport.mockRestore();
        await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
      }
      expect(await describeRowSecurityPolicies(runtime!.prisma)).toMatchObject({
        connectionEnforced: true,
        deploymentEnforced: false,
      });
    },
    120_000,
  );
});
