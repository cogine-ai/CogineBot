import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor, McpServer } from "@rakazo/contracts";
import { createMcpManagement, emptyMcpServerDraft, initialMcpManagementState } from "@rakazo/core";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
const origin = "http://127.0.0.1:5173";
postgres("MCP creation recovery through authenticated API", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let db: ReturnType<typeof createDb>;
  let dir: string;
  const secretStore = new EncryptedSecretStore("synthetic-receipt-secrets");
  const secretPuts = vi.spyOn(secretStore, "put");
  const users: string[] = [];
  const organizations: string[] = [];
  const outbound = vi.fn(async () => {
    throw new Error("No upstream calls allowed");
  });
  type Account = { cookie: string; actor: Actor };
  async function call<T>(account: Account, procedure: string, input: unknown = {}): Promise<T> {
    const response = await app.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: account.cookie,
        "x-rakazo-space-id": account.actor.spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json: T };
    if (!response.ok)
      throw Object.assign(new Error("Synthetic API rejection"), { status: response.status });
    return body.json;
  }
  async function account(): Promise<Account> {
    const response = await app.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${randomUUID()}@example.test`,
        password: "offline-fixture-password-123",
        name: "MCP fixture",
      }),
    });
    expect(response.ok).toBe(true);
    const cookie = sessionCookieHeader(response);
    const me = await app.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    const actor = ((await me.json()) as { json: Actor }).json;
    users.push(actor.userId);
    organizations.push(
      (await db.prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } })).organizationId,
    );
    return { cookie, actor };
  }
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    dir = await mkdtemp(join(tmpdir(), "mcp-create-http-"));
    app = await createApp({
      prisma: db.prisma,
      secretStore,
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: dir,
      encryptionKey: "offline-mcp-create-key",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
      remoteConnectors: {
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: outbound,
      },
    });
  });
  afterAll(async () => {
    expect(outbound).not.toHaveBeenCalled();
    if (db) {
      await db.prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await db.prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    await app?.stop();
    await db?.prisma.$disconnect();
    await db?.pool.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it.each(["lost", "acknowledged"])(
    "F1: never claims a replacement after commit, deletion/recreation and %s response",
    async (response) => {
      const actor = await account();
      const draft = {
        ...emptyMcpServerDraft(),
        name: "Recovery fixture",
        endpoint: "https://tools.example.test/mcp",
        secret: "synthetic-token",
      };
      let state = initialMcpManagementState();
      let originalId = "";
      const manager = createMcpManagement({
        isCurrent: () => true,
        changed: (next) => {
          state = next;
        },
        request: async <T>(procedure: string, input: unknown) => {
          const result = await call<T>(actor, procedure, input);
          if (procedure === "mcp/servers/create" || procedure === "mcp/servers/createOnce") {
            originalId =
              (result as { id?: string; serverId?: string }).id ??
              (result as { serverId: string }).serverId;
            await call(actor, "mcp/servers/remove", { id: originalId });
            await call(actor, "mcp/servers/create", {
              slug: "recovery-fixture",
              name: draft.name,
              transport: "sse",
              endpoint: "https://replacement.example.test/mcp",
            });
            if (response === "lost") throw new Error("Synthetic lost response after commit");
          }
          return result;
        },
      });
      await manager.refresh();
      await manager.create(draft);
      expect(originalId).not.toBe("");
      const rows = await call<McpServer[]>(actor, "mcp/servers/list");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).not.toBe(originalId);
      expect(state).toMatchObject({ recovered: null, error: "removed", pendingCreate: false });
      expect(draft.secret).toBe("synthetic-token");
      expect(JSON.stringify(rows)).not.toContain("synthetic-token");
      manager.dispose();
    },
  );
  it("F2: a real public HTTP rejection after a lost send preserves an editable draft", async () => {
    const actor = await account();
    const draft = {
      ...emptyMcpServerDraft(),
      name: "Rejected fixture",
      endpoint: "http://public.example.test/mcp",
    };
    let state = initialMcpManagementState();
    let first = true;
    const manager = createMcpManagement({
      isCurrent: () => true,
      changed: (next) => {
        state = next;
      },
      request: async <T>(procedure: string, input: unknown) => {
        if (
          first &&
          (procedure === "mcp/servers/create" || procedure === "mcp/servers/createOnce")
        ) {
          first = false;
          throw new Error("Synthetic failure before send");
        }
        return call<T>(actor, procedure, input);
      },
    });
    await manager.refresh();
    await manager.create(draft);
    expect(state.pendingCreate).toBe(true);
    await manager.create(draft);
    expect(await call(actor, "mcp/servers/list")).toEqual([]);
    expect(state.pendingCreate).toBe(false);
    expect(state.recovered).toBeNull();
    expect(draft.endpoint).toBe("http://public.example.test/mcp");
    manager.dispose();
  });
  it("serializes concurrent retries and preserves the same receipt after removal", async () => {
    const actor = await account();
    const requestId = randomUUID();
    const config = {
      slug: "once",
      name: "Once",
      transport: "stdio",
      command: "fixture-command",
      secret: "synthetic-once-secret",
    };
    const results = await Promise.all([
      call<{ requestId: string; serverId: string }>(actor, "mcp/servers/createOnce", {
        requestId,
        config,
      }),
      call<{ requestId: string; serverId: string }>(actor, "mcp/servers/createOnce", {
        requestId,
        config,
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await db.prisma.mcpServer.count({ where: { userId: actor.actor.userId } })).toBe(1);
    expect(
      await db.prisma.secret.count({ where: { userId: actor.actor.userId, kind: "mcp" } }),
    ).toBe(1);
    expect(
      await call(actor, "mcp/servers/createOnce", {
        requestId,
        config: { ...config, command: "different-command", secret: "different-synthetic-secret" },
      }),
    ).toEqual(results[0]);
    expect((await call<McpServer[]>(actor, "mcp/servers/list"))[0]!.command).toBe(
      "fixture-command",
    );
    expect(
      await db.prisma.secret.count({ where: { userId: actor.actor.userId, kind: "mcp" } }),
    ).toBe(1);
    await call(actor, "mcp/servers/remove", { id: results[0]!.serverId });
    const replacement = await call<McpServer>(actor, "mcp/servers/create", {
      ...config,
      transport: "sse",
      command: undefined,
      endpoint: "https://replacement.example.test/mcp",
    });
    expect(await call(actor, "mcp/servers/createOnce", { requestId, config })).toEqual(results[0]);
    expect(await call(actor, "mcp/servers/creation", { requestId })).toEqual(results[0]);
    expect(await call(actor, "mcp/servers/cancelCreate", { requestId })).toEqual(results[0]);
    expect(replacement.id).not.toBe(results[0]!.serverId);
    expect(await call<McpServer[]>(actor, "mcp/servers/list")).toHaveLength(1);
  });
  it("cancellation fences a delayed create without deleting an already committed object", async () => {
    const actor = await account();
    const requestId = randomUUID();
    const canceled = await call(actor, "mcp/servers/cancelCreate", { requestId });
    expect(canceled).toEqual({ requestId, serverId: null });
    expect(
      await call(actor, "mcp/servers/createOnce", {
        requestId,
        config: { slug: "late", name: "Late", transport: "stdio", command: "fixture" },
      }),
    ).toEqual(canceled);
    expect(await call(actor, "mcp/servers/list")).toEqual([]);
    const nextId = randomUUID();
    const results = await Promise.all([
      call<{ serverId: string | null }>(actor, "mcp/servers/createOnce", {
        requestId: nextId,
        config: { slug: "race", name: "Race", transport: "stdio", command: "fixture" },
      }),
      call<{ serverId: string | null }>(actor, "mcp/servers/cancelCreate", { requestId: nextId }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await call<McpServer[]>(actor, "mcp/servers/list")).length).toBe(
      results[0]!.serverId ? 1 : 0,
    );
  });
  it("binds request receipts to the authenticated user and Space and preserves legacy clients", async () => {
    const a = await account();
    const b = await account();
    const requestId = randomUUID();
    const config = { slug: "scope", name: "Scoped", transport: "stdio", command: "fixture" };
    const own = await call<{ serverId: string }>(a, "mcp/servers/createOnce", {
      requestId,
      config,
    });
    const secondSpace = await call<{ id: string }>(a, "spaces/create", {
      name: "Second fixture space",
    });
    const otherSpace = { ...a, actor: { ...a.actor, spaceId: secondSpace.id } };
    expect(await call(otherSpace, "mcp/servers/creation", { requestId })).toBeNull();
    await call(otherSpace, "mcp/servers/cancelCreate", { requestId });
    expect(await call(a, "mcp/servers/creation", { requestId })).toEqual(own);
    expect(await call(b, "mcp/servers/creation", { requestId })).toBeNull();
    await call(b, "mcp/servers/cancelCreate", { requestId });
    expect(await call(a, "mcp/servers/creation", { requestId })).toEqual(own);
    await expect(
      call({ ...a, actor: { ...a.actor, spaceId: b.actor.spaceId } }, "mcp/servers/creation", {
        requestId,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const anonymous = await app.app.request("/rpc/mcp/servers/cancelCreate", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ json: { requestId } }),
    });
    expect(anonymous.status).toBe(401);
    const legacy = await call<McpServer>(a, "mcp/servers/create", { ...config, slug: "legacy" });
    const saved = await call<McpServer>(a, "mcp/servers/setTools", {
      id: legacy.id,
      revision: legacy.revision,
      allowAllTools: false,
      allowedTools: ["fixture_tool"],
    });
    await expect(
      call(a, "mcp/servers/setTools", {
        id: legacy.id,
        revision: legacy.revision,
        allowAllTools: true,
        allowedTools: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(saved.allowedTools).toEqual(["fixture_tool"]);
  });
  it("keeps an earlier commit recoverable after a real unauthenticated cancellation and failed fence", async () => {
    const owner = await account();
    let rejectAuth = false;
    let lost = false;
    let state = initialMcpManagementState();
    const draft = {
      ...emptyMcpServerDraft(),
      name: "Auth recovery",
      transport: "stdio" as const,
      command: "fixture",
    };
    const manager = createMcpManagement({
      isCurrent: () => true,
      changed: (next) => {
        state = next;
      },
      request: async <T>(procedure: string, input: unknown) => {
        if (lost && !rejectAuth && procedure === "mcp/servers/creation")
          throw new Error("Synthetic read outage");
        const result = await call<T>(
          rejectAuth ? { ...owner, cookie: "" } : owner,
          procedure,
          input,
        );
        if (procedure === "mcp/servers/createOnce") {
          lost = true;
          throw new Error("Synthetic lost committed response");
        }
        return result;
      },
    });
    await manager.refresh();
    await manager.create(draft);
    expect(state).toMatchObject({ pendingCreate: true, fresh: false });
    // A definite 401 on cancellation cannot prove the earlier write failed.
    lost = false;
    rejectAuth = true;
    await manager.cancelCreate();
    expect(state).toMatchObject({ pendingCreate: true, fresh: false, recovered: null });
    rejectAuth = false;
    await manager.refresh();
    expect(state).toMatchObject({ pendingCreate: false, fresh: true });
    expect(state.recovered?.slug).toBe("auth-recovery");
    expect(await call<McpServer[]>(owner, "mcp/servers/list")).toHaveLength(1);
    manager.dispose();
  });
  it("does not adopt another client's same-slug object after its initial list becomes stale", async () => {
    const owner = await account();
    let state = initialMcpManagementState();
    const draft = {
      ...emptyMcpServerDraft(),
      name: "Concurrent",
      endpoint: "https://tools.example.test/mcp",
      secret: "synthetic-original",
    };
    const manager = createMcpManagement({
      isCurrent: () => true,
      changed: (next) => {
        state = next;
      },
      request: <T>(procedure: string, input: unknown) => call<T>(owner, procedure, input),
    });
    await manager.refresh();
    const other = await call<McpServer>(owner, "mcp/servers/create", {
      slug: "concurrent",
      name: "Concurrent",
      transport: "sse",
      endpoint: "https://replacement.example.test/mcp",
      secret: "synthetic-other",
    });
    await manager.create(draft);
    expect(state.recovered).toBeNull();
    if (state.pendingCreate) await manager.cancelCreate();
    expect(state).toMatchObject({ pendingCreate: false, recovered: null });
    const rows = await call<McpServer[]>(owner, "mcp/servers/list");
    expect(rows.map((row) => row.id)).toEqual([other.id]);
    expect(draft.secret).toBe("synthetic-original");
    expect(
      JSON.stringify(
        await call(owner, "mcp/servers/creation", {
          requestId: (
            await db.prisma.mcpCreateRequest.findFirstOrThrow({
              where: { userId: owner.actor.userId },
            })
          ).requestId,
        }),
      ),
    ).not.toContain("synthetic-");
    manager.dispose();
  });
  it("maps only duplicate server creation to 409 and fences the draft for correction", async () => {
    const owner = await account();
    const config = {
      slug: "duplicate",
      name: "Duplicate",
      transport: "stdio",
      command: "fixture",
      secret: "synthetic-duplicate",
    };
    await call(owner, "mcp/servers/create", config);
    const putCount = secretPuts.mock.calls.length;
    await expect(
      call(owner, "mcp/servers/createOnce", { requestId: randomUUID(), config }),
    ).rejects.toMatchObject({ status: 409 });
    const draft = {
      ...emptyMcpServerDraft(),
      name: "Duplicate",
      transport: "stdio" as const,
      command: "fixture",
      secret: "synthetic-duplicate",
    };
    let state = initialMcpManagementState();
    const manager = createMcpManagement({
      isCurrent: () => true,
      changed: (next) => {
        state = next;
      },
      request: <T>(procedure: string, input: unknown) => call<T>(owner, procedure, input),
    });
    await manager.refresh();
    await manager.create(draft);
    expect(state).toMatchObject({ pendingCreate: false, recovered: null, error: "write" });
    expect(secretPuts).toHaveBeenCalledTimes(putCount);
    expect(draft.name).toBe("Duplicate");
    expect(
      await db.prisma.secret.count({ where: { userId: owner.actor.userId, kind: "mcp" } }),
    ).toBe(1);
    expect(
      await db.prisma.mcpCreateRequest.findMany({
        where: { userId: owner.actor.userId },
        select: { serverId: true },
      }),
    ).toEqual([{ serverId: null }]);
    await manager.create({ ...draft, name: "Corrected" });
    expect(state.recovered?.slug).toBe("corrected");
    expect(await call<McpServer[]>(owner, "mcp/servers/list")).toHaveLength(2);
    manager.dispose();
  });
  it("does not translate a non-unique database rejection into conflict", async () => {
    const owner = await account();
    await db.pool.query(
      `CREATE FUNCTION public.receipt_reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.slug='reject-nonunique-fixture' THEN RAISE EXCEPTION 'Synthetic check failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`,
    );
    await db.pool.query(
      "CREATE TRIGGER receipt_reject_fixture BEFORE INSERT ON public.mcp_servers FOR EACH ROW EXECUTE FUNCTION public.receipt_reject_fixture()",
    );
    try {
      await expect(
        call(owner, "mcp/servers/createOnce", {
          requestId: randomUUID(),
          config: {
            slug: "reject-nonunique-fixture",
            name: "Rejected",
            transport: "stdio",
            command: "fixture",
          },
        }),
      ).rejects.toMatchObject({ status: 500 });
      expect(
        await db.prisma.mcpCreateRequest.count({ where: { userId: owner.actor.userId } }),
      ).toBe(0);
      expect(await db.prisma.mcpServer.count({ where: { userId: owner.actor.userId } })).toBe(0);
    } finally {
      await db.pool.query("DROP TRIGGER receipt_reject_fixture ON public.mcp_servers");
      await db.pool.query("DROP FUNCTION public.receipt_reject_fixture()");
    }
  });
});
