import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  BotSecretAuth,
  BotSecretName,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeLoginSecret,
  isPrivateNetworkHost,
  loginSecretFields,
  SecretHttpRequest,
} from "@rakazo/contracts";
import { BOT_SECRET_HTTP_REQUEST_KIND } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { ActionRuleDispatchError } from "./connector-dispatch.js";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export type BotSecretScope = { userId: string; spaceId: string; botId: string };
function scopeFields({ userId, spaceId, botId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId, botId };
}

const metadata = { name: true, origin: true, auth: true } as const;

const UNUSABLE_CREDENTIAL = "Credential cannot be used with this authentication method";

/** `encodeURIComponent` throws on an unpaired surrogate. */
function percentEncoded(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function commandRedactionForms(value: string): string[] {
  const forms = [value, Buffer.from(value).toString("base64")];
  const encoded = percentEncoded(value);
  if (encoded !== undefined) forms.push(encoded);
  return forms;
}

export function commandCredentialRedactions(environment: Record<string, string>): string[] {
  return [...new Set(Object.values(environment).flatMap(commandRedactionForms))];
}

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  // A login is only typed into its site, and a command variable only reaches shell commands.
  if (destination.auth.type === "login" || destination.auth.type === "command") {
    throw new Error("Credential cannot be used with this authentication method");
  }
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

/** Owner escape enabling plain-HTTP origins on private LAN hosts (see #907). */
export function allowPrivateHttpSecretOrigins(): boolean {
  return process.env.RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP === "1";
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const parsed = botSecretDestinationSchema({
    allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
  }).safeParse(value);
  if (!parsed.success) {
    // Surface the actual failing field: models (and people) supply all three
    // parts and still fail on a name character or an origin rule, and a
    // generic "specify name, origin, auth" error sends them retrying blind.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "credential"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid credential destination — ${detail}`);
  }
  if (parsed.data.auth.type === "command") return parsed.data;
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

function isCommandCredential(auth: unknown): boolean {
  const parsed = BotSecretAuth.safeParse(auth);
  return parsed.success && parsed.data.type === "command";
}

/**
 * What the bot's tools show for a saved credential. A command variable has no site, so it is
 * listed with the environment variable its shell commands read instead.
 */
export function botSecretToolView(row: { name: string; origin: string; auth: unknown }) {
  if (!isCommandCredential(row.auth)) return row;
  const variable = commandVariableName(row.name);
  const problem = commandVariableProblem(variable);
  if (problem === undefined) return { name: row.name, auth: row.auth, variable };
  const reason =
    problem === "reserved"
      ? `$${variable} is reserved and is not exported.`
      : `$${variable} is not a valid environment variable name and is not exported.`;
  return {
    name: row.name,
    auth: row.auth,
    error: `${reason} Remove it and save it under another name.`,
  };
}

/**
 * Decrypt this bot's command variables for one shell command. Loaded per command so an added,
 * replaced, or removed value applies to the next command. The values must never be logged or
 * returned; callers register them for redaction before the command runs.
 */
export async function loadBotCommandEnvironment(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: BotSecretScope,
  unsetVariables?: Set<string>,
): Promise<Record<string, string>> {
  const rows = await prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: { id: true, name: true, auth: true, ciphertext: true },
    orderBy: { name: "asc" },
    take: 100,
  });
  const environment: Record<string, string> = {};
  for (const row of rows) {
    if (!isCommandCredential(row.auth)) continue;
    const variable = commandVariableName(row.name);
    if (commandVariableProblem(variable)) continue;
    let value: string;
    try {
      value = await secretStore.load(row.ciphertext, row.id);
    } catch {
      // One unreadable value must not stop every shell command; the variable is left unset.
      unsetVariables?.add(variable);
      continue;
    }
    if (value && !value.includes("\0")) environment[variable] = value;
  }
  return environment;
}

/**
 * The environment for one shell command: the space variables, with this bot's command variables
 * loaded fresh over them (the bot's own value wins a name clash). The bot's values are handed to
 * `registerRedactions` before this returns, so the command's output is redacted.
 */
