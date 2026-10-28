import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChatGPTPlanLogin,
  disconnectChatGPTPlan,
  listChatGPTPlanProfiles,
} from "./chatgpt-plan.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("ChatGPT registration persistence (PostgreSQL)", () => {
  let database: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let dataDir: string;
  const secrets = new EncryptedSecretStore("offline-registration-scope-fixture");
  const users = [randomUUID(), randomUUID()];
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const actor = { userId: users[0]!, spaceId };
  const otherActor = { userId: users[1]!, spaceId };

  beforeAll(async () => {
    database = createDb(databaseUrl!, { applicationName: "chatgpt-registration-scope" });
    prisma = withSecretPersistence(database.prisma, secrets);
    dataDir = await mkdtemp(path.join(tmpdir(), "chatgpt-registration-scope-"));
    for (const id of users)
      await database.prisma.user.create({
        data: { id, name: "Fixture", email: `${id}@example.test` },
      });
    await database.prisma.organization.create({
      data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: new Date() },
    });
    await database.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Fixture" },
    });
  });
  afterAll(async () => {
    try {
      await database?.prisma.organization.deleteMany({ where: { id: organizationId } });
      await database?.prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await secrets.close();
      await database?.prisma.$disconnect();
      await database?.pool.end();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("commits the encrypted issued registration before exchange, retains it on failure and reuses it only for its owner", async () => {
    const issuedClientId = "oaiapp_offline_registration_fixture";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.openai.com/api/accounts/oauth/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe(issuedClientId);
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      // Only HTTP is synthetic: registration must already be committed through
      // the real encrypted store and secret-persistence transaction wrapper.
      const rows = await database.prisma.secret.findMany({
        where: { userId: actor.userId, spaceId: null, kind: "chatgpt-plan-registration" },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ciphertext).toMatch(/^v2:/);
      expect(rows[0]!.ciphertext).not.toContain(issuedClientId);
      expect(JSON.parse(await secrets.load(rows[0]!.ciphertext, rows[0]!.id))).toMatchObject({
        version: 1,
        registration: { clientId: issuedClientId, issuer: "https://auth.openai.com" },
      });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    const deps = { prisma, secrets, dataDir, chatgptPlanFetch: fetcher as typeof fetch };
    async function login(registrationId?: string) {
      let authorization!: URL;
      const operation = createChatGPTPlanLogin(deps, actor, {
        callbackTransport: "desktop",
        ...(registrationId ? { registrationId } : { newRegistration: true }),
      })({
        signal: AbortSignal.timeout(10_000),
        notify(event) {
          if (event.type === "auth_url") authorization = new URL(event.url);
        },
        async prompt() {
          expect(authorization.searchParams.get("client_id")).toBe(
            registrationId ? issuedClientId : "dynamic_agent_client",
          );
          expect(authorization.searchParams.has("agent_name_hint")).toBe(!registrationId);
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            code: "offline-code-fixture",
            state: authorization.searchParams.get("state")!,
            ...(!registrationId ? { client_id: issuedClientId } : {}),
          }).toString();
          return callback.href;
        },
      });
      await expect(operation).rejects.toThrow("ChatGPT OAuth request failed (400) invalid_grant.");
    }
    await login();
    const profiles = await listChatGPTPlanProfiles(deps, actor);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.status).toBe("incomplete");
    expect(
      await database.prisma.userModelCredential.count({ where: { userId: actor.userId } }),
    ).toBe(0);
    await login(profiles[0]!.id);
    expect(await listChatGPTPlanProfiles(deps, actor)).toEqual(profiles);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await listChatGPTPlanProfiles(deps, otherActor)).toEqual([]);
    const notify = vi.fn();
    await expect(
      createChatGPTPlanLogin(deps, otherActor, {
        callbackTransport: "desktop",
        registrationId: profiles[0]!.id,
      })({ signal: AbortSignal.timeout(10_000), notify, prompt: async () => "unused" }),
    ).rejects.toThrow("ChatGPT registration was not found.");
    expect(notify).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps account-only and space-only secret boundaries strict", async () => {
    for (const kind of ["model", "voice", "native_application", "chatgpt-plan-registration"]) {
      await expect(
        database.prisma.secret.create({
          data: { userId: actor.userId, spaceId: null, kind, ciphertext: "offline-scope-fixture" },
        }),
      ).resolves.toMatchObject({ kind, spaceId: null });
      await expect(
        database.prisma.secret.create({
          data: { userId: actor.userId, spaceId, kind, ciphertext: "offline-scope-fixture" },
        }),
      ).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
      });
    }
    for (const kind of ["connection", "mcp", "unrecognized-fixture-kind"]) {
      await expect(
        database.prisma.secret.create({
          data: { userId: actor.userId, spaceId, kind, ciphertext: "offline-scope-fixture" },
        }),
      ).resolves.toMatchObject({ kind, spaceId });
      await expect(
        database.prisma.secret.create({
          data: { userId: actor.userId, spaceId: null, kind, ciphertext: "offline-scope-fixture" },
        }),
      ).rejects.toMatchObject({
        meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
      });
    }
  });
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Real OIDC verification and encrypted persistence; only OpenAI HTTP is synthetic.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const registrationJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "registration-race",
  alg: "RS256",
  use: "sig",
};

