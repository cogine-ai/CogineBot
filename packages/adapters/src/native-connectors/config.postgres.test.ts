import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeConfigStore } from "./config.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("native deployment configuration lifecycle (PostgreSQL)", () => {
  const suffix = randomUUID();
  let db: ReturnType<typeof createDb> | undefined;
  let configId: string | undefined;
  const userIds = [`config-owner-${suffix}`, `grant-owner-${suffix}`];
  const organizationId = `native-org-${suffix}`;
  const spaceA = `native-space-a-${suffix}`;
  const spaceB = `native-space-b-${suffix}`;

  afterAll(async () => {
    if (!db) return;
    await db.prisma.nativeOAuthGrant.deleteMany({ where: { userId: { in: userIds } } });
    if (configId) await db.prisma.nativeAppConfig.deleteMany({ where: { id: configId } });
    await db.prisma.organization.deleteMany({ where: { id: organizationId } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps a deployment OAuth client and another Space's grant after the configuring Space is deleted", async () => {
    db = createDb(process.env.DATABASE_URL!);
    const prisma = db.prisma;
    for (const id of userIds)
      await prisma.user.create({
        data: {
          id,
          name: "Native Test User",
          email: `${id}@example.test`,
        },
      });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Native Test Organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const id of [spaceA, spaceB])
      await prisma.space.create({
        data: {
          id,
          organizationId,
          name: "Native Test Space",
        },
      });
    const context: AdapterContext = {
      userId: userIds[0]!,
      spaceId: spaceA,
      operationId: "native.configure",
      traceId: "native.configure",
      signal: new AbortController().signal,
    };
    const secrets = new EncryptedSecretStore("offline-native-test-key");
    const store = new NativeConfigStore(prisma, secrets, "https://api.example.test");
    const saved = await store.save(
      NativeConfigInputSchema.parse({
        appId: "google-calendar",
        ownership: "byo",
        credentialKind: "oauth",
        label: "Synthetic client",
        clientId: "fake-client",
        clientSecret: "fake-application-secret",
        scopes: ["openid"],
      }),
      context,
      true,
    );
    configId = saved.id;
    const configured = await store.require(configId);
    const appSecret = await prisma.secret.findUniqueOrThrow({
      where: { id: configured.secretId! },
    });
    expect(appSecret.spaceId).toBeNull();
    await expect(
      prisma.secret.create({
        data: {
          id: `invalid-account-${suffix}`,
          userId: userIds[1]!,
          spaceId: null,
          kind: "native_account",
          ciphertext: "fixture-never-used",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.secret.create({
        data: {
          id: `invalid-app-${suffix}`,
          userId: userIds[0]!,
          spaceId: spaceA,
          kind: "native_application",
          ciphertext: "fixture-never-used",
        },
      }),
    ).rejects.toThrow();
    const grantId = `native-grant-${suffix}`;
    await prisma.nativeOAuthGrant.create({
      data: {
        id: grantId,
        userId: userIds[1]!,
        spaceId: spaceB,
        configId,
        configRevision: saved.revision,
        authority: "google",
        subject: "synthetic-subject",
        scopes: ["openid"],
      },
    });
    await prisma.space.delete({ where: { id: spaceA } });
    expect((await store.require(configId)).secretId).toBe(appSecret.id);
    const after = await prisma.secret.findUniqueOrThrow({ where: { id: appSecret.id } });
    expect(await secrets.load(after.ciphertext, after.id)).toBe("fake-application-secret");
    expect(await prisma.nativeOAuthGrant.findUnique({ where: { id: grantId } })).toMatchObject({
      userId: userIds[1],
      spaceId: spaceB,
      configId,
    });
    // Account grants keep their own Space lifecycle; only the global app config is detached.
    await prisma.space.delete({ where: { id: spaceB } });
    expect(await prisma.nativeOAuthGrant.findUnique({ where: { id: grantId } })).toBeNull();
    expect((await store.require(configId)).secretId).toBe(appSecret.id);
  });
});