export async function shellCommandEnvironment(input: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  scope: BotSecretScope;
  spaceEnvironment: Record<string, string>;
  registerRedactions: (values: string[]) => void;
}): Promise<{ env: Record<string, string>; unsetEnv: string[] }> {
  const unsetVariables = new Set<string>();
  const botEnvironment = await loadBotCommandEnvironment(
    input.prisma,
    input.secretStore,
    input.scope,
    unsetVariables,
  );
  // Encoded forms too, as secret_request does, so an accidental `base64` or URL-encoding of a
  // value is still redacted from command output.
  input.registerRedactions(commandCredentialRedactions(botEnvironment));
  const environment = { ...input.spaceEnvironment, ...botEnvironment };
  // A failed bot credential still shadows the space credential with the same name.
  for (const variable of unsetVariables) delete environment[variable];
  return { env: environment, unsetEnv: [...unsetVariables] };
}

/** Another command credential of this bot that is exported as the same variable. */
export async function findCommandVariableConflict(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  destination: BotSecretDestination,
): Promise<string | undefined> {
  if (destination.auth.type !== "command") return undefined;
  const variable = commandVariableName(destination.name);
  const rows = await client.botSecret.findMany({
    where: { ...scopeFields(scope), name: { not: destination.name } },
    select: { name: true, auth: true },
    take: 100,
  });
  return rows.find(
    (row) => isCommandCredential(row.auth) && commandVariableName(row.name) === variable,
  )?.name;
}

export type RequestSecretDestinationResult = {
  /** Metadata only. The protected value is never part of this result. */
  destination?: BotSecretDestination;
  connectionId?: string;
  error?: string;
};

/**
 * The model-facing schema is one object, so a credential often arrives beside
 * `connectionId`, as a JSON string, or as top-level `name` / `origin` / `auth`
 * instead of a nested `credential`. A destination that normalizes is the masked
 * reusable path. `connectionId` applies only when no credential was supplied.
 */
export function resolveRequestSecretDestination(
  args: Record<string, unknown>,
): RequestSecretDestinationResult {
  const credential = credentialArgument(args);
  if (credential !== undefined) {
    try {
      return { destination: normalizeSecretDestination(credential) };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.message.startsWith("Invalid credential destination")
            ? error.message
            : "Specify a credential name, HTTPS origin, and auth method.",
      };
    }
  }
  const connectionId = connectionIdArgument(args.connectionId);
  if (connectionId) return { connectionId };
  return { error: "Provide either a reusable credential destination or a connectionId." };
}

const destinationFields = ["name", "origin", "auth"] as const;

/**
 * Credential object from `credential`, a JSON string of that object, or top-level fields.
 * Only destination metadata is returned. A partial `name` / `origin` / `auth` set is still
 * a credential attempt so it cannot fall through to `connectionId`.
 */
export function credentialArgument(args: Record<string, unknown>): unknown {
  if (Object.hasOwn(args, "credential") && args.credential != null && args.credential !== "") {
    return parsedCredentialObject(args.credential);
  }
  if (destinationFields.some((key) => Object.hasOwn(args, key))) {
    return destinationMetadata(args);
  }
  return undefined;
}

export function connectionIdArgument(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return undefined;
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `{ name, origin, auth }` only. Secret fields must not survive, including ones nested in
 * `auth` or carried in an origin string. The effect request is this object, and destination
 * parsing strips extras only from its own copy.
 */
function destinationMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of destinationFields) {
    if (!Object.hasOwn(record, key)) continue;
    if (key === "auth") {
      const auth = authMetadata(record.auth);
      if (auth !== undefined) metadata.auth = auth;
      continue;
    }
    if (key === "origin") {
      const origin = originMetadata(record.origin);
      if (origin !== undefined) metadata.origin = origin;
      continue;
    }
    if (typeof record.name === "string") {
      // Keep a real name. Anything else is replaced so a secret in that string is not recorded,
      // while destination validation still reports the name pattern.
      metadata.name = BotSecretName.safeParse(record.name).success ? record.name : "Invalid Name";
    }
  }
  return metadata;
}

