import type { AdapterContext } from "@rakazo/adapter-kit";
import { NativeConfigInputSchema, NativeConfigStatusSchema } from "@rakazo/contracts";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import {
  NativeConfigSettingsSchema,
  NativeConfigStore,
  nativeCallbackUri,
  nativeConfigStatus,
} from "./config.js";
import { NativeHttpClient } from "./http.js";

const context: AdapterContext = {
  userId: "user-1",
  spaceId: "space-1",
  operationId: "configure",
  traceId: "configure",
  signal: new AbortController().signal,
};
const configInput = () =>
  NativeConfigInputSchema.parse({
    appId: "google-calendar",
    ownership: "byo",
    credentialKind: "oauth",
    label: "Test calendar",
    clientId: "fake-client",
    scopes: ["openid", "https://www.googleapis.com/auth/calendar.events"],
  });

function database() {
  let row: NativeAppConfig | null = null;
  const stored = new Map<string, { id: string; ciphertext: string }>();
  const nativeAppConfig = {
    findUnique: vi.fn(async () => row),
    findUniqueOrThrow: vi.fn(async () => {
      if (!row) throw new Error("missing");
      return row;
    }),
    findMany: vi.fn(async () => (row ? [row] : [])),
    count: vi.fn(async ({ where }) => Number(row?.ciphertext === where.ciphertext)),
    create: vi.fn(async ({ data }) => {
      row = { id: "config-1", revision: 1, createdAt: new Date(), updatedAt: new Date(), ...data };
      if (row?.ciphertext && row.secretRecordId)
        stored.set(row.secretRecordId, { id: row.secretRecordId, ciphertext: row.ciphertext });
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      if (!row || row.id !== where.id || row.revision !== where.revision) return { count: 0 };
      const next: NativeAppConfig = {
        ...row,
        ...data,
        revision: row.revision + (data.revision?.increment ?? 0),
      };
      row = next;
      stored.clear();
      if (next.ciphertext && next.secretRecordId)
        stored.set(next.secretRecordId, { id: next.secretRecordId, ciphertext: next.ciphertext });
      return { count: 1 };
    }),
  };
  const secret = {
    create: vi.fn(async ({ data }) => {
      stored.set(data.id, data);
      return data;
    }),
    deleteMany: vi.fn(async ({ where }) => ({ count: Number(stored.delete(where.id)) })),
    count: vi.fn(async () => 0),
  };
  const db = {
    nativeAppConfig,
    secret,
    botSecret: { count: async () => 0 },
    integrationProviderConfig: { count: async () => 0 },
    $queryRaw: vi.fn(async () => [{ referenced: false }]),
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db: db as unknown as PrismaClient, nativeAppConfig, secret, stored };
}

