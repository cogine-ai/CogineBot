import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { NativeAppConfig, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { NativeConnectorProvider } from "./provider.js";

const context: AdapterContext = {
  userId: "owner-a",
  spaceId: "space-a",
  operationId: "catalog",
  traceId: "catalog",
  signal: new AbortController().signal,
};
function config(appId: string, extra: Partial<NativeAppConfig> = {}): NativeAppConfig {
  return {
    id: `config-${appId}`,
    appId,
    label: "Synthetic",
    credentialKind: "oauth",
    ownership: "byo",
    enabled: true,
    revision: 1,
    callbackUri: "https://api.example.test/api/connectors/oauth/callback",
    ciphertext: "synthetic-encrypted-client",
    secretRecordId: "synthetic-ref",
    config: {
      clientId: "synthetic-client",
      scopes: ["openid", "email"],
      capabilities: [],
      knowledgeBaseIds: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}
async function catalog(configs: NativeAppConfig[], connected: string[] = []) {
  const fetch = vi.fn(async () => {
    throw new Error("Catalog readiness must not call remote APIs");
  });
  const provider = new NativeConnectorProvider(
    {
      nativeAppConfig: { findMany: async () => configs },
      connection: { findMany: async () => connected.map((provider) => ({ provider })) },
    } as unknown as PrismaClient,
    new EncryptedSecretStore("synthetic-catalog-key"),
    "https://api.example.test",
    { artifacts: {} as ArtifactStore, network: { fetch } },
  );
  vi.spyOn(provider.oauth, "expireSessions").mockResolvedValue(undefined);
  try {
    const rows = await provider.catalog(context);
    expect(fetch).not.toHaveBeenCalled();
    return rows;
  } finally {
    await provider.close();
  }
}
describe("native catalog connection readiness", () => {
  it("keeps all thirteen native apps visible when none has an application configuration", async () => {
    const rows = await catalog([]);
    expect(rows).toHaveLength(13);
    expect(rows.every((row) => row.connectable === false)).toBe(true);
  });
  it("reports Gmail readiness from enabled application configuration", async () => {
    const rows = await catalog([config("gmail")]);
    expect(rows.find((row) => row.slug === "gmail")).toMatchObject({
      connectable: true,
      connected: false,
    });
    expect(rows.find((row) => row.slug === "google-drive")).toMatchObject({ connectable: false });
  });
  it.each([
    { enabled: false },
    { ciphertext: null },
    { secretRecordId: null },
    { config: { scopes: ["openid"], capabilities: [], knowledgeBaseIds: [] } },
  ])("does not claim a disabled or incomplete OAuth source is connectable", async (extra) => {
    expect(
      (await catalog([config("gmail", extra)])).find((row) => row.slug === "gmail")?.connectable,
    ).toBe(false);
  });
  it("preserves connected account state independently of current configuration readiness", async () => {
    expect((await catalog([], ["gmail"])).find((row) => row.slug === "gmail")).toMatchObject({
      connected: true,
      connectable: false,
    });
  });
  it("another ready configuration for the same native app remains available", async () => {
    expect(
      (
        await catalog([
          config("gmail", { enabled: false }),
          config("gmail", { id: "other-config" }),
        ])
      ).find((row) => row.slug === "gmail")?.connectable,
    ).toBe(true);
  });
});
