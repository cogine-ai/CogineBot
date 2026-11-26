import type {
  ModelApiProtocol,
  ModelCatalogEntry,
  ModelCatalogProbeInput,
  ModelConnectInput,
  ModelCredential,
  ModelHeaderRow,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  canonicalPiProviderId,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DISCOVERED_MODEL_LIMITS,
  ModelApiProtocolSchema,
  ModelHeaderRowsSchema,
  modelHeadersInput,
  modelOutputLeavesInputRoom,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionMaxTokensField,
  pickCatalogModelId,
} from "./model-providers.js";
import { credentialModelSettings } from "./model-settings-form.js";

/** A replacement draft always takes precedence over the saved connection. */
export function modelCatalogProbeInput(
  entry: Pick<ModelCatalogEntry, "provider" | "catalogProbe" | "savedCatalogProbe"> | undefined,
  draftKey: string,
  credential?: Pick<ModelCredential, "id" | "provider" | "authKind" | "connectionRevision">,
  expectedRevision?: number,
): ModelCatalogProbeInput | undefined {
  if (!entry?.catalogProbe) return undefined;
  const apiKey = draftKey.trim();
  if (apiKey) return apiKey.length >= 8 ? { provider: entry.provider, apiKey } : undefined;
  if (
    !entry.savedCatalogProbe ||
    credential?.authKind !== "api_key" ||
    !expectedRevision ||
    expectedRevision !== credential.connectionRevision ||
    canonicalPiProviderId(credential.provider) !== canonicalPiProviderId(entry.provider)
  )
    return undefined;
  return { provider: credential.provider, credentialId: credential.id, expectedRevision };
}

export function modelCatalogProbeOutcome(modelId: string | undefined, models: readonly string[]) {
  if (models.length === 0) return "empty";
  const selected = modelId?.trim();
  return selected && !models.includes(selected) ? "missing" : "listed";
}

/** Only rank discovery choices. Current selections and saved model order use the base catalog. */
export function prioritizeProviderListedModels(
  models: ModelCatalogEntry[],
  credential: Pick<ModelCredential, "providerListedModelIds" | "connectionRevision"> | undefined,
  revision: number | undefined,
  draftKey: string,
): ModelCatalogEntry[] {
  if (
    !credential?.providerListedModelIds?.length ||
    revision === undefined ||
    revision !== credential.connectionRevision ||
    draftKey.trim()
  )
    return models;
  const listed = new Set(credential.providerListedModelIds);
  return [...models].sort((a, b) => Number(listed.has(b.id)) - Number(listed.has(a.id)));
}

/** Add choices from the one connection being edited, leaving the global catalog alone. */
export function withConnectionCatalogModels(
  models: ModelCatalogEntry[],
  credential:
    | Pick<
        ModelCredential,
        | "provider"
        | "providerListedModelIds"
        | "savedProviderCatalogModelIds"
        | "savedModelDirectory"
        | "modelId"
        | "connectionRevision"
      >
    | undefined,
  revision = credential?.connectionRevision,
  draftKey = "",
): ModelCatalogEntry[] {
  if (!credential || revision === undefined || revision !== credential.connectionRevision)
    return models;
  const provider = canonicalPiProviderId(credential.provider);
  const anchor = models.find((entry) => canonicalPiProviderId(entry.provider) === provider);
  if (!anchor) return models;
  const known = new Set(
    models
      .filter((entry) => canonicalPiProviderId(entry.provider) === provider)
      .map(({ id }) => id),
  );
  const saved = [...(credential.savedProviderCatalogModelIds ?? [])];
  if (credential.savedModelDirectory?.confirmationRequired && credential.modelId)
    saved.push(credential.modelId);
  const choices = draftKey.trim()
    ? saved.filter((id) => id === credential.modelId)
    : [...(credential.providerListedModelIds ?? []), ...saved];
  const added = [...new Set(choices)].filter((id) => !known.has(id));
  if (!added.length) return models;
  return [
    ...models,
    ...added.map(
      (id): ModelCatalogEntry => ({
        provider: anchor.provider,
        providerName: anchor.providerName,
        id,
        label: id,
        billing: anchor.billing,
        auth: "api-key",
        subscription: false,
        ...DISCOVERED_MODEL_LIMITS,
        reasoning: false,
        images: false,
        thinkingLevels: ["off"],
        catalogProbe: anchor.catalogProbe,
        savedCatalogProbe: anchor.savedCatalogProbe,
      }),
    ),
  ];
}

