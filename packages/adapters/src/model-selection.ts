import type { AgentRunRequest, SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { usableModelId } from "@rakazo/contracts";
import {
  chooseModelCredential,
  findBoundModelCredential,
  type findDefaultModelCredential,
  findModelCredential,
  type PrismaClient,
} from "@rakazo/db";
import { readChatGPTPlanCredential } from "./chatgpt-plan-auth.js";
import { CHATGPT_PLAN_PROVIDER_ID, readChatGPTPlanModels } from "./chatgpt-plan-provider.js";
import { modelCredentialDto } from "./model-connect.js";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKind,
  modelCredentialAuthKindFromPlaintext,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "./pi-catalog-availability.js";
import type { CodexLiveCatalog, CodexLiveReadOptions } from "./pi-codex-catalog.js";
import { codexLiveListsModel } from "./pi-codex-catalog.js";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import { CHATGPT_OAUTH_PROVIDER, parseModelSecret } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  if (provider === CHATGPT_PLAN_PROVIDER_ID) return false;
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

export function defaultCatalogModelId(
  provider: string,
  credentialPlaintext?: string,
): string | null {
  if (provider === CHATGPT_PLAN_PROVIDER_ID) {
    return credentialPlaintext
      ? (chatGPTModelsFromPlaintext(credentialPlaintext)[0]?.id ?? null)
      : null;
  }
  const authKind = credentialPlaintext
    ? modelCredentialAuthKindFromPlaintext(credentialPlaintext)
    : "disconnected";
  const authByProvider: Partial<Record<string, ModelCredentialAuthKind>> =
    authKind === "disconnected" ? {} : { [provider]: authKind };
  const entry = listAvailablePiCatalog(authByProvider).find((item) => item.provider === provider);
  return usableModelId(entry?.id);
}

export class UnavailableModelForAuthError extends Error {
  constructor(message = UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE) {
    super(message);
    this.name = "UnavailableModelForAuthError";
  }
}

function chatGPTModelsFromPlaintext(plaintext: string) {
  const secret = parseModelSecret(plaintext);
  const credential =
    secret.kind === "oauth" ? readChatGPTPlanCredential(secret.credential) : undefined;
  return credential ? readChatGPTPlanModels(credential) : [];
}

export type SpaceCatalogAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  /** Model-specific kinds. `"disconnected"` blocks the provider fallback. */
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  /**
   * Secret id of the credential governing each provider/model slot, so
   * per-account lookups (like the live Codex catalog) stay keyed to the
   * credential that would actually serve the model.
   */
  secretIdByProvider: Partial<Record<string, string>>;
  secretIdByModel: Partial<Record<string, Partial<Record<string, string>>>>;
};

/**
 * Auth kinds for the credentials `chooseModelCredential` would select in this space.
 * Each catalog model uses the preference that owns that model id, then the provider
 * preference, then the newest account credential. An unreadable selected secret stays
 * disconnected instead of falling through to an older key.
 */
