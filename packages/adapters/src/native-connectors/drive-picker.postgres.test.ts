import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import {
  DRIVE_PICKER_IDENTITY_KIND,
  DRIVE_PICKER_SCOPE,
  NativeOAuthAuthorities,
} from "./authorities.js";
import { NativeConfigStore } from "./config.js";
import { NativeOAuthStore } from "./oauth.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
const SCOPES = ["openid", "email", DRIVE_PICKER_SCOPE];
const API_ORIGIN = "https://api.example.test";
const CLIENT_SECRET = "synthetic-picker-client-secret";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("independent Drive Picker sessions and grants (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `picker-org-${suffix}`;
  const spaceId = `picker-space-${suffix}`;
  const userIds = [`picker-owner-${suffix}`, `picker-peer-${suffix}`];
  const configs = new Set<string>();
  const authorities: NativeOAuthAuthorities[] = [];
  let db: ReturnType<typeof createDb>;
  const context = (userId = userIds[0]!): AdapterContext => ({
    userId,
    spaceId,
    operationId: `drive-picker-test-${suffix}`,
    traceId: `drive-picker-test-${suffix}`,
    signal: new AbortController().signal,
  });
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, {
      poolMax: 4,
      applicationName: "native-drive-picker",
    });
    const version = await db.prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    expect(version[0]?.version).toContain("PostgreSQL");
    await db.prisma.organization.create({
      data: {
        id: organizationId,
        name: "Synthetic Picker organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await db.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Synthetic Picker Space" },
    });
    for (const [index, userId] of userIds.entries()) {
      await db.prisma.user.create({
        data: { id: userId, name: "Synthetic Picker user", email: `${userId}@example.test` },
      });
      await db.prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId,
          userId,
          role: index === 0 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
      await db.prisma.spaceMember.create({
        data: {
          id: randomUUID(),
          organizationId,
          spaceId,
          userId,
          role: index === 0 ? "owner" : "member",
          createdAt: new Date(),
        },
      });
    }
  }, 20_000);
  afterAll(async () => {
    await Promise.all(authorities.map((authority) => authority.close()));
    if (db) {
      try {
        await db.prisma.organization.deleteMany({ where: { id: organizationId } });
        await db.prisma.nativeAppConfig.deleteMany({ where: { id: { in: [...configs] } } });
        await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });

  async function fixture(scopes = SCOPES) {
    const vault = new EncryptedSecretStore("synthetic-drive-picker-master-key");
    const configStore = new NativeConfigStore(db.prisma, vault, API_ORIGIN);
    const config = await configStore.save(
      NativeConfigInputSchema.parse({
        appId: "google-drive",
        ownership: "byo",
        credentialKind: "oauth",
        label: `Synthetic Drive ${randomUUID()}`,
        clientId: "synthetic-picker-client",
        clientSecret: CLIENT_SECRET,
        scopes,
      }),
      context(),
      true,
    );
    configs.add(config.id);
    const control: {
      pickerExchanges: number;
      ordinaryExchanges: number;
      gate?: ReturnType<typeof deferred>;
      entered?: ReturnType<typeof deferred>;
    } = { pickerExchanges: 0, ordinaryExchanges: 0 };
    const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(target));
      if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_secret")).toBe(CLIENT_SECRET);
        expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
        const picker = body.get("code") === "picker-code";
        if (picker) {
          control.pickerExchanges++;
          control.entered?.resolve();
          await control.gate?.promise;
        } else control.ordinaryExchanges++;
        return Response.json({
          access_token: picker ? "synthetic-picker-token" : "synthetic-oidc-token",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: picker ? DRIVE_PICKER_SCOPE : SCOPES.join(" "),
        });
      }
      if (url.origin === "https://openidconnect.googleapis.com" && url.pathname === "/v1/userinfo")
        return Response.json({
          sub: "synthetic-oidc-subject",
          email: "shared-display@example.test",
          email_verified: true,
        });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-picker-token");
      if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/about")
        return Response.json({
          user: {
            permissionId: "synthetic-permission-id",
            me: true,
            emailAddress: "shared-display@example.test",
          },
        });
      if (
        url.origin === "https://www.googleapis.com" &&
        url.pathname.startsWith("/drive/v3/files/")
      )
        return Response.json({
          id: url.pathname.split("/").at(-1),
          name: "Synthetic selected file",
          mimeType: "text/plain",
          isAppAuthorized: true,
        });
      throw new Error("Unexpected synthetic Picker URL");
    });
    const authority = new NativeOAuthAuthorities({
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    authorities.push(authority);
    const store = new NativeOAuthStore(db.prisma, vault, configStore, authority);
    const second = new NativeOAuthStore(db.prisma, vault, configStore, authority);
    async function begin(picker = true) {
      const started = await store.begin(
        config.id,
        context(),
        undefined,
        picker ? "drive_picker" : undefined,
      );
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      return { ...started, state };
    }
    const callback = (
      started: { state: string },
      pickedFileIds = "file_a",
      actor = context().userId,
    ) =>
      store.callback(
        { state: started.state, code: "picker-code", pickedFileIds },
        context().signal,
        actor,
      );
    async function ordinary() {
      const started = await begin(false);
      await store.callback(
        { state: started.state, code: "ordinary-code", pickedFileIds: "file_should_be_ignored" },
        context().signal,
        context().userId,
      );
      const old = await db.prisma.connection.findUniqueOrThrow({
        where: { id: started.connectionId },
        include: { oauthGrant: true },
      });
      expect(old.oauthGrant?.subject).toBe("synthetic-oidc-subject");
      return old;
    }
    async function assertOldUnchanged(old: Awaited<ReturnType<typeof ordinary>>) {
      const current = await db.prisma.connection.findUniqueOrThrow({
        where: { id: old.id },
        include: { oauthGrant: true },
      });
      expect(current.status).toBe("connected");
      expect(current.oauthGrant).toEqual(old.oauthGrant);
    }
    return {
      store,
      second,
      configStore,
      config,
      control,
      fetch,
      begin,
      callback,
      ordinary,
      assertOldUnchanged,
    };
  }

  it("stores narrow requested scopes and binds launch to the initiating browser", async () => {
    const f = await fixture();
    const pending = await f.begin();
    const session = await db.prisma.nativeOAuthSession.findUniqueOrThrow({
      where: { connectionId: pending.connectionId },
    });
    expect(session.requestedScopes).toEqual([DRIVE_PICKER_SCOPE]);
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeLessThanOrEqual(
      10 * 60_000 + 1000,
    );
    await expect(
      f.store.launch(pending.state, userIds[1]!, context().signal),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    const url = new URL(await f.store.launch(pending.state, context().userId, context().signal));
    expect(url.searchParams.get("scope")).toBe(DRIVE_PICKER_SCOPE);
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("creates an independent permission grant without replacing an OIDC connection with the same display email", async () => {
    const f = await fixture();
    const old = await f.ordinary();
    const pending = await f.begin();
    await f.callback(pending, "file_a,file_b");
    const current = await db.prisma.connection.findUniqueOrThrow({
      where: { id: pending.connectionId },
      include: { oauthGrant: true },
    });
    expect(current.status).toBe("connected");
    expect(current.oauthGrantId).not.toBe(old.oauthGrantId);
    expect(current.oauthGrant).toMatchObject({
      authority: "https://www.googleapis.com/drive/v3",
      subject: "drive-permission:synthetic-permission-id",
      scopes: [DRIVE_PICKER_SCOPE],
      principal: {
        identityKind: DRIVE_PICKER_IDENTITY_KIND,
        drivePermissionId: "synthetic-permission-id",
        pickedFiles: [{ id: "file_a" }, { id: "file_b" }],
      },
    });
    expect(JSON.stringify(current)).not.toContain("synthetic-picker-token");
    await f.assertOldUnchanged(old);
  });
  it("rejects a previous-connection Picker intent before creating any pending session", async () => {
    const f = await fixture();
    const old = await f.ordinary();
    const before = await db.prisma.nativeOAuthSession.count({ where: { configId: f.config.id } });
    await expect(
      f.store.begin(f.config.id, context(), old.id, "drive_picker"),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    expect(await db.prisma.nativeOAuthSession.count({ where: { configId: f.config.id } })).toBe(
      before,
    );
    await f.assertOldUnchanged(old);
  });
  it("requires an explicit administrator drive.file ceiling before creating a session", async () => {
    const f = await fixture([
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]);
    await expect(f.begin()).rejects.toMatchObject({ kind: "not_configured" });
    expect(await db.prisma.nativeOAuthSession.count({ where: { configId: f.config.id } })).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["cancel", "ttl", "config_revision", "wrong_browser"] as const)(
    "rejects %s before exchanging and preserves the old connection",
    async (change) => {
      const f = await fixture();
      const old = await f.ordinary();
      const pending = await f.begin();
      if (change === "cancel") await f.store.disconnect(pending.connectionId, context());
      if (change === "ttl")
        await db.prisma.nativeOAuthSession.update({
          where: { connectionId: pending.connectionId },
          data: { expiresAt: new Date(0) },
        });
      if (change === "config_revision")
        await db.prisma.nativeAppConfig.update({
          where: { id: f.config.id },
          data: { revision: { increment: 1 } },
        });
      await expect(
        f.callback(pending, "file_a", change === "wrong_browser" ? userIds[1]! : context().userId),
      ).rejects.toMatchObject({ kind: "authorization_required" });
      expect(f.control.pickerExchanges).toBe(0);
      await f.assertOldUnchanged(old);
    },
  );
  it("handles refusal only on the new pending connection and never exchanges or revokes the old grant", async () => {
    const f = await fixture();
    const old = await f.ordinary();
    const pending = await f.begin();
    await expect(
      f.store.callback({ state: pending.state, denied: true }, context().signal, context().userId),
    ).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.control.pickerExchanges).toBe(0);
    expect(
      (await db.prisma.connection.findUniqueOrThrow({ where: { id: pending.connectionId } }))
        .status,
    ).toBe("error");
    await f.assertOldUnchanged(old);
  });
  it("rejects a completed consent without a file selection and consumes only that attempt", async () => {
    const f = await fixture();
    const old = await f.ordinary();
    const pending = await f.begin();
    await expect(f.callback(pending, "")).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.control.pickerExchanges).toBe(0);
    await expect(f.callback(pending)).rejects.toMatchObject({ kind: "authorization_required" });
    await f.assertOldUnchanged(old);
  });
  it("allows only one callback winner across competing stores and rejects a later replay", async () => {
    const f = await fixture();
    const pending = await f.begin();
    const input = { state: pending.state, code: "picker-code", pickedFileIds: "file_a" };
    const results = await Promise.allSettled([
      f.store.callback(input, context().signal, context().userId),
      f.second.callback(input, context().signal, context().userId),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.control.pickerExchanges).toBe(1);
    expect(await db.prisma.nativeOAuthGrant.count({ where: { configId: f.config.id } })).toBe(1);
    await expect(f.callback(pending)).rejects.toMatchObject({ kind: "authorization_required" });
    expect(f.control.pickerExchanges).toBe(1);
  });
  it.each(["cancel", "ttl", "config_revision"] as const)(
    "fences adoption after %s while code exchange is in flight",
    async (change) => {
      const f = await fixture();
      const old = await f.ordinary();
      const pending = await f.begin();
      f.control.gate = deferred();
      f.control.entered = deferred();
      const result = f.callback(pending).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await f.control.entered.promise;
      try {
        if (change === "cancel") await f.second.disconnect(pending.connectionId, context());
        if (change === "ttl")
          await db.prisma.nativeOAuthSession.update({
            where: { connectionId: pending.connectionId },
            data: { expiresAt: new Date(0) },
          });
        if (change === "config_revision")
          await db.prisma.nativeAppConfig.update({
            where: { id: f.config.id },
            data: { revision: { increment: 1 } },
          });
      } finally {
        f.control.gate.resolve();
      }
      expect(await result).toHaveProperty("error");
      expect(
        (await db.prisma.connection.findUniqueOrThrow({ where: { id: pending.connectionId } }))
          .oauthGrantId,
      ).toBeNull();
      expect(await db.prisma.nativeOAuthGrant.count({ where: { configId: f.config.id } })).toBe(1);
      await f.assertOldUnchanged(old);
    },
  );
});
