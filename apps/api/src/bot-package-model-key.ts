import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { verifyBackupModelKey } from "@rakazo/adapters";
import type { Actor, AgentBackupModel } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { lockSpaceModelSelection } from "@rakazo/db";

export async function hasBackupModelAccount(
  prisma: Pick<PrismaClient, "userModelCredential">,
  actor: Actor,
  provider: string,
) {
  return Boolean(
    await prisma.userModelCredential.findFirst({
      where: { userId: actor.userId, provider },
      select: { id: true },
    }),
  );
}

export async function prepareBackupModelKey(
  secrets: SecretStore,
  actor: Actor,
  model: AgentBackupModel,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch = globalThis.fetch,
) {
  let plaintext: string;
  try {
    plaintext = await verifyBackupModelKey(model, apiKey, signal, fetcher);
  } catch {
    signal?.throwIfAborted();
    throw new ORPCError("BAD_REQUEST", {
      message: "Could not verify the backup model key. Check it in model settings.",
    });
  }
  signal?.throwIfAborted();
  try {
    return await secrets.put(plaintext, {
      operationId: "backup-model-key",
      traceId: "backup-model-key",
      userId: actor.userId,
      spaceId: actor.spaceId,
      signal: signal ?? new AbortController().signal,
    });
  } catch {
    signal?.throwIfAborted();
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Could not save the model connection." });
  }
}

/** The account existence check and create are in the same serializable transaction. */
export async function createBackupModelKey(
  tx: Prisma.TransactionClient,
  actor: Actor,
  model: AgentBackupModel,
  prepared: { id: string; ciphertext: string },
) {
  await lockSpaceModelSelection(tx, actor, "write");
  if (await hasBackupModelAccount(tx, actor, model.provider)) return null;
  await tx.secret.create({
    data: {
      id: prepared.id,
      ciphertext: prepared.ciphertext,
      userId: actor.userId,
      spaceId: null,
      kind: "model",
    },
  });
  const credential = await tx.userModelCredential.create({
    data: {
      userId: actor.userId,
      provider: model.provider,
      label: model.provider,
      secretId: prepared.id,
    },
  });
  await tx.spaceModelPreference.create({
    data: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      credentialId: credential.id,
      modelId: model.modelId,
      isDefault: false,
    },
  });
  return {
    modelProvider: model.provider,
    modelId: model.modelId,
    modelCredentialId: credential.id,
  };
}