describe("native application configuration boundary", () => {
  it.each([
    ["https://knowai.example.test", "https://knowai.example.test"],
    ["https://knowai.example.test/api/v1", "https://knowai.example.test"],
    ["https://knowai.example.test/api/v1/", "https://knowai.example.test"],
    ["https://knowai.example.test/atlas/", "https://knowai.example.test/atlas"],
    ["https://knowai.example.test/atlas/api/v1/", "https://knowai.example.test/atlas"],
    ["https://knowai.example.test/api/v10/", "https://knowai.example.test/api/v10"],
  ])(
    "saves Knowai endpoint %s as its instance base and preserves actual action URLs",
    async (endpoint, expectedBase) => {
      const { db } = database();
      const network = {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
        fetch: vi.fn(
          async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response(JSON.stringify({ success: true })),
        ),
      };
      const service = new NativeConfigStore(
        db,
        new EncryptedSecretStore("test-key"),
        "https://api.example.test",
        network,
      );
      await service.save(
        {
          appId: "knowai",
          ownership: "byo",
          credentialKind: "machine_key",
          label: "Knowai fixture",
          endpoint,
          scopes: [],
          capabilities: ["retrieve"],
          knowledgeBaseIds: ["kb-fixture"],
          tenantId: "42",
          enabled: true,
        },
        context,
        true,
      );
      const editable = await service.configuration("config-1", true);
      expect(editable.endpoint).toBe(expectedBase);
      const row = await service.require("config-1");
      const stored = NativeConfigSettingsSchema.parse(row.config);
      const client = new NativeHttpClient(
        stored.endpoint!,
        async () => ({ kind: "api_key", value: "fixture-key" }),
        {
          network,
          signal: context.signal,
          readOnly: true,
        },
      );
      try {
        await client.request({ method: "GET", path: "/api/v1/auth/me" });
        await client.request({ method: "GET", path: "/api/v1/knowledge-bases" });
        expect(network.fetch.mock.calls.map(([url]) => String(url))).toEqual([
          `${expectedBase}/api/v1/auth/me`,
          `${expectedBase}/api/v1/knowledge-bases`,
        ]);
      } finally {
        await client.close();
      }
    },
  );

  it("does not normalize another service's API path or bypass URL validation", async () => {
    const { db } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "https://api.example.test",
      {
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    );
    await service.save(
      {
        appId: "coginex",
        ownership: "byo",
        credentialKind: "mcp_oauth",
        label: "MCP fixture",
        enabled: true,
        endpoint: "https://mcp.example.test/atlas/api/v1",
        scopes: ["mcp"],
        capabilities: [],
        knowledgeBaseIds: [],
      },
      context,
      true,
    );
    expect((await service.configuration("config-1", true)).endpoint).toBe(
      "https://mcp.example.test/atlas/api/v1",
    );
    for (const endpoint of [
      "https://user:fixture-password@knowai.example.test/atlas/api/v1",
      "https://knowai.example.test/atlas/api/v1?api_key=fixture-key",
      "https://knowai.example.test/atlas/api/v1#fragment",
    ]) {
      const { db, nativeAppConfig } = database();
      const service = new NativeConfigStore(
        db,
        new EncryptedSecretStore("test-key"),
        "https://api.example.test",
      );
      await expect(
        service.save(
          {
            appId: "knowai",
            ownership: "byo",
            credentialKind: "machine_key",
            label: "Knowai fixture",
            enabled: true,
            endpoint,
            scopes: [],
            capabilities: ["retrieve"],
            knowledgeBaseIds: ["kb-fixture"],
            tenantId: "42",
          },
          context,
          true,
        ),
      ).rejects.toThrow();
      expect(nativeAppConfig.create).not.toHaveBeenCalled();
    }
  });

  it("derives a single fixed callback from the configured API origin", () => {
    expect(nativeCallbackUri("https://api.example.test/prefix")).toBe(
      "https://api.example.test/api/connectors/oauth/callback",
    );
    expect(nativeCallbackUri("http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100/api/connectors/oauth/callback",
    );
    expect(() => nativeCallbackUri("http://api.example.test")).toThrow();
    expect(() => nativeCallbackUri("https://user:pass@api.example.test")).toThrow();
    expect(() => nativeCallbackUri("https://api.example.test?token=hidden")).toThrow();
  });

  it("rejects Space/member configuration before reading or writing application material", async () => {
    const { db, nativeAppConfig } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "https://api.example.test",
    );
    await expect(service.save(configInput(), context, false)).rejects.toThrow(
      "deployment administrator",
    );
    expect(nativeAppConfig.findUnique).not.toHaveBeenCalled();
    expect(nativeAppConfig.create).not.toHaveBeenCalled();
  });

  it("keeps optional unconfigured OAuth from blocking a plain HTTP core deployment", async () => {
    const { db } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "http://instance.example.test",
    );
    await expect(service.statuses()).resolves.toEqual([]);
    await expect(service.save(configInput(), context, true)).rejects.toThrow("HTTPS");
  });

  it("keeps write-only client secrets in the existing scoped SecretStore", async () => {
    const { db, stored, secret } = database();
    const secrets = new EncryptedSecretStore("test-key");
    const service = new NativeConfigStore(db, secrets, "https://api.example.test");
    const result = await service.save(
      { ...configInput(), clientSecret: "fake-client-secret" },
      context,
      true,
    );
    expect(result.configured).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/fake-client|ciphertext|secretId|endpoint/);
    const material = [...stored.values()][0];
    expect(material?.ciphertext).not.toContain("fake-client-secret");
    expect(secret.create).not.toHaveBeenCalled();
    expect(await secrets.load(material!.ciphertext, material!.id)).toBe("fake-client-secret");
    await expect(secrets.load(material!.ciphertext, "another-owner-record")).rejects.toThrow();
  });

  it("retains existing credentials when omitted and rejects stale configuration saves", async () => {
    const { db, stored } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "https://api.example.test",
    );
    await service.save({ ...configInput(), clientSecret: "fake-client-secret" }, context, true);
    const original = [...stored.values()][0];
    const next = await service.save(
      { ...configInput(), id: "config-1", expectedRevision: 1, label: "Renamed" },
      context,
      true,
    );
    expect(next.revision).toBe(1);
    expect([...stored.values()]).toEqual([original]);
    const disabled = await service.save(
      { ...configInput(), id: "config-1", expectedRevision: 1, enabled: false },
      context,
      true,
    );
    expect(disabled.revision).toBe(2);
    await expect(
      service.save({ ...configInput(), id: "config-1", expectedRevision: 1 }, context, true),
    ).rejects.toThrow("changed");
    await expect(
      service.save(
        { ...configInput(), id: "config-1", expectedRevision: 2, clientId: "other-client" },
        context,
        true,
      ),
    ).rejects.toThrow("matching secret");
  });

  it("does not expose instance endpoints, client IDs or credential fields in member status", async () => {
    const { db } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "https://api.example.test",
    );
    await service.save(configInput(), context, true);
    const [row] = await db.nativeAppConfig.findMany();
    const dto = nativeConfigStatus(row!);
    expect(dto.configured).toBe(false);
    expect(
      NativeConfigStatusSchema.parse({
        ...dto,
        endpoint: "https://private.example.test",
        clientSecret: "fake-secret",
      }),
    ).toEqual(dto);
    await expect(service.require(dto.id)).rejects.toThrow("not configured");
  });

  it("rejects borrowed credential kinds and account material in shared configuration", () => {
    expect(() => NativeConfigInputSchema.parse({ ...configInput(), appId: "knowai" })).toThrow();
    expect(() =>
      NativeConfigInputSchema.parse({
        ...configInput(),
        appId: "coginex",
        credentialKind: "mcp_oauth",
        endpoint: "https://mcp.example.test",
        clientSecret: "secret",
      }),
    ).toThrow();
    expect(() =>
      NativeConfigInputSchema.parse({ ...configInput(), credential: "account-token" }),
    ).toThrow();
  });

  it("does not accept a full Calendar administration scope or vendor scope substitution", async () => {
    const { db } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("test-key"),
      "https://api.example.test",
    );
    await expect(
      service.save(
        { ...configInput(), scopes: ["openid", "https://www.googleapis.com/auth/calendar"] },
        context,
        true,
      ),
    ).rejects.toThrow("Unsupported Calendar scope");
    await expect(service.save({ ...configInput(), scopes: [] }, context, true)).rejects.toThrow(
      "openid",
    );
  });
});