function registrationIdToken(clientId: string, nonce: string, subject: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: registrationJwk.kid })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        iss: "https://auth.openai.com",
        sub: subject,
        aud: clientId,
        nonce,
        email,
        iat: now - 1,
        exp: now + 3600,
      }),
    ).toString("base64url"),
  ];
  return `${parts.join(".")}.${sign("RSA-SHA256", Buffer.from(parts.join(".")), privateKey).toString("base64url")}`;
}

describe.skipIf(!enabled)("ChatGPT registration cross-process publication (PostgreSQL)", () => {
  let writer: ReturnType<typeof createDb>;
  let remover: ReturnType<typeof createDb>;
  let writerPrisma: PrismaClient;
  let removerPrisma: PrismaClient;
  let dataDir: string;
  const writerSecrets = new EncryptedSecretStore("offline-profile-publication-fixture");
  const removerSecrets = new EncryptedSecretStore("offline-profile-publication-fixture");
  const users: string[] = [];

  beforeAll(async () => {
    writer = createDb(databaseUrl!, { poolMax: 2, applicationName: "chatgpt-profile-writer" });
    remover = createDb(databaseUrl!, { poolMax: 2, applicationName: "chatgpt-profile-remover" });
    writerPrisma = withSecretPersistence(writer.prisma, writerSecrets);
    removerPrisma = withSecretPersistence(remover.prisma, removerSecrets);
    dataDir = await mkdtemp(path.join(tmpdir(), "chatgpt-profile-publication-"));
  });
  afterAll(async () => {
    try {
      await writer?.prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      for (const store of [writerSecrets, removerSecrets]) await store.close();
      for (const client of [writer, remover]) {
        await client?.prisma.$disconnect();
        await client?.pool.end();
      }
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  });

  async function fixture() {
    const userId = randomUUID();
    users.push(userId);
    await writer.prisma.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    const actor = { userId, spaceId: randomUUID() };
    const id = randomUUID();
    const clientId = `oaiapp_${id.replaceAll("-", "")}`;
    const stored = await writerSecrets.put(
      JSON.stringify({
        version: 1,
        registration: { clientId, issuer: "https://auth.openai.com" },
        label: "Retained label",
        idTokenHint: "offline-legacy-hint",
      }),
      { ...actor, operationId: "fixture", traceId: "fixture", signal: AbortSignal.timeout(10_000) },
      { recordId: id },
    );
    await writerPrisma.secret.create({
      data: {
        id,
        userId,
        spaceId: null,
        kind: "chatgpt-plan-registration",
        ciphertext: stored.ciphertext,
      },
    });
    const removerDeps = { prisma: removerPrisma, secrets: removerSecrets, dataDir };
    async function readProfile() {
      const row = await writer.prisma.secret.findFirstOrThrow({
        where: { id, userId, spaceId: null, kind: "chatgpt-plan-registration" },
      });
      expect(row.ciphertext).toMatch(/^v2:/);
      expect(row.ciphertext).not.toContain(clientId);
      return JSON.parse(await writerSecrets.load(row.ciphertext, row.id));
    }
    function login(
      options: {
        subject?: string;
        email?: string;
        label?: string;
        beforeModels?: () => Promise<void>;
      } = {},
    ) {
      let authorization!: URL;
      const subject = options.subject ?? "verified-subject";
      const email = options.email ?? "bound@example.test";
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://auth.openai.com/api/accounts/oauth/token") {
          const body = init?.body as URLSearchParams;
          expect(body.get("client_id")).toBe(clientId);
          return Response.json({
            access_token: `offline-access-${subject}`,
            refresh_token: `offline-refresh-${subject}`,
            expires_in: 3600,
            token_type: "Bearer",
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            id_token: registrationIdToken(
              clientId,
              authorization.searchParams.get("nonce")!,
              subject,
              email,
            ),
          });
        }
        if (url === "https://auth.openai.com/.well-known/openid-configuration")
          return Response.json({
            issuer: "https://auth.openai.com",
            jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
          });
        if (url === "https://auth.openai.com/.well-known/jwks.json")
          return Response.json({ keys: [registrationJwk] });
        if (url === "https://api.openai.com/v1/models") {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer offline-access-${subject}`,
          );
          await options.beforeModels?.();
          return Response.json({
            models: [{ slug: "offline-model", display_name: "Offline model", visibility: "list" }],
          });
        }
        throw new Error("Unexpected offline registration endpoint");
      });
      return createChatGPTPlanLogin(
        {
          prisma: writerPrisma,
          secrets: writerSecrets,
          dataDir,
          chatgptPlanFetch: fetcher as typeof fetch,
        },
        actor,
        { callbackTransport: "desktop", registrationId: id, label: options.label },
      )({
        signal: AbortSignal.timeout(15_000),
        notify(event) {
          if (event.type === "auth_url") authorization = new URL(event.url);
        },
        async prompt() {
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            state: authorization.searchParams.get("state")!,
            code: "offline-race-code",
          }).toString();
          return callback.href;
        },
      });
    }
    return { actor, id, clientId, removerDeps, readProfile, login };
  }

  async function waitForBlockedOrSettled(applicationName: string, settled: () => boolean) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (settled()) return;
      const result = await writer.pool.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock') AS waiting",
        [applicationName],
      );
      if (result.rows[0]?.waiting) return;
      await delay(10);
    }
    throw new Error("Expected competing profile publication to block or settle");
  }

  it("retains verified identity when disconnect began from an incomplete profile before login publication", async () => {
    const f = await fixture();
    const saving = barrier();
    const release = barrier();
    const originalPut = removerSecrets.put.bind(removerSecrets);
    const put = vi
      .spyOn(removerSecrets, "put")
      .mockImplementation(async (plaintext, context, options) => {
        if (options?.recordId === f.id && JSON.parse(plaintext).signedOut === true) {
          saving.release();
          await release.promise;
        }
        return originalPut(plaintext, context, options);
      });
    const disconnect = disconnectChatGPTPlan(f.removerDeps, f.actor);
    let connected: ReturnType<typeof f.login> | undefined;
    let settled = false;
    try {
      await saving.promise;
      connected = f.login({ label: "Verified label" });
      void connected.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitForBlockedOrSettled("chatgpt-profile-writer", () => settled);
    } finally {
      release.release();
      await Promise.allSettled([disconnect, ...(connected ? [connected] : [])]);
      put.mockRestore();
    }
    await expect(disconnect).resolves.toEqual({ confirmed: true });
    await expect(connected).resolves.toMatchObject({ subject: "verified-subject" });
    expect(await f.readProfile()).toMatchObject({
      version: 1,
      label: "Verified label",
      registration: {
        clientId: f.clientId,
        issuer: "https://auth.openai.com",
        subject: "verified-subject",
        email: "bound@example.test",
      },
    });
    expect((await f.readProfile()).idTokenHint).toBeUndefined();
  });

  it("disconnects the latest verified profile when login publication started before sign-out", async () => {
    const f = await fixture();
    const saving = barrier();
    const release = barrier();
    const originalPut = writerSecrets.put.bind(writerSecrets);
    const put = vi
      .spyOn(writerSecrets, "put")
      .mockImplementation(async (plaintext, context, options) => {
        if (
          options?.recordId === f.id &&
          JSON.parse(plaintext).registration?.subject === "verified-subject"
        ) {
          saving.release();
          await release.promise;
        }
        return originalPut(plaintext, context, options);
      });
    const connected = f.login({ label: "Verified label" });
    let disconnect: ReturnType<typeof disconnectChatGPTPlan> | undefined;
    let settled = false;
    try {
      await saving.promise;
      disconnect = disconnectChatGPTPlan(f.removerDeps, f.actor);
      void disconnect.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitForBlockedOrSettled("chatgpt-profile-remover", () => settled);
    } finally {
      release.release();
      await Promise.allSettled([connected, ...(disconnect ? [disconnect] : [])]);
      put.mockRestore();
    }
    await expect(connected).resolves.toMatchObject({ subject: "verified-subject" });
    await expect(disconnect).resolves.toEqual({ confirmed: true });
    expect(await f.readProfile()).toMatchObject({
      version: 1,
      signedOut: true,
      label: "Verified label",
      registration: {
        clientId: f.clientId,
        issuer: "https://auth.openai.com",
        subject: "verified-subject",
        email: "bound@example.test",
      },
    });
    expect((await f.readProfile()).idTokenHint).toBeUndefined();
  });

  it("rejects a second verified identity after parallel logins selected the same incomplete profile", async () => {
    const f = await fixture();
    const firstReady = barrier();
    const secondReady = barrier();
    const releaseFirst = barrier();
    const releaseSecond = barrier();
    const first = f.login({
      subject: "first-subject",
      label: "First label",
      beforeModels: async () => {
        firstReady.release();
        await releaseFirst.promise;
      },
    });
    const second = f.login({
      subject: "other-subject",
      email: "other@example.test",
      label: "Other label",
      beforeModels: async () => {
        secondReady.release();
        await releaseSecond.promise;
      },
    });
    const secondResult = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.all([firstReady.promise, secondReady.promise]);
      releaseFirst.release();
      await expect(first).resolves.toMatchObject({ subject: "first-subject" });
      releaseSecond.release();
      expect(await secondResult).toMatchObject({
        error: new Error("ChatGPT account changed. Connect the intended account again."),
      });
    } finally {
      releaseFirst.release();
      releaseSecond.release();
      await Promise.allSettled([first, second]);
    }
    expect(await f.readProfile()).toMatchObject({
      label: "First label",
      registration: { subject: "first-subject", email: "bound@example.test" },
    });
  });
});
