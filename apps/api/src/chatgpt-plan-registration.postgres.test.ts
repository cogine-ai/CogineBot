import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedSecretStore, withSecretPersistence } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createChatGPTPlanLogin, listChatGPTPlanProfiles } from "./chatgpt-plan.js";

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