it.each([
  {
    appId: "telegram-bot",
    actor: "bot",
    credentialKind: "bot_token",
    ownership: "official",
    targetIds: ["-100000000001"],
  },
  {
    appId: "discord",
    actor: "bot",
    credentialKind: "bot_token",
    ownership: "official",
    tenantId: "123456789",
    targetIds: ["987654321"],
  },
  {
    appId: "dingtalk",
    actor: "app",
    credentialKind: "machine_key",
    ownership: "byo",
    clientId: "synthetic-app",
    tenantId: "synthetic-corp",
  },
  {
    appId: "wecom",
    actor: "app",
    credentialKind: "machine_key",
    ownership: "byo",
    tenantId: "synthetic-corp",
    agentId: "100001",
  },
  {
    appId: "feishu-lark",
    actor: "app",
    credentialKind: "machine_key",
    ownership: "byo",
    clientId: "synthetic-app",
    region: "feishu",
  },
])(
  "keeps $appId owner credentials and connection candidates in the configured Space",
  async (fields) => {
    const { db } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("space-bound-fixture-key"),
      "https://api.example.test",
    );
    const input = NativeConfigInputSchema.parse({
      ...fields,
      label: "Synthetic private application",
      clientSecret: "write-only-fixture-secret",
    });
    const saved = await service.save(input, context, true);
    expect(saved.configured).toBe(true);
    expect(saved.usesConfiguredCredential).toBe(true);
    expect(await service.statuses()).toEqual([]);
    expect(await service.statuses("space-elsewhere")).toEqual([]);
    expect(await service.statuses(context.spaceId)).toEqual([saved]);
    await expect(service.configuration(saved.id, true, "space-elsewhere")).rejects.toThrow();
    const editable = await service.configuration(saved.id, true, context.spaceId);
    expect(editable.hasClientSecret).toBe(true);
    expect(JSON.stringify(editable)).not.toContain("write-only-fixture-secret");
    expect(JSON.stringify(editable)).not.toContain("credentialOwner");
    expect(JSON.stringify(editable)).not.toContain("boundSpaceId");
    await expect(
      service.save(
        { ...input, id: saved.id, expectedRevision: saved.revision },
        { ...context, spaceId: "space-elsewhere" },
        true,
      ),
    ).rejects.toThrow();
  },
);

