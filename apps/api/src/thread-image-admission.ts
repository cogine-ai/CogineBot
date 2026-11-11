import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { CodexLiveCatalog, ModelChoice } from "@rakazo/adapters";
import {
  CHATGPT_OAUTH_PROVIDER,
  CHATGPT_PLAN_PROVIDER_ID,
  codexLiveModel,
  connectionModelImageInput,
  findConnectedModelCredential,
  knownModelImageInput,
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
  const activeAttempt =
    run?.status === "running" && run.modelPinned
      ? runAttemptModelSchema.safeParse(run.attemptModel).data
      : undefined;
  const selectedRun = run?.status === "running" && run.modelProvider && run.modelId;
  const override =
    activeAttempt && activeAttempt.leaseFence === run?.leaseFence
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
  if (!provider || !id) {
    const status: ImageInputStatus = configuration?.scripted ? "supported" : "unknown";
    return { status };
  }
  let supportsImages = knownModelImageInput(provider, id);
  let credential = selected.credential;
  if (lockConnection && credential) {
    const [current] = await prisma.$queryRaw<Array<{ secretId: string; supportsImages: boolean }>>`
      SELECT "secretId", "supportsImages" FROM user_model_credentials
      WHERE id = ${credential.id} AND "userId" = ${actor.userId} AND provider = ${credential.provider}
      FOR SHARE
    `;
    if (!current) return { status: "unknown" as const };
    credential = {
      ...credential,
      secretId: current.secretId,
      supportsImages: current.supportsImages,
    };
  }
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
      if (provider === "openai-compatible" || provider === CHATGPT_PLAN_PROVIDER_ID) {
        supportsImages = connectionModelImageInput(provider, id, credential, secret);
      } else if (provider === CHATGPT_OAUTH_PROVIDER && configuration.codexCatalog) {
        const live = await codexLiveModel(configuration.codexCatalog, actor.userId, secret, id, {
          waitMs: 0,
        });
        if (live?.supportsImages !== undefined) supportsImages = live.supportsImages;
      }
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
