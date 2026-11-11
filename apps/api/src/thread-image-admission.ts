import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog, ModelChoice } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  CHATGPT_PLAN_PROVIDER_ID,
  codexLiveModel,
  findConnectedModelCredential,
  knownModelImageInput,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  parseModelSecret,
  readChatGPTPlanModels,
  runModelChoice,
  selectConfiguredModel,
} from "@rakazo/adapters";
import type { Actor, ImageInputStatus } from "@rakazo/contracts";
import { runQuotaWaitStateSchema } from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR, MODEL_IMAGE_INPUT_UNKNOWN } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { findDefaultModelCredential, runAsSystem } from "@rakazo/db";

export type ImageAdmissionRun = ModelChoice & {
  id: string;
  status: string;
  trigger: string;
  modelPinned?: boolean;
  quotaWait?: unknown;
};

export type ImageAdmissionConfiguration = {
  secrets: Pick<SecretStore, "load">;
  deployment: { provider: string; model: string } | null;
  scripted?: boolean;
  codexCatalog?: CodexLiveCatalog;
};

/** Read the same model/connection as execution without refreshing credentials or probing a model. */
export async function threadModelImageInput(
  prisma: Prisma.TransactionClient,
  actor: Actor,
  botId: string,
  run?: ImageAdmissionRun,
  configuration?: ImageAdmissionConfiguration,
): Promise<ImageInputStatus> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: actor.userId, spaceId: actor.spaceId },
    select: { modelProvider: true, modelId: true, modelCredentialId: true, thinkingLevel: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND");
  const quota =
    run?.status === "waiting_limit"
      ? runQuotaWaitStateSchema.safeParse(run.quotaWait).data?.target
      : undefined;
  const selectedRun = run?.status === "running" && run.modelProvider && run.modelId;
  const override = quota
    ? {
        modelProvider: quota.provider,
        modelId: quota.modelId,
        modelCredentialId: quota.modelCredentialId,
        thinkingLevel: null,
      }
    : selectedRun
      ? run
      : run
        ? runModelChoice(run, bot)
        : bot;
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
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    defaultCredential: await findDefaultModelCredential(prisma, actor),
    settings: await runAsSystem("read deployment defaults for image admission", () =>
      prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    ),
    deployment: configuration?.deployment ?? null,
  });
  const provider = selected.provider;
  const id = selected.id;
  if (!provider || !id) return configuration?.scripted ? "supported" : "unknown";
  let supportsImages = knownModelImageInput(provider, id);
  const credential = selected.credential;
  if (provider === "openai-compatible" && !credential && modelAcceptsImageInput(provider, id))
    supportsImages = true;
  if (
    ["openai-compatible", CHATGPT_PLAN_PROVIDER_ID, CHATGPT_OAUTH_PROVIDER].includes(provider) &&
    credential &&
    configuration
  ) {
    const row = await prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (row) {
      const secret = parseModelSecret(await configuration.secrets.load(row.ciphertext, row.id));
      if (provider === "openai-compatible" && secret.kind === "openai_compatible") {
        const legacy = await prisma.userModelCredential.findFirst({
          where: { id: credential.id, userId: actor.userId },
          select: { supportsImages: true },
        });
        supportsImages =
          modelIdSupportsImages(secret.visionModelIds, id) ||
          (secret.visionModelIds === undefined &&
            credential.defaultModel?.trim() === id.trim() &&
            legacy?.supportsImages === true) ||
          undefined;
      } else if (provider === CHATGPT_PLAN_PROVIDER_ID && secret.kind === "oauth") {
        const model = readChatGPTPlanModels(secret.credential).find((model) => model.id === id);
        supportsImages = model ? model.input?.includes("image") === true : undefined;
      } else if (provider === CHATGPT_OAUTH_PROVIDER && configuration.codexCatalog) {
        const live = await codexLiveModel(configuration.codexCatalog, actor.userId, secret, id, {
          waitMs: 0,
        });
        if (live?.supportsImages !== undefined) supportsImages = live.supportsImages;
      }
    }
  }
  return supportsImages === undefined ? "unknown" : supportsImages ? "supported" : "unsupported";
}

export function assertImageInputStatus(status: ImageInputStatus): void {
  if (status === "supported") return;
  throw new ORPCError("CONFLICT", {
    message: status === "unknown" ? MODEL_IMAGE_INPUT_UNKNOWN : MODEL_IMAGE_INPUT_ERROR,
    data: { reason: "model_image_input_unsupported", imageInputStatus: status },
  });
}
