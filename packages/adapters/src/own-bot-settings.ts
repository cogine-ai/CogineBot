import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { BotSettingsValues, VoiceInfo } from "@rakazo/contracts";
import {
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BotSettingsValuesSchema,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import { containsSecret } from "@rakazo/core";
import type { BotSettingsValuesRow, Prisma, PrismaClient } from "@rakazo/db";
import {
  botSettingsValueSelect,
  findDefaultModelCredential,
  findDefaultVoiceCredential,
  prepareBotSettingsVersion,
} from "@rakazo/db";
import { z } from "zod";
import { modelCredentialDto } from "./model-connect.js";
import {
  compatibleThinkingLevels,
  defaultCatalogModelId,
  findConnectedModelCredential,
  listOwnedModelConnections,
  loadStoredModelSecret,
} from "./model-selection.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import { codexLiveModel } from "./pi-codex-catalog.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER, parseModelSecret } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { createVoiceProvider, isVoiceProviderId, voiceCatalogEntry } from "./voice-factory.js";

export const OWN_BOT_SETTINGS_CHANGED =
  "Settings changed elsewhere. Review the current settings and try again.";
export const OWN_INSTRUCTIONS_BASELINE_UNKNOWN =
  "Start a new chat turn before changing instructions. This run has no saved instructions baseline.";

const settingFields = ["instructions", "model", "thinkingLevel", "voice", "readAloud"] as const;
export const profileFields = [
  "name",
  "title",
  "description",
  "color",
  "artifact_id",
  "use_attached_image",
  "notifyOnFinish",
] as const;
export const ownBotSettingsArgs = z.object({
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
  model: z.string().trim().min(1).max(300).optional(),
  connection: z.string().trim().min(1).max(200).optional(),
  modelQuery: z.string().trim().min(1).max(300).optional(),
  thinkingLevel: z.union([ThinkingLevelSchema, z.literal("default")]).optional(),
  voice: z.string().trim().min(1).max(200).optional(),
  readAloud: z.boolean().optional(),
});

export function hasOwnSettingsWrite(args: Record<string, unknown>) {
  return settingFields.some((field) => args[field] !== undefined);
}

const modelBinding = z.object({
  id: z.string(),
  revision: z.number(),
  label: z.string(),
  usesSpaceDefault: z.boolean(),
  model: z.string(),
});

const voiceBinding = z.object({
  id: z.string(),
  provider: z.string(),
  updatedAt: z.string(),
  voiceId: z.string(),
});

const settingsRequestSchema = z.strictObject({
  kind: z.literal("own-bot-settings"),
  runId: z.string(),
  botId: z.string(),
  botName: z.string(),
  spaceId: z.string(),
  userId: z.string(),
  revision: z.number().int().nonnegative(),
  before: BotSettingsValuesSchema,
  after: BotSettingsValuesSchema,
  modelConnection: modelBinding.optional(),
  previousModelConnection: z.string().optional(),
  voiceConnection: voiceBinding.optional(),
  voiceLabel: z.string().optional(),
});

export type OwnSettingsRequest = z.infer<typeof settingsRequestSchema>;
export const readOwnSettingsRequest = (request: unknown) =>
  settingsRequestSchema.safeParse(request).data;

type Scope = { userId: string; spaceId: string; botId: string; runId: string };
type SettingsDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  codexCatalog?: CodexLiveCatalog;
};
type DefaultModel = { provider?: string | null; id?: string | null; thinkingLevel?: string | null };
type ModelCredential = NonNullable<Awaited<ReturnType<typeof findDefaultModelCredential>>>;

const words = (value: string) => value.toLowerCase().match(/\p{L}+|\d+(?:\.\d+)*/gu) ?? [];
function matchByName<T>(choices: T[], query: string, keys: (choice: T) => string[]) {
  const wanted = query.trim().toLowerCase();
  const exact = choices.filter((choice) =>
    keys(choice).some((key) => key.toLowerCase() === wanted),
  );
  if (exact.length) return exact;
  const asked = words(query);
  return choices.filter((choice) => {
    const have = new Set(keys(choice).flatMap(words));
    return asked.length > 0 && asked.every((word) => have.has(word));
  });
}

