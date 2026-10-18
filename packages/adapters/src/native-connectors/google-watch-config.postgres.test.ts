import { randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeConfigStore } from "./config.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
suite("Gmail deployment push ownership (PostgreSQL)", () => {
  const id = randomUUID().replaceAll("-", "").slice(0, 20),
    projectId = `native-test-${id}`;
  const db = createDb(process.env.DATABASE_URL!),
    secrets = new EncryptedSecretStore("synthetic-google-watch-config-test-key");
  const store = new NativeConfigStore(db.prisma, secrets, "https://api.example.test");
  const context: AdapterContext = {
    userId: `owner-${id}`,
    spaceId: `space-${id}`,
    operationId: "configure",
    traceId: "configure",
    signal: new AbortController().signal,
  };
  const ids: string[] = [];
  const input = (topic = "mailbox-topic", subscription = "mailbox-sub") => ({
    appId: "gmail" as const,
    ownership: "byo" as const,
    credentialKind: "oauth" as const,
    enabled: true,
    capabilities: [],
    knowledgeBaseIds: [],
    label: "Synthetic Gmail client",
    clientId: `client-${id}`,
    clientSecret: "synthetic-write-only-secret",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    googleWatch: {
      projectId,
      topicName: `projects/${projectId}/topics/${topic}`,
      subscriptionName: `projects/${projectId}/subscriptions/${subscription}`,
      callbackAudience: "https://api.example.test/api/connectors/events/gmail",
      pushServiceAccountEmail: `push@${projectId}.iam.gserviceaccount.com`,
    },
  });
  afterAll(async () => {
    await db.prisma.nativeAppConfig.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it("rejects a callback audience outside this deployment", async () => {
    const value = input();
    value.googleWatch.callbackAudience = "https://other.example.test/api/connectors/events/gmail";
    await expect(store.save(value, context, true)).rejects.toThrow(
      "exact public HTTPS callback audience",
    );
  });
  it("rejects a mismatched topic project before saving credentials", async () => {
    const value = input();
    value.googleWatch.topicName = "projects/other-project/topics/mailbox-topic";
    await expect(store.save(value, context, true)).rejects.toThrow("configured Google project");
  });
  it("serializes conflicting topic choices from concurrent administrators", async () => {
    const results = await Promise.allSettled([
      store.save(input("mailbox-a"), context, true),
      store.save(input("mailbox-b"), context, true),
    ]);
    for (const result of results) if (result.status === "fulfilled") ids.push(result.value.id);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = await db.prisma.nativeAppConfig.findMany({ where: { id: { in: ids } } });
    expect(saved).toHaveLength(1);
  });
  it("does not accept two service accounts for one exact push subscription", async () => {
    const saved = await store.configuration(ids[0]!, true),
      value = input(saved.googleWatch!.topicName.split("/").at(-1)!);
    value.googleWatch.pushServiceAccountEmail = `other@${projectId}.iam.gserviceaccount.com`;
    await expect(store.save(value, context, true)).rejects.toThrow(
      "one exact callback audience and service account",
    );
  });
});
