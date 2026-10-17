import type { SecretMigrationRepository, SecretMigrationRow } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

const tables = [
  "secret",
  "botSecret",
  "integrationProviderConfig",
  "nativeAppConfig",
  "nativeNotionHook",
] as const;

export function createSecretMigrationRepository(prisma: PrismaClient): SecretMigrationRepository {
  return {
    async *rows() {
      for (const label of tables) {
        let cursor: string | undefined;
        while (true) {
          const delegate = prisma[label];
          const batch = (await Reflect.apply(delegate.findMany, delegate, [
            {
              orderBy: { id: "asc" },
              take: 100,
              ...(cursor ? { where: { id: { gt: cursor } } } : {}),
            },
          ])) as Array<{
            id: string;
            ciphertext: string | null;
            kind?: string;
            secretRecordId?: string | null;
          }>;
          for (const row of batch) {
            if (!row.ciphertext) continue;
            if (
              (label === "nativeAppConfig" || label === "nativeNotionHook") &&
              !row.secretRecordId
            )
              throw new Error(
                label === "nativeNotionHook"
                  ? "Native webhook material has no SecretStore identity"
                  : "Native application material has no SecretStore identity",
              );
            yield {
              id: row.id,
              label,
              ref: row.ciphertext,
              recordId:
                label === "integrationProviderConfig"
                  ? `integration-provider:${row.id}`
                  : label === "nativeAppConfig" || label === "nativeNotionHook"
                    ? row.secretRecordId!
                    : row.id,
              ephemeral: row.kind?.startsWith("run-secret:"),
            };
          }
          if (batch.length < 100) break;
          cursor = batch.at(-1)?.id;
        }
      }
    },
    async replace(row: SecretMigrationRow, ref: string) {
      const delegate = prisma[row.label as (typeof tables)[number]];
      const result = (await Reflect.apply(delegate.updateMany, delegate, [
        {
          where: {
            id: row.id,
            ciphertext: row.ref,
            ...(row.label === "nativeAppConfig" || row.label === "nativeNotionHook"
              ? { secretRecordId: row.recordId }
              : {}),
          },
          data: { ciphertext: ref },
        },
      ])) as { count: number };
      return result.count === 1;
    },
    async referenced(ref) {
      return Boolean(
        (await prisma.secret.count({ where: { ciphertext: ref } })) ||
          (await prisma.botSecret.count({ where: { ciphertext: ref } })) ||
          (await prisma.integrationProviderConfig.count({
            where: { ciphertext: ref },
          })) ||
          (await prisma.nativeAppConfig.count({
            where: { ciphertext: ref },
          })) ||
          (await prisma.nativeNotionHook.count({ where: { ciphertext: ref } })),
      );
    },
  };
}

/** A webhook row id is also its owner-only setup URL capability. */
export function secretMigrationReportIdentity(
  row: Pick<SecretMigrationRow, "id" | "label">,
): string {
  return `${row.label} ${row.label === "nativeNotionHook" ? "[redacted]" : row.id}`;
}