async function modelChoices(deps: SettingsDeps, scope: Scope) {
  const connections = await listOwnedModelConnections(
    deps.prisma,
    deps.secretStore,
    scope,
    deps.codexCatalog,
  );
  const catalog = new Map(listPiCatalog().map((row) => [`${row.provider}/${row.id}`, row.label]));
  return connections.flatMap((connection) =>
    connection.modelIds.map((id) => ({
      id,
      provider: connection.provider,
      name: catalog.get(`${connection.provider}/${id}`) ?? id,
      connection: {
        id: connection.modelCredentialId,
        label: connection.label,
        connectionRevision: connection.connectionRevision,
      },
    })),
  );
}

type Choice = Awaited<ReturnType<typeof modelChoices>>[number];
const modelKeys = (choice: Choice) => [choice.id, choice.name, `${choice.provider}/${choice.id}`];
const publicModel = (choice: Choice) => ({
  provider: choice.provider,
  model: choice.id,
  name: choice.name,
  connection: choice.connection.label,
});

function limitedModelChoices(choices: Choice[]) {
  const byProvider = new Map<string, Choice[]>();
  for (const choice of choices) {
    const list = byProvider.get(choice.provider) ?? [];
    list.push(choice);
    byProvider.set(choice.provider, list);
  }
  return [...byProvider].map(([provider, entries]) => ({
    provider,
    models: entries.slice(0, 15).map(publicModel),
    more: Math.max(0, entries.length - 15),
  }));
}

async function spaceVoices(deps: SettingsDeps, scope: Scope, context: AdapterContext) {
  const credential = await findDefaultVoiceCredential(deps.prisma, scope);
  if (!credential || !isVoiceProviderId(credential.provider)) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return null;
  const provider = createVoiceProvider(credential.provider);
  const voices = await provider.listVoices(
    await deps.secretStore.load(secret.ciphertext, secret.id),
    { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(8_000)]) },
  );
  return { credential, voices };
}

export function resolveOwnVoice(voices: VoiceInfo[], query: string) {
  return matchByName(voices, query, (voice) => [voice.id, voice.label]);
}

async function effectiveModel(
  deps: SettingsDeps,
  scope: Scope,
  bot: BotSettingsValuesRow,
  fallback: DefaultModel,
) {
  const overridden = Boolean(bot.modelProvider && bot.modelId);
  const credential = overridden
    ? await findConnectedModelCredential(
        deps.prisma,
        scope,
        bot.modelProvider!,
        bot.modelId,
        bot.modelCredentialId,
      )
    : await findDefaultModelCredential(deps.prisma, scope);
  const id = overridden
    ? bot.modelId
    : (credential?.defaultModel ??
      (credential && defaultCatalogModelId(credential.provider)) ??
      fallback.id);
  const inherited = credential?.defaultModel === id ? credential?.thinkingLevel : undefined;
  return {
    provider: overridden ? bot.modelProvider : (credential?.provider ?? fallback.provider),
    id,
    credential,
    source: overridden ? "bot" : credential ? "space" : "system",
    thinkingLevel: bot.thinkingLevel ?? inherited ?? (overridden ? null : fallback.thinkingLevel),
  };
}

async function thinkingSettings(
  deps: SettingsDeps,
  scope: Scope,
  provider: string | null | undefined,
  model: string | null | undefined,
  credential: ModelCredential | null,
) {
  const catalogLevels = listPiCatalog().find(
    (row) => row.provider === provider && row.id === model,
  )?.thinkingLevels;
  if (
    !model ||
    !credential ||
    (provider !== OPENAI_COMPATIBLE_PROVIDER_ID && provider !== CHATGPT_OAUTH_PROVIDER)
  )
    return { allowed: catalogLevels ?? ["off"], connectionDefault: undefined };
  const stored = await loadStoredModelSecret(
    deps.prisma,
    deps.secretStore,
    scope.userId,
    credential.secretId,
  );
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const plaintext = stored.status === "loaded" ? stored.plaintext : undefined;
    return {
      allowed: compatibleThinkingLevels(credential, plaintext, model).allowed,
      connectionDefault: plaintext
        ? modelCredentialDto(credential, plaintext).thinkingLevel
        : undefined,
    };
  }
  const live =
    stored.status === "loaded"
      ? await codexLiveModel(
          deps.codexCatalog,
          scope.userId,
          parseModelSecret(stored.plaintext),
          model,
        )
      : undefined;
  const levels = live?.reasoningEfforts.filter(
    (level) => ThinkingLevelSchema.safeParse(level).success,
  );
  return {
    allowed: levels?.length ? levels : (catalogLevels ?? ["off"]),
    connectionDefault: undefined,
  };
}

