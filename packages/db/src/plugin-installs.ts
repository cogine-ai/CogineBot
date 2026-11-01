import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";

/** Tombstoned managed plugins cannot contribute instructions even if a child row survives. */
export const activePluginSkillWhere: Prisma.AgentSkillWhereInput = {
  OR: [
    { installId: null },
    {
      install: {
        is: {
          OR: [{ kind: { not: "plugin" } }, { clientNonce: null }, { status: "installed" }],
        },
      },
    },
  ],
};

export type PluginCredentialCleanupEntry =
  | { id: string; ref: string; pending?: never }
  | { id: string; ref?: never; pending: true };

/** Internal, bounded recovery data. A missing ref is an unknown external write, never success. */
export function readPluginCleanupRefs(value: unknown): PluginCredentialCleanupEntry[] {
  if (!Array.isArray(value) || value.length > 2048) throw new Error("Invalid plugin cleanup state");
  let bytes = 0;
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid plugin cleanup state");
    const { id, ref, pending } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || ids.has(id))
      throw new Error("Invalid plugin cleanup state");
    ids.add(id);
    if (
      pending === true &&
      ref === undefined &&
      Object.keys(item).every((key) => key === "id" || key === "pending")
    )
      return { id, pending: true };
    if (
      pending !== undefined ||
      typeof ref !== "string" ||
      !ref ||
      ref.length > 4_000_000 ||
      Object.keys(item).some((key) => key !== "id" && key !== "ref")
    )
      throw new Error("Invalid plugin cleanup state");
    bytes += Buffer.byteLength(ref);
    if (bytes > 8_000_000) throw new Error("Invalid plugin cleanup state");
    return { id, ref };
  });
}

export class PluginInstallInactiveError extends Error {
  constructor() {
    super("This plugin is no longer installed.");
    this.name = "PluginInstallInactiveError";
  }
}

/** Shared by managed child mutations, final tool admission and uninstall. */
export async function lockPluginInstall(
  tx: Prisma.TransactionClient,
  installId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plugin-install:${installId}`}, 0))::text`;
}

/** Legacy capabilities retain their existing behavior; only nonce-bound plugins are managed. */
export async function assertManagedPluginActive(
  tx: Pick<Prisma.TransactionClient, "capabilityInstall">,
  installId: string,
  actor?: Pick<Actor, "spaceId" | "userId">,
) {
  const install = await tx.capabilityInstall.findFirst({ where: { id: installId } });
  if (!install) throw new PluginInstallInactiveError();
  if (actor && (install.spaceId !== actor.spaceId || install.userId !== actor.userId)) {
    throw new IsolationError();
  }
  if (install.kind === "plugin" && install.clientNonce !== null && install.status !== "installed") {
    throw new PluginInstallInactiveError();
  }
  return install;
}

export async function isPluginSecretReferenced(
  tx: Prisma.TransactionClient,
  id: string,
  ref: string,
) {
  const counts = await Promise.all([
    tx.mcpServer.count({ where: { secretId: id } }),
    tx.connection.count({ where: { secretId: id } }),
    tx.capabilityInstall.count({ where: { secretId: id } }),
    tx.nativeOAuthSession.count({ where: { secretId: id } }),
    tx.nativeOAuthGrant.count({ where: { secretId: id } }),
    tx.spaceMemoryConfig.count({ where: { secretId: id } }),
    tx.agentSecret.count({ where: { secretId: id } }),
    tx.userModelCredential.count({ where: { secretId: id } }),
    tx.userVoiceCredential.count({ where: { secretId: id } }),
    tx.secret.count({ where: { ciphertext: ref, id: { not: id } } }),
    tx.botSecret.count({ where: { ciphertext: ref } }),
    tx.integrationProviderConfig.count({ where: { ciphertext: ref } }),
    tx.nativeAppConfig.count({ where: { ciphertext: ref } }),
  ]);
  if (counts.some((count) => count > 0)) return true;
  const hooks = await tx.$queryRaw<Array<{ referenced: boolean }>>`
    SELECT (EXISTS(SELECT 1 FROM native_notion_hooks WHERE ciphertext=${ref})
      OR EXISTS(SELECT 1 FROM native_slack_hooks WHERE ciphertext=${ref})) AS referenced`;
  return hooks[0]?.referenced === true;
}
