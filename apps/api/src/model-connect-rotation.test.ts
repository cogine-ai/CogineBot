import { RPCHandler } from "@orpc/server/fetch";
import { parseModelSecret, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
} satisfies Actor;
function fixture(change?: "newer" | "revision" | "ciphertext") {
  const credential = (id: string, time: number) => ({
    id,
    userId: actor.userId,
    provider: "xai",
    label: id,
    secretId: `secret-${id}`,
    connectionRevision: 4,
    supportsImages: false,
    createdAt: new Date(time),
    updatedAt: new Date(time),
  });
  const first = credential("first", 1),
    newest = credential("newest", 2);
  const credentials = new Map([first, newest].map((row) => [row.id, row]));
  const plaintext = new Map<string, string>([
    [
      "cipher-first",
      serializeModelSecret({
        kind: "api_key",
        key: "fake-first-key",
        maxTokens: 1024,
        contextWindow: 32000,
        cacheCapabilities: { scope: "connection", retentionMode: "short", retentionMs: 60000 },
      }),
    ],
    [
      "cipher-newest",
      serializeModelSecret({
        kind: "api_key",
        key: "fake-newest-key",
        maxTokens: 2048,
        contextWindow: 64000,
        cacheCapabilities: { scope: "connection", retentionMode: "long", retentionMs: 120000 },
      }),
    ],
  ]);
  const secrets = new Map(
    [first, newest].map((row) => [
      row.secretId,
      { id: row.secretId, ciphertext: `cipher-${row.id}` },
    ]),
  );
  const preferences = [
    {
      id: "pref-first",
      ...actor,
      credential: first,
      credentialId: first.id,
      modelId: "grok-4.6",
      thinkingLevel: null,
      isDefault: true,
      updatedAt: new Date(3),
    },
  ];
  const userModelCredential = {
    findMany: vi.fn(async () => [...credentials.values()]),
    findFirst: vi.fn(
      async ({ where }: { where: { id?: string; userId: string; provider: string } }) => {
        const row = where.id
          ? credentials.get(where.id)
          : [...credentials.values()].sort(
              (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
            )[0];
        return row && row.userId === where.userId && row.provider === where.provider
          ? { ...row }
          : null;
      },
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; connectionRevision: number };
        data: { secretId: string; label: string };
      }) => {
        const row = credentials.get(where.id);
        if (!row || row.connectionRevision !== where.connectionRevision)
          throw Object.assign(new Error("Changed"), { code: "P2025" });
        Object.assign(row, {
          secretId: data.secretId,
          label: data.label,
          connectionRevision: row.connectionRevision + 1,
        });
        return { ...row };
      },
    ),
    count: vi.fn(async () => 0),
  };
  const secret = {
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = secrets.get(where.id);
      return row ? { ...row } : null;
    }),
    create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
      secrets.set(data.id, data);
      return data;
    }),
    deleteMany: vi.fn(async () => ({ count: 1 })),
  };
  const spaceModelPreference = {
    findMany: vi.fn(async () => preferences),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async () => ({})),
  };
  const tx = {
    userModelCredential,
    secret,
    spaceModelPreference,
    userVoiceCredential: { count: vi.fn(async () => 0) },
  };
  const load = vi.fn(async (cipher: string) => {
    const value = plaintext.get(cipher);
    if (!value) throw new Error("Missing synthetic key");
    return value;
  });
  const put = vi.fn(async (value: string) => {
    if (change === "newer") credentials.set("later", credential("later", 20));
    if (change === "revision") newest.connectionRevision++;
    if (change === "ciphertext") secrets.get(newest.secretId)!.ciphertext = "changed-in-place";
    plaintext.set("written", value);
    return { id: "written-secret", ciphertext: "written" };
  });
  const handler = new RPCHandler(
    createRouter({
      prisma: { ...tx, $transaction: vi.fn(async (work) => work(tx)) },
      secrets: { load, put },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps),
  );
  const call = async () =>
    (
      await handler.handle(
        new Request("http://localhost/rpc/models/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { provider: "xai", modelId: "grok-4.6", maxTokens: 8192 } }),
        }),
        { prefix: "/rpc", context: { actor } },
      )
    ).response;
  return { call, credentials, plaintext, load, put, secret };
}

describe("implicit catalog connection rotation", () => {
  it("inherits only the newest connection's key and metadata despite an older Space preference", async () => {
    const f = fixture();
    const response = await f.call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ json: { id: "newest", connectionRevision: 5 } });
    expect(parseModelSecret(f.plaintext.get("written")!)).toEqual({
      kind: "api_key",
      key: "fake-newest-key",
      maxTokens: 8192,
      contextWindow: 64000,
      cacheCapabilities: { scope: "connection", retentionMode: "long", retentionMs: 120000 },
    });
    expect(f.load).toHaveBeenCalledExactlyOnceWith("cipher-newest", "secret-newest");
    expect(f.credentials.get("first")).toMatchObject({
      secretId: "secret-first",
      connectionRevision: 4,
    });
  });
  it("keeps the loaded connection when another same-provider row appears before commit", async () => {
    const f = fixture("newer");
    const response = await f.call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ json: { id: "newest", connectionRevision: 5 } });
    expect(f.credentials.get("later")).toMatchObject({
      secretId: "secret-later",
      connectionRevision: 4,
    });
  });
  it.each(["revision", "ciphertext"] as const)(
    "rejects a concurrent %s change before writing credential data",
    async (change) => {
      const f = fixture(change);
      const response = await f.call();
      expect(response.status).toBe(409);
      expect(f.secret.create).not.toHaveBeenCalled();
    },
  );
});