/**
 * Parsed auth, or a stand-in that fails the same way. The stand-in does not copy the
 * original fields: an invalid method or header can still carry a secret, and the effect
 * row is written before destination validation.
 */
function authMetadata(value: unknown): unknown {
  const parsed = BotSecretAuth.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isPlainObject(value)) return undefined;
  if (value.type === "header") {
    if (typeof value.name !== "string") return { type: "header" };
    const header = BotSecretAuth.safeParse({ type: "header", name: value.name });
    const unsupported =
      !header.success &&
      header.error.issues.some((issue) => issue.message === "Unsupported credential header");
    return { type: "header", name: unsupported ? "Cookie" : "bad header" };
  }
  if (value.type === "basic") {
    if (typeof value.username !== "string") return { type: "basic" };
    return { type: "basic", username: ":" };
  }
  return { type: "invalid" };
}

/**
 * Keep a bare origin. Never return the raw string: `new URL` resolves `..`, so the raw
 * path can still hold a secret while the parsed path is `/`. Userinfo, query, fragment,
 * and a real path are removed. A placeholder keeps the origin error when no bare origin remains.
 */
function originMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "") return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid-origin";
  }
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  if (bare) return url.origin;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.pathname === "/" ? url.origin : `${url.origin}/path`;
}

function parsedCredentialObject(value: unknown): unknown {
  if (typeof value !== "string") {
    // Not metadata. Keep the attempt, but do not forward the raw value into the effect.
    return isPlainObject(value) ? destinationMetadata(value) : {};
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return destinationMetadata(parsed);
  } catch {
    return {};
  }
  return {};
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: metadata,
  });
  return row ? normalizeSecretDestination(row) : null;
}

export async function prepareBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
  expectedRevision?: string | null;
  requireBotOwner?: boolean;
}) {
  const { prisma, secretStore, scope, plaintext } = input;
  const destination = normalizeSecretDestination(input.destination);
  const login = validateBotSecretValue(destination, plaintext);
  if (login && "fields" in login && input.expectedRevision === undefined) throw credentialChanged();
  const existing = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  function validate(row: typeof existing, count: number) {
    validateBotSecretSlot(row, count, destination);
  }
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== (existing?.revision ?? null)
  )
    throw credentialChanged();
  validate(existing, await prisma.botSecret.count({ where: scopeFields(scope) }));
  if (existing && login && !("fields" in login)) {
    const stored = await secretStore.load(existing.ciphertext, existing.id);
    let currentLogin: ReturnType<typeof decodeLoginSecret>;
    try {
      currentLogin = decodeLoginSecret(stored);
    } catch {
      throw new BotSecretConflictError("This login cannot be edited in the current form.");
    }
    if ("fields" in currentLogin)
      throw new BotSecretConflictError(
        "This login uses named fields. Use a form that supports them.",
      );
  }
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const stored = await secretStore.put(
    login && "fields" in login ? encodeLoginSecret(login) : plaintext,
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: new AbortController().signal,
    },
    { recordId: id },
  );
  return {
    id,
    ciphertext: stored.ciphertext,
    async store(tx: Prisma.TransactionClient) {
      if (!(await lockBotSecretScope(tx, scope, input.requireBotOwner ?? false)))
        throw credentialChanged();
      const current = await tx.botSecret.findFirst({
        where: { ...scopeFields(scope), name: destination.name },
      });
      if (current?.id !== existing?.id || current?.revision !== existing?.revision)
        throw credentialChanged();
      validate(current, await tx.botSecret.count({ where: scopeFields(scope) }));
      const conflict = await findCommandVariableConflict(tx, scope, destination);
      if (conflict) {
        throw new Error(
          `Invalid credential destination — name: ${conflict} is already exported as $${commandVariableName(destination.name)}`,
        );
      }
      if (current) {
        const updated = await tx.botSecret.updateMany({
          where: { id, ...scopeFields(scope), revision: current.revision },
          data: { ciphertext: stored.ciphertext },
        });
        if (updated.count !== 1) throw credentialChanged();
      } else {
        await tx.botSecret.create({
          data: { id, ...scopeFields(scope), ...destination, ciphertext: stored.ciphertext },
        });
      }
    },
  };
}

