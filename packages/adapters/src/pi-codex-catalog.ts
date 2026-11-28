import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { ThinkingLevel } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";
import { codexAccountCatalogModelIds } from "./pi-current-models.js";
import { LiveCatalogCache } from "./pi-live-cache.js";
import { codexDirectoryModel } from "./pi-live-model.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { listPiCatalog } from "./pi-models.js";
import type { StoredModelSecret } from "./pi-oauth.js";
import { CHATGPT_OAUTH_PROVIDER, oauthCredentialAccountId, parseModelSecret } from "./pi-oauth.js";

/**
 * The ChatGPT backend reports which Codex models a subscription account can call.
 * Pin a client from the GPT-6.2 release window to request the corresponding
 * compatibility view. The returned catalog still decides account access.
 */
export const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const CODEX_CLIENT_VERSION = "0.169.1";

const CODEX_CATALOG_TIMEOUT_MS = 12_000;
const CODEX_CATALOG_HARD_DEADLINE_MS = CODEX_CATALOG_TIMEOUT_MS + 10_000;
const CODEX_CATALOG_MAX_BYTES = 1024 * 1024;
const MAX_CODEX_MODELS = 128;
const MAX_CODEX_LIST_ITEMS = 32;
const MAX_REASONING_LEVELS = 16;
const MAX_CATALOG_CACHE_ENTRIES = 256;
const CATALOG_TTL_MS = 15 * 60_000;
const CATALOG_FAILURE_TTL_MS = 60_000;
const CATALOG_READ_WAIT_MS = 1_500;
/**
 * How long a last-good catalog may keep answering after its TTL while refreshes
 * keep failing. Beyond this window the account's list is distrusted entirely —
 * a model the backend removed must not stay selectable forever — and reads fall
 * back to the static catalog until a refresh finally succeeds.
 */
const CATALOG_STALE_MAX_AGE_MS = 4 * 60 * 60_000;

export type CodexCatalogModel = {
  slug: string;
  reasoningEfforts: string[];
  contextWindow?: number;
  supportsImages: boolean;
  supportsFastTier: boolean;
};

export type CodexCatalogFailureReason = "transport" | "timeout" | "http" | "malformed";

export type CodexCatalogResult =
  | { status: "ok"; models: CodexCatalogModel[] }
  | { status: "error"; reason: CodexCatalogFailureReason; httpStatus?: number };

/**
 * Account-scoped handle for one catalog read. `accessToken` returns the bearer
 * the credential already holds, or null once it expires — the catalog path
 * never refreshes or writes credentials; the runtime's locked refresh owns all
 * token writes. When the caller supplies `onExpiredToken` (see
 * `CodexLiveReadOptions`) an expired bearer fires it so a detached refresh can
 * warm the next read; this read still gets null.
 */
export type CodexCatalogAccount = {
  accountId: string;
  accessToken: () => Promise<string | null>;
  connection?: { secretId: string; connectionRevision: number };
};

type CodexCacheReadOptions = { waitMs?: number; cacheOnly?: boolean; freshOnly?: boolean };

export interface CodexLiveCatalog {
  read(
    userId: string,
    account: CodexCatalogAccount,
    opts?: CodexCacheReadOptions,
  ): Promise<CodexCatalogModel[] | undefined>;
}

/**
 * Options for a live catalog check. `waitMs` bounds how long a cold read waits
 * for an in-flight fetch (`0` consults only settled cache state while still
 * kicking a background revalidation on a miss — safe inside a transaction).
 * `cacheOnly` reads settled cache state without triggering or awaiting a refresh.
 * `onExpiredToken` fires when the stored bearer is expired so the caller can
 * kick a detached refresh through the runtime's credential lock.
 */
export type CodexLiveReadOptions = CodexCacheReadOptions & {
  connection?: CodexCatalogAccount["connection"];
  onExpiredToken?: () => void;
};

