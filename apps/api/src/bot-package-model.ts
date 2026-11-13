import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  codexLiveListsModel,
  LOCAL_PROVIDER_ID,
  listPiCatalog,
  validateModelAuthAvailability,
} from "@rakazo/adapters";
import type { Actor, AgentBackupModel } from "@rakazo/contracts";
import { AgentBackupModelSchema, canonicalPiProviderId } from "@rakazo/contracts";
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

function matchingProviderIds(provider: string): string[] {
  const canonical = canonicalPiProviderId(provider);
  return canonical === "azure" ? [canonical, "azure-openai-responses"] : [canonical];
}

export async function findBackupModelBinding(
  prisma: ModelReader,
  secrets: ModelSecrets,
  actor: Actor,
  model: AgentBackupModel,
  codexCatalog: CodexLiveCatalog,
) {
  const exact = await prisma.spaceModelPreference.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId: model.modelId,
      credential: { provider: { in: matchingProviderIds(model.provider) } },
    },
    select: { credential: { select: { id: true, provider: true, connectionRevision: true } } },
    take: 2,
  });
  if (exact.length !== 1) return null;
  const credential = exact[0]!.credential;
  const binding = {
    ...model,
    provider: credential.provider,
    credentialId: credential.id,
    revision: credential.connectionRevision,
  };
  return (await validateBackupModelBinding(prisma, secrets, actor, binding, codexCatalog))
    ? binding
    : null;
}

export async function validateBackupModelBinding(
  prisma: ModelReader,
  secrets: ModelSecrets,
  actor: Actor,
  binding: BackupModelBinding,
  codexCatalog: CodexLiveCatalog,
  lock = false,
) {
  const catalogProvider = canonicalPiProviderId(binding.provider);
  if (
    !listPiCatalog().some(
      (entry) =>
        entry.provider === catalogProvider &&
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
        AND p."modelId" = ${binding.modelId}
        AND c.provider IN (${Prisma.join(matchingProviderIds(binding.provider))})
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
    if (!checked || checked.secret.kind === "openai_compatible") return null;
    if (
      validateModelAuthAvailability(catalogProvider, binding.modelId, checked.plaintext) &&
      (catalogProvider !== CHATGPT_OAUTH_PROVIDER ||
        !(await codexLiveListsModel(
          codexCatalog,
          actor.userId,
          checked.secret,
          binding.modelId,
          lock ? { cacheOnly: true } : undefined,
        )))
    )
      return null;
    return model;
  } catch (error) {
    if (error instanceof ORPCError && ["NOT_FOUND", "BAD_REQUEST", "CONFLICT"].includes(error.code))
      return null;
    throw error;
  }
}