export async function readOwnBotSettings(
  deps: SettingsDeps,
  scope: Scope,
  context: AdapterContext,
  fallback: DefaultModel,
  query?: string,
  connection?: string,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null },
    select: {
      ...botSettingsValueSelect,
      title: true,
      description: true,
      color: true,
      notifyOnFinish: true,
    },
  });
  if (!bot) return { error: "This Bot is unavailable." };
  const [active, choices, voice] = await Promise.all([
    effectiveModel(deps, scope, bot, fallback),
    modelChoices(deps, scope),
    query || connection
      ? Promise.resolve(null)
      : spaceVoices(deps, scope, context).catch(() => null),
  ]);
  const selection = connection
    ? choices.filter((choice) => choice.connection.label.toLowerCase() === connection.toLowerCase())
    : choices;
  const id = bot.voiceId ?? voice?.credential.voiceId ?? null;
  const models = limitedModelChoices(query ? matchByName(selection, query, modelKeys) : selection);
  if (query || connection) return { models };
  const thinking = await thinkingSettings(
    deps,
    scope,
    active.provider,
    active.id,
    active.credential,
  );
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    instructions: { value: bot.instructions, source: "bot" },
    avatar: bot.color.startsWith("data:image/") ? "image" : bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    revision: bot.settingsRevision,
    model: {
      provider: active.provider,
      id: active.id,
      connection: active.credential?.label,
      source: active.source,
      available:
        active.source === "system"
          ? Boolean(active.id)
          : choices.some(
              (choice) =>
                choice.id === active.id &&
                choice.provider === active.provider &&
                choice.connection.id === active.credential?.id,
            ),
    },
    thinkingLevel: {
      value: active.thinkingLevel ?? thinking.connectionDefault ?? "default",
      source: bot.thinkingLevel === null ? (active.source === "space" ? "space" : "model") : "bot",
      allowed: thinking.allowed,
    },
    models,
    voice: {
      id,
      label: voice?.voices.find((option) => option.id === id)?.label,
      provider: voice && voiceCatalogEntry(voice.credential.provider)?.name,
      source: bot.voiceId ? "bot" : "space",
      available: Boolean(id && voice?.voices.some((option) => option.id === id)),
      choices: voice?.voices.slice(0, 10).map(({ id, label }) => ({ id, label })) ?? [],
    },
    readAloud: {
      value: bot.autoSpeak,
      source: "bot",
      playback: voice ? "provider_or_device" : "device_if_enabled",
    },
  };
}