function validateBotSecretValue(destination: BotSecretDestination, plaintext: string) {
  if (typeof plaintext !== "string" || !plaintext || plaintext.length > 16_384)
    throw new Error("Invalid credential length");
  if (destination.auth.type === "login") return decodeLoginSecret(plaintext);
  else if (destination.auth.type === "command") {
    // NUL cannot be an environment value. An unpaired surrogate cannot be percent-encoded
    // later, and that throw would abort every subsequent shell command for this bot.
    if (plaintext.includes("\0") || percentEncoded(plaintext) === undefined) {
      throw new Error(UNUSABLE_CREDENTIAL);
    }
  } else credentialHeader(destination, plaintext);
}

function validateBotSecretSlot(
  row: { name: string; origin: string; auth: unknown } | null,
  count: number,
  destination: BotSecretDestination,
) {
  if (row && !sameSecretDestination(normalizeSecretDestination(row), destination))
    throw new Error("Remove the existing credential before changing its destination");
  if (!row && count >= 100) throw new Error("Credential limit reached");
}

/** Transfer only typed credentials; values and login fields stay out of metadata. */
export function validateTransferBotSecret(destination: unknown, plaintext: string) {
  const normalized = normalizeSecretDestination(destination);
  if (normalized.auth.type === "command")
    throw new Error("This credential type cannot be transferred");
  try {
    const login = validateBotSecretValue(normalized, plaintext);
    return { destination: normalized, plaintext: login ? encodeLoginSecret(login) : plaintext };
  } catch {
    throw new Error(UNUSABLE_CREDENTIAL);
  }
}

export type ExpectedBotSecret =
  | { kind: "absent" }
  | { kind: "present"; id: string; revision: string };

export class BotSecretConflictError extends Error {
  constructor(message = "The saved credential changed. Review the transfer again.") {
    super(message);
    this.name = "BotSecretConflictError";
  }
}

function credentialChanged() {
  return new BotSecretConflictError(
    "The saved credential changed. Reload credentials and try again.",
  );
}

