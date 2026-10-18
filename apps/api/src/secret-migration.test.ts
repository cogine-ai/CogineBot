import type { AdapterContext } from "@rakazo/adapter-kit";
import { EncryptedSecretStore, InfisicalSecretStore, migrateSecrets } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../packages/adapters/src/secret-store-fake.js";
import {
  createSecretMigrationRepository,
  secretMigrationReportIdentity,
} from "./secret-migration.js";

const hookTables = ["nativeNotionHook", "nativeSlackHook"] as const;
type HookTable = (typeof hookTables)[number];

function fixture() {
  const tables = {
    secret: Array.from({ length: 101 }, (_, i) => ({
      id: `row-${String(i).padStart(3, "0")}`,
      ciphertext: `fake-ref-${i}`,
      kind: i === 0 ? "run-secret:run" : "model",
    })),
    botSecret: [{ id: "bot-row", ciphertext: "fake-bot-ref" }],
    integrationProviderConfig: [{ id: "composio", ciphertext: "fake-config-ref" }],
    nativeNotionHook: [] as Array<{
      id: string;
      ciphertext: string | null;
      secretRecordId: string | null;
    }>,
    nativeSlackHook: [] as Array<{
      id: string;
      ciphertext: string | null;
      secretRecordId: string | null;
    }>,
    nativeAppConfig: [
      {
        id: "native-app",
        ciphertext: "fake-native-ref",
        secretRecordId: "native-app-material",
      },
      { id: "native-without-secret", ciphertext: null, secretRecordId: null },
    ],
  };
  const client = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      {
        findMany: vi.fn(
          async (args: {
            where?: { id: { gt: string } };
            take: number;
            orderBy: { id: string };
          }) => {
            expect(args.orderBy).toEqual({ id: "asc" });
            return rows
              .filter((row) => !args.where || row.id > args.where.id.gt)
              .slice(0, args.take);
          },
        ),
        updateMany: vi.fn(
          async (args: {
            where: { id: string; ciphertext: string; secretRecordId?: string };
            data: { ciphertext: string };
          }) => {
            const row = rows.find(
              (row) =>
                row.id === args.where.id &&
                row.ciphertext === args.where.ciphertext &&
                (args.where.secretRecordId === undefined ||
                  ("secretRecordId" in row && row.secretRecordId === args.where.secretRecordId)),
            );
            if (!row) return { count: 0 };
            row.ciphertext = args.data.ciphertext;
            return { count: 1 };
          },
        ),
        count: vi.fn(
          async (args: { where: { ciphertext: string } }) =>
            rows.filter((row) => row.ciphertext === args.where.ciphertext).length,
        ),
      },
    ]),
  );
  return {
    tables,
    client,
    repository: createSecretMigrationRepository(client as unknown as PrismaClient),
  };
}
describe("migration persistence", () => {
  it("paginates every credential table, binds config ids, and marks short-lived rows", async () => {
    const f = fixture();
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    expect(rows).toHaveLength(104);
    expect(rows[0]).toMatchObject({
      ephemeral: true,
      id: "row-000",
      label: "secret",
    });
    expect(rows.find((row) => row.id === "composio")).toMatchObject({
      id: "composio",
      recordId: "integration-provider:composio",
      ref: "fake-config-ref",
    });
    expect(rows.at(-1)).toMatchObject({
      id: "native-app",
      ref: "fake-native-ref",
      recordId: "native-app-material",
    });
    expect(rows.find((row) => row.id === "bot-row")?.recordId).toBe("bot-row");
  });
  it("compares the original ref so a concurrent update or delete wins", async () => {
    const f = fixture();
    const row = (await f.repository.rows()[Symbol.asyncIterator]().next()).value!;
    expect(await f.repository.replace(row, "fake-next")).toBe(true);
    expect(await f.repository.replace(row, "fake-stale")).toBe(false);
    f.tables.secret.splice(0, 1);
    expect(await f.repository.replace(row, "fake-deleted")).toBe(false);
    expect(await f.repository.referenced("fake-bot-ref")).toBe(true);
    expect(await f.repository.referenced("fake-config-ref")).toBe(true);
    expect(await f.repository.referenced("fake-native-ref")).toBe(true);
    expect(await f.repository.referenced("fake-missing")).toBe(false);
  });
});

