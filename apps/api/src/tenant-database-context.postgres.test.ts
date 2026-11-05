import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouterClient } from "@orpc/server";
import { EncryptedSecretStore, InMemoryRealtimeFanout } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  boardEventTopic,
  createBoardEvents,
  createDb,
  rlsBypassKey,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";

describePostgres("trusted request contexts on a restricted single-connection pool", () => {
  const suffix = randomBytes(10).toString("hex");
  const role = `context_api_${suffix}`;
  const password = randomBytes(24).toString("hex");
  const policy = `context_api_${suffix}`;
  const tenantPredicate =
    "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '') AND \"userId\" = NULLIF(current_setting('app.user_id', true), '')";
  // These controlled fixtures exercise the actual ingress composition. They do
  // not enable the product's complete policy set or switch its runtime role.
  const policies = new Map([
    ["user", "id = NULLIF(current_setting('app.user_id', true), '')"],
    ["session", "\"userId\" = NULLIF(current_setting('app.user_id', true), '')"],
    ["space_members", "\"userId\" = NULLIF(current_setting('app.user_id', true), '')"],
    ["bots", tenantPredicate],
    ["boards", "\"spaceId\" = NULLIF(current_setting('app.space_id', true), '')"],
    ["connections", tenantPredicate],
    ["ai_data_consents", tenantPredicate],
    [
      "secrets",
      "\"userId\" = NULLIF(current_setting('app.user_id', true), '') AND (\"spaceId\" IS NULL OR \"spaceId\" = NULLIF(current_setting('app.space_id', true), ''))",
    ],
  ]);
  const previousRls = new Map<string, boolean>();
  const store = new EncryptedSecretStore("offline-request-context-key");
  const realtime = new InMemoryRealtimeFanout();
  const deleted = vi.spyOn(store, "delete");
  let owner: ReturnType<typeof createDb>;
  let runtime: ReturnType<typeof createDb>;
  let runtimeUrl: string;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let dataDir: string;
  let first: { cookie: string; actor: Actor };
  let second: { cookie: string; actor: Actor };
  let rejectConsent: string | undefined;
  let rejectRevocation = false;

  beforeAll(async () => {
    owner = createDb(databaseUrl!);
    const target = new URL(databaseUrl!);
    target.username = role;
    target.password = password;
    target.searchParams.delete("user");
    target.searchParams.delete("password");
    runtimeUrl = target.toString();
    await owner.pool.query(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${password}'`,
    );
    const database = await owner.pool.query<{ name: string }>("SELECT current_database() AS name");
    await owner.pool.query(
      `GRANT CONNECT ON DATABASE "${database.rows[0]!.name.replaceAll('"', '""')}" TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await owner.pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );
    await owner.pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    await owner.pool.query(
      "INSERT INTO cogine_private.rls_bypass_keys (digest) VALUES (sha256(convert_to($1, 'UTF8'))) ON CONFLICT DO NOTHING",
      [rlsBypassKey(runtimeUrl)],
    );
    for (const [table, predicate] of policies) {
      const state = await owner.pool.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass",
        [table],
      );
      previousRls.set(table, state.rows[0]!.relrowsecurity);
      await owner.pool.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await owner.pool.query(
        `CREATE POLICY "${policy}" ON "${table}" USING ((SELECT app_rls_bypass()) OR (${predicate}))`,
      );
    }
    runtime = createDb(runtimeUrl, { poolMax: 1, rowSecurity: true });
    const instrumented = runtime.prisma.$extends({
      query: {
        aiDataConsent: {
          async upsert({ args, query }) {
            if (args.create.recipientKey === rejectConsent)
              throw new Error("Consent write rejected");
            return query(args);
          },
        },
        connection: {
          async updateMany({ args, query }) {
            if (rejectRevocation && args.data.status === "revoked")
              throw new Error("Revocation rejected");
            return query(args);
          },
        },
      },
    });
    dataDir = await mkdtemp(join(tmpdir(), "trusted-request-context-"));
    handles = await createApp({
      prisma: instrumented as unknown as typeof runtime.prisma,
      databaseUrl: runtimeUrl,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      ticketBoardEnabled: true,
      secretStore: store,
      realtime,
      webOrigin: origin,
      authUrl: origin,
    });
    first = await account("First");
    second = await account("Second");
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => handles?.stop());
    await cleanup(async () => runtime?.prisma.$disconnect());
    await cleanup(async () => runtime?.pool.end());
    if (owner) {
      for (const table of policies.keys()) {
        await cleanup(() => owner.pool.query(`DROP POLICY IF EXISTS "${policy}" ON "${table}"`));
        if (previousRls.get(table) === false)
          await cleanup(() =>
            owner.pool.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`),
          );
      }
      if (runtimeUrl)
        await cleanup(() =>
          owner.pool.query(
            "DELETE FROM cogine_private.rls_bypass_keys WHERE digest = sha256(convert_to($1, 'UTF8'))",
            [rlsBypassKey(runtimeUrl)],
          ),
        );
      await cleanup(() => owner.pool.query(`DROP OWNED BY "${role}"`));
      await cleanup(() => owner.pool.query(`DROP ROLE IF EXISTS "${role}"`));
      await cleanup(() => owner.prisma.$disconnect());
      await cleanup(() => owner.pool.end());
    }
    if (dataDir) await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    deleted.mockRestore();
    if (failures.length)
      throw new AggregateError(failures, "Request context fixture cleanup failed");
  });

  function scope(actor: Actor) {
    return { userId: actor.userId, spaceId: actor.spaceId };
  }
  function raw(cookie: string, procedure: string, input: unknown = {}, spaceId?: string) {
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin,
        ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: input }),
    });
  }
  async function rpc<T>(
    cookie: string,
    procedure: string,
    input: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await raw(cookie, procedure, input, spaceId);
    expect(response.status).toBe(200);
    return ((await response.json()) as { json: T }).json;
  }
  async function account(name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${name.toLowerCase()}-${suffix}@example.test`,
        password: "offline-password-123",
        name,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    return { cookie, actor: await rpc<Actor>(cookie, "me") };
  }

  it("authenticates and interleaves requests without leaking the owner role or prior tenant", async () => {
    expect(
      await runtime.prisma
        .$queryRaw`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    ).toEqual([{ name: role, rolsuper: false, rolbypassrls: false }]);
    expect(await runtime.prisma.user.findMany()).toEqual([]);
    const responses = await runAsTenant({ spaceId: "forged-space", userId: "forged-user" }, () =>
      Promise.all(
        [first, second, first, second].map(async (caller) => {
          const me = await rpc<Actor>(caller.cookie, "me");
          expect(me.userId).toBe(caller.actor.userId);
          expect(me.spaceId).toBe(caller.actor.spaceId);
          return me;
        }),
      ),
    );
    expect(responses).toHaveLength(4);
    expect((await raw("", "me")).status).toBe(401);
    expect((await raw(first.cookie, "me", {}, second.actor.spaceId)).status).toBe(403);
    expect(await runtime.prisma.user.findMany()).toEqual([]);
    expect(runtime.pool.totalCount).toBe(1);
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("keeps Board sharing by Space and Bot access private to the authenticated owner", async () => {
    const space = await owner.prisma.space.findUniqueOrThrow({
      where: { id: first.actor.spaceId },
    });
    await owner.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: space.id, userId: second.actor.userId } },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: space.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const firstBoards = await rpc<Array<{ id: string }>>(first.cookie, "boards/list");
    const sharedBoards = await rpc<Array<{ id: string }>>(
      second.cookie,
      "boards/list",
      {},
      space.id,
    );
    expect(sharedBoards.map((board) => board.id)).toEqual(firstBoards.map((board) => board.id));
    const bot = await owner.prisma.bot.create({
      data: { userId: first.actor.userId, spaceId: space.id, name: "Private", color: "blue" },
    });
    expect(
      await runAsTenant({ userId: second.actor.userId, spaceId: space.id }, () =>
        runtime.prisma.bot.findUnique({ where: { id: bot.id } }),
      ),
    ).toBeNull();
    expect(
      await runAsTenant(first.actor, () =>
        runtime.prisma.bot.findUnique({ where: { id: bot.id } }),
      ),
    ).toMatchObject({ id: bot.id });
  });

  it("switches to a verified target Space while retaining owner and deletion checks", async () => {
    const target = await rpc<{ id: string }>(first.cookie, "spaces/create", { name: "Draft" });
    expect(
      await rpc(first.cookie, "spaces/rename", { spaceId: target.id, name: "Renamed" }),
    ).toEqual({ id: target.id, name: "Renamed" });
    const space = await owner.prisma.space.findUniqueOrThrow({ where: { id: target.id } });
    await owner.prisma.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: space.organizationId,
          userId: second.actor.userId,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: target.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    for (const procedure of ["spaces/rename", "spaces/remove"]) {
      expect(
        (
          await raw(
            second.cookie,
            procedure,
            { spaceId: target.id, ...(procedure.endsWith("rename") ? { name: "Stolen" } : {}) },
            target.id,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (await raw(first.cookie, "spaces/rename", { spaceId: "missing-space", name: "Missing" }))
        .status,
    ).toBe(404);
    expect(await rpc(first.cookie, "spaces/remove", { spaceId: target.id })).toMatchObject({
      ok: true,
      activeSpaceId: first.actor.spaceId,
    });
    expect(await owner.prisma.space.findUnique({ where: { id: target.id } })).toBeNull();
    expect(runtime.pool.waitingCount).toBe(0);
  });

  it("rechecks actual membership before delivering another frame on an open stream", async () => {
    const target = await rpc<{ id: string }>(first.cookie, "spaces/create", { name: "Stream" });
    const space = await owner.prisma.space.findUniqueOrThrow({ where: { id: target.id } });
    await owner.prisma.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: space.organizationId,
          userId: second.actor.userId,
        },
      },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await owner.prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      update: {},
      create: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: target.id,
        userId: second.actor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const subscribed = vi.spyOn(realtime, "subscribe");
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const readUntil = async (expected: string) => {
      const decoder = new TextDecoder();
      let text = "";
      for (let index = 0; index < 8; index++) {
        const next = await reader!.read();
        text += decoder.decode(next.value, { stream: !next.done });
        if (text.includes(expected)) return text;
        if (next.done) break;
      }
      throw new Error(`Stream closed without the expected frame: ${expected}`);
    };
    try {
      const response = await handles.app.request("/rpc/boards/subscribe", {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          cookie: second.cookie,
          origin,
          "x-rakazo-space-id": target.id,
        },
        body: JSON.stringify({ json: {} }),
      });
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const firstFrame = readUntil(target.id);
      await vi.waitFor(() =>
        expect(subscribed.mock.calls.some(([topic]) => topic === boardEventTopic(target.id))).toBe(
          true,
        ),
      );
      const events = createBoardEvents(realtime);
      await events.notify(target.id);
      expect(await firstFrame).toContain(target.id);
      await owner.prisma.spaceMember.delete({
        where: { spaceId_userId: { spaceId: target.id, userId: second.actor.userId } },
      });
      clock += 10_001;
      const deniedFrame = readUntil("UNAUTHORIZED");
      await events.notify(target.id);
      expect(await deniedFrame).toContain("UNAUTHORIZED");
      expect(runtime.pool.waitingCount).toBe(0);
    } finally {
      abort.abort();
      clearTimeout(timeout);
      await reader?.cancel();
      subscribed.mockRestore();
      now.mockRestore();
    }
  }, 10_000);

  it("rolls back both consent writes when a later recipient fails, then commits them together", async () => {
    const secret = await owner.prisma.secret.create({
      data: { ...scope(first.actor), kind: "memory", ciphertext: "offline-memory-reference" },
    });
    await owner.prisma.spaceMemoryConfig.create({
      data: { ...scope(first.actor), provider: "supermemory", settings: {}, secretId: secret.id },
    });
    const credential = await owner.prisma.userVoiceCredential.create({
      data: { userId: first.actor.userId, provider: "openai", secretId: "offline-voice-reference" },
    });
    await owner.prisma.spaceVoicePreference.create({
      data: { ...scope(first.actor), credentialId: credential.id, voiceId: "alloy" },
    });
    const status = await rpc<{
      scope: string;
      version: string;
      recipients: Array<{ key: string }>;
    }>(first.cookie, "aiConsent/status");
    const keys = status.recipients.map((recipient) => recipient.key);
    expect(keys).toHaveLength(2);
    rejectConsent = keys[1];
    try {
      expect(
        (
          await raw(first.cookie, "aiConsent/allow", {
            scope: status.scope,
            version: status.version,
            keys,
          })
        ).status,
      ).toBe(500);
      expect(
        await owner.prisma.aiDataConsent.count({
          where: { userId: first.actor.userId, spaceId: first.actor.spaceId },
        }),
      ).toBe(0);
    } finally {
      rejectConsent = undefined;
    }
    await rpc(first.cookie, "aiConsent/allow", {
      scope: status.scope,
      version: status.version,
      keys,
    });
    expect(
      await owner.prisma.aiDataConsent.count({
        where: { userId: first.actor.userId, spaceId: first.actor.spaceId },
      }),
    ).toBe(2);
    expect(await runtime.prisma.aiDataConsent.count()).toBe(0);
  });

  it("keeps catalog reconciliation atomic even when the RPC logs a later write failure", async () => {
    const rows = await Promise.all(
      [0, 1].map((index) =>
        owner.prisma.connection.create({
          data: {
            ...scope(first.actor),
            connectorId: "fixture",
            provider: "MAIL",
            displayName: `Mail ${index}`,
            status: "pending",
            createdAt: new Date(index),
          },
        }),
      ),
    );
    const client = createRouterClient(
      createRouter({
        prisma: handles.prisma,
        env: {},
        connectors: {
          managedProviders: () => [
            {
              describe: () => ({ id: "fixture" }),
              catalog: async () => [
                {
                  connectorId: "fixture",
                  slug: "MAIL",
                  name: "Mail",
                  logo: null,
                  connected: true,
                  noAuth: false,
                },
              ],
            },
          ],
        },
      } as unknown as RouterDeps),
      { context: { actor: first.actor } },
    );
    const statuses = () =>
      owner.prisma.connection.findMany({
        where: { id: { in: rows.map((row) => row.id) } },
        select: { status: true },
        orderBy: { createdAt: "asc" },
      });
    rejectRevocation = true;
    try {
      expect(await client.connections.catalog({})).toHaveLength(1);
      expect(await statuses()).toEqual([{ status: "pending" }, { status: "pending" }]);
    } finally {
      rejectRevocation = false;
    }
    await client.connections.catalog({});
    expect(await statuses()).toEqual([{ status: "connected" }, { status: "revoked" }]);
  });

  it("checks references across tenants after commit and releases its sole connection before cleanup", async () => {
    const ciphertext = `offline-shared-${suffix}`;
    const a = await owner.prisma.secret.create({
      data: { userId: first.actor.userId, spaceId: null, kind: "model", ciphertext },
    });
    const b = await owner.prisma.secret.create({
      data: {
        userId: second.actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext,
      },
    });
    deleted.mockClear();
    await runAsTenant(first.actor, () =>
      handles.prisma.$transaction(async (tx) => {
        await tx.secret.delete({ where: { id: a.id } });
        expect(deleted).not.toHaveBeenCalled();
      }),
    );
    expect(deleted).not.toHaveBeenCalled();
    expect(await owner.prisma.secret.findUnique({ where: { id: b.id } })).toMatchObject({
      ciphertext,
    });
    await runAsTenant(second.actor, () =>
      handles.prisma.$transaction(async (tx) => {
        await tx.secret.delete({ where: { id: b.id } });
        expect(deleted).not.toHaveBeenCalled();
      }),
    );
    expect(deleted).toHaveBeenCalledExactlyOnceWith(ciphertext, b.id);
    expect(runtime.pool.waitingCount).toBe(0);
    expect(await runtime.prisma.secret.count()).toBe(0);
  });
});
