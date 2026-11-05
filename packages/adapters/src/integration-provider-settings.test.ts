import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
function fixture() {
  const rows = new Map<string, { id: string; ciphertext: string }>();
  let ownerUserId: string | null = context.userId;
  const transaction = vi.fn(
    async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      work(prisma as unknown as Prisma.TransactionClient),
  );
  const unreferenced = () => ({ count: vi.fn(async () => 0) });
  const prisma = {
    $transaction: transaction,
    $queryRaw: vi.fn(async (query: Prisma.Sql) =>
      query.text.includes("deployment_settings") ? [{ ownerUserId }] : [{ referenced: false }],
    ),
    secret: unreferenced(),
    botSecret: unreferenced(),
    nativeAppConfig: unreferenced(),
    deploymentIdentity: unreferenced(),
    deploymentTransferSession: unreferenced(),
    deploymentTransferItem: unreferenced(),
    integrationProviderConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
        rows.set(create.id, create);
        return create;
      }),
      count: vi.fn(
        async ({ where }: { where: { ciphertext: string } }) =>
          [...rows.values()].filter((row) => row.ciphertext === where.ciphertext).length,
      ),
    },
  };
  const adapter = {
    listConnectedExternalIds: vi.fn(async () => []),
    catalog: vi.fn(async () => []),
    discoverTools: vi.fn(async () => []),
  } as unknown as ManagedConnectorProvider;
  const factory = vi.fn(() => adapter);
  const secrets = new EncryptedSecretStore("test-encryption-key");
  const settings = new IntegrationProviderSettings(
    prisma as unknown as PrismaClient,
    secrets,
    "test-identity",
    {},
    factory,
  );
  return {
    rows,
    prisma,
    adapter,
    factory,
    secrets,
    settings,
    setOwner: (userId: string | null) => {
      ownerUserId = userId;
    },
  };
}
describe("integration provider settings", () => {
  it("encrypts credentials and shares updates with a separately created worker resolver", async () => {
    const f = fixture();
    const worker = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {},
      f.factory,
    );
    expect(await worker.resolve("composio")).toBeUndefined();
    await f.settings.save({ provider: "composio", apiKey: "fake-first-key" }, context);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("fake-first-key");
    expect(await worker.resolve("composio")).toBe(f.adapter);
    expect(f.factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-first-key" });
    await f.settings.save({ provider: "composio", apiKey: "fake-replacement-key" }, context);
    await worker.resolve("composio");
    expect(f.factory).toHaveBeenLastCalledWith({
      provider: "composio",
      apiKey: "fake-replacement-key",
    });
  });
  it("preserves working settings and hides provider error details on failed verification", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
    const before = f.rows.get("composio");
    vi.mocked(f.adapter.listConnectedExternalIds).mockRejectedValueOnce(
      new Error("fake-secret-in-provider-response"),
    );
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-bad-key" }, context),
    ).rejects.toThrow("Could not verify these credentials");
    expect(f.rows.get("composio")).toBe(before);
  });
  it("preserves working credentials when deployment ownership changes during verification", async () => {
    const f = fixture();
    await runAsTenant(context, async () => {
      await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
      const before = await f.settings.prepare("composio");
      const written = vi.spyOn(f.secrets, "put");
      const deleted = vi.spyOn(f.secrets, "delete");
      vi.mocked(f.adapter.listConnectedExternalIds).mockImplementationOnce(async () => {
        expect(currentDbContext()).toEqual({
          kind: "tenant",
          spaceId: context.spaceId,
          userId: context.userId,
        });
        f.setOwner("replacement-owner");
        return [];
      });

      await expect(
        f.settings.save({ provider: "composio", apiKey: "fake-obsolete-owner-key" }, context),
      ).rejects.toThrow("Only the deployment owner can configure integrations");

      expect((await f.settings.prepare("composio")).ref).toBe(before.ref);
      const candidate = await written.mock.results[0]!.value;
      expect(deleted).toHaveBeenCalledExactlyOnceWith(candidate.ciphertext, candidate.id);
      expect(currentDbContext()).toEqual({
        kind: "tenant",
        spaceId: context.spaceId,
        userId: context.userId,
      });
    });
  });
  it("compensates a prepared credential when the deployment owner is removed during secret storage", async () => {
    const f = fixture();
    await runAsTenant(context, async () => {
      await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
      const before = await f.settings.prepare("composio");
      const put = f.secrets.put.bind(f.secrets);
      const written = vi.spyOn(f.secrets, "put").mockImplementationOnce(async (...args) => {
        expect(currentDbContext()).toEqual({
          kind: "tenant",
          spaceId: context.spaceId,
          userId: context.userId,
        });
        const candidate = await put(...args);
        f.setOwner(null);
        return candidate;
      });
      const deleted = vi.spyOn(f.secrets, "delete");

      await expect(
        f.settings.save({ provider: "composio", apiKey: "fake-removed-owner-key" }, context),
      ).rejects.toThrow("Only the deployment owner can configure integrations");

      expect((await f.settings.prepare("composio")).ref).toBe(before.ref);
      const candidate = await written.mock.results[0]!.value;
      expect(deleted).toHaveBeenCalledExactlyOnceWith(candidate.ciphertext, candidate.id);
      expect(currentDbContext()).toEqual({
        kind: "tenant",
        spaceId: context.spaceId,
        userId: context.userId,
      });
    });
  });
  it("returns no tools or catalog for unconfigured providers", async () => {
    const f = fixture();
    for (const provider of f.settings.providers()) {
      expect(await provider.catalog(context)).toEqual([]);
      expect(await provider.discoverTools(context)).toEqual([]);
      await expect(
        provider.begin({ provider: "slack", redirectUrl: "https://example.test" }, context),
      ).rejects.toThrow("Set up an integration provider");
    }
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("warms directories only for configured providers", async () => {
    const f = fixture();
    const warm = vi.fn(async () => undefined);
    const adapter = {
      listConnectedExternalIds: vi.fn(async () => []),
      catalog: vi.fn(async () => []),
      discoverTools: vi.fn(async () => []),
      warmDirectory: warm,
    } as unknown as ManagedConnectorProvider;
    f.factory.mockReturnValue(adapter);
    const fallbackWarm = vi.fn(async () => undefined);
    const settings = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {
        pipedream: {
          warmDirectory: fallbackWarm,
        } as unknown as ManagedConnectorProvider,
      },
      f.factory,
    );
    settings.warmDirectories();
    await vi.waitFor(() => expect(fallbackWarm).toHaveBeenCalledOnce());
    expect(warm).not.toHaveBeenCalled();
    await settings.save({ provider: "composio", apiKey: "fake-warm-key" }, context);
    settings.warmDirectories();
    await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce());
  });
});

