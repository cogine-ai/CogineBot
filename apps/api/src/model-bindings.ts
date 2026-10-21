import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  enabledOpenAiCompatibleModelIds,
  isCatalogModelChoice,
  loadStoredModelSecret,
  parseModelSecret,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { findBoundModelCredential } from "@rakazo/db";

type BindingClient = Pick<PrismaClient, "userModelCredential" | "secret">;
type ReferenceClient = Pick<
  PrismaClient,
  "bot" | "routine" | "run" | "spaceBackupModel" | "spaceModelPreference" | "userModelCredential"
>;

export type ModelBindingInput = {
  modelProvider?: string | null;
  modelId?: string | null;
  modelCredentialId?: string | null;
  expectedRevision?: number;
};

export function assertConnectionRevision(
  credential: { connectionRevision: number },
  expectedRevision: number | undefined,
) {
  if (!Number.isInteger(expectedRevision) || !expectedRevision || expectedRevision < 1) {
    throw new ORPCError("BAD_REQUEST", { message: "Choose the model connection again." });
  }
  if (credential.connectionRevision !== expectedRevision) {
    throw new ORPCError("CONFLICT", { message: "Model connection changed. Reload and try again." });
  }
}

export async function loadConnectionSecret(
  prisma: Pick<PrismaClient, "secret">,
  secrets: Pick<SecretStore, "load">,
  userId: string,
  secretId: string,
) {
  try {
    const loaded = await loadStoredModelSecret(prisma, secrets, userId, secretId);
    if (loaded.status !== "loaded") {
      throw new ORPCError("BAD_REQUEST", { message: "Model connection is unavailable." });
    }
    return loaded;
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError)
      throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
    throw error;
  }
}

export type PreparedModelBindingSecret = {
  modelCredentialId: string;
  secretId: string;
  ciphertext: string;
  plaintext: string;
};

/** Call inside the transaction which writes a pin or preference. */
export async function validateModelBinding(
  prisma: BindingClient,
  secrets: Pick<SecretStore, "load">,
  actor: Pick<Actor, "userId" | "spaceId">,
  binding: ModelBindingInput,
  prepared?: PreparedModelBindingSecret,
) {
  if (!binding.modelProvider && !binding.modelId && !binding.modelCredentialId) return null;
  if (!binding.modelProvider || !binding.modelId || !binding.modelCredentialId) {
    throw new ORPCError("BAD_REQUEST", { message: "Choose a model connection." });
  }
  const credential = await findBoundModelCredential(prisma, actor, {
    provider: binding.modelProvider,
    modelId: binding.modelId,
    modelCredentialId: binding.modelCredentialId,
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Model connection not found." });
  assertConnectionRevision(credential, binding.expectedRevision);
  let loaded: { plaintext: string; ciphertext: string };
  if (prepared) {
    const row = await prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
      select: { ciphertext: true },
    });
    if (
      credential.id !== prepared.modelCredentialId ||
      credential.secretId !== prepared.secretId ||
      row?.ciphertext !== prepared.ciphertext
    )
      throw new ORPCError("CONFLICT", {
        message: "Model connection changed. Reload and try again.",
      });
    loaded = prepared;
  } else loaded = await loadConnectionSecret(prisma, secrets, actor.userId, credential.secretId);
  let secret: ReturnType<typeof parseModelSecret>;
  try {
    secret = parseModelSecret(loaded.plaintext);
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Model connection is unavailable." });
  }
  if (binding.modelProvider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    if (
      secret.kind !== "openai_compatible" ||
      !enabledOpenAiCompatibleModelIds(secret, credential.defaultModel).includes(binding.modelId)
    ) {
      throw new ORPCError("BAD_REQUEST", {
        message: "That model is not enabled for this connection.",
      });
    }
  } else if (
    !isCatalogModelChoice(binding.modelProvider, binding.modelId) &&
    credential.defaultModel !== binding.modelId
  ) {
    throw new ORPCError("BAD_REQUEST", { message: "Unknown model for that provider." });
  }
  return {
    credential,
    secret,
    modelId: binding.modelId,
    plaintext: loaded.plaintext,
    ciphertext: loaded.ciphertext,
  };
}