export async function prepareOwnBotSettings(
  deps: SettingsDeps,
  scope: Scope,
  context: AdapterContext,
  args: z.infer<typeof ownBotSettingsArgs>,
  baseline: { instructions?: string; revision?: number },
  fallback: DefaultModel,
  secrets: string[],
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: scope.botId, userId: scope.userId, spaceId: scope.spaceId, archivedAt: null },
    select: botSettingsValueSelect,
  });
  if (!bot) return { error: "This Bot is unavailable." };
  if (args.instructions !== undefined) {
    if (baseline.instructions === undefined || baseline.revision === undefined)
      return { error: OWN_INSTRUCTIONS_BASELINE_UNKNOWN };
    if (containsSecret(args.instructions, secrets))
      return { error: "Instructions cannot contain credentials." };
    if (bot.instructions !== baseline.instructions || bot.settingsRevision !== baseline.revision)
      return { error: OWN_BOT_SETTINGS_CHANGED };
  }
  const patch: BotSettingsValues = { instructions: args.instructions, autoSpeak: args.readAloud };
  let modelConnection: OwnSettingsRequest["modelConnection"];
  let previousModelConnection: string | undefined;
  let voiceConnection: OwnSettingsRequest["voiceConnection"];
  let voiceLabel: string | undefined;
  if (args.model !== undefined || args.thinkingLevel !== undefined) {
    let active = await effectiveModel(deps, scope, bot, fallback);
    previousModelConnection = active.credential?.label;
    if (args.model?.toLowerCase() === "default") {
      Object.assign(patch, { modelProvider: null, modelId: null, modelCredentialId: null });
      active = await effectiveModel(
        deps,
        scope,
        { ...bot, modelProvider: null, modelId: null },
        fallback,
      );
    } else if (args.model) {
      const choices = await modelChoices(deps, scope);
      const selection = args.connection
        ? choices.filter(
            (choice) => choice.connection.label.toLowerCase() === args.connection!.toLowerCase(),
          )
        : choices;
      const matches = matchByName(selection, args.model, modelKeys);
      const [choice] = matches;
      if (!choice || matches.length !== 1)
        return {
          error: choice
            ? "Several connected models match. Ask which model and connection to use."
            : "No connected model matches. Check the model connections in Settings.",
          models: limitedModelChoices(matches),
        };
      Object.assign(patch, {
        modelProvider: choice.provider,
        modelId: choice.id,
        modelCredentialId: choice.connection.id,
      });
      active = await effectiveModel(
        deps,
        scope,
        {
          ...bot,
          modelProvider: choice.provider,
          modelId: choice.id,
          modelCredentialId: choice.connection.id,
        },
        fallback,
      );
      if (active.credential?.connectionRevision !== choice.connection.connectionRevision)
        return { error: "The model connection changed. Read the available choices again." };
    }
    if (active.credential && active.id)
      modelConnection = {
        id: active.credential.id,
        revision: active.credential.connectionRevision,
        label: active.credential.label,
        usesSpaceDefault: active.source === "space",
        model: active.id,
      };
    const { allowed } = await thinkingSettings(
      deps,
      scope,
      active.provider,
      active.id,
      active.credential,
    );
    if (args.thinkingLevel && args.thinkingLevel !== "default") {
      if (!allowed.includes(args.thinkingLevel))
        return { error: `This model supports these thinking levels: ${allowed.join(", ")}.` };
      patch.thinkingLevel = args.thinkingLevel;
    } else if (
      args.thinkingLevel === "default" ||
      (args.model !== undefined &&
        bot.thinkingLevel !== null &&
        !allowed.includes(bot.thinkingLevel))
    )
      patch.thinkingLevel = null;
  }
  if (args.voice?.toLowerCase() === "default") patch.voiceId = null;
  if (args.voice && patch.voiceId !== null) {
    const loaded = await spaceVoices(deps, scope, context).catch(() => null);
    if (!loaded) return { error: "Connect an available voice provider in Voice settings first." };
    const { credential, voices } = loaded;
    const matches = resolveOwnVoice(voices, args.voice);
    const [voice] = matches;
    if (!voice || matches.length !== 1)
      return {
        error: voice ? "Several voices match. Ask which voice to use." : "No voice matches.",
        voices: (voice ? matches : voices).slice(0, 10).map(({ id, label }) => ({ id, label })),
      };
    patch.voiceId = voice.id;
    voiceLabel = voice.label;
    voiceConnection = {
      id: credential.id,
      provider: credential.provider,
      updatedAt: credential.updatedAt.toISOString(),
      voiceId: credential.voiceId,
    };
  }

  const version = prepareBotSettingsVersion(bot, patch);
  if (!version) return { unchanged: true as const };
  return {
    request: settingsRequestSchema.parse({
      kind: "own-bot-settings",
      ...scope,
      botName: bot.name,
      revision: bot.settingsRevision,
      before: version.before,
      after: version.after,
      ...(modelConnection && { modelConnection }),
      ...(previousModelConnection && { previousModelConnection }),
      ...(voiceConnection && { voiceConnection }),
      ...(voiceLabel && { voiceLabel }),
    }),
  };
}

export async function ownSettingsBindingsCurrent(
  tx: Prisma.TransactionClient,
  request: OwnSettingsRequest,
) {
  const { modelConnection, voiceConnection } = request;
  if (modelConnection) {
    await tx.$queryRaw`SELECT id FROM user_model_credentials
      WHERE id = ${modelConnection.id} AND "userId" = ${request.userId} FOR SHARE`;
    const model = modelConnection.usesSpaceDefault
      ? await findDefaultModelCredential(tx, request)
      : await tx.userModelCredential.findFirst({
          where: { id: modelConnection.id, userId: request.userId },
        });
    if (
      model?.id !== modelConnection.id ||
      model.connectionRevision !== modelConnection.revision ||
      model.label !== modelConnection.label ||
      (modelConnection.usesSpaceDefault &&
        "defaultModel" in model &&
        model.defaultModel !== modelConnection.model)
    )
      return false;
  }
  if (voiceConnection) {
    await tx.$queryRaw`SELECT id FROM user_voice_credentials
      WHERE id = ${voiceConnection.id} AND "userId" = ${request.userId} FOR SHARE`;
    const voice = await findDefaultVoiceCredential(tx, request);
    if (
      voice?.id !== voiceConnection.id ||
      voice.provider !== voiceConnection.provider ||
      voice.updatedAt.toISOString() !== voiceConnection.updatedAt ||
      voice.voiceId !== voiceConnection.voiceId
    )
      return false;
  }
  return true;
}
