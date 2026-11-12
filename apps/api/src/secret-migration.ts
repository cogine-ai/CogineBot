import type { SecretMigrationRepository, SecretMigrationRow } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

const tables = [
  "secret",
  "botSecret",
  "integrationProviderConfig",
  "nativeAppConfig",
  "nativeNotionHook",
  "nativeSlackHook",
  "deploymentIdentity",
  "deploymentTransferSession",
  "messagingInstallation",
] as const;
const separateAadTables: ReadonlySet<string> = new Set([
  "nativeAppConfig",
  "nativeNotionHook",
  "nativeSlackHook",
  "deploymentIdentity",
  "deploymentTransferSession",
]);

export function createSecretMigrationRepository(prisma: PrismaClient): SecretMigrationRepository {
  return {
    async *rows() {
      // Prepared external writes cannot be moved or forgotten while their outcome is unknown.
      if (
        await prisma.deploymentTransferItem.count({
          where: { OR: [{ recoveryRef: { not: null } }, { ciphertext: { not: null } }] },
        })
      )
        throw new Error("Settle pending credential transfers before changing secret storage");
      if (await prisma.messagingCredentialCleanup.count())
        throw new Error("Settle pending Slack credential cleanup before changing secret storage");
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
            credentialId?: string | null;
          }>;
          for (const row of batch) {
            if (!row.ciphertext) continue;
            if (label === "messagingInstallation" && !row.credentialId)
              throw new Error("Slack credential has no SecretStore identity");
            if (separateAadTables.has(label) && !row.secretRecordId)
              throw new Error(
                label === "nativeNotionHook" || label === "nativeSlackHook"
                  ? "Native webhook material has no SecretStore identity"
                  : label === "deploymentIdentity" || label === "deploymentTransferSession"
                    ? "Deployment material has no SecretStore identity"
                    : "Native application material has no SecretStore identity",
              );
            yield {
              id: row.id,
              label,
              ref: row.ciphertext,
              recordId:
                label === "integrationProviderConfig"
                  ? `integration-provider:${row.id}`
                  : label === "messagingInstallation"
                    ? row.credentialId!
                    : separateAadTables.has(label)
                      ? row.secretRecordId!
                      : row.id,
              ephemeral:
                label === "deploymentIdentity" ||
                label === "deploymentTransferSession" ||
                row.kind?.startsWith("run-secret:"),
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
            ...(separateAadTables.has(row.label) ? { secretRecordId: row.recordId } : {}),
            ...(row.label === "messagingInstallation" ? { credentialId: row.recordId } : {}),
          },
          data: {
            ciphertext: ref,
            ...(row.label === "messagingInstallation" ? { revision: { increment: 1 } } : {}),
          },
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
          (await prisma.nativeNotionHook.count({ where: { ciphertext: ref } })) ||
          (await prisma.nativeSlackHook.count({ where: { ciphertext: ref } })) ||
          (await prisma.deploymentIdentity.count({ where: { ciphertext: ref } })) ||
          (await prisma.deploymentTransferSession.count({ where: { ciphertext: ref } })) ||
          (await prisma.messagingInstallation.count({ where: { ciphertext: ref } })) ||
          (await prisma.messagingCredentialCleanup.count({ where: { ref } })) ||
          (await prisma.deploymentTransferItem.count({
            where: { OR: [{ ciphertext: ref }, { recoveryRef: ref }] },
          })),
      );
    },
  };
}

/** A webhook row id is also its owner-only setup URL capability. */
export function secretMigrationReportIdentity(
  row: Pick<SecretMigrationRow, "id" | "label">,
): string {
  return `${row.label} ${["nativeNotionHook", "nativeSlackHook", "deploymentIdentity", "deploymentTransferSession", "messagingInstallation"].includes(row.label) ? "[redacted]" : row.id}`;
}