/** GET the backend's per-account model list. Failure modes are typed, never thrown. */
export async function fetchCodexCatalog(
  accessToken: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CodexCatalogResult> {
  const url = `${CODEX_MODELS_ENDPOINT}?client_version=${CODEX_CLIENT_VERSION}`;
  const timeout = AbortSignal.timeout(CODEX_CATALOG_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "rakazo",
        accept: "application/json",
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { status: "error", reason: name === "TimeoutError" ? "timeout" : "transport" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "error", reason: "http", httpStatus: response.status };
  }
  const text = await readBoundedText(response);
  if (text === undefined) return { status: "error", reason: "malformed" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const models = parseCodexCatalog(payload);
  return models ? { status: "ok", models } : { status: "error", reason: "malformed" };
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > CODEX_CATALOG_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CODEX_CATALOG_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  }
}

const INVALID = Symbol("invalid-codex-catalog");

/**
 * Parse the backend response: keep only `visibility === "list" && supported_in_api`.
 * Any malformed entry fails the whole catalog so a broken response cannot wipe the list.
 */
export function parseCodexCatalog(payload: unknown): CodexCatalogModel[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models) || models.length > MAX_CODEX_MODELS) return undefined;
  const catalog: CodexCatalogModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.visibility !== "string" || typeof entry.supported_in_api !== "boolean") {
      return undefined;
    }
    if (entry.visibility !== "list" || !entry.supported_in_api) continue;
    if (typeof entry.slug !== "string" || !isValidSlug(entry.slug)) return undefined;
    const reasoningEfforts = parseReasoningEfforts(entry.supported_reasoning_levels);
    const contextWindow = parseContextWindow(entry.context_window);
    const supportsImages = stringListContains(entry.input_modalities, "image");
    const supportsFastTier = stringListContains(entry.additional_speed_tiers, "fast");
    if (
      reasoningEfforts === INVALID ||
      contextWindow === INVALID ||
      supportsImages === INVALID ||
      supportsFastTier === INVALID
    ) {
      return undefined;
    }
    catalog.push({
      slug: entry.slug,
      reasoningEfforts,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      supportsImages,
      supportsFastTier,
    });
  }
  return catalog;
}

/** Printable non-space ASCII only, bounded length. */
function isValidSlug(slug: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(slug);
}

function parseReasoningEfforts(value: unknown): string[] | typeof INVALID {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REASONING_LEVELS) return INVALID;
  const efforts: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return INVALID;
    const effort = (entry as Record<string, unknown>).effort;
    if (typeof effort !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(effort)) return INVALID;
    efforts.push(effort);
  }
  return efforts;
}

function parseContextWindow(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return INVALID;
  }
  return value;
}

function stringListContains(value: unknown, expected: string): boolean | typeof INVALID {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value) || value.length > MAX_CODEX_LIST_ITEMS) return INVALID;
  let found = false;
  for (const entry of value) {
    if (typeof entry !== "string") return INVALID;
    if (entry === expected) found = true;
  }
  return found;
}

/** Process-local refresh policy for the subscription account's model catalog. */
export class CodexCatalogCache implements CodexLiveCatalog {
  private readonly cache: LiveCatalogCache<CodexCatalogModel>;
  private readonly fetchImpl: typeof fetch;

  constructor(
    opts: {
      fetch?: typeof fetch;
      now?: () => number;
      ttlMs?: number;
      failureTtlMs?: number;
      waitMs?: number;
      /** Bound on the shared refresh itself, so a signal-ignoring fetch cannot pin a key. */
      deadlineMs?: number;
      /** Max age of a last-good catalog that failures may keep serving. */
      staleMaxAgeMs?: number;
    } = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.cache = new LiveCatalogCache({
      now: opts.now ?? Date.now,
      ttlMs: opts.ttlMs ?? CATALOG_TTL_MS,
      failureTtlMs: opts.failureTtlMs ?? CATALOG_FAILURE_TTL_MS,
      waitMs: opts.waitMs ?? CATALOG_READ_WAIT_MS,
      deadlineMs: opts.deadlineMs ?? CODEX_CATALOG_HARD_DEADLINE_MS,
      staleMaxAgeMs: opts.staleMaxAgeMs ?? CATALOG_STALE_MAX_AGE_MS,
      maxEntries: MAX_CATALOG_CACHE_ENTRIES,
    });
  }