/** The status belongs to the saved ID on the exact revision being edited. */
export function selectedModelDirectoryStatus(
  credential:
    | Pick<ModelCredential, "modelId" | "connectionRevision" | "savedModelDirectory">
    | undefined,
  revision: number | undefined,
  selectedId: string | undefined,
  draftKey: string,
) {
  return revision !== undefined &&
    revision === credential?.connectionRevision &&
    credential.modelId === selectedId &&
    !draftKey.trim()
    ? credential.savedModelDirectory
    : undefined;
}

type CatalogModel = Pick<ModelCatalogEntry, "provider" | "id" | "thinkingLevels">;
type DefaultModel = { defaultProvider: string | null; defaultModel: string | null };

/** What a connection form edits, as the strings and toggles its fields hold. */
export type ConnectionFormFields = {
  enabledModelIds: string[];
  baseUrl: string;
  apiProtocol: ModelApiProtocol | "";
  reasoning: boolean;
  thinkingLevel: ThinkingLevel | null;
  maxTokens: string;
  contextWindow: string;
  supportsImages: boolean;
  maxImagesPerPrompt: string;
  accountId: string;
  gatewayId: string;
};

/**
 * The model a connection form opens on. An OpenAI-compatible connection keeps its own model, so
 * a new one starts empty rather than borrowing another server's. A catalog provider keeps the
 * model on screen while the catalog still lists it, else the connection's, else the default's.
 */
export function connectionFormModelId(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  credential?: Pick<ModelCredential, "modelId">;
  defaults?: DefaultModel | null;
  current?: string;
}): string {
  const { catalog, provider, credential, defaults, current } = input;
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) return credential?.modelId ?? "";
  return (
    catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider) &&
        entry.id === current,
    )?.id ??
    pickCatalogModelId(
      catalog,
      provider,
      credential?.modelId ??
        (canonicalPiProviderId(provider) === canonicalPiProviderId(defaults?.defaultProvider ?? "")
          ? (defaults?.defaultModel ?? null)
          : null),
    )
  );
}

/**
 * The fields a form shows for a saved connection, or a new one when `credential` is undefined.
 * A stored effort is bound to the model it was saved with, and is clamped to what `modelId` runs.
 */
export function connectionFormFields(input: {
  catalog: readonly CatalogModel[];
  provider: string;
  modelId: string;
  credential?: Pick<
    ModelCredential,
    | "modelId"
    | "modelSettings"
    | "enabledModelIds"
    | "baseUrl"
    | "apiProtocol"
    | "reasoning"
    | "thinkingLevel"
    | "maxTokens"
    | "contextWindow"
    | "supportsImages"
    | "maxImagesPerPrompt"
    | "accountId"
    | "gatewayId"
  >;
  /** Prefills a new OpenAI-compatible connection, such as the Ollama Cloud preset. */
  presetBaseUrl?: string;
}): ConnectionFormFields {
  const { catalog, provider, modelId, credential, presetBaseUrl } = input;
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const supportedThinking = compatible
    ? compatibleThinkingLevels(credential?.apiProtocol)
    : catalog.find(
        (entry) =>
          canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider) &&
          entry.id === modelId,
      )?.thinkingLevels;
  return {
    enabledModelIds: credential?.enabledModelIds ?? [],
    baseUrl: compatible ? (credential?.baseUrl ?? presetBaseUrl ?? "") : "",
    apiProtocol:
      credential?.apiProtocol === undefined
        ? "chat-completions"
        : ModelApiProtocolSchema.safeParse(credential.apiProtocol).success
          ? credential.apiProtocol
          : "",
    reasoning: credential?.reasoning ?? false,
    thinkingLevel: clampCatalogThinkingLevel(
      credential?.modelId === modelId ? credential.thinkingLevel : null,
      supportedThinking,
    ) as ThinkingLevel | null,
    maxTokens: connectionMaxTokensField(provider, credential?.maxTokens),
    contextWindow: String(credential?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW),
    supportsImages: credential?.supportsImages ?? false,
    maxImagesPerPrompt: String(credential?.maxImagesPerPrompt ?? ""),
    accountId: credential?.accountId ?? "",
    gatewayId: credential?.gatewayId ?? "",
  };
}

