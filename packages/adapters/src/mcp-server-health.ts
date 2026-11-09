import type { McpServerHealth } from "@rakazo/contracts";
import { MCP_OAUTH_CLIENT_REQUIRED, McpServerHealthSchema } from "@rakazo/contracts";
import type { McpServer, Prisma, PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizeConnectorError } from "./connector-safety.js";

const REWRITE_MS = 60_000;
const REGISTRATION_UNSUPPORTED =
  "Incompatible auth server: does not support dynamic client registration";
const REGISTRATION_REQUIRED_MESSAGE = "This MCP server requires a pre-registered OAuth client.";

export class McpOAuthClientRequiredError extends Error {
  constructor(message = REGISTRATION_REQUIRED_MESSAGE) {
    super(message);
    this.name = "McpOAuthClientRequiredError";
  }
}

export type McpHealthUpdate = Omit<McpServerHealth, "checkedAt">;

export function needsMcpOAuthClient(error: unknown): boolean {
  for (let depth = 0; depth < 6 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof McpOAuthClientRequiredError || error.message === REGISTRATION_UNSUPPORTED)
      return true;
  }
  return false;
}

export function mcpHealthError(error: unknown, secrets: string[] = []): McpHealthUpdate {
  const code = needsMcpOAuthClient(error) ? MCP_OAUTH_CLIENT_REQUIRED : null;
  return {
    status: "error",
    message: code ? REGISTRATION_REQUIRED_MESSAGE : sanitizeConnectorError(error, secrets),
    code,
    toolCount: null,
  };
}

type HealthServer = Pick<McpServer, "id" | "spaceId" | "userId" | "revision"> &
  Partial<Pick<McpServer, "installId">>;

/** Reject old configurations and observations older than the recorded status.
 * Same-state checks inside the refresh window are deliberately not persisted. */
export async function recordMcpServerHealth(
  prisma: PrismaClient,
  server: HealthServer,
  update: McpHealthUpdate,
  checkedAt: Date,
  force = false,
): Promise<void> {
  const staleRevision: Prisma.McpServerWhereInput[] = [
    { healthRevision: null },
    { healthRevision: { not: server.revision } },
    { healthCheckedAt: null },
  ];
  try {
    await prisma.mcpServer.updateMany({
      where: {
        id: server.id,
        spaceId: server.spaceId,
        userId: server.userId,
        revision: server.revision,
        enabled: true,
        ...(server.installId
          ? {
              install: {
                is: {
                  OR: [
                    { kind: { not: "plugin" } },
                    { clientNonce: null },
                    { status: update.status === "installing" ? "installing" : "installed" },
                  ],
                },
              },
            }
          : {}),
        AND: [
          { OR: [...staleRevision, { healthCheckedAt: { lt: checkedAt } }] },
          ...(force
            ? []
            : [
                {
                  OR: [
                    ...staleRevision,
                    { healthStatus: { not: update.status } },
                    { healthCheckedAt: { lte: new Date(checkedAt.getTime() - REWRITE_MS) } },
                  ],
                },
              ]),
        ],
      },
      data: {
        healthRevision: server.revision,
        healthStatus: update.status,
        healthMessage: update.message,
        healthCode: update.code,
        healthToolCount: update.toolCount,
        healthCheckedAt: checkedAt,
      },
    });
  } catch {
    getLogger().warn("MCP server health could not be recorded");
  }
}

type HealthFields = Partial<
  Pick<
    McpServer,
    | "healthRevision"
    | "healthStatus"
    | "healthMessage"
    | "healthCode"
    | "healthToolCount"
    | "healthCheckedAt"
  >
> & { revision: number };

export function mcpServerHealthDto(row: HealthFields): McpServerHealth {
  if (row.healthRevision === row.revision) {
    const parsed = McpServerHealthSchema.safeParse({
      status: row.healthStatus,
      message: row.healthMessage ?? null,
      code: row.healthCode ?? null,
      toolCount: row.healthToolCount ?? null,
      checkedAt: row.healthCheckedAt?.toISOString() ?? null,
    });
    if (parsed.success) return parsed.data;
  }
  return { status: "unknown", message: null, code: null, toolCount: null, checkedAt: null };
}
