import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type {
  ChatGPTPlanCredential,
  ChatGPTPlanRegistration,
  PiOAuthLogins,
  readChatGPTPlanModels,
} from "@rakazo/adapters";
import {
  CHATGPT_PLAN_PROVIDER_ID,
  createChatGPTPlanOAuthAuth,
  discoverChatGPTPlanModels,
  parseModelSecret,
  persistStoredModelSecret,
  readChatGPTPlanCredential,
  resolveModelAuth,
  revokeChatGPTPlanCredential,
  serializeModelSecret,
  withChatGPTPlanCredentialLock,
  withModelCredentialLock,
} from "@rakazo/adapters";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

const REGISTRATION_KIND = "chatgpt-plan-registration";
type Scope = { userId: string; spaceId: string };
type Login = NonNullable<Parameters<PiOAuthLogins["begin"]>[0]["login"]>;
type AuthInteraction = Parameters<Login>[0];
type Credential = Awaited<ReturnType<Login>>;
type DataDeps = {
  prisma: Pick<PrismaClient, "secret" | "userModelCredential">;
  secrets: SecretStore;
  dataDir: string;
  chatgptPlanFetch?: typeof fetch;
};
type Deps = DataDeps & {
  prisma: Pick<PrismaClient, "secret" | "userModelCredential" | "$transaction">;
};
type Profile = {
  version: 1;
  registration: ChatGPTPlanRegistration;
  label: string;
  idTokenHint?: string;
  signedOut?: boolean;
};
type SavedProfile = Profile & { id: string };
export type ChatGPTPlanConnectionCredential = ChatGPTPlanCredential & {
  registrationId: string;
  chatgptPlanModels: ReturnType<typeof readChatGPTPlanModels>;
};

