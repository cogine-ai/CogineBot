import { createHash, randomBytes, randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { withSecretPersistence } from "@rakazo/adapters";
import type { Actor, PageShareState } from "@rakazo/contracts";
import { PageShareStateSchema, SHARED_PAGE_PATH_PREFIX } from "@rakazo/contracts";
import {
  applyRowSecurityPolicies,
  createDb,
  provisionRuntimeRole,
  rlsBypassKey,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { mountSharedPages } from "./shared-pages.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;
const origin = "https://pages.example.test";
const pageTitle = "Weekly plan";
const initialShare = { visibility: "link", expectedVersion: 1, expectedTitle: pageTitle } as const;
const privateShare = {
  status: 200,
  body: { visibility: "private", publishingEnabled: true, shareUrl: null, generation: null },
};
const dormant = (visibility: "private" | "link") => ({
  status: 200,
  body: { visibility, publishingEnabled: false, shareUrl: null, generation: null },
});
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function vaultFixture() {
  const records = new Map<string, { id: string; value: string }>();
  const store = {
    describe: () => ({
      id: "fixture-vault",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: true },
    }),
    put: vi.fn<SecretStore["put"]>(async (value, _context, options) => {
      const id = options?.recordId ?? randomUUID();
      const ref = options?.recoveryRef ?? `fixture-vault:${id}`;
      records.set(ref, { id, value });
      return { id, ref, ciphertext: ref };
    }),
    load: vi.fn<SecretStore["load"]>(async (ref, context) => {
      const record = records.get(ref);
      const id = typeof context === "string" ? context : context.recordId;
      if (record?.id !== id) throw new SecretNotFoundError();
      return record.value;
    }),
    delete: vi.fn<SecretStore["delete"]>(async (ref, context) => {
      const record = records.get(ref);
      const id = typeof context === "string" ? context : context.recordId;
      if (record && record.id !== id) throw new Error("Wrong fixture vault record");
      records.delete(ref);
    }),
    redact: (value: string) => value,
    onChange: () => () => undefined,
    start: async () => undefined,
    close: async () => undefined,
  } satisfies SecretStore;
  return { store, records };
}

function liveLink(response: {
  status: number;
  body: unknown;
}): Extract<PageShareState, { visibility: "link"; publishingEnabled: true }> {
  expect(response.status).toBe(200);
  const share = PageShareStateSchema.parse(response.body);
  if (share.visibility !== "link" || !share.publishingEnabled)
    throw new Error("Page link is missing");
  return share;
}

function tokenFromLink(shareUrl: string, slug = "weekly-plan"): string {
  const url = new URL(shareUrl);
  const token = url.pathname.slice(-43);
  expect(url.origin).toBe(origin);
  expect(url.pathname).toBe(`/p/${slug}-${token}`);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
  return token;
}

function tokenHash(shareUrl: string): string {
  return createHash("sha256").update(tokenFromLink(shareUrl)).digest("hex");
}

postgres("owner Page share RPC (isolated PostgreSQL)", () => {
  const login = `page_share_runtime_${randomBytes(8).toString("hex")}`;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let grantRole: string | undefined;
  let runtimeUrl: string | undefined;
  let ownRoles = false;
  const admin = () => owner!.prisma;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw new Error("Page share RPC tests require an explicitly isolated harness database");
    }
    owner = createDb(databaseUrl!, { poolMax: 4 });
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname=current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    expect(
      (
        await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
          [login, grantRole],
        ])
      ).rowCount,
    ).toBe(0);
    ownRoles = true;
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { poolMax: 6, rowSecurity: true });
    await expect(verifyRuntimeDatabase(runtime.prisma)).resolves.toMatchObject({
      connectionEnforced: true,
    });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (runtime) {
      await clean(() => runtime!.prisma.$disconnect());
      await clean(() => runtime!.pool.end());
    }
    if (owner) {
      if (ownRoles) {
        if (runtimeUrl) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(runtimeUrl!)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${quote(role)}`);
            await owner!.pool.query(`DROP ROLE ${quote(role)}`);
          });
        }
      }
      await clean(() => owner!.prisma.$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (failures.length)
      throw new AggregateError(failures, "Page share RPC fixture cleanup failed");
  });

  async function setup() {
    const id = randomUUID();
    const db = admin();
    const actor: Actor = {
      userId: `owner-${id}`,
      spaceId: `space-${id}`,
      email: `owner-${id}@example.test`,
      isDeploymentOwner: false,
    };
    const guest: Actor = {
      ...actor,
      userId: `guest-${id}`,
      email: `guest-${id}@example.test`,
      isDeploymentOwner: true,
    };
    const otherSpace: Actor = { ...actor, spaceId: `other-${id}` };
    const title = pageTitle;
    await db.user.createMany({
      data: [actor, guest].map(({ userId, email }) => ({ id: userId, email, name: "Page owner" })),
    });
    await db.organization.create({
      data: { id, name: "Page share fixture", slug: id, createdAt: new Date() },
    });
    await db.space.createMany({
      data: [actor, otherSpace].map(({ spaceId }) => ({
        id: spaceId,
        organizationId: id,
        name: spaceId,
      })),
    });
    await db.member.createMany({
      data: [actor, guest].map(({ userId }) => ({
        id: `member-${userId}`,
        organizationId: id,
        userId,
        role: "member",
        createdAt: new Date(),
      })),
    });
    await db.spaceMember.createMany({
      data: [actor, guest, otherSpace].map(({ userId, spaceId }) => ({
        id: `${spaceId}-${userId}`,
        organizationId: id,
        userId,
        spaceId,
        createdAt: new Date(),
      })),
    });
    const { userId, spaceId } = actor;
    const bot = await db.bot.create({
      data: { userId, spaceId, name: "Page fixture Bot", color: "#3EC5A8" },
    });
    const page = await db.page.create({
      data: {
        userId,
        spaceId,
        botId: bot.id,
        title,
        versions: { create: { version: 1, title, source: "fixture source", code: "fixture code" } },
      },
    });
    const vault = vaultFixture();
    const prisma = withSecretPersistence(runtime!.prisma, vault.store);
    let unexpectedError: unknown;
    const handler = (pageSharingEnabled?: boolean) =>
      new RPCHandler(
        createRouter({
          prisma,
          secrets: vault.store,
          env: { webOrigin: origin, sandboxProvider: "fake", agentRuntime: "scripted" },
          pageSharingEnabled,
        } as RouterDeps),
        {
          clientInterceptors: [
            onError((error) => {
              unexpectedError = error;
            }),
          ],
        },
      );
    const enabled = handler(true);
    const disabled = handler();
    const anonymous = new Hono();
    mountSharedPages(anonymous, runtime!.prisma, { enabled: true });
    async function call(
      proc: "get" | "getShare" | "setShare" | "remove" | "rename",
      input: Record<string, unknown> = {},
      requestActor: Actor | null = actor,
      sharingEnabled = true,
    ): Promise<{ status: number; body: unknown }> {
      const { response } = await (sharingEnabled ? enabled : disabled).handle(
        new Request(`${origin}/rpc/pages/${proc}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { pageId: page.id, ...input } }),
        }),
        { prefix: "/rpc", context: { actor: requestActor } },
      );
      if (!response) throw new Error("Page RPC did not resolve");
      if (response.status === 500) throw new Error("Page RPC failed", { cause: unexpectedError });
      return { status: response.status, body: (await response.json()).json };
    }
    return {
      actor,
      guest,
      otherSpace,
      call,
      vault,
      readPublic: (token: string) =>
        anonymous.request(`${origin}${SHARED_PAGE_PATH_PREFIX}${token}`),
      updateSecret: (id: string, data: { kind?: string; spaceId?: string; userId?: string }) =>
        db.secret.update({ where: { id }, data }),
      removeOrigin: () => db.bot.delete({ where: { id: bot.id } }),
      advance: () =>
        db.page.update({
          where: { id: page.id },
          data: {
            currentVersion: 2,
            versions: {
              create: { version: 2, title, source: "revised source", code: "revised code" },
            },
          },
        }),
      row: () => db.page.findUniqueOrThrow({ where: { id: page.id } }),
      secrets: () => db.secret.findMany({ where: { userId, spaceId, kind: "page_share" } }),
    };
  }

  it("keeps sharing dormant by default and only lets the active Page owner manage the link", async () => {
    const f = await setup();
    const enable = initialShare;
    expect(await f.call("setShare", enable, f.actor, false)).toMatchObject({ status: 404 });
    expect(await f.call("getShare", {}, f.actor, false)).toEqual(dormant("private"));
    expect(await f.call("setShare", enable, null)).toMatchObject({ status: 401 });
    const absent = await f.call("getShare", { pageId: `missing-${randomUUID()}` });
    expect(absent).toMatchObject({ status: 404 });
    for (const outsider of [f.guest, f.otherSpace]) {
      expect(await f.call("getShare", {}, outsider)).toEqual(absent);
      expect(await f.call("setShare", enable, outsider)).toEqual(absent);
      expect(await f.call("setShare", { visibility: "private" }, outsider)).toEqual(absent);
    }
    expect(f.vault.store.put).not.toHaveBeenCalled();
    expect(f.vault.store.load).not.toHaveBeenCalled();
    expect(await f.secrets()).toEqual([]);
    expect(await f.call("getShare")).toEqual(privateShare);

    const link = liveLink(await f.call("setShare", enable));
    f.vault.store.load.mockClear();
    expect(await f.call("getShare", {}, f.actor, false)).toEqual(dormant("link"));
    const detail = await f.call("get");
    expect(detail).toMatchObject({
      status: 200,
      body: { code: "fixture code", sharedByLink: true },
    });
    expect(detail.body).not.toHaveProperty("shareUrl");
    expect(JSON.stringify(detail.body)).not.toContain(tokenFromLink(link.shareUrl));
    expect(f.vault.store.load).not.toHaveBeenCalled();
    for (const outsider of [f.guest, f.otherSpace]) {
      expect(await f.call("getShare", {}, outsider)).toEqual(absent);
      expect(await f.call("setShare", { visibility: "private" }, outsider)).toEqual(absent);
    }
    expect(await f.call("getShare")).toEqual({ status: 200, body: link });
    expect(await f.call("setShare", { visibility: "private" }, f.actor, false)).toEqual(
      dormant("private"),
    );
    expect(await f.call("getShare")).toEqual(privateShare);
    expect(await f.secrets()).toEqual([]);
  });

  it("publishes one winning token for two concurrent enables and never reuses a revoked token", async () => {
    const f = await setup();
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.put.mockImplementation(async (...args) => {
      const staged = await put(...args);
      await release.promise;
      return staged;
    });
    const calls = [f.call("setShare", initialShare), f.call("setShare", initialShare)];
    let link: ReturnType<typeof liveLink>;
    try {
      await vi.waitFor(() => expect(f.vault.store.put).toHaveBeenCalledTimes(2), { timeout: 5000 });
      release.resolve();
      const [first, second] = await Promise.all(calls);
      link = liveLink(first!);
      expect(liveLink(second!)).toEqual(link);
    } finally {
      release.resolve();
      await Promise.allSettled(calls);
    }
    expect(await f.call("getShare")).toEqual({ status: 200, body: link });
    const old = await f.row();
    expect(old).toMatchObject({
      visibility: "link",
      shareTokenHash: tokenHash(link.shareUrl),
      currentVersion: 1,
    });
    const activeSecrets = await f.secrets();
    expect(activeSecrets).toHaveLength(1);
    expect(activeSecrets[0]?.id).toBe(old.shareSecretId);
    expect(activeSecrets[0]?.ciphertext).not.toContain(tokenFromLink(link.shareUrl));
    expect([...f.vault.records.keys()]).toEqual([activeSecrets[0]!.ciphertext]);
    const candidates = await Promise.all(f.vault.store.put.mock.results.map(({ value }) => value));
    const discarded = candidates.find((candidate) => candidate.id !== activeSecrets[0]!.id);
    expect(discarded).toBeDefined();
    expect(f.vault.store.delete.mock.calls.map(([ref]) => ref)).toEqual([discarded!.ciphertext]);

    expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
    expect(await f.row()).toMatchObject({
      visibility: "private",
      shareTokenHash: null,
      shareSecretId: null,
      currentVersion: 1,
    });
    expect(await f.secrets()).toEqual([]);
    expect(f.vault.records.size).toBe(0);
    expect(await f.call("getShare")).toEqual(privateShare);

    const reopened = liveLink(await f.call("setShare", initialShare));
    expect(tokenFromLink(reopened.shareUrl)).not.toBe(tokenFromLink(link.shareUrl));
    expect(reopened.generation).not.toBe(link.generation);
    expect(await f.row()).toMatchObject({
      visibility: "link",
      shareTokenHash: tokenHash(reopened.shareUrl),
      currentVersion: 1,
    });
    expect(await f.secrets()).not.toContainEqual(activeSecrets[0]);
  });

  it("requires the version shown to the owner even if the page changes during token staging", async () => {
    const f = await setup();
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const stored = await put(...args);
      staged.resolve();
      await release.promise;
      return stored;
    });
    const priorVersion = initialShare;
    const pending = f.call("setShare", priorVersion);
    try {
      await staged.promise;
      await f.advance();
      release.resolve();
      expect(await pending).toMatchObject({ status: 409 });
      expect(await f.call("getShare")).toEqual(privateShare);
      expect(await f.secrets()).toEqual([]);
      expect(f.vault.records.size).toBe(0);
      expect(await f.call("setShare", priorVersion)).toMatchObject({ status: 409 });
      expect(f.vault.store.put).toHaveBeenCalledTimes(1);
      expect(
        liveLink(await f.call("setShare", { ...initialShare, expectedVersion: 2 })).generation,
      ).toBeTruthy();
      expect(await f.row()).toMatchObject({ currentVersion: 2, visibility: "link" });
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("reads only the current shared version under RLS and requires the owner's live share secret", async () => {
    const f = await setup();
    const link = liveLink(await f.call("setShare", initialShare));
    const token = tokenFromLink(link.shareUrl);
    const original = await f.row();
    f.vault.store.load.mockClear();
    const first = await f.readPublic(token);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await first.json()).toEqual({
      title: original.title,
      code: "fixture code",
      version: 1,
      updatedAt: original.updatedAt.toISOString(),
    });
    const current = await f.advance();
    expect(await (await f.readPublic(token)).json()).toEqual({
      title: current.title,
      code: "revised code",
      version: 2,
      updatedAt: current.updatedAt.toISOString(),
    });
    const [secret] = await f.secrets();
    expect(secret).toBeDefined();
    const wrong = [
      { kind: "fixture_credential", userId: f.actor.userId, spaceId: f.actor.spaceId },
      { kind: secret!.kind, userId: f.guest.userId, spaceId: f.actor.spaceId },
      { kind: secret!.kind, userId: f.actor.userId, spaceId: f.otherSpace.spaceId },
    ];
    for (const data of wrong) {
      await f.updateSecret(secret!.id, data);
      const unavailable = await f.readPublic(token);
      expect(unavailable.status).toBe(404);
      expect(await unavailable.json()).toEqual({ error: "Not found" });
    }
    await f.updateSecret(secret!.id, {
      kind: secret!.kind,
      userId: f.actor.userId,
      spaceId: f.actor.spaceId,
    });
    expect(f.vault.store.load).not.toHaveBeenCalled();
    expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
    expect((await f.readPublic(token)).status).toBe(404);
    const reopened = liveLink(await f.call("setShare", { ...initialShare, expectedVersion: 2 }));
    const currentToken = tokenFromLink(reopened.shareUrl);
    expect((await f.readPublic(token)).status).toBe(404);
    expect((await f.readPublic(currentToken)).status).toBe(200);
    expect(await f.call("remove")).toMatchObject({ status: 200 });
    expect((await f.readPublic(currentToken)).status).toBe(404);
  });

  it("requires the confirmed title when first sharing and retains direct owner renames", async () => {
    const f = await setup();
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const stored = await put(...args);
      staged.resolve();
      await release.promise;
      return stored;
    });

    const pending = f.call("setShare", initialShare);
    const title = "Confirmed plan";
    try {
      await staged.promise;
      expect(await f.call("rename", { title })).toMatchObject({
        status: 200,
        body: { title, currentVersion: 1 },
      });
      release.resolve();
      expect(await pending).toMatchObject({ status: 409 });
      expect(await f.call("setShare", initialShare)).toMatchObject({ status: 409 });
      expect(f.vault.store.put).toHaveBeenCalledTimes(1);
      expect(await f.call("getShare")).toEqual(privateShare);
      expect(await f.secrets()).toEqual([]);
      expect(f.vault.records.size).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }

    const link = liveLink(await f.call("setShare", { ...initialShare, expectedTitle: title }));
    const token = tokenFromLink(link.shareUrl, "confirmed-plan");
    expect(await (await f.readPublic(token)).json()).toMatchObject({
      title,
      code: "fixture code",
      version: 1,
    });
    const renamed = "Owner renamed the plan";
    expect(await f.call("rename", { title: renamed }, f.guest)).toMatchObject({ status: 404 });
    expect(await f.call("rename", { title: renamed })).toMatchObject({ status: 200 });
    const current = await f.row();
    expect(current.shareSecretId).toBe(link.generation);
    expect(await (await f.readPublic(token)).json()).toEqual({
      title: renamed,
      code: "fixture code",
      version: 1,
      updatedAt: current.updatedAt.toISOString(),
    });
  });

  it("keeps a live token on provider outage and rotates a proven missing or mismatched token", async () => {
    const f = await setup();
    const enable = initialShare;
    const original = liveLink(await f.call("setShare", enable));
    const originalRow = await f.row();
    f.vault.store.load
      .mockRejectedValueOnce(new SecretStoreUnavailableError(503, "Private vault diagnostic"))
      .mockRejectedValueOnce(new SecretStoreUnavailableError(503, "Private vault diagnostic"));
    for (const response of [await f.call("getShare"), await f.call("setShare", enable)]) {
      expect(response).toMatchObject({ status: 503 });
      expect(JSON.stringify(response.body)).not.toContain("Private vault diagnostic");
    }
    expect(f.vault.store.put).toHaveBeenCalledTimes(1);
    expect(f.vault.store.delete).not.toHaveBeenCalled();
    expect(await f.row()).toEqual(originalRow);
    expect(await f.call("getShare")).toEqual({ status: 200, body: original });

    for (const fault of ["missing", "mismatched"] as const) {
      const [secret] = await f.secrets();
      const old = await f.row();
      if (fault === "missing") f.vault.records.delete(secret!.ciphertext);
      else {
        const record = f.vault.records.get(secret!.ciphertext)!;
        f.vault.records.set(secret!.ciphertext, {
          ...record,
          value: randomBytes(32).toString("base64url"),
        });
      }
      expect(await f.call("getShare")).toMatchObject({ status: 503 });
      const recovered = liveLink(await f.call("setShare", enable));
      expect(tokenHash(recovered.shareUrl)).not.toBe(old.shareTokenHash);
      expect(await f.call("getShare")).toEqual({ status: 200, body: recovered });
      expect(await f.secrets()).not.toContainEqual(secret);
      expect(f.vault.records.has(secret!.ciphertext)).toBe(false);
      expect(f.vault.records.size).toBe(1);
    }
  });

  it("rejects a former link read when its vault load races revocation and replacement", async () => {
    const f = await setup();
    const enable = initialShare;
    const original = liveLink(await f.call("setShare", enable));
    const release = Promise.withResolvers<void>();
    const load = f.vault.store.load.getMockImplementation()!;
    f.vault.store.load.mockImplementationOnce(async (...args) => {
      const value = await load(...args);
      await release.promise;
      return value;
    });
    const pending = f.call("getShare");
    try {
      await vi.waitFor(() => expect(f.vault.store.load).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
      const current = liveLink(await f.call("setShare", enable));
      expect(current.shareUrl).not.toBe(original.shareUrl);
      release.resolve();
      const stale = await pending;
      expect(stale).toMatchObject({ status: 409 });
      expect(JSON.stringify(stale.body)).not.toContain(tokenFromLink(original.shareUrl));
      expect(await f.call("getShare")).toEqual({ status: 200, body: current });
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("does not re-enable a revoked link when a repair token was already staged", async () => {
    const f = await setup();
    const enable = initialShare;
    const original = liveLink(await f.call("setShare", enable));
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.load.mockRejectedValueOnce(new SecretNotFoundError());
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const staged = await put(...args);
      await release.promise;
      return staged;
    });
    const pending = f.call("setShare", enable);
    try {
      await vi.waitFor(() => expect(f.vault.store.put).toHaveBeenCalledTimes(2), { timeout: 5000 });
      expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
      release.resolve();
      expect(await pending).toMatchObject({ status: 409 });
      expect(await f.call("getShare")).toEqual(privateShare);
      expect((await f.readPublic(tokenFromLink(original.shareUrl))).status).toBe(404);
      expect(await f.secrets()).toEqual([]);
      expect(f.vault.records.size).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("does not publish an old confirmation after another window shares and then revokes", async () => {
    const f = await setup();
    const enable = initialShare;
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    const original = await f.row();
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const staged = await put(...args);
      await release.promise;
      return staged;
    });
    const pending = f.call("setShare", enable);
    try {
      await vi.waitFor(() => expect(f.vault.store.put).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const winner = liveLink(await f.call("setShare", enable));
      expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
      expect(await f.row()).toMatchObject({
        visibility: "private",
        currentVersion: original.currentVersion,
        updatedAt: original.updatedAt,
        shareRevision: original.shareRevision + 2,
      });
      release.resolve();
      expect(await pending).toMatchObject({ status: 409 });
      expect(await f.call("getShare")).toEqual(privateShare);
      expect((await f.readPublic(tokenFromLink(winner.shareUrl))).status).toBe(404);
      expect(await f.secrets()).toEqual([]);
      expect(f.vault.records.size).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("does not return a new generation to a losing concurrent share after readback is delayed", async () => {
    const f = await setup();
    const enable = initialShare;
    const releasePut = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const stored = await put(...args);
      await releasePut.promise;
      return stored;
    });
    const pending = f.call("setShare", enable);
    try {
      await vi.waitFor(() => expect(f.vault.store.put).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const winner = liveLink(await f.call("setShare", enable));
      const deleteSecret = f.vault.store.delete.getMockImplementation()!;
      f.vault.store.delete.mockImplementationOnce(async (...args) => {
        await deleteSecret(...args);
        await releaseCleanup.promise;
      });
      releasePut.resolve();
      await vi.waitFor(() => expect(f.vault.store.delete).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      expect(await f.call("setShare", { visibility: "private" })).toEqual(privateShare);
      const replacement = liveLink(await f.call("setShare", enable));
      expect(replacement.generation).not.toBe(winner.generation);
      releaseCleanup.resolve();
      const stale = await pending;
      expect(stale).toMatchObject({ status: 409 });
      expect(JSON.stringify(stale.body)).not.toContain(tokenFromLink(replacement.shareUrl));
      expect(await f.call("getShare")).toEqual({ status: 200, body: replacement });
      expect(f.vault.records.size).toBe(1);
    } finally {
      releasePut.resolve();
      releaseCleanup.resolve();
      await pending;
    }
  });

  it("cannot attach a staged token after a private Page loses its Bot", async () => {
    const f = await setup();
    const release = Promise.withResolvers<void>();
    const put = f.vault.store.put.getMockImplementation()!;
    f.vault.store.put.mockImplementationOnce(async (...args) => {
      const staged = await put(...args);
      await release.promise;
      return staged;
    });
    const pending = f.call("setShare", initialShare);
    try {
      await vi.waitFor(() => expect(f.vault.store.put).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      expect(await f.call("getShare")).toEqual(privateShare);
      await f.removeOrigin();
      release.resolve();
      expect(await pending).toMatchObject({ status: 409 });
      expect(await f.row()).toMatchObject({
        botId: null,
        groupId: null,
        visibility: "private",
        shareTokenHash: null,
        shareSecretId: null,
      });
      expect(await f.secrets()).toEqual([]);
      expect(f.vault.records.size).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
  });
});