/** Whether a compatible form has a model, a known protocol and valid replacement headers. */
export function compatibleConnectionReady(input: {
  baseUrl: string;
  modelId: string;
  apiProtocol: ModelApiProtocol | "";
  headerRows: ModelHeaderRow[] | null;
}): boolean {
  return (
    openAiCompatibleConnectReady({ baseUrl: input.baseUrl, modelId: input.modelId }) &&
    ModelApiProtocolSchema.safeParse(input.apiProtocol).success &&
    (input.headerRows === null || ModelHeaderRowsSchema.safeParse(input.headerRows).success)
  );
}

export type ConnectionFormDraft = Omit<ConnectionFormFields, "enabledModelIds"> & {
  apiKey: string;
  modelId: string;
  enabledModelIds: readonly string[];
  headerRows: ModelHeaderRow[] | null;
};

/** A local validation failure; applications provide safe field messages. */
export type ConnectionFormInvalidField =
  | "maxTokens"
  | "maxImagesPerPrompt"
  | "contextWindow"
  | "outputRoom"
  | "apiProtocol"
  | "headers"
  | "connection";

export type ModelConnectRequest =
  | { status: "incomplete" }
  | { status: "invalid"; field: ConnectionFormInvalidField }
  | {
      status: "ready";
      input: ModelConnectInput;
      /** A catalog provider's save without a new key: limits and gateway ids only. */
      savingLimitOnly: boolean;
      /** The model the saved connection runs. */
      activeModelId: string;
    };

/**
 * The `models.connect` input for a connection form. `settingsOnly` saves a catalog provider's
 * limits and gateway ids without the key field. Existing connections retain their captured revision.
 */
