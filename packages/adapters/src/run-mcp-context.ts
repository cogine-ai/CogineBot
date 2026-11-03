import type { AdapterContext, ConnectorRoute } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { assertManagedPluginActive, IsolationError, PluginInstallInactiveError } from "@rakazo/db";

const selection = {
  id: true,
  slug: true,
  allowAllTools: true,
  allowedTools: true,
  verbatimResults: true,
  installId: true,
} as const;

async function activePlugin(
  prisma: PrismaClient,
  installId: string | null,
  context: AdapterContext,
): Promise<boolean> {
  if (!installId) return true;
  try {
    await assertManagedPluginActive(prisma, installId, context);
    return true;
  } catch (error) {
    if (error instanceof PluginInstallInactiveError || error instanceof IsolationError)
      return false;
    throw error;
  }
}

/** Retention follows the existing shared-service authorization; it grants no execution access. */
export async function loadRunVerbatimMcpServers(prisma: PrismaClient, context: AdapterContext) {
  if (!context.botId) return { ids: [], slugs: [] };
  const rows = await prisma.mcpServer.findMany({
    where: {
      userId: context.userId,
      spaceId: context.spaceId,
      enabled: true,
      verbatimResults: true,
    },
    select: selection,
  });
  const ids: string[] = [];
  const slugs: string[] = [];
  for (const row of rows) {
    if (
      !row.allowAllTools &&
      !(
        Array.isArray(row.allowedTools) && row.allowedTools.some((name) => typeof name === "string")
      )
    )
      continue;
    if (!(await activePlugin(prisma, row.installId, context))) continue;
    ids.push(row.id);
    slugs.push(row.slug);
  }
  return { ids, slugs };
}

/** Restore only server-owned identity whose actual service and tool are still authorized. */
export async function restoreRunMcpResultRoute(
  prisma: PrismaClient,
  context: AdapterContext,
  route: ConnectorRoute,
): Promise<ConnectorRoute | undefined> {
  if (!context.botId || route.connectorId !== "mcp" || !route.resourceId) return undefined;
  const row = await prisma.mcpServer.findFirst({
    where: {
      id: route.resourceId,
      userId: context.userId,
      spaceId: context.spaceId,
      enabled: true,
    },
    select: selection,
  });
  if (
    !row ||
    (!row.allowAllTools &&
      !(Array.isArray(row.allowedTools) && row.allowedTools.includes(route.toolName)))
  )
    return undefined;
  if (!(await activePlugin(prisma, row.installId, context))) return undefined;
  // This is historical ownership, not a new call bound to the service's current revision.
  return { ...route };
}
