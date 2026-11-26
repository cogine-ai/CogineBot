import { timingSafeEqual } from "node:crypto";
import type { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import {
  isLocalSettingsProcedure,
  LOCAL_SETTINGS_RPC,
  LOCAL_SETTINGS_TOKEN_HEADER,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireMembership, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";

export function validLocalSettingsToken(
  expected: string | undefined,
  supplied: string | undefined,
): boolean {
  return Boolean(
    expected &&
      supplied &&
      /^[a-f0-9]{64}$/.test(expected) &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)),
  );
}

/** Separate, allowlisted RPC surface; ordinary session authentication is unchanged. */
export function mountLocalSettings(
  app: Hono,
  deps: {
    token?: string;
    prisma: PrismaClient;
    rpc: RPCHandler<{
      actor: Actor | null;
      signal?: AbortSignal;
      stillAuthorized?: () => Promise<boolean>;
    }>;
  },
) {
  const readOwner = async () => {
    const owner = await runAsSystem("find the local settings deployment owner", () =>
      deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    );
    return owner?.ownerUserId
      ? requireMembership(deps.prisma, owner.ownerUserId).catch(() => null)
      : null;
  };
  app.use(`${LOCAL_SETTINGS_RPC}/*`, async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(deps.token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER))) {
      return c.json({ error: "Local settings are unavailable" }, 401);
    }
    if (c.req.method !== "POST" || !isLocalSettingsProcedure(new URL(c.req.url).pathname)) {
      return c.json({ error: "Not available in local settings" }, 403);
    }
    const actor = await readOwner();
    if (!actor?.isDeploymentOwner) {
      return c.json(
        { error: "Create the server owner account before configuring local settings" },
        409,
      );
    }
    const { matched, response } = await deps.rpc.handle(c.req.raw, {
      prefix: LOCAL_SETTINGS_RPC,
      context: {
        actor,
        signal: c.req.raw.signal,
        stillAuthorized: async () => {
          const owner = await readOwner();
          return Boolean(
            owner?.isDeploymentOwner &&
              owner.userId === actor.userId &&
              owner.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (!matched) return c.notFound();
    return c.newResponse(response.body, response);
  });
}