const migrationContext: AdapterContext = {
  operationId: "synthetic-hook-migration",
  traceId: "synthetic-trace",
  spaceId: "synthetic-space",
  userId: "synthetic-owner",
  signal: new AbortController().signal,
};
async function hookOnlyFixture(table: HookTable) {
  const f = fixture();
  for (const rows of Object.values(f.tables)) rows.splice(0);
  const encrypted = new EncryptedSecretStore("synthetic-migration-key"),
    fake = infisicalFake(),
    remote = new InfisicalSecretStore(fake.options);
  await remote.start();
  const material = await encrypted.put("synthetic-webhook-token", migrationContext, {
    recordId: "hook-material-aad",
  });
  f.tables[table].push({
    id: "hook-row",
    ciphertext: material.ref,
    secretRecordId: "hook-material-aad",
  });
  return {
    ...f,
    encrypted,
    remote,
    fake,
    close: async () => {
      await encrypted.close();
      await remote.close();
    },
  };
}
describe.each(hookTables)("%s material migration", (table) => {
  it("paginates the new table, skips empty pending material and keeps its independent AAD", async () => {
    const f = fixture();
    f.tables[table].push(
      ...Array.from({ length: 101 }, (_, i) => ({
        id: `hook-${String(i).padStart(3, "0")}`,
        ciphertext: `synthetic-hook-ref-${i}`,
        secretRecordId: `hook-material-${i}`,
      })),
      { id: "hook-z-empty", ciphertext: null, secretRecordId: null },
    );
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    const hooks = rows.filter((row) => row.label === table);
    expect(hooks).toHaveLength(101);
    expect(hooks[100]).toMatchObject({
      id: "hook-100",
      recordId: "hook-material-100",
      ref: "synthetic-hook-ref-100",
    });
    expect(rows).toHaveLength(205);
    expect(f.client[table]!.findMany).toHaveBeenCalledTimes(2);
    expect(await f.repository.referenced("synthetic-hook-ref-100")).toBe(true);
  });
  it("CAS protects both ciphertext and AAD generation for Hook and existing NativeAppConfig material", async () => {
    const f = fixture();
    f.tables[table].push({
      id: "hook-row",
      ciphertext: "synthetic-hook-ref",
      secretRecordId: "hook-aad",
    });
    const rows = [];
    for await (const row of f.repository.rows()) rows.push(row);
    const hook = rows.find((row) => row.label === table)!,
      app = rows.find((row) => row.id === "native-app")!;
    f.tables[table][0]!.secretRecordId = "new-hook-aad";
    expect(await f.repository.replace(hook, "losing-hook-ref")).toBe(false);
    expect(f.tables[table][0]!.ciphertext).toBe("synthetic-hook-ref");
    const native = f.tables.nativeAppConfig.find((row) => row.id === "native-app")!;
    native.secretRecordId = "new-app-aad";
    expect(await f.repository.replace(app, "losing-app-ref")).toBe(false);
    expect(native.ciphertext).toBe("fake-native-ref");
    f.tables[table][0]!.secretRecordId = "hook-aad";
    expect(await f.repository.replace(hook, "new-hook-ref")).toBe(true);
    expect(await f.repository.replace(hook, "stale-hook-ref")).toBe(false);
    expect(await f.repository.referenced("synthetic-hook-ref")).toBe(false);
    expect(await f.repository.referenced("new-hook-ref")).toBe(true);
    f.tables[table].splice(0);
    expect(await f.repository.replace({ ...hook, ref: "new-hook-ref" }, "deleted-hook-ref")).toBe(
      false,
    );
    expect(await f.repository.referenced("new-hook-ref")).toBe(false);
  });
  it.each(["nativeAppConfig", table] as const)(
    "fails closed when nonempty %s material lacks its AAD identity",
    async (label) => {
      const f = fixture();
      if (label === table)
        f.tables[table].push({
          id: "hook-bad",
          ciphertext: "synthetic-ref",
          secretRecordId: null,
        });
      else f.tables.nativeAppConfig[0]!.secretRecordId = null;
      await expect(
        (async () => {
          for await (const _row of f.repository.rows()) {
            /* consume */
          }
        })(),
      ).rejects.toThrow("SecretStore identity");
    },
  );
  it("uses the existing migration both ways with actual AES-GCM/AAD and protects the hook reference", async () => {
    const f = await hookOnlyFixture(table);
    try {
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "forward",
        }),
      ).toMatchObject({ migrated: 1, failed: 0 });
      expect(f.fake.values.size).toBe(1);
      expect(await f.repository.referenced(f.tables[table][0]!.ciphertext!)).toBe(true);
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "forward",
        }),
      ).toMatchObject({ verified: 1, migrated: 0 });
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "reverse",
        }),
      ).toMatchObject({ migrated: 1, failed: 0 });
      expect(f.fake.values.size).toBe(0);
      const ref = f.tables[table][0]!.ciphertext!;
      await expect(f.encrypted.load(ref, { recordId: "hook-material-aad" })).resolves.toBe(
        "synthetic-webhook-token",
      );
      await expect(f.encrypted.load(ref, { recordId: "hook-row" })).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("keeps the committed remote hook material when the persistence acknowledgement is lost", async () => {
    const f = await hookOnlyFixture(table);
    try {
      f.client[table]!.updateMany.mockImplementationOnce(async (args) => {
        f.tables[table][0]!.ciphertext = args.data.ciphertext;
        throw new Error("synthetic lost acknowledgement");
      });
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "forward",
        }),
      ).toMatchObject({ failed: 1, migrated: 0 });
      expect(f.fake.values.size).toBe(1);
      await expect(
        f.remote.load(f.tables[table][0]!.ciphertext!, {
          recordId: "hook-material-aad",
        }),
      ).resolves.toBe("synthetic-webhook-token");
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "forward",
        }),
      ).toMatchObject({ verified: 1, migrated: 0 });
    } finally {
      await f.close();
    }
  });
});

