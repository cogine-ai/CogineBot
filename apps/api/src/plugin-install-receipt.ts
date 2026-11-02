import type { PluginInstallReceipt } from "@rakazo/contracts";
import { PluginInstallReceiptSchema } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

type InstallRow = Prisma.CapabilityInstallGetPayload<{
  include: { agentSkills: true; mcpServers: true };
}>;

/** Only the reviewed public child snapshot survives removal; cleanup refs never leave the server. */
export function pluginInstallReceipt(row: InstallRow): PluginInstallReceipt {
  const config = row.config as Record<string, unknown>;
  const saved = config.installedChildren as
    | Pick<PluginInstallReceipt, "skills" | "mcpServers">
    | undefined;
  return PluginInstallReceiptSchema.parse({
    id: row.id,
    clientNonce: row.clientNonce,
    source: row.source,
    sourceSha: row.version,
    digest: row.digest,
    name: row.name,
    status: row.status,
    revision: row.revision,
    installedAt: row.installedAt?.toISOString() ?? null,
    skills:
      row.status === "installed"
        ? row.agentSkills.map(({ id, name }) => ({ id, name }))
        : (saved?.skills ?? []),
    mcpServers:
      row.status === "installed"
        ? row.mcpServers.map(({ id, name, endpoint, transport }) => ({
            id,
            name,
            endpoint,
            transport,
          }))
        : (saved?.mcpServers ?? []),
  });
}