export async function modelCredentialAuthKindsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<SpaceCatalogAuth> {
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId },
      select: {
        id: true,
        provider: true,
        secretId: true,
        updatedAt: true,
        createdAt: true,
      },
    }),
    prisma.spaceModelPreference.findMany({
      where: { userId: scope.userId, spaceId: scope.spaceId },
      select: {
        id: true,
        modelId: true,
        thinkingLevel: true,
        isDefault: true,
        updatedAt: true,
        credential: {
          select: {
            id: true,
            provider: true,
            secretId: true,
            updatedAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);
  const connectedProviders = new Set([
    ...credentials.map((credential) => credential.provider),
    ...preferences.map((preference) => preference.credential.provider),
  ]);
  const selections: Array<{
    provider: string;
    modelId: string;
    secretId: string;
    modelSpecific: boolean;
  }> = [];
  for (const entry of listPiCatalog()) {
    if (!connectedProviders.has(entry.provider)) continue;
    const choice = chooseModelCredential({
      provider: entry.provider,
      modelId: entry.id,
      preferences,
      credentials,
    });
    if (!choice) continue;
    const secretId =
      choice.source === "preference"
        ? choice.preference.credential.secretId
        : choice.credential.secretId;
    const requestedModelId = usableModelId(entry.id);
    selections.push({
      provider: entry.provider,
      modelId: entry.id,
      secretId,
      modelSpecific:
        choice.source === "preference" &&
        requestedModelId !== null &&
        choice.preference.modelId === requestedModelId,
    });
  }
  const empty: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  if (selections.length === 0) return empty;

  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: [...new Set(selections.map((selection) => selection.secretId))] },
      userId: scope.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  // Every catalog model of a provider shares one secret; load each once per operation.
  const kindBySecretId = new Map<string, Promise<ModelCredentialAuthKind | undefined>>();
  const decryptKind = async (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    const ciphertext = ciphertextById.get(secretId);
    if (!ciphertext) return undefined;
    try {
      return modelCredentialAuthKindFromPlaintext(await secretStore.load(ciphertext, secretId));
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return undefined;
    }
  };
  const readKind = (secretId: string): Promise<ModelCredentialAuthKind | undefined> => {
    if (!kindBySecretId.has(secretId)) kindBySecretId.set(secretId, decryptKind(secretId));
    return kindBySecretId.get(secretId)!;
  };

  const auth: SpaceCatalogAuth = {
    byProvider: {},
    byModel: {},
    secretIdByProvider: {},
    secretIdByModel: {},
  };
  for (const selection of selections) {
    const kind = await readKind(selection.secretId);
    if (selection.modelSpecific) {
      const models = auth.byModel[selection.provider] ?? {};
      models[selection.modelId] = kind ?? "disconnected";
      auth.byModel[selection.provider] = models;
      const secrets = auth.secretIdByModel[selection.provider] ?? {};
      secrets[selection.modelId] = selection.secretId;
      auth.secretIdByModel[selection.provider] = secrets;
      continue;
    }
    if (kind) auth.byProvider[selection.provider] = kind;
    auth.secretIdByProvider[selection.provider] = selection.secretId;
  }
  return auth;
}

export function validateModelAuthAvailability(
  provider: string,
  modelId: string,
  credentialPlaintext?: string,
): string | undefined {
  if (provider === CHATGPT_PLAN_PROVIDER_ID) {
    return credentialPlaintext &&
      chatGPTModelsFromPlaintext(credentialPlaintext).some((entry) => entry.id === modelId)
      ? undefined
      : UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  if (!credentialPlaintext) return undefined;
  const authKind = modelCredentialAuthKindFromPlaintext(credentialPlaintext);
  const catalogEntry = listPiCatalog().find(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (!catalogModelAvailableForAuth(provider, modelId, authKind, catalogEntry?.auth)) {
    return UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE;
  }
  return undefined;
}

function modelAuthIsRestricted(provider: string, modelId: string): boolean {
  if (provider === CHATGPT_PLAN_PROVIDER_ID) return true;
  const entry = listPiCatalog().find((item) => item.provider === provider && item.id === modelId);
  if (!entry) return false;
  return (["oauth", "api_key", "openai_compatible", "disconnected"] as const).some(
    (kind) => !catalogModelAvailableForAuth(provider, modelId, kind, entry.auth),
  );
}

/**
 * Ready credential to save as the space default.
 * The first ready credential in `orderedIds` wins, unless it already stores an
 * auth-restricted model and another ready credential can take the new default.
 */
export function selectDefaultCredentialId(input: {
  provider: string;
  modelId: string;
  orderedIds: readonly string[];
  readyIds: readonly string[];
  savedModelId: (credentialId: string) => string | null | undefined;
}): string | undefined {
  const ready = new Set(input.readyIds);
  const preferred = input.orderedIds.find((id) => ready.has(id));
  if (!preferred) return undefined;
  const saved = usableModelId(input.savedModelId(preferred));
  const requested = usableModelId(input.modelId);
  if (!saved || saved === requested) return preferred;
  const alternate = input.orderedIds.find((id) => id !== preferred && ready.has(id));
  if (!alternate || !modelAuthIsRestricted(input.provider, saved)) return preferred;
  return alternate;
}

export type StoredModelAuthRead =
  | { status: "ready" }
  | { status: "unreadable" }
  | { status: "rejected"; message: string };

export type LoadedModelSecret =
  | { status: "missing" }
  | { status: "unreadable"; ciphertext: string }
  | { status: "loaded"; ciphertext: string; plaintext: string };

export async function loadStoredModelSecret(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
): Promise<LoadedModelSecret> {
  const secret = await prisma.secret.findFirst({
    where: { id: secretId, userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return { status: "missing" };
  try {
    const plaintext = await secretStore.load(secret.ciphertext, secret.id);
    return { status: "loaded", ciphertext: secret.ciphertext, plaintext };
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    return { status: "unreadable", ciphertext: secret.ciphertext };
  }
}

/** Load credential auth outside transactions; retain the ref for a transactional recheck. */
export async function prepareStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<{ ref: string | null; auth: StoredModelAuthRead }> {
  const secret = await loadStoredModelSecret(prisma, secretStore, userId, secretId);
  if (secret.status === "missing") return { ref: null, auth: { status: "unreadable" } };
  if (secret.status === "unreadable") {
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  const { plaintext } = secret;
  let message: string | undefined;
  try {
    message = validateModelAuthAvailability(provider, modelId, plaintext);
  } catch {
    // A secret that decrypts but does not parse is as unreadable as a corrupt one.
    return { ref: secret.ciphertext, auth: { status: "unreadable" } };
  }
  // validateModelAuthAvailability already parsed the secret without throwing.
  if (
    message &&
    provider === CHATGPT_OAUTH_PROVIDER &&
    (await codexLiveListsModel(live, userId, parseModelSecret(plaintext), modelId, liveOpts))
  ) {
    return { ref: secret.ciphertext, auth: { status: "ready" } };
  }
  return {
    ref: secret.ciphertext,
    auth: message ? { status: "rejected", message } : { status: "ready" },
  };
}

export async function readStoredModelAuth(
  ...args: Parameters<typeof prepareStoredModelAuth>
): Promise<StoredModelAuthRead> {
  return (await prepareStoredModelAuth(...args)).auth;
}

/** Readable rejection when a stored credential cannot call this catalog model. */
export async function validateStoredModelAuth(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
  provider: string,
  modelId: string,
  live?: CodexLiveCatalog,
  liveOpts?: CodexLiveReadOptions,
): Promise<string | undefined> {
  const auth = await readStoredModelAuth(
    prisma,
    secretStore,
    userId,
    secretId,
    provider,
    modelId,
    live,
    liveOpts,
  );
  // Unreadable credentials fail when the run loads them, not as an auth mismatch.
  return auth.status === "rejected" ? auth.message : undefined;
}

/** Enabled connection models, including the space default, in stable order. */
export function enabledOpenAiCompatibleModelIds(
  secret: StoredModelSecret | undefined,
  defaultModel: string | null | undefined,
): string[] {
  const listed = secret?.kind === "openai_compatible" ? (secret.enabledModelIds ?? []) : [];
  const ids = [defaultModel, ...listed].map((id) => usableModelId(id));
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

type ModelSelectionClient = Pick<
  PrismaClient,
  "userModelCredential" | "spaceModelPreference" | "secret"
>;

export async function findConnectedModelCredential(
  prisma: ModelSelectionClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId?: string | null,
  modelCredentialId?: string | null,
) {
  if (modelCredentialId !== undefined) {
    return findBoundModelCredential(prisma, actor, {
      provider,
      modelId: modelId ?? "",
      modelCredentialId,
    });
  }
  return findModelCredential(prisma, actor, provider, modelId);
}

/** Owned helper choices; secret material is never returned. */
export async function listHelperModelConnections(
  prisma: ModelSelectionClient,
  secretStore: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
) {
  const rows = await prisma.userModelCredential.findMany({
    where: { userId: actor.userId },
    include: {
      preferences: {
        where: { userId: actor.userId, spaceId: actor.spaceId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const secrets = rows.length
    ? await prisma.secret.findMany({
        where: { userId: actor.userId, spaceId: null, id: { in: rows.map((row) => row.secretId) } },
        select: { id: true, ciphertext: true },
      })
    : [];
  const parsedById = new Map(
    await Promise.all(
      secrets.map(async (secret) => {
        try {
          return [
            secret.id,
            parseModelSecret(await secretStore.load(secret.ciphertext, secret.id)),
          ] as const;
        } catch (error) {
          if (error instanceof SecretStoreUnavailableError) throw error;
          return [secret.id, undefined] as const;
        }
      }),
    ),
  );
  return rows.flatMap((row) => {
    const parsed = parsedById.get(row.secretId);
    if (!parsed) return [];
    const modelIds =
      row.provider === CHATGPT_PLAN_PROVIDER_ID
        ? parsed.kind === "oauth" && readChatGPTPlanCredential(parsed.credential)
          ? readChatGPTPlanModels(parsed.credential).map((entry) => entry.id)
          : []
        : row.provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? parsed.kind === "openai_compatible"
            ? enabledOpenAiCompatibleModelIds(parsed, row.preferences[0]?.modelId)
            : []
          : listAvailablePiCatalog({ [row.provider]: modelCredentialAuthKind(parsed) })
              .filter((entry) => entry.provider === row.provider)
              .map((entry) => entry.id);
    if (modelIds.length === 0) return [];
    return [
      {
        modelCredentialId: row.id,
        provider: row.provider,
        modelIds,
        baseUrl: parsed.kind === "openai_compatible" ? parsed.baseUrl : undefined,
      },
    ];
  });
}

/** Bound optional helper hints without truncating the recipient inventory or changing authorization. */
export function helperModelChoicesDescription(
  choices: readonly { modelCredentialId: string; provider: string; modelIds: readonly string[] }[],
): string {
  const connections: Array<{
    model_credential_id: string;
    model_provider: string;
    model_ids: string[];
  }> = [];
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let truncated = choices.length > 20;
  for (const choice of choices.slice(0, 20)) {
    const entry = {
      model_credential_id: choice.modelCredentialId,
      model_provider: choice.provider,
      model_ids: [] as string[],
    };
    truncated ||= choice.modelIds.length > 8;
    for (const id of choice.modelIds.slice(0, 8)) {
      const candidate = { ...entry, model_ids: [...entry.model_ids, id] };
      if (bytes([...connections, candidate]) > 10_000) {
        truncated = true;
        break;
      }
      entry.model_ids.push(id);
    }
    if (entry.model_ids.length > 0) connections.push(entry);
    else if (choice.modelIds.length > 0) truncated = true;
  }
  return `Available explicit model choices (configuration data): ${JSON.stringify({ connections, truncated })}. Omit model fields to inherit the active model. For an explicit choice use a listed provider, model ID, and model_credential_id together.`;
}

export function compatibleThinkingLevels(
  row: Parameters<typeof modelCredentialDto>[0],
  plaintext: string | undefined,
  modelId: string,
) {
  let parsed: StoredModelSecret | undefined;
  let levels: string[] | undefined;
  if (plaintext !== undefined) {
    try {
      parsed = parseModelSecret(plaintext);
      levels = modelCredentialDto(row, plaintext).thinkingLevels;
    } catch {
      // Unreadable connections must not advertise reasoning support.
    }
  }
  const enabled = enabledOpenAiCompatibleModelIds(parsed, row.defaultModel);
  return {
    allowed:
      parsed?.kind === "openai_compatible" && enabled.includes(modelId.trim())
        ? (levels ?? ["off"])
        : ["off"],
    enabledModelIds: enabled,
    storedEnabledModelIds:
      parsed?.kind === "openai_compatible" ? parsed.enabledModelIds : undefined,
  };
}

export async function validateConnectedModelChoice(
  prisma: ModelSelectionClient,
  secretStore: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
  modelCredentialId?: string | null,
) {
  const credential = await findConnectedModelCredential(
    prisma,
    actor,
    provider,
    modelId,
    modelCredentialId,
  );
  if (!credential) return "Connect that model provider first";
  if (!usableModelId(modelId)) return "Unknown model for that provider";
  if (provider === CHATGPT_PLAN_PROVIDER_ID) {
    const auth = await readStoredModelAuth(
      prisma,
      secretStore,
      actor.userId,
      credential.secretId,
      provider,
      modelId,
    );
    return auth.status === "ready"
      ? undefined
      : auth.status === "rejected"
        ? auth.message
        : "Connect that model provider first";
  }
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return isCatalogModelChoice(provider, modelId) ? undefined : "Unknown model for that provider";
  }
  const secret = await loadStoredModelSecret(
    prisma,
    secretStore,
    actor.userId,
    credential.secretId,
  );
  if (secret.status !== "loaded") return "Model connection is unavailable";
  let parsed: StoredModelSecret;
  try {
    parsed = parseModelSecret(secret.plaintext);
  } catch {
    return "Model connection is unavailable";
  }
  return parsed.kind === "openai_compatible" &&
    enabledOpenAiCompatibleModelIds(parsed, credential.defaultModel).includes(modelId.trim())
    ? undefined
    : "Unknown model for that provider";
}

export type ModelChoice = {
  modelProvider: string | null;
  modelId: string | null;
  modelCredentialId?: string | null;
  thinkingLevel: string | null;
};

/**
 * The model a queued run will use. `modelPinned` is the choice captured when the
 * run was created. Model columns written later only record the attempt, so a
 * routine that follows its bot still follows the bot after a resume.
 */
export function runModelChoice(
  run: ModelChoice & { modelPinned?: boolean },
  bot: ModelChoice,
): ModelChoice {
  if (run.modelPinned && run.modelProvider && usableModelId(run.modelId)) {
    return {
      modelProvider: run.modelProvider,
      modelId: run.modelId,
      modelCredentialId: run.modelCredentialId ?? null,
      thinkingLevel: run.thinkingLevel,
    };
  }
  return {
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    modelCredentialId: bot.modelCredentialId ?? null,
    thinkingLevel: bot.thinkingLevel,
  };
}

/** The model columns a routine's run starts with; empty when it follows the bot. */
export function routineRunModelPin(routine: ModelChoice): {
  modelProvider?: string;
  modelId?: string;
  modelCredentialId?: string | null;
  thinkingLevel?: string | null;
  modelPinned?: true;
} {
  if (!routine.modelProvider || !routine.modelId) return {};
  return {
    modelProvider: routine.modelProvider,
    modelId: routine.modelId,
    modelCredentialId: routine.modelCredentialId ?? null,
    thinkingLevel: routine.thinkingLevel,
    modelPinned: true,
  };
}

/**
 * One inbound delivery is one turn. Pin a model only when every routine in that
 * delivery chose the same one; mixed choices stay on the bot's model.
 */
export function inboundRoutineModelPin(routines: readonly ModelChoice[]) {
  const pins = routines.map((routine) => routineRunModelPin(routine));
  const first = pins[0];
  if (!first) return {};
  const agreed = pins.every(
    (pin) =>
      pin.modelPinned === first.modelPinned &&
      pin.modelProvider === first.modelProvider &&
      pin.modelId === first.modelId &&
      (pin.modelCredentialId ?? null) === (first.modelCredentialId ?? null) &&
      (pin.thinkingLevel ?? null) === (first.thinkingLevel ?? null),
  );
  return agreed ? first : {};
}

/** Why a pinned model cannot run on the credential that was found for it. */
export function pinnedModelCredentialError(
  choice: ModelChoice,
  credential: { id: string; defaultModel: string | null } | null,
): string | undefined {
  if (!choice.modelProvider || !usableModelId(choice.modelId)) return undefined;
  if (!credential || !choice.modelCredentialId || credential.id !== choice.modelCredentialId)
    return "Connect that model provider first";
  if (
    choice.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID ||
    choice.modelProvider === CHATGPT_PLAN_PROVIDER_ID
  )
    return undefined;
  const modelId = usableModelId(choice.modelId);
  if (
    modelId &&
    !isCatalogModelChoice(choice.modelProvider, modelId) &&
    credential.defaultModel !== modelId
  ) {
    return "Unknown model for that provider";
  }
  return undefined;
}

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  /** The bot's or the run's own model; null follows the space default. */
  override: ModelChoice | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { override: bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && usableModelId(bot.modelId));
  // The override provider, model and credential must win together.
  const useOverride = hasOverride;
  const credential = hasOverride ? overrideCredential : defaultCredential;
  const id =
    usableModelId(useOverride ? bot!.modelId : null) ??
    usableModelId(credential?.defaultModel) ??
    (credential ? defaultCatalogModelId(credential.provider) : null) ??
    usableModelId(settings?.defaultModelId) ??
    usableModelId(deployment?.model);
  // A preference's thinking level is bound to its stored modelId, so it only applies
  // when that model is the one being run.
  const credentialThinkingLevel =
    credential && id && credential.defaultModel === id ? credential.thinkingLevel : null;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id,
    credential,
    // Preserve bot thinking for the Space default; drop it for an unavailable override.
    thinkingLevel:
      hasOverride && !useOverride
        ? null
        : (((bot?.thinkingLevel ??
            credentialThinkingLevel) as AgentRunRequest["model"]["thinkingLevel"]) ?? null),
  };
}
