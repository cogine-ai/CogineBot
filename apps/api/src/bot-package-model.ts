import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { LOCAL_PROVIDER_ID, listPiCatalog, validateModelAuthAvailability } from "@rakazo/adapters";
import type { Actor, AgentBackupModel } from "@rakazo/contracts";
import { AgentBackupModelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { lockSpaceModelSelection, Prisma } from "@rakazo/db";
import * as z from "zod";
import { validateModelBinding } from "./model-bindings.js";

export const BackupModelBindingSchema = AgentBackupModelSchema.extend({
  credentialId: z.string().min(1),
  revision: z.int().positive(),
});
export type BackupModelBinding = z.infer<typeof BackupModelBindingSchema>;

type ModelReader = Pick<
  PrismaClient,
  "spaceModelPreference" | "userModelCredential" | "secret" | "$queryRaw"
>;
type ModelSecrets = Pick<SecretStore, "load">;

export async function findBackupModelBinding(
  prisma: ModelReader,
  secrets: ModelSecrets,
  actor: Actor,
  model: AgentBackupModel,
) {
  const exact = await prisma.spaceModelPreference.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId: model.modelId,
      credential: { provider: model.provider },
    },
    select: { credential: { select: { id: true, connectionRevision: true } } },
    take: 2,
  });
  if (exact.length !== 1) return null;
  const credential = exact[0]!.credential;
  const binding = {
    ...model,
    credentialId: credential.id,
    revision: credential.connectionRevision,
  };
  return (await validateBackupModelBinding(prisma, secrets, actor, binding)) ? binding : null;
}

export async function validateBackupModelBinding(
  prisma: ModelReader,
  secrets: ModelSecrets,
  actor: Actor,
  binding: BackupModelBinding,
  lock = false,
) {
  if (
    !listPiCatalog().some(
      (entry) =>
        entry.provider === binding.provider &&
        entry.id === binding.modelId &&
        !entry.placeholder &&
        entry.provider !== LOCAL_PROVIDER_ID,
    )
  )
    return null;
  const model = {
    modelProvider: binding.provider,
    modelId: binding.modelId,
    modelCredentialId: binding.credentialId,
  };
  if (lock) {
    await lockSpaceModelSelection(prisma, actor, "read");
    const rows = await prisma.$queryRaw<
      Array<{ id: string; connectionRevision: number }>
    >(Prisma.sql`
      SELECT c.id, c."connectionRevision" FROM space_model_preferences p
      JOIN user_model_credentials c ON c.id = p."credentialId" AND c."userId" = p."userId"
      WHERE p."spaceId" = ${actor.spaceId} AND p."userId" = ${actor.userId}
        AND p."modelId" = ${binding.modelId} AND c.provider = ${binding.provider}
      LIMIT 2
      FOR SHARE OF p, c
    `);
    if (
      rows.length !== 1 ||
      rows[0]?.id !== binding.credentialId ||
      rows[0].connectionRevision !== binding.revision
    )
      return null;
  }
  try {
    const checked = await validateModelBinding(prisma, secrets, actor, {
      ...model,
      expectedRevision: binding.revision,
    });
    if (
      !checked ||
      checked.secret.kind === "openai_compatible" ||
      validateModelAuthAvailability(binding.provider, binding.modelId, checked.plaintext)
    )
      return null;
    return model;
  } catch (error) {
    if (error instanceof ORPCError && ["NOT_FOUND", "BAD_REQUEST", "CONFLICT"].includes(error.code))
      return null;
    throw error;
  }
}
