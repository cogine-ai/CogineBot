import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  codexLiveModel,
  connectionModelSettings,
  liveThinkingLevels,
  loadStoredModelSecret,
  parseModelSecret,
  runtimeThinkingLevels,
  validateModelAuthAvailability,
} from "@rakazo/adapters";
import type { Actor, DefaultModelChoice } from "@rakazo/contracts";
import type { findDefaultModelCredential, PreparedThinkingModel, PrismaClient } from "@rakazo/db";
import { findEffectiveModelDefault, thinkingModelBinding } from "@rakazo/db";

export async function prepareThinkingModel(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
  catalog?: CodexLiveCatalog,
): Promise<PreparedThinkingModel | null> {
  const selected = await findEffectiveModelDefault(prisma, actor);
  const binding = thinkingModelBinding(selected);
  const credential = selected.credential;
  if (!binding || !credential) return null;
  const context = await readThinkingCapabilities(
    prisma,
    secrets,
    actor,
    binding.model,
    credential,
    catalog,
  );
  return context ? { ...context, binding, secretId: credential.secretId } : null;
}

export async function readThinkingCapabilities(
  prisma: PrismaClient,
  secrets: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId">,
  { provider, modelId }: DefaultModelChoice,
  credential: NonNullable<Awaited<ReturnType<typeof findDefaultModelCredential>>>,
  catalog?: CodexLiveCatalog,
) {
  const stored = await loadStoredModelSecret(prisma, secrets, actor.userId, credential.secretId);
  if (stored.status !== "loaded") return null;
  let secret: ReturnType<typeof parseModelSecret>;
  let rejected: string | undefined;
  try {
    secret = parseModelSecret(stored.plaintext);
    rejected = validateModelAuthAvailability(provider, modelId, stored.plaintext);
  } catch {
    return null;
  }
  const live =
    provider === CHATGPT_OAUTH_PROVIDER
      ? await codexLiveModel(catalog, actor.userId, secret, modelId, {
          waitMs: 0,
          connection: credential,
        })
      : undefined;
  if (rejected && !live) return null;
  const settings = connectionModelSettings(secret, provider, modelId, credential);
  return {
    ciphertext: stored.ciphertext,
    connectionLevel: secret.kind === "openai_compatible" ? (secret.thinkingLevel ?? null) : null,
    levels:
      (live && liveThinkingLevels(live)) ??
      runtimeThinkingLevels({
        provider,
        id: modelId,
        modelCredentialId: credential.id,
        reasoning: settings.reasoning,
        contextWindow: settings.contextWindow,
        ...(secret.kind === "openai_compatible"
          ? { baseUrl: secret.baseUrl, apiProtocol: secret.apiProtocol }
          : {}),
        ...(secret.kind === "oauth" ? { oauth: { credential: secret.credential } } : {}),
      }),
  };
}