async function lockBotSecretScope(
  tx: Prisma.TransactionClient,
  scope: BotSecretScope,
  requireBotOwner: boolean,
) {
  const bots = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM bots WHERE id=${scope.botId} AND "spaceId"=${scope.spaceId}
      AND "archivedAt" IS NULL AND (NOT ${requireBotOwner} OR "userId"=${scope.userId})
    FOR UPDATE`;
  return bots.length === 1;
}

/** Adopt a provider-prepared value inside the caller's authorization/receipt transaction. No I/O. */
export async function adoptPreparedBotSecret(
  tx: Prisma.TransactionClient,
  input: {
    scope: BotSecretScope;
    destination: BotSecretDestination;
    recordId: string;
    ciphertext: string;
    expected: ExpectedBotSecret;
  },
): Promise<{ id: string; revision: string }> {
  const { scope, recordId, ciphertext, expected } = input;
  if (!recordId || !ciphertext || ciphertext.length > 4_000_000) throw new BotSecretConflictError();
  const destination = normalizeSecretDestination(input.destination);
  if (!(await lockBotSecretScope(tx, scope, true))) throw new BotSecretConflictError();
  const current = await tx.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  if (
    (expected.kind === "absent" && current !== null) ||
    (expected.kind === "present" &&
      (!current ||
        current.id !== expected.id ||
        current.revision !== expected.revision ||
        recordId !== current.id))
  )
    throw new BotSecretConflictError();
  validateBotSecretSlot(
    current,
    await tx.botSecret.count({ where: scopeFields(scope) }),
    destination,
  );
  if (await findCommandVariableConflict(tx, scope, destination)) throw new BotSecretConflictError();
  if (!current) {
    return tx.botSecret.create({
      data: { id: recordId, ...scopeFields(scope), ...destination, ciphertext },
      select: { id: true, revision: true },
    });
  }
  const changed = await tx.botSecret.updateMany({
    where: {
      id: current.id,
      ...scopeFields(scope),
      revision: expected.kind === "present" ? expected.revision : "",
      ciphertext: current.ciphertext,
    },
    data: { ciphertext },
  });
  if (changed.count !== 1) throw new BotSecretConflictError();
  return tx.botSecret.findUniqueOrThrow({
    where: { id: current.id },
    select: { id: true, revision: true },
  });
}

export async function storeBotSecret(
  input: Omit<Parameters<typeof prepareBotSecret>[0], "requireBotOwner">,
) {
  return withTransactionRetry(async () => {
    const prepared = await prepareBotSecret({ ...input, requireBotOwner: true });
    return persistPreparedSecret(input.prisma, input.secretStore, prepared, () =>
      input.prisma.$transaction(async (tx) => {
        await prepared.store(tx);
        return getBotSecretMetadata(tx, input.scope, input.destination.name);
      }),
    );
  });
}

export async function listBotSecrets(prisma: PrismaClient, scope: BotSecretScope) {
  const rows = await prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: metadata,
    orderBy: { name: "asc" },
    take: 100,
  });
  return rows.map(botSecretToolView);
}

// Owner metadata includes the mutation precondition but no row id or encrypted value.
const ownerMetadata = { ...metadata, createdAt: true, updatedAt: true, revision: true } as const;

export function listBotSecretMetadata(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: ownerMetadata,
    orderBy: { name: "asc" },
    take: 100,
  });
}

export function getBotSecretMetadata(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  return client.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: ownerMetadata,
  });
}

export async function forgetBotSecret(
  prisma: PrismaClient,
  scope: BotSecretScope,
  name: string,
  options?: { expectedRevision?: string; requireBotOwner?: boolean },
) {
  const expectedRevision = options?.expectedRevision;
  await prisma.$transaction(async (tx) => {
    if (!(await lockBotSecretScope(tx, scope, options?.requireBotOwner ?? false)))
      throw credentialChanged();
    const removed = await tx.botSecret.deleteMany({
      where: {
        ...scopeFields(scope),
        name,
        ...(expectedRevision !== undefined && { revision: expectedRevision }),
      },
    });
    if (expectedRevision !== undefined && removed.count !== 1) throw credentialChanged();
  });
  return { removed: true };
}

type BotSecretHttpBinding = Pick<
  Extract<ExpectedBotSecret, { kind: "present" }>,
  "id" | "revision"
>;

export const BOT_SECRET_HTTP_APPROVAL_CHANGED =
  "The saved credential changed or was not bound to this request. Ask for a new approval.";

export class BotSecretHttpRequestError extends ActionRuleDispatchError {}

function credentialHttpDestination(
  row: unknown,
  url: URL,
): { error: string } | { destination: BotSecretDestination } {
  let destination: BotSecretDestination;
  try {
    destination = normalizeSecretDestination(row);
  } catch {
    return { error: "Invalid authenticated request." };
  }
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  if (destination.auth.type === "command") {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands, as $${commandVariableName(destination.name)}.`,
    };
  }
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  return { destination };
}