/** Order finalization and disconnect even before the first credential exists. */
export async function lockChatGPTPlanConnection(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext('coginebot-chatgpt-plan-connection'), hashtext(${userId}))::text AS "lock"
  `);
}

export function isLocalChatGPTPlanOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** An installation identity, never an account identifier or credential. */
export async function chatGPTPlanHostId(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, "chatgpt-plan-host-id");
  const id = `urn:uuid:${randomUUID()}`;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(id);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, filename);
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let saved: string;
    try {
      saved = (await existing.readFile("utf8")).trim();
    } finally {
      await existing.close();
    }
    if (
      !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)
    ) {
      throw new Error("Stored ChatGPT host identity is invalid.");
    }
    return saved;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function profileValue(plaintext: string): Profile {
  let data: Profile;
  try {
    data = JSON.parse(plaintext) as Profile;
  } catch {
    throw new Error("Stored ChatGPT registration is invalid.");
  }
  if (
    data.version !== 1 ||
    !data.registration ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(data.registration.clientId) ||
    data.registration.clientId === "dynamic_agent_client" ||
    typeof data.label !== "string"
  ) {
    throw new Error("Stored ChatGPT registration is invalid.");
  }
  if (
    (data.registration.issuer !== undefined &&
      data.registration.issuer !== "https://auth.openai.com") ||
    (data.registration.subject !== undefined &&
      (typeof data.registration.subject !== "string" || !data.registration.subject)) ||
    (data.idTokenHint !== undefined && (typeof data.idTokenHint !== "string" || !data.idTokenHint))
  )
    throw new Error("Stored ChatGPT registration is invalid.");
  return data;
}

async function profiles(deps: DataDeps, actor: Scope): Promise<SavedProfile[]> {
  const rows = await deps.prisma.secret.findMany({
    where: { userId: actor.userId, spaceId: null, kind: REGISTRATION_KIND },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const saved: SavedProfile[] = [];
  for (const row of rows) {
    try {
      saved.push({ ...profileValue(await deps.secrets.load(row.ciphertext, row.id)), id: row.id });
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      // An unreadable registration cannot authorize requests, and must not
      // prevent connecting another account. Leave its encrypted record intact.
    }
  }
  return saved;
}

async function saveProfile(
  deps: DataDeps,
  actor: Scope,
  profile: Profile,
  id: string = randomUUID(),
): Promise<SavedProfile> {
  const stored = await deps.secrets.put(
    JSON.stringify(profile),
    {
      userId: actor.userId,
      spaceId: actor.spaceId,
      operationId: "models.chatgpt-registration",
      traceId: "models.chatgpt-registration",
      signal: AbortSignal.timeout(30_000),
    },
    { recordId: id },
  );
  await deps.prisma.secret.upsert({
    where: { id },
    create: {
      id,
      userId: actor.userId,
      spaceId: null,
      kind: REGISTRATION_KIND,
      ciphertext: stored.ciphertext,
    },
    update: { ciphertext: stored.ciphertext },
  });
  return { ...profile, id };
}

/** Profile mutations never hold the account lock across authorization or model HTTP. */
async function withProfileLock<T>(
  deps: Deps,
  actor: Scope,
  operation: (scoped: DataDeps) => Promise<T>,
): Promise<T> {
  return deps.prisma.$transaction(
    async (tx) => {
      await lockChatGPTPlanConnection(tx, actor.userId);
      return operation({ ...deps, prisma: tx });
    },
    { maxWait: 15_000, timeout: 30_000 },
  );
}

async function updateProfile(
  deps: Deps,
  actor: Scope,
  id: string | undefined,
  mutation: (current: Profile | undefined) => Profile,
): Promise<SavedProfile> {
  return withProfileLock(deps, actor, async (scoped) => {
    const row = id
      ? await scoped.prisma.secret.findFirst({
          where: { id, userId: actor.userId, spaceId: null, kind: REGISTRATION_KIND },
        })
      : undefined;
    if (id && !row) throw new Error("ChatGPT registration was not found.");
    const current = row
      ? profileValue(await scoped.secrets.load(row.ciphertext, row.id))
      : undefined;
    return saveProfile(scoped, actor, mutation(current), id);
  });
}

function assertProfileBinding(
  current: Profile | undefined,
  registration: ChatGPTPlanRegistration,
  verified: boolean,
): void {
  if (
    current &&
    (current.registration.clientId !== registration.clientId ||
      (current.registration.issuer !== undefined &&
        current.registration.issuer !== registration.issuer) ||
      (verified &&
        current.registration.subject !== undefined &&
        (current.registration.subject !== registration.subject ||
          (current.registration.issuer ?? "https://auth.openai.com") !== registration.issuer)))
  ) {
    throw new Error("ChatGPT account changed. Connect the intended account again.");
  }
}

export async function listChatGPTPlanProfiles(deps: Deps, actor: Scope) {
  const active = await activeCredential(deps, actor).catch(() => undefined);
  return (await profiles(deps, actor)).map((profile) => ({
    id: profile.id,
    label: `${profile.label}${profile.registration.email ? ` · ${profile.registration.email}` : ""} (${profile.id.slice(0, 8)})`,
    status: (active?.credential.registrationId === profile.id
      ? "connected"
      : profile.signedOut
        ? "signed-out"
        : profile.registration.subject
          ? "registered"
          : "incomplete") as "connected" | "signed-out" | "registered" | "incomplete",
  }));
}

/** No bearer or identity token is ever transported through this listener. */
export async function createChatGPTPlanLoopback(signal: AbortSignal) {
  let expectedState: string | undefined;
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  let consumed = false;
  const result = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => undefined);
  let redirectUri = "";
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    let callback: URL;
    try {
      callback = new URL(request.url ?? "/", redirectUri);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const expected = new URL(redirectUri);
    if (
      consumed ||
      request.method !== "GET" ||
      request.headers.host !== expected.host ||
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      !expectedState ||
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.get("state") !== expectedState ||
      callback.searchParams.has("access_token") ||
      callback.searchParams.has("refresh_token") ||
      callback.searchParams.has("id_token")
    ) {
      response.writeHead(400).end("Authorization callback rejected.");
      return;
    }
    consumed = true;
    resolve(callback.href);
    response.end("Return to CogineBot.", close);
  });
  const close = () => {
    signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  };
  const abort = () => {
    reject(new Error("ChatGPT authorization cancelled."));
    close();
  };
  signal.throwIfAborted();
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => yes());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("Could not start ChatGPT authorization callback.");
  }
  redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    redirectUri,
    result,
    close,
    setAuthorizationUrl(url: string) {
      expectedState = new URL(url).searchParams.get("state") ?? undefined;
    },
  };
}

export function createChatGPTPlanLogin(
  deps: Deps,
  actor: Scope,
  input: {
    callbackTransport?: "desktop" | "loopback";
    registrationId?: string;
    newRegistration?: boolean;
    label?: string;
  },
): (interaction: AuthInteraction) => Promise<Credential> {
  return async (interaction) => {
    const signal = interaction.signal ?? AbortSignal.timeout(15 * 60_000);
    const saved = await profiles(deps, actor);
    const active = await activeCredential(deps, actor).catch(() => undefined);
    let selected = input.newRegistration
      ? undefined
      : input.registrationId
        ? saved.find((profile) => profile.id === input.registrationId)
        : (saved.find((profile) => profile.id === active?.credential.registrationId) ?? saved[0]);
    if (input.registrationId && !selected && !input.newRegistration)
      throw new Error("ChatGPT registration was not found.");
    const listener =
      input.callbackTransport === "desktop" ? undefined : await createChatGPTPlanLoopback(signal);
    try {
      const auth = createChatGPTPlanOAuthAuth({
        fetch: deps.chatgptPlanFetch,
        getLoginContext: async () => ({
          hostId: await chatGPTPlanHostId(deps.dataDir),
          redirectUri: listener?.redirectUri ?? "http://127.0.0.1:1455/auth/callback",
          registration: selected?.registration,
          // The authorization URL crosses the renderer/RPC boundary. Omit the
          // optional ID-token hint so credential material stays in the backend.
          agentName: "CogineBot",
          onRegistration: async (registration) => {
            selected = await updateProfile(deps, actor, selected?.id, (current) => {
              const issued = {
                clientId: registration.clientId,
                ...(registration.issuer ? { issuer: registration.issuer } : {}),
              };
              assertProfileBinding(current, issued, false);
              return {
                version: 1,
                registration: { ...current?.registration, ...issued },
                label: input.label ?? current?.label ?? "ChatGPT",
                ...(current?.signedOut ? { signedOut: true } : {}),
              };
            });
          },
        }),
      });
      const value = await auth.login({
        ...interaction,
        signal,
        notify(event) {
          if (event.type === "auth_url") listener?.setAuthorizationUrl(event.url);
          interaction.notify(event);
        },
        prompt(prompt) {
          return listener && prompt.type === "manual_code"
            ? listener.result
            : interaction.prompt(prompt);
        },
      });
      const credential = readChatGPTPlanCredential(value);
      if (!credential || !selected) throw new Error("ChatGPT authorization is incomplete.");
      const models = await discoverChatGPTPlanModels(credential.access, {
        fetch: deps.chatgptPlanFetch,
        signal: interaction.signal,
      });
      if (!models.length) throw new Error("No models are available for this ChatGPT account.");
      signal.throwIfAborted();
      selected = await updateProfile(deps, actor, selected.id, (current) => {
        const registration = {
          clientId: credential.clientId,
          issuer: credential.issuer,
          subject: credential.subject,
          ...(credential.email !== undefined ? { email: credential.email } : {}),
        };
        // Another process may have verified an initially incomplete registration
        // while this attempt waited for authorization or model discovery.
        assertProfileBinding(current, registration, true);
        return {
          version: 1,
          registration: { ...current?.registration, ...registration },
          label: input.label ?? current?.label ?? "ChatGPT",
        };
      });
      return { ...credential, registrationId: selected.id, chatgptPlanModels: models };
    } finally {
      listener?.close();
    }
  };
}

async function activeCredential(deps: DataDeps, actor: Scope, credentialId?: string) {
  const row = await deps.prisma.userModelCredential.findFirst({
    where: {
      userId: actor.userId,
      provider: CHATGPT_PLAN_PROVIDER_ID,
      ...(credentialId ? { id: credentialId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (!row) return undefined;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: row.secretId, userId: actor.userId, spaceId: null },
  });
  if (!secret) return undefined;
  const parsed = parseModelSecret(await deps.secrets.load(secret.ciphertext, secret.id));
  if (parsed.kind !== "oauth") throw new Error("Stored ChatGPT connection is invalid.");
  const credential = readChatGPTPlanCredential(parsed.credential) as
    | ChatGPTPlanConnectionCredential
    | undefined;
  if (!credential || typeof credential.registrationId !== "string" || !credential.registrationId)
    throw new Error("Stored ChatGPT connection is invalid.");
  return { row, secret, credential };
}

const catalogCache = new Map<
  string,
  { access: string; expires: number; models: ReturnType<typeof readChatGPTPlanModels> }
>();

/** Account model discovery cannot silently fall back to another provider/catalog. */
export async function applyChatGPTPlanCatalog(
  deps: Deps,
  actor: Scope,
  catalog: ModelCatalogEntry[],
): Promise<ModelCatalogEntry[]> {
  try {
    return await connectedChatGPTPlanCatalog(deps, actor, catalog);
  } catch {
    // A ChatGPT outage must not remove unrelated model providers. Keep only
    // the non-executable connection placeholder, never stale account models.
    return catalog.map((entry) =>
      entry.provider === CHATGPT_PLAN_PROVIDER_ID
        ? {
            ...entry,
            id: "connect",
            placeholder: true,
            label: "Continue with ChatGPT",
            billing: "ChatGPT models are unavailable. Reconnect or try again.",
          }
        : entry,
    );
  }
}

async function connectedChatGPTPlanCatalog(
  deps: Deps,
  actor: Scope,
  catalog: ModelCatalogEntry[],
): Promise<ModelCatalogEntry[]> {
  const active = await activeCredential(deps, actor);
  if (!active) return catalog;
  const models = await withModelCredentialLock(active.secret.id, async () => {
    const resolved = await withChatGPTPlanCredentialLock(
      deps.prisma,
      active.secret.id,
      async (tx) => {
        const current = await activeCredential({ ...deps, prisma: tx }, actor);
        if (!current || current.secret.id !== active.secret.id)
          throw new Error("ChatGPT connection changed.");
        return resolveModelAuth(
          await deps.secrets.load(current.secret.ciphertext, current.secret.id),
          CHATGPT_PLAN_PROVIDER_ID,
          {
            oauth: createChatGPTPlanOAuthAuth({ fetch: deps.chatgptPlanFetch }),
            persist: persistStoredModelSecret(tx, deps.secrets, actor, current.secret.id),
          },
        );
      },
    );
    const cached = catalogCache.get(active.secret.id);
    if (cached && cached.access === resolved.apiKey && cached.expires > Date.now())
      return cached.models;
    const discovered = await discoverChatGPTPlanModels(resolved.apiKey, {
      fetch: deps.chatgptPlanFetch,
      signal: AbortSignal.timeout(30_000),
    });
    const published = await withChatGPTPlanCredentialLock(
      deps.prisma,
      active.secret.id,
      async (tx) => {
        const current = await activeCredential({ ...deps, prisma: tx }, actor);
        if (
          !current ||
          current.secret.id !== active.secret.id ||
          current.credential.access !== resolved.apiKey
        )
          return false;
        const stored = parseModelSecret(
          await deps.secrets.load(current.secret.ciphertext, current.secret.id),
        );
        if (stored.kind !== "oauth") throw new Error("Stored ChatGPT connection is invalid.");
        await persistStoredModelSecret(
          tx,
          deps.secrets,
          actor,
          current.secret.id,
        )(
          serializeModelSecret({
            ...stored,
            credential: { ...stored.credential, chatgptPlanModels: discovered },
          }),
        );
        return true;
      },
    );
    if (!published) throw new Error("ChatGPT connection changed. Refresh the model list.");
    if (catalogCache.size >= 500) catalogCache.delete(catalogCache.keys().next().value!);
    catalogCache.set(active.secret.id, {
      access: resolved.apiKey,
      expires: Date.now() + 60_000,
      models: discovered,
    });
    return discovered;
  });
  const placeholder = catalog.find((entry) => entry.provider === CHATGPT_PLAN_PROVIDER_ID);
  return [
    ...catalog.filter((entry) => entry.provider !== CHATGPT_PLAN_PROVIDER_ID),
    ...(models.length === 0 && placeholder
      ? [placeholder]
      : models.map((model) => ({
          ...placeholder,
          provider: CHATGPT_PLAN_PROVIDER_ID,
          providerName: "ChatGPT",
          id: model.id,
          label: model.name,
          billing: "Uses your ChatGPT plan.",
          auth: "oauth" as const,
          subscription: true,
          signIn: "auth-url" as const,
          oauthLabel: "Continue with ChatGPT",
          placeholder: false,
          catalogProbe: false,
          reasoning: model.reasoning ?? false,
        }))),
  ];
}

export async function disconnectChatGPTPlan(
  deps: Deps,
  actor: Scope,
  removeCredentials?: (tx: Prisma.TransactionClient) => Promise<void>,
  options: {
    credentialId?: string;
    validateRemoval?: (tx: Prisma.TransactionClient) => Promise<void>;
  } = {},
): Promise<{ confirmed: boolean }> {
  let confirmed = true;
  const selected = await deps.prisma.userModelCredential.findFirst({
    where: {
      userId: actor.userId,
      provider: CHATGPT_PLAN_PROVIDER_ID,
      ...(options.credentialId ? { id: options.credentialId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (selected) {
    await withModelCredentialLock(selected.secretId, async () => {
      await withChatGPTPlanCredentialLock(deps.prisma, selected.secretId, async (tx) => {
        await lockChatGPTPlanConnection(tx, actor.userId);
        await options.validateRemoval?.(tx);
        const latest = await tx.userModelCredential.findFirst({
          where: { id: selected.id, userId: actor.userId, provider: CHATGPT_PLAN_PROVIDER_ID },
        });
        if (
          !latest ||
          latest.secretId !== selected.secretId ||
          latest.connectionRevision !== selected.connectionRevision
        ) {
          throw new ORPCError("CONFLICT", {
            message: "ChatGPT connection changed. Reload and try again.",
          });
        }
        const current = await activeCredential({ ...deps, prisma: tx }, actor, selected.id).catch(
          () => {
            confirmed = false;
            return undefined;
          },
        );
        if (current)
          confirmed = (
            await revokeChatGPTPlanCredential(current.credential, AbortSignal.timeout(30_000), {
              fetch: deps.chatgptPlanFetch,
            })
          ).confirmed;
        await removeCredentials?.(tx);
      });
    });
    catalogCache.delete(selected.secretId);
  } else if (removeCredentials) {
    await deps.prisma.$transaction(async (tx) => {
      await lockChatGPTPlanConnection(tx, actor.userId);
      await options.validateRemoval?.(tx);
      const appeared = await tx.userModelCredential.findFirst({
        where: {
          userId: actor.userId,
          provider: CHATGPT_PLAN_PROVIDER_ID,
          ...(options.credentialId ? { id: options.credentialId } : {}),
        },
      });
      if (appeared)
        throw new ORPCError("CONFLICT", {
          message: "ChatGPT connection changed. Reload and try again.",
        });
      await removeCredentials(tx);
    });
  }
  await withProfileLock(deps, actor, async (scoped) => {
    for (const profile of await profiles(scoped, actor).catch(() => {
      confirmed = false;
      return [];
    })) {
      await saveProfile(
        scoped,
        actor,
        { version: 1, registration: profile.registration, label: profile.label, signedOut: true },
        profile.id,
      );
    }
  });
  return { confirmed };
}