describe("integration credentials with Infisical", () => {
  it("reloads external rotation and does not retain credentials expired during a slow save", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({
      ...fake.options,
      cacheTtlMs: 100,
      cacheMaxEntries: 1,
    });
    await store.start();
    let row: { id: string; ciphertext: string } | undefined;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { prisma, rows } = fixture();
    prisma.integrationProviderConfig.upsert.mockImplementation(async ({ create }) => {
      row = create;
      rows.set(create.id, create);
      started();
      await gate;
      return row;
    });
    const adapter = {
      listConnectedExternalIds: vi.fn(async () => []),
    } as unknown as ManagedConnectorProvider;
    const factory = vi.fn(() => adapter);
    const settings = new IntegrationProviderSettings(
      prisma as unknown as PrismaClient,
      store,
      "fake",
      {},
      factory,
    );
    try {
      const pending = settings.save({ provider: "composio", apiKey: "fake-initial" }, context);
      await saving;
      fake.values.set(
        row!.ciphertext.split(":").at(-1)!,
        JSON.stringify({ provider: "composio", apiKey: "fake-rotated" }),
      );
      await vi.advanceTimersByTimeAsync(100);
      release();
      await pending;
      const changed = vi.fn();
      store.onChange(changed);
      await settings.resolve("composio");
      expect(changed).toHaveBeenCalledExactlyOnceWith(row!.ciphertext);
      expect(factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-rotated" });
      changed.mockClear();
      const calls = factory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      await settings.resolve("composio");
      expect(factory).toHaveBeenCalledTimes(calls);
      expect(changed).not.toHaveBeenCalled();
      await store.put("unrelated", context);
      changed.mockClear();
      fake.values.set(
        row!.ciphertext.split(":").at(-1)!,
        JSON.stringify({ provider: "composio", apiKey: "fake-again" }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await settings.resolve("composio");
      expect(factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-again" });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release();
      await store.close();
      vi.useRealTimers();
    }
  });
});