export async function prepareBotSecretHttpEffect(
  prisma: PrismaClient,
  scope: BotSecretScope,
  args: Record<string, unknown>,
) {
  const request = SecretHttpRequest.parse(args);
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name: request.name },
    select: { ...metadata, id: true, revision: true },
  });
  if (!row)
    throw new BotSecretHttpRequestError(
      "Credential is unavailable. Use request_secret to save it first.",
    );
  const resolved = credentialHttpDestination(row, new URL(request.url.trim()));
  if ("error" in resolved) throw new BotSecretHttpRequestError(resolved.error);
  return [BOT_SECRET_HTTP_REQUEST_KIND, { id: row.id, revision: row.revision }, args];
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  beforeDispatch?: (tx?: Prisma.TransactionClient) => Promise<void>;
  credentialBinding?: BotSecretHttpBinding;
  registerRedactions?: (values: string[]) => void;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const where = { ...scopeFields(input.scope), name: request.name, ...input.credentialBinding };
  const row = await input.prisma.botSecret.findFirst({ where });
  if (!row) {
    return {
      error: input.credentialBinding
        ? BOT_SECRET_HTTP_APPROVAL_CHANGED
        : "Credential is unavailable. Use request_secret to save it first.",
    };
  }
  const url = new URL(request.url.trim());
  const resolved = credentialHttpDestination(row, url);
  if ("error" in resolved) return resolved;
  const destination = resolved.destination;
  const beforeDispatch = input.credentialBinding
    ? () =>
        withTransactionRetry(() =>
          input.prisma.$transaction(
            async (tx) => {
              const current = await tx.botSecret.findFirst({ where, select: { id: true } });
              if (!current) throw new BotSecretHttpRequestError(BOT_SECRET_HTTP_APPROVAL_CHANGED);
              await input.beforeDispatch?.(tx);
            },
            { isolationLevel: "RepeatableRead" },
          ),
        )
    : input.beforeDispatch;
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  const plaintext = await input.secretStore.load(row.ciphertext, {
    recordId: row.id,
    signal,
  });
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
  input.registerRedactions?.(redactions);
  // The safe fetch refuses plain-HTTP and private hosts outright. A credential
  // saved under the owner's private-HTTP opt-in was validated against exactly
  // those rules at save time, and the request URL is pinned to its origin, so
  // deliver it through the inverted transport instead — it re-checks that every
  // resolved address is private (metadata endpoints stay blocked) and pins the
  // connection to the validated answer.
  const privateHttpDestination =
    allowPrivateHttpSecretOrigins() &&
    url.protocol === "http:" &&
    isPrivateNetworkHost(url.hostname);
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname)
    : createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(
        url,
        { method: request.method, headers, body: request.body, redirect: "manual", signal },
        beforeDispatch,
      ),
      signal,
    );
    const bytes = await readBodyCapped(response, 1_000_000, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    return {
      status: response.status,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch (error) {
    if (error instanceof BotSecretHttpRequestError) return { error: error.message };
    if (error instanceof ActionRuleDispatchError) throw error;
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

export type LoginField = "username" | "password";
const MIN_REDACTED_VISIBLE_LOGIN_VALUE = 6;

/**
 * Resolve one field of a saved website login for a page fill. The caller must pass `origin` to
 * the page browser, which refuses to fill unless the page is still on that origin.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: SecretStore;
  scope: BotSecretScope;
  name: string;
  field: LoginField;
}): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: input.name },
  });
  if (!row) return { error: "Login is unavailable. Use request_secret to save it first." };
  if (isCommandCredential(row.auth)) {
    return {
      error: `${UNUSABLE_CREDENTIAL}. Command variables are only available to shell commands.`,
    };
  }
  // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
  let storedOrigin: URL;
  try {
    storedOrigin = new URL(row.origin);
  } catch {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  if (storedOrigin.protocol !== "https:") {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type !== "login") {
    return { error: "This credential is not a website login." };
  }
  if (destination.origin !== storedOrigin.origin) {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const plaintext = await input.secretStore.load(row.ciphertext, row.id);
  let fields: ReturnType<typeof loginSecretFields>;
  try {
    fields = loginSecretFields(decodeLoginSecret(plaintext));
  } catch {
    return { error: UNUSABLE_CREDENTIAL };
  }
  // Old browser actions support only these two field categories. The stored visibility
  // takes precedence over the label, so a hidden field cannot be chosen for a text input.
  const hidden = input.field === "password";
  const eligible = fields.filter((field) => field.hidden === hidden);
  const field = eligible.find((field) => field.label.toLowerCase() === input.field) ?? eligible[0];
  if (!field) return { error: "This login has no field for this input type." };
  const redactions = fields
    .filter(({ hidden, value }) => hidden || value.length >= MIN_REDACTED_VISIBLE_LOGIN_VALUE)
    .flatMap(({ value }) => {
      const encoded = percentEncoded(value);
      return encoded === undefined ? [value] : [value, encoded];
    });
  return {
    text: field.value,
    origin: destination.origin,
    redactions: [...new Set(redactions)],
  };
}