  async read(
    userId: string,
    account: CodexCatalogAccount,
    opts?: CodexCacheReadOptions,
  ): Promise<CodexCatalogModel[] | undefined> {
    const key = JSON.stringify([
      userId,
      account.accountId,
      account.connection?.secretId,
      account.connection?.connectionRevision,
    ]);
    const models = await this.cache.read(
      key,
      async (signal) => {
        let accessToken: string | null;
        try {
          accessToken = await account.accessToken();
        } catch {
          return { attempted: false };
        }
        // A missing or expired bearer leaves no negative cache entry.
        if (!accessToken || signal.aborted) return { attempted: false };
        const result = await fetchCodexCatalog(
          accessToken,
          account.accountId,
          this.fetchImpl,
          signal,
        );
        return { attempted: true, models: result.status === "ok" ? result.models : undefined };
      },
      opts,
    );
    return opts?.freshOnly && models && !this.cache.isFresh(key, models) ? undefined : models;
  }
}

export type CodexCatalogSpaceAuth = {
  byProvider: Partial<Record<string, ModelCredentialAuthKind>>;
  byModel: Partial<
    Record<string, Partial<Record<string, ModelCredentialAuthKind | "disconnected">>>
  >;
  /**
   * Secret id of the credential governing each provider/model slot, as resolved by
   * `modelCredentialAuthKindsForSpace`. Missing ids keep that slot on the static
   * catalog — the live overlay is only as per-credential as this mapping.
   */
  secretIdByProvider?: Partial<Record<string, string>>;
  secretIdByModel?: Partial<Record<string, Partial<Record<string, string>>>>;
};

/**
 * Account handle over a stored ChatGPT OAuth credential; null without an
 * account id. An expired bearer yields null — and fires `onExpiredToken` when
 * given so the caller can kick a detached refresh through the runtime's locked
 * credential path; this read still gets no catalog.
 */
function codexAccountHandle(
  credential: OAuthCredential,
  onExpiredToken?: () => void,
): CodexCatalogAccount | null {
  const accountId = oauthCredentialAccountId(credential);
  if (!accountId) return null;
  return {
    accountId,
    accessToken: async () => {
      if (credential.expires > Date.now()) return credential.access;
      onExpiredToken?.();
      return null;
    },
  };
}

/**
 * Whether the live catalog for the account this credential signs into lists
 * `modelId` — the selection/run-time half of the models.list overlay, consulted
 * including a directory-only chat model on a trusted account list.
 */
export async function codexLiveModel(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  modelId: string,
  opts?: CodexLiveReadOptions,
): Promise<CodexCatalogModel | undefined> {
  const known = knownCodexSlugs();
  const models = await readCodexLiveModels(catalog, userId, secret, opts);
  if (
    !known.has(modelId) &&
    (!codexDirectoryModel(modelId) || !trustedCodexDirectory(models, known))
  )
    return undefined;
  return models?.find((model) => model.slug === modelId);
}

function trustedCodexDirectory(
  models: readonly CodexCatalogModel[] | undefined,
  known: ReadonlySet<string>,
) {
  return models &&
    known.size > 0 &&
    new Set(models.filter(({ slug }) => known.has(slug)).map(({ slug }) => slug)).size >=
      Math.ceil(known.size / 4)
    ? models
    : undefined;
}

