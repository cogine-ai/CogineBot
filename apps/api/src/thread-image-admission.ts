import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog, ModelChoice } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  CHATGPT_PLAN_PROVIDER_ID,
  codexLiveModel,
  connectionModelImageInput,
  enabledOpenAiCompatibleModelIds,
  findConnectedModelCredential,
  knownModelImageInput,
  loadStoredModelSecret,
  modelAcceptsImageInput,
  parseModelSecret,
  runModelChoice,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, ImageInputStatus } from "@rakazo/contracts";
import { runAttemptModelSchema, runQuotaWaitStateSchema } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { findDefaultModelCredential, runAsSystem } from "@rakazo/db";

export type ImageAdmissionRun = ModelChoice & {
  id: string;
  status: string;
  trigger: string;
  modelPinned?: boolean;
  leaseFence?: number;
  attemptModel?: unknown;
  quotaWait?: unknown;
  sourceMessage?: { blocks: unknown } | null;
};

export type ImageAdmissionConfiguration = {
  secrets: Pick<SecretStore, "load">;
  deployment: { provider: string; model: string } | null;
  scripted?: boolean;
  codexCatalog?: CodexLiveCatalog;
};

/** Read the same model/connection as execution without refreshing credentials or probing a model. */
export async function resolveThreadImageInput(
  prisma: Prisma.TransactionClient,
  actor: Actor,
  botId: string,
  run?: ImageAdmissionRun,
  configuration?: ImageAdmissionConfiguration,
  lockConnection = false,
) {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: actor.userId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, modelCredentialId: true, thinkingLevel: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  const quota = runQuotaWaitStateSchema.safeParse(run?.quotaWait).data?.target;
  const attempt =
    run?.status === "running" ? runAttemptModelSchema.safeParse(run.attemptModel).data : undefined;
  const activeAttempt = attempt?.leaseFence === run?.leaseFence ? attempt : undefined;
  // An unpinned Run in setup can still carry the last lease's model columns.
  if (
    run?.status === "running" &&
    !run.modelPinned &&
    !activeAttempt &&
    !quota &&
    !configuration?.scripted
  ) {
    return { status: "unknown" as const };
  }
  const override = activeAttempt
    ? {
        modelProvider: activeAttempt.provider,
        modelId: activeAttempt.modelId,
        modelCredentialId: activeAttempt.modelCredentialId,
        thinkingLevel: null,
      }
    : quota
      ? {
          modelProvider: quota.provider,
          modelId: quota.modelId,
          modelCredentialId: quota.modelCredentialId,
          thinkingLevel: null,
        }
      : run
        ? runModelChoice(run, bot)
        : bot;
  const readSelection = async () => {
    const overrideCredential =
      override.modelProvider && override.modelId
        ? await findConnectedModelCredential(
            prisma,
            actor,
            override.modelProvider,
            override.modelId,
            override.modelCredentialId ?? null,
          )
        : null;
    return selectConfiguredModel({
      override,
      overrideCredential,
      defaultCredential: await findDefaultModelCredential(prisma, actor),
      settings: await runAsSystem("read deployment defaults for image admission", () =>
        prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ),
      deployment: configuration?.deployment ?? null,
    });
  };
  let selected = await readSelection();
  if (lockConnection && selected.credential) {
    const { id, provider } = selected.credential;
    const locked = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM user_model_credentials
      WHERE id = ${id} AND "userId" = ${actor.userId} AND provider = ${provider}
      FOR SHARE
    `;
    if (locked.length !== 1) return { status: "unknown" as const };
    // A connection edit also updates the Space preference in the same commit.
    // Resolve it again after the lock so the capability and selected model agree.
    selected = await readSelection();
    if (selected.credential?.id !== id) return { status: "unknown" as const };
  }
  const provider = selected.provider;
  const id = selected.id;
  if (!provider || !id) {
    const status: ImageInputStatus = configuration?.scripted ? "supported" : "unknown";
    return { status };
  }
  let supportsImages =
    configuration?.scripted && provider === "scripted" ? true : knownModelImageInput(provider, id);
  const credential = selected.credential;
  if (provider === "openai-compatible" && !credential && modelAcceptsImageInput(provider, id))
    supportsImages = true;
  if (
    ["openai-compatible", CHATGPT_PLAN_PROVIDER_ID, CHATGPT_OAUTH_PROVIDER].includes(provider) &&
    credential &&
    configuration
  ) {
    let stored: Awaited<ReturnType<typeof loadStoredModelSecret>>;
    try {
      stored = await loadStoredModelSecret(
        prisma,
        configuration.secrets,
        actor.userId,
        credential.secretId,
      );
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError)
        throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
      throw error;
    }
    if (stored.status !== "loaded") return { status: "unknown" as const };
    let secret: ReturnType<typeof parseModelSecret>;
    try {
      secret = parseModelSecret(stored.plaintext);
      if (
        provider === "openai-compatible" &&
        (secret.kind !== "openai_compatible" ||
          !enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(id.trim()))
      )
        return { status: "unknown" as const };
      if (provider !== CHATGPT_OAUTH_PROVIDER) {
        supportsImages = connectionModelImageInput(provider, id, credential, secret);
      }
    } catch {
      return { status: "unknown" as const };
    }
    if (provider === CHATGPT_OAUTH_PROVIDER && configuration.codexCatalog) {
      const live = await codexLiveModel(configuration.codexCatalog, actor.userId, secret, id, {
        waitMs: 0,
      });
      if (live?.supportsImages !== undefined) supportsImages = live.supportsImages;
    }
  }
  const status: ImageInputStatus =
    supportsImages === undefined ? "unknown" : supportsImages ? "supported" : "unsupported";
  return {
    status,
    modelPin:
      !run && credential
        ? {
            modelProvider: provider,
            modelId: id,
            modelCredentialId: credential.id,
            thinkingLevel: selected.thinkingLevel,
          }
        : undefined,
  };
}

export async function threadModelImageInput(
  ...args: Parameters<typeof resolveThreadImageInput>
): Promise<ImageInputStatus> {
  return (await resolveThreadImageInput(...args)).status;
}

export function assertImageInputStatus(status: ImageInputStatus, botId: string): void {
  if (status === "supported") return;
  throw new ORPCError("CONFLICT", {
    message: status === "unknown" ? MODEL_IMAGE_INPUT_UNKNOWN : MODEL_IMAGE_INPUT_ERROR,
    data: { reason: "model_image_input_unsupported", imageInputStatus: status, botId },
  });
}