it("keeps enterprise callback credentials write-only in an encrypted owner envelope", async () => {
  const { db } = database();
  const service = new NativeConfigStore(
    db,
    new EncryptedSecretStore("enterprise-fixture-key"),
    "https://api.example.test",
  );
  const saved = await service.save(
    NativeConfigInputSchema.parse({
      appId: "wecom",
      actor: "app",
      credentialKind: "oauth",
      ownership: "official",
      label: "Synthetic suite",
      clientId: "synthetic-suite",
      agentId: "100001",
      clientSecret: "suite-fixture-secret",
      verificationToken: "callback-fixture-token",
      encryptionKey: "callback-fixture-key",
    }),
    context,
    true,
  );
  const editable = await service.configuration(saved.id, true, context.spaceId);
  expect(editable).toMatchObject({
    hasClientSecret: true,
    hasVerificationToken: true,
    hasEncryptionKey: true,
  });
  for (const value of ["suite-fixture-secret", "callback-fixture-token", "callback-fixture-key"])
    expect(JSON.stringify(editable)).not.toContain(value);
  expect(
    JSON.parse(await service.credential(await service.forEnterpriseCallback(saved.id))),
  ).toEqual({
    version: 1,
    clientSecret: "suite-fixture-secret",
    verificationToken: "callback-fixture-token",
    encryptionKey: "callback-fixture-key",
  });
});

it.each([
  ["wecom", false],
  ["wecom", true],
  ["feishu-lark", false],
  ["feishu-lark", true],
] as const)(
  "preserves a concurrently rotated %s ticket through an owner label save (existing=%s)",
  async (platform, existing) => {
    const { db, nativeAppConfig } = database();
    const service = new NativeConfigStore(
      db,
      new EncryptedSecretStore("concurrent-ticket-fixture-key"),
      "https://api.example.test",
    );
    const input = NativeConfigInputSchema.parse({
      appId: platform,
      actor: platform === "wecom" ? "app" : "user",
      credentialKind: "oauth",
      ownership: "official",
      label: "Original synthetic label",
      clientId: "synthetic-application",
      clientSecret: "synthetic-secret",
      verificationToken: "synthetic-verification",
      encryptionKey: "synthetic-encryption",
      ...(platform === "wecom" ? { agentId: "100001" } : { region: "feishu" }),
    });
    const saved = await service.save(input, context, true);
    const ticket = { platform, value: "synthetic-current-ticket", issuedAt: 200 };
    if (existing)
      await service.recordEnterpriseTicket(
        saved.id,
        "synthetic-application",
        saved.revision,
        { ...ticket, value: "synthetic-previous-ticket", issuedAt: 100 },
        context.signal,
      );
    const before = structuredClone(await service.forEnterpriseCallback(saved.id));
    nativeAppConfig.findUnique.mockImplementationOnce(async () => {
      await service.recordEnterpriseTicket(
        saved.id,
        "synthetic-application",
        saved.revision,
        ticket,
        context.signal,
      );
      return before;
    });
    const {
      clientSecret: _secret,
      verificationToken: _verify,
      encryptionKey: _key,
      ...editable
    } = input;
    const result = await service.save(
      {
        ...editable,
        id: saved.id,
        expectedRevision: saved.revision,
        label: "Changed synthetic label",
      },
      context,
      true,
    );
    const row = await service.forEnterpriseCallback(saved.id);
    const material = JSON.parse(await service.credential(row));
    expect(material[platform === "wecom" ? "suiteTicket" : "appTicket"]).toEqual({
      value: ticket.value,
      issuedAt: 200,
    });
    expect(row.revision).toBe(saved.revision);
    expect(result.configured).toBe(true);
    const update = nativeAppConfig.updateMany.mock.calls.at(-1)?.[0].data;
    expect(update).not.toHaveProperty("ciphertext");
    expect(update).not.toHaveProperty("secretRecordId");
  },
);