export type ModelConnectionReference = {
  kind: "bot" | "routine" | "backup" | "space-default" | "run";
  id: string;
  name: string;
  spaceId: string;
  provider: string;
  modelId: string | null;
  modelCredentialId: string | null;
  unresolved: boolean;
};

/** Account ownership scopes every query; the caller filters names by current membership. */
export async function listModelConnectionReferences(
  prisma: ReferenceClient,
  userId: string,
  credentialId?: string,
): Promise<ModelConnectionReference[]> {
  const pin = { spaceId: true, modelId: true, modelCredentialId: true } as const;
  const where = {
    userId,
    modelProvider: { not: null },
    modelId: { not: null },
    ...(credentialId ? { modelCredentialId: credentialId } : {}),
  };
  const [bots, routines, backups, preferences, runs, credentials] = await Promise.all([
    prisma.bot.findMany({ where, select: { ...pin, id: true, name: true, modelProvider: true } }),
    prisma.routine.findMany({
      where,
      select: { ...pin, id: true, name: true, modelProvider: true },
    }),
    prisma.spaceBackupModel.findMany({
      where: { userId, ...(credentialId ? { modelCredentialId: credentialId } : {}) },
      select: { ...pin, provider: true, position: true },
    }),
    prisma.spaceModelPreference.findMany({
      where: { userId, isDefault: true, ...(credentialId ? { credentialId } : {}) },
      select: { spaceId: true, id: true, modelId: true, credentialId: true },
    }),
    prisma.run.findMany({
      where: { ...where, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { ...pin, id: true, modelProvider: true, bot: { select: { name: true } } },
    }),
    prisma.userModelCredential.findMany({
      where: { userId },
      select: { id: true, provider: true },
    }),
  ]);
  const providers = new Map(credentials.map((row) => [row.id, row.provider]));
  const bound = (id: string | null, provider: string) =>
    Boolean(id && providers.get(id) === provider);
  const named = (
    kind: "bot" | "routine" | "run",
    row: {
      id: string;
      spaceId: string;
      modelId: string | null;
      modelCredentialId: string | null;
      modelProvider: string | null;
    },
    name: string,
  ): ModelConnectionReference => ({
    kind,
    id: row.id,
    name,
    spaceId: row.spaceId,
    provider: row.modelProvider ?? "",
    modelId: row.modelId,
    modelCredentialId: row.modelCredentialId,
    unresolved: !bound(row.modelCredentialId, row.modelProvider ?? ""),
  });
  return [
    ...bots.map((row) => named("bot", row, row.name)),
    ...routines.map((row) => named("routine", row, row.name)),
    ...backups.map((row) => ({
      kind: "backup" as const,
      id: JSON.stringify([row.spaceId, row.position]),
      name: "Backup models",
      spaceId: row.spaceId,
      provider: row.provider,
      modelId: row.modelId,
      modelCredentialId: row.modelCredentialId,
      unresolved: !bound(row.modelCredentialId, row.provider),
    })),
    ...preferences.map((row) => ({
      kind: "space-default" as const,
      id: row.id,
      name: "Space default",
      spaceId: row.spaceId,
      provider: providers.get(row.credentialId) ?? "",
      modelId: row.modelId,
      modelCredentialId: row.credentialId,
      unresolved: !providers.has(row.credentialId),
    })),
    ...runs.map((row) => named("run", row, row.bot.name)),
  ];
}

export function refuseModelReferences(references: ModelConnectionReference[]) {
  if (references.length === 0) return;
  const names = [...new Set(references.map((row) => row.name))];
  throw new ORPCError("BAD_REQUEST", {
    message: `In use by ${names.join(", ")}. Pick another model for them first.`,
  });
}

export async function refuseAccountModelReferences(
  prisma: Pick<PrismaClient, "spaceMember">,
  userId: string,
  references: ModelConnectionReference[],
) {
  if (references.length === 0) return;
  const memberships = await prisma.spaceMember.findMany({
    where: { userId },
    select: { spaceId: true },
  });
  const visible = new Set(memberships.map((membership) => membership.spaceId));
  refuseModelReferences(
    references.map((reference) => ({
      ...reference,
      name: visible.has(reference.spaceId) ? reference.name : "Models in another space",
    })),
  );
}