describe("Slack signing material store switching", () => {
  it("reverses a newly created Infisical signing secret and migrates it forward again", async () => {
    const f = await hookOnlyFixture("nativeSlackHook");
    try {
      const material = await f.remote.put("synthetic-webhook-token", migrationContext, {
        recordId: "hook-material-aad",
      });
      f.tables.nativeSlackHook[0]!.ciphertext = material.ref;
      const progress: string[] = [];
      const report = (row: { id: string; label: string }) => {
        progress.push(secretMigrationReportIdentity(row));
      };
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "reverse",
          report,
        }),
      ).toMatchObject({ migrated: 1, failed: 0 });
      expect(progress).toEqual(["nativeSlackHook [redacted]"]);
      const ref = f.tables.nativeSlackHook[0]!.ciphertext!;
      await expect(f.encrypted.load(ref, { recordId: "hook-material-aad" })).resolves.toBe(
        "synthetic-webhook-token",
      );
      await expect(f.encrypted.load(ref, { recordId: "hook-row" })).rejects.toThrow();
      expect(f.fake.values.size).toBe(0);
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "forward",
        }),
      ).toMatchObject({ migrated: 1, failed: 0 });
      await expect(
        f.remote.load(f.tables.nativeSlackHook[0]!.ciphertext!, {
          recordId: "hook-material-aad",
        }),
      ).resolves.toBe("synthetic-webhook-token");
    } finally {
      await f.close();
    }
  });

  it("keeps a shared source ref until the Slack hook has also switched stores", async () => {
    const f = await hookOnlyFixture("nativeSlackHook");
    try {
      const material = await f.remote.put("synthetic-webhook-token", migrationContext, {
        recordId: "hook-material-aad",
      });
      f.tables.nativeSlackHook[0]!.ciphertext = material.ref;
      f.tables.secret.push({
        id: "hook-material-aad",
        ciphertext: material.ref,
        kind: "model",
      });
      f.client.nativeSlackHook!.updateMany.mockImplementationOnce(async (args) => {
        // The ordinary secret migrated first; its cleanup must see the remaining hook ref.
        await expect(f.remote.load(material.ref, { recordId: "hook-material-aad" })).resolves.toBe(
          "synthetic-webhook-token",
        );
        expect(args.where).toEqual({
          id: "hook-row",
          ciphertext: material.ref,
          secretRecordId: "hook-material-aad",
        });
        f.tables.nativeSlackHook[0]!.ciphertext = args.data.ciphertext;
        return { count: 1 };
      });
      expect(
        await migrateSecrets(f.repository, f.encrypted, f.remote, migrationContext, {
          direction: "reverse",
        }),
      ).toMatchObject({ migrated: 2, failed: 0 });
      expect(f.client.nativeSlackHook!.updateMany).toHaveBeenCalledTimes(1);
      expect(f.fake.values.size).toBe(0);
      for (const ref of [
        f.tables.secret[0]!.ciphertext,
        f.tables.nativeSlackHook[0]!.ciphertext!,
      ]) {
        await expect(f.encrypted.load(ref, { recordId: "hook-material-aad" })).resolves.toBe(
          "synthetic-webhook-token",
        );
      }
    } finally {
      await f.close();
    }
  });
});

it.each(hookTables)("keeps %s setup capabilities out of CLI progress", (label) => {
  const capability = "synthetic-private-callback-capability";
  expect(
    secretMigrationReportIdentity({
      label,
      id: capability,
    }),
  ).toBe(`${label} [redacted]`);
  expect(
    secretMigrationReportIdentity({
      label,
      id: capability,
    }),
  ).not.toContain(capability);
  expect(
    secretMigrationReportIdentity({
      label: "nativeAppConfig",
      id: "native-app",
    }),
  ).toBe("nativeAppConfig native-app");
  expect(secretMigrationReportIdentity({ label: "secret", id: "ordinary-row" })).toBe(
    "secret ordinary-row",
  );
});
