import type { PlatformModelAllowlist } from "@rakazo/core";
import { PlatformModelForbiddenError, platformModelAllowed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Read current authority, never a caller's email or cached session owner flag. */
export async function canUsePlatformModel(
  prisma: Pick<PrismaClient, "user" | "deploymentSettings">,
  allowlist: PlatformModelAllowlist | undefined,
  userId: string,
): Promise<boolean> {
  if (!allowlist || (Array.isArray(allowlist) && allowlist.length === 0)) return true;
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    }),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
  ]);
  if (!user) return false;
  return platformModelAllowed({
    allowlist,
    email: user.email,
    emailVerified: user.emailVerified,
    isOwner: settings?.ownerUserId === userId,
  });
}

/** Bound to the billed subject and rechecked before each provider request. */
export function platformModelAuthorization(
  prisma: Pick<PrismaClient, "user" | "deploymentSettings">,
  allowlist: PlatformModelAllowlist | undefined,
  userId: string,
): (() => Promise<void>) | undefined {
  if (!allowlist || (Array.isArray(allowlist) && allowlist.length === 0)) return undefined;
  return async () => {
    if (!(await canUsePlatformModel(prisma, allowlist, userId)))
      throw new PlatformModelForbiddenError();
  };
}
