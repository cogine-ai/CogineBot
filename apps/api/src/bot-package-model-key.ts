import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  buildModelConnectPlaintext,
  catalogProviderProbeBaseUrl,
  listPiCatalog,
  probeCatalogProviderModels,
  validateModelAuthAvailability,
} from "@rakazo/adapters";
import type { Actor, AgentBackupModel } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { lockSpaceModelSelection } from "@rakazo/db";

const keyChecks = new Map([
  ["anthropic", { url: "https://api.anthropic.com/v1/models", header: "x-api-key" }],
  ["deepseek", { url: "https://api.deepseek.com/models", header: "Authorization" }],
  [
    "google",
    {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      header: "x-goog-api-key",
    },
  ],
  ["openrouter", { url: "https://openrouter.ai/api/v1/key", header: "Authorization" }],
]);
const catalogChecks = new Set(["openai", "groq"]);

export function supportsBackupModelKey(model: AgentBackupModel) {
  return (
    (keyChecks.has(model.provider) ||
      (catalogChecks.has(model.provider) &&
        catalogProviderProbeBaseUrl(model.provider) !== null)) &&
    listPiCatalog().some(
      (entry) =>
        entry.provider === model.provider &&
        entry.id === model.modelId &&
        !entry.placeholder &&
        entry.auth !== "oauth",
    )
  );
}

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
  if (!supportsBackupModelKey(model)) throw new ORPCError("BAD_REQUEST");
  let plaintext: string;
  try {
    plaintext = buildModelConnectPlaintext({ ...model, apiKey });
    if (validateModelAuthAvailability(model.provider, model.modelId, plaintext))
      throw new Error("Unavailable model");
    const check = keyChecks.get(model.provider);
    if (check) {
      const response = await fetcher(check.url, {
        headers: {
          [check.header]: check.header === "Authorization" ? `Bearer ${apiKey}` : apiKey,
          ...(model.provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      });
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error("Provider did not accept the key");
    } else {
      await probeCatalogProviderModels({ provider: model.provider, apiKey }, fetcher, signal);
    }
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