/** Directory-only choices for the account whose credential the caller loaded. */
export function codexConnectionDirectory(
  models: readonly CodexCatalogModel[] | undefined,
  savedId: string | undefined,
) {
  const known = knownCodexSlugs();
  const anchor = listPiCatalog().find((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER);
  const observed = trustedCodexDirectory(models, known);
  const discovered = new Map<string, PiCatalogEntry>();
  const entryFor = (id: string, live?: CodexCatalogModel): PiCatalogEntry | undefined => {
    const model = !known.has(id) ? codexDirectoryModel(id) : undefined;
    if (!anchor || !model) return undefined;
    const thinkingLevels = live && liveThinkingLevels(live);
    return {
      provider: anchor.provider,
      providerName: anchor.providerName,
      id,
      label: id,
      auth: "oauth",
      subscription: true,
      billing: anchor.billing,
      signIn: anchor.signIn,
      oauthLabel: anchor.oauthLabel,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      images: live?.supportsImages ?? false,
      reasoning: Boolean(thinkingLevels?.some((level) => level !== "off")),
      thinkingLevels: thinkingLevels ?? ["off"],
    };
  };
  for (const model of observed ?? []) {
    const entry = entryFor(model.slug, model);
    if (entry && !discovered.has(entry.id)) discovered.set(entry.id, entry);
  }
  const retained = savedId && !discovered.has(savedId) ? entryFor(savedId) : undefined;
  return {
    models: [...discovered.values(), ...(retained ? [retained] : [])],
    savedModelDirectory: retained
      ? {
          confirmationRequired: true as const,
          ...(observed ? { notListed: true as const } : { confirmationUnavailable: true as const }),
        }
      : undefined,
  };
}

export async function readCodexLiveModels(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  opts?: CodexLiveReadOptions,
) {
  if (!catalog || secret.kind !== "oauth") return undefined;
  const account = codexAccountHandle(secret.credential, opts?.onExpiredToken);
  return account
    ? catalog
        .read(
          userId,
          opts?.connection ? { ...account, connection: opts.connection } : account,
          opts,
        )
        .catch(() => undefined)
    : undefined;
}

function knownCodexSlugs(): Set<string> {
  return new Set(
    listPiCatalog()
      .filter((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER)
      .map((entry) => entry.id),
  );
}

/** Keep a callable pick, or start a new sign-in on a model the account lists. */
export async function resolveCodexOAuthDefaultModel(
  catalog: CodexLiveCatalog,
  userId: string,
  secret: StoredModelSecret,
  requested: string | undefined,
): Promise<string | undefined> {
  const models = await readCodexLiveModels(catalog, userId, secret);
  const known = knownCodexSlugs();
  const available = models?.filter(({ slug }) => known.has(slug)).map(({ slug }) => slug);
  if (!available?.length || (requested && available.includes(requested))) return requested;
  return available.find((id) => id === "gpt-6.2-sol") ?? available[0];
}

export async function codexLiveListsModel(
  catalog: CodexLiveCatalog | undefined,
  userId: string,
  secret: StoredModelSecret,
  modelId: string,
  opts?: CodexLiveReadOptions,
): Promise<boolean> {
  return Boolean(await codexLiveModel(catalog, userId, secret, modelId, opts));
}

/**
 * The live per-account catalog for every ChatGPT OAuth credential governing a
 * codex slot in this space, keyed by credential secret id. Credentials that are
 * unreadable, non-OAuth, or lack an account id — and reads that fail — map to no
 * entry, so their models keep the static availability (which hides Codex Spark).
 * No token refresh or credential write happens here: an expired bearer only
 * fires `opts.onExpiredToken` so the caller can kick the runtime's locked
 * refresh path, and this read still gets no catalog.
 */
export async function codexLiveCatalogsForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
  auth: CodexCatalogSpaceAuth,
  catalog: CodexLiveCatalog,
  opts?: { onExpiredToken?: (secretId: string) => void },
): Promise<Map<string, CodexCatalogModel[]>> {
  const live = new Map<string, CodexCatalogModel[]>();
  const secretIds = oauthCodexSecretIds(auth);
  if (secretIds.length === 0) return live;
  const secrets = await prisma.secret.findMany({
    where: { id: { in: secretIds }, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const accounts = new Map<string, CodexCatalogAccount>();
  for (const secret of secrets) {
    let credential: OAuthCredential | undefined;
    try {
      const parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
      credential = parsed.kind === "oauth" ? parsed.credential : undefined;
    } catch {
      // Unreadable secrets keep static behavior.
    }
    const account = credential
      ? codexAccountHandle(credential, () => opts?.onExpiredToken?.(secret.id))
      : null;
    if (account) accounts.set(secret.id, account);
  }
  await Promise.all(
    [...accounts].map(async ([secretId, account]) => {
      const models = await catalog.read(scope.userId, account).catch(() => undefined);
      if (models) live.set(secretId, models);
    }),
  );
  return live;
}

/** Distinct secret ids of credentials governing an OAuth-kind codex slot. */
function oauthCodexSecretIds(auth: CodexCatalogSpaceAuth): string[] {
  const ids = new Set<string>();
  if (auth.byProvider[CHATGPT_OAUTH_PROVIDER] === "oauth") {
    const id = auth.secretIdByProvider?.[CHATGPT_OAUTH_PROVIDER];
    if (id) ids.add(id);
  }
  const byModel = auth.byModel[CHATGPT_OAUTH_PROVIDER] ?? {};
  for (const modelId of Object.keys(byModel)) {
    if (byModel[modelId] !== "oauth") continue;
    const id = auth.secretIdByModel?.[CHATGPT_OAUTH_PROVIDER]?.[modelId];
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Overlay the live catalogs on the static-filtered list. A codex entry governed
 * by a ChatGPT OAuth credential is available exactly when that credential's own
 * catalog lists it — which can restore statically excluded models like Codex
 * Spark. Entries governed by an API key, by an unreadable (per-model
 * "disconnected") credential, or by a credential whose catalog could not be
 * read keep their static behavior. Only slugs the pi registry knows are
 * overlayable — a live-only model cannot resolve to a runtime Model, so unknown
 * slugs are ignored rather than listed as broken picks. The pi catalog supplies
 * every field the endpoint lacks; a catalog sharing no known static slug is
 * ignored as untrusted.
 */
export function applyCodexLiveCatalog(
  base: readonly PiCatalogEntry[],
  auth: CodexCatalogSpaceAuth,
  liveBySecretId: ReadonlyMap<string, readonly CodexCatalogModel[]>,
): PiCatalogEntry[] {
  const knownSlugs = knownCodexSlugs();
  const trusted = new Map<string, Map<string, CodexCatalogModel>>();
  for (const [secretId, models] of liveBySecretId) {
    if (!models.some((model) => knownSlugs.has(model.slug))) continue;
    trusted.set(secretId, new Map(models.map((model) => [model.slug, model])));
  }
  if (trusted.size === 0) return [...base];
  const baseSet = new Set(base);
  const out: PiCatalogEntry[] = [];
  for (const entry of listPiCatalog()) {
    if (entry.provider !== CHATGPT_OAUTH_PROVIDER) {
      if (baseSet.has(entry)) out.push(entry);
      continue;
    }
    const modelKind = auth.byModel[entry.provider]?.[entry.id];
    const kind = modelKind ?? auth.byProvider[entry.provider] ?? "disconnected";
    const secretId =
      modelKind === undefined
        ? auth.secretIdByProvider?.[entry.provider]
        : auth.secretIdByModel?.[entry.provider]?.[entry.id];
    const live = kind === "oauth" && secretId ? trusted.get(secretId) : undefined;
    if (!live) {
      if (baseSet.has(entry)) out.push(entry);
      continue;
    }
    const liveModel = live.get(entry.id);
    if (liveModel) out.push(withLiveFields(entry, liveModel));
  }
  return out;
}

function withLiveFields(entry: PiCatalogEntry, model: CodexCatalogModel): PiCatalogEntry {
  const listed = codexAccountCatalogModelIds.has(entry.id)
    ? { ...entry, images: model.supportsImages }
    : entry;
  const thinkingLevels = liveThinkingLevels(model);
  return thinkingLevels
    ? { ...listed, reasoning: true, thinkingLevels }
    : { ...listed, reasoning: listed.reasoning || model.reasoningEfforts.length > 0 };
}

export function liveThinkingLevels(model: CodexCatalogModel): ThinkingLevel[] | undefined {
  const levels = [
    ...new Set(
      model.reasoningEfforts.flatMap((effort) => {
        const parsed = ThinkingLevelSchema.safeParse(effort);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
  return levels.length > 0 ? levels : undefined;
}