export function modelConnectRequest(input: {
  form: ConnectionFormDraft;
  selected: Pick<ModelCatalogEntry, "provider" | "providerName" | "id" | "thinkingLevels">;
  credential?: Pick<
    ModelCredential,
    "provider" | "modelId" | "thinkingLevel" | "modelSettings" | "reasoning"
  >;
  credentialId: string | null;
  expectedRevision?: number;
  settingsOnly?: boolean;
}): ModelConnectRequest {
  const {
    form,
    selected,
    credential,
    credentialId,
    expectedRevision,
    settingsOnly = false,
  } = input;
  if (credentialId && expectedRevision === undefined)
    return { status: "invalid", field: "connection" };
  if (
    credentialId &&
    credential &&
    canonicalPiProviderId(credential.provider) !== canonicalPiProviderId(selected.provider)
  )
    return { status: "invalid", field: "connection" };
  const identity = credentialId ? { credentialId, expectedRevision } : {};
  const mutationProvider = credentialId
    ? (credential?.provider ?? selected.provider)
    : selected.provider;
  const compatible = selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const protocol = ModelApiProtocolSchema.safeParse(form.apiProtocol);
  if (compatible && !protocol.success) return { status: "invalid", field: "apiProtocol" };
  if (
    compatible &&
    form.headerRows !== null &&
    !ModelHeaderRowsSchema.safeParse(form.headerRows).success
  ) {
    return { status: "invalid", field: "headers" };
  }
  const baseUrl = form.baseUrl.trim();
  const modelId = form.modelId.trim();
  const newKey = settingsOnly ? "" : form.apiKey.trim();
  const savingLimitOnly = !compatible && !newKey;
  const activeModelId = compatible ? modelId : selected.id;
  if (compatible) {
    if (!baseUrl || !modelId) return { status: "incomplete" };
  } else if (savingLimitOnly) {
    if (!credential) return { status: "incomplete" };
  } else if (newKey.length < 8) {
    return { status: "incomplete" };
  }
  const maxTokens = form.maxTokens.trim() ? parseModelMaxTokens(form.maxTokens) : undefined;
  if ((compatible || form.maxTokens.trim()) && maxTokens === undefined) {
    return { status: "invalid", field: "maxTokens" };
  }
  const maxImagesPerPrompt = compatible
    ? parseModelMaxImagesPerPrompt(form.maxImagesPerPrompt, form.supportsImages)
    : undefined;
  if (
    compatible &&
    form.supportsImages &&
    form.maxImagesPerPrompt.trim() &&
    maxImagesPerPrompt === undefined
  ) {
    return { status: "invalid", field: "maxImagesPerPrompt" };
  }
  const contextWindow = compatible ? parseModelContextWindow(form.contextWindow) : undefined;
  if (compatible && contextWindow === undefined) {
    return { status: "invalid", field: "contextWindow" };
  }
  if (compatible && !modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
    return { status: "invalid", field: "outputRoom" };
  }
  // The staged effort belongs to the model on screen. Clamp it before a connect or a limit
  // save so a previous model's level cannot stick.
  const thinkingLevel = clampCatalogThinkingLevel(
    form.thinkingLevel,
    compatible
      ? (credential ? credentialModelSettings(credential, modelId).reasoning : form.reasoning)
        ? compatibleThinkingLevels(form.apiProtocol)
        : []
      : selected.thinkingLevels,
  ) as ThinkingLevel | null;
  const label = selected.providerName ?? selected.provider;
  if (compatible) {
    // A hidden effort control must not clear the saved level during an ordinary connection save.
    const preserveDormantThinking =
      credential?.modelId === modelId && !credentialModelSettings(credential, modelId).reasoning;
    return {
      status: "ready",
      savingLimitOnly,
      activeModelId,
      input: {
        provider: mutationProvider,
        baseUrl,
        apiProtocol: protocol.success ? protocol.data : undefined,
        headers: modelHeadersInput(form.headerRows),
        modelId,
        // The server adds the default itself.
        enabledModelIds: form.enabledModelIds.filter((id) => id !== modelId),
        reasoning: form.reasoning,
        ...(preserveDormantThinking ? {} : { thinkingLevel }),
        maxTokens,
        contextWindow,
        supportsImages: form.supportsImages,
        maxImagesPerPrompt:
          form.supportsImages && !form.maxImagesPerPrompt.trim() ? null : maxImagesPerPrompt,
        apiKey: form.apiKey.trim() || undefined,
        label,
        ...identity,
      },
    };
  }
  const modelChanged = (credential?.modelId ?? null) !== (activeModelId || null);
  const storedThinking =
    credential?.modelId === selected.id ? (credential.thinkingLevel ?? null) : null;
  return {
    status: "ready",
    savingLimitOnly,
    activeModelId,
    input: {
      provider: mutationProvider,
      ...(newKey ? { apiKey: newKey } : {}),
      ...(selected.provider === CLOUDFLARE_AI_GATEWAY_PROVIDER_ID
        ? { accountId: form.accountId.trim(), gatewayId: form.gatewayId.trim() }
        : {}),
      modelId: selected.id,
      // A limits-only save leaves the stored effort alone while the model and effort stay
      // put. Changing either sends the clamped level, including null, so the previous
      // model's effort is not reused.
      ...(!savingLimitOnly || modelChanged || (form.thinkingLevel ?? null) !== storedThinking
        ? { thinkingLevel }
        : {}),
      maxTokens: maxTokens ?? null,
      label,
      ...identity,
    },
  };
}
