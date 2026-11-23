import { createHash } from "node:crypto";
import type {
  DefaultModelChoice,
  ModelDefaults,
  UpdateModelDefaultsInput,
} from "@rakazo/contracts";
import {
  AccountModelDefaultHistory,
  SpaceModelDefaultHistory,
  usableModelId,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import {
  findDefaultModelCredential,
  lockAccountModelSelection,
  lockSpaceModelSelection,
  selectSpaceModelPreference,
  withModelPreference,
} from "./model-credentials.js";
import type { PersonalSettingsScope } from "./personal-settings.js";
import { lockPersonalSettings } from "./personal-settings.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = PersonalSettingsScope;
type ModelReader = Pick<PrismaClient, "secret" | "spaceMember" | "spaceModelPreference">;
type Resolution = ModelDefaults["effective"] & {
  credential: Awaited<ReturnType<typeof findDefaultModelCredential>>;
};

function memberKey({ userId, spaceId }: Scope) {
  return { spaceId_userId: { userId, spaceId } };
}

function localModels(prisma: ModelReader, { userId, spaceId }: Scope, choice?: DefaultModelChoice) {
  return prisma.spaceModelPreference.findMany({
    where: {
      spaceId,
      userId,
      modelId: choice ? choice.modelId : { not: null },
      credential: { userId, ...(choice && { provider: choice.provider }) },
    },
    include: { credential: true },
    orderBy: [{ credential: { provider: "asc" } }, { modelId: "asc" }, { id: "asc" }],
    ...(choice && { take: 2 }),
  });
}

function modelSecretScope(userId: string) {
  return { userId, spaceId: null, kind: "model" };
}

async function resolveDefault(
  prisma: ModelReader,
  scope: Scope,
  account: DefaultModelChoice | null,
  override: boolean,
): Promise<Resolution> {
  if (account && !override) {
    const [first, second] = await localModels(prisma, scope, account);
    const secret =
      first && !second
        ? await prisma.secret.findFirst({
            where: { ...modelSecretScope(scope.userId), id: first.credential.secretId },
            select: { id: true },
          })
        : null;
    return {
      choice: account,
      credential: first && secret ? withModelPreference(first) : null,
      source: "account",
      unavailable: second ? "ambiguous" : secret ? null : "missing",
    };
  }
  const credential = await findDefaultModelCredential(prisma, scope);
  return {
    choice: credential?.defaultModel
      ? { provider: credential.provider, modelId: credential.defaultModel }
      : null,
    credential,
    source: override || credential ? "space" : "system",
    unavailable: null,
  };
}

/** Resolve inheritance from bindings in this Space, never from the user's account credential list. */
export async function findEffectiveModelDefault(prisma: ModelReader, scope: Scope) {
  const membership = await prisma.spaceMember.findUnique({
    where: memberKey(scope),
    select: {
      modelOverrideHistory: true,
      member: { select: { user: { select: { modelDefaultHistory: true } } } },
    },
  });
  const account = AccountModelDefaultHistory.parse(
    membership?.member?.user.modelDefaultHistory ?? [],
  );
  const space = SpaceModelDefaultHistory.parse(membership?.modelOverrideHistory ?? []);
  return {
    ...(await resolveDefault(prisma, scope, account[0]?.value ?? null, space[0]?.value ?? false)),
    revisions: { account: account[0]?.revision ?? 0, space: space[0]?.revision ?? 0 },
  };
}

/** A prepared inherited Run may keep its model while the connection is still authorized here. */
export async function findAuthorizedSpaceModelCredential(
  prisma: Pick<PrismaClient, "spaceModelPreference">,
  { userId, spaceId }: Scope,
  provider: string,
  credentialId: string | null | undefined,
) {
  if (!credentialId) return null;
  const row = await prisma.spaceModelPreference.findFirst({
    where: { spaceId, userId, credentialId, credential: { userId, provider } },
    include: { credential: true },
  });
  return row ? withModelPreference(row) : null;
}

async function readSettings(tx: Prisma.TransactionClient, actor: Scope) {
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { modelDefaultHistory: true },
  });
  const memberships = await tx.spaceMember.findMany({
    where: { userId: actor.userId, space: { deletingAt: null } },
    orderBy: [{ space: { name: "asc" } }, { spaceId: "asc" }],
    select: { space: { select: { id: true, name: true } }, modelOverrideHistory: true },
  });
  const here = memberships.find(({ space }) => space.id === actor.spaceId);
  if (!user || !here) throw new IsolationError();
  const accountHistory = AccountModelDefaultHistory.parse(user.modelDefaultHistory);
  const spaceHistory = SpaceModelDefaultHistory.parse(here.modelOverrideHistory);
  const account = {
    value: accountHistory[0]?.value ?? null,
    revision: accountHistory[0]?.revision ?? 0,
  };
  const space = {
    value: spaceHistory[0]?.value ?? false,
    revision: spaceHistory[0]?.revision ?? 0,
  };
  const [{ credential, ...effective }, rows] = await Promise.all([
    resolveDefault(tx, actor, account.value, space.value),
    localModels(tx, actor),
  ]);
  const candidates = new Map<
    string,
    { choice: DefaultModelChoice; count: number; secretId: string }
  >();
  for (const row of rows) {
    const modelId = usableModelId(row.modelId);
    if (!modelId || modelId !== row.modelId) continue;
    const choice = { provider: row.credential.provider, modelId };
    const key = JSON.stringify(choice);
    const previous = candidates.get(key);
    if (previous) previous.count++;
    else candidates.set(key, { choice, count: 1, secretId: row.credential.secretId });
  }
  const unique = [...candidates.values()].filter(({ count }) => count === 1);
  const secrets = unique.length
    ? await tx.secret.findMany({
        where: {
          ...modelSecretScope(actor.userId),
          id: { in: unique.map(({ secretId }) => secretId) },
        },
        select: { id: true },
      })
    : [];
  const stored = new Set(secrets.map(({ id }) => id));
  const settings: ModelDefaults = {
    account,
    space,
    effective,
    choices: unique.filter(({ secretId }) => stored.has(secretId)).map(({ choice }) => choice),
    followingSpaces: memberships
      .filter(
        ({ modelOverrideHistory }) =>
          !SpaceModelDefaultHistory.parse(modelOverrideHistory)[0]?.value,
      )
      .map(({ space }) => space),
  };
  return { settings, accountHistory, spaceHistory, credential };
}

export function readModelDefaults(prisma: PrismaClient, actor: Scope) {
  return prisma.$transaction(async (tx) => (await readSettings(tx, actor)).settings, {
    isolationLevel: "RepeatableRead",
  });
}

function sameModel(left: DefaultModelChoice | null, right: DefaultModelChoice | null) {
  return left === right || (left?.provider === right?.provider && left?.modelId === right?.modelId);
}

export function updateModelDefaults(
  prisma: PrismaClient,
  actor: Scope,
  input: UpdateModelDefaultsInput,
) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        input.scope === "account"
          ? [input.scope, input.expectedRevision, input.value, [...input.followingSpaceIds].sort()]
          : [
              input.scope,
              input.expectedRevision,
              input.enabled,
              input.expectedAccountRevision,
              input.expectedChoice,
            ],
      ),
    )
    .digest("hex");
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        if (input.scope === "account") await lockAccountModelSelection(tx, actor.userId, "write");
        else await lockSpaceModelSelection(tx, actor, "write");
        await lockPersonalSettings(tx, actor);
        const { settings, accountHistory, spaceHistory, credential } = await readSettings(
          tx,
          actor,
        );
        const conflict = { status: "conflict" as const, settings };
        const unavailable = { status: "unavailable" as const, settings };
        const previous = (input.scope === "account" ? accountHistory : spaceHistory).find(
          ({ receipt }) => receipt?.clientNonce === input.clientNonce,
        );
        if (previous)
          return previous.receipt?.requestHash === hash
            ? { status: "updated" as const, settings }
            : conflict;
        const current = input.scope === "account" ? settings.account : settings.space;
        if (current.revision !== input.expectedRevision) return conflict;
        const receipt = { clientNonce: input.clientNonce, requestHash: hash };
        const revision = current.revision + 1;
        if (input.scope === "account") {
          const following = new Set(input.followingSpaceIds);
          if (
            following.size !== settings.followingSpaces.length ||
            settings.followingSpaces.some(({ id }) => !following.has(id))
          )
            return conflict;
          if (input.value && !settings.choices.some((choice) => sameModel(choice, input.value)))
            return unavailable;
          await tx.user.update({
            where: { id: actor.userId },
            data: {
              modelDefaultHistory: [
                { value: input.value, revision, receipt },
                ...accountHistory,
              ].slice(0, 20),
            },
          });
        } else {
          if (
            settings.account.revision !== input.expectedAccountRevision ||
            !sameModel(settings.effective.choice, input.expectedChoice) ||
            settings.space.value === input.enabled
          )
            return conflict;
          if (input.enabled) {
            if (!credential || settings.effective.unavailable) return unavailable;
            await selectSpaceModelPreference(
              tx,
              actor,
              credential.id,
              credential.defaultModel,
              credential.thinkingLevel,
            );
          }
          const choice = settings.effective.choice;
          await tx.spaceMember.update({
            where: memberKey(actor),
            data: {
              modelOverrideHistory: [
                { value: input.enabled, revision, receipt, ...(choice && { choice }) },
                ...spaceHistory,
              ].slice(0, 20),
            },
          });
        }
        return { status: "updated" as const, settings: (await readSettings(tx, actor)).settings };
      },
      { isolationLevel: "ReadCommitted" },
    ),
  );
}

/** Called by the explicit Space model picker under the Space model-selection lock. */
export async function recordSpaceModelChoice(
  tx: Prisma.TransactionClient,
  actor: Scope,
  choice: DefaultModelChoice,
) {
  const membership = await tx.spaceMember.findUniqueOrThrow({
    where: memberKey(actor),
    select: { modelOverrideHistory: true },
  });
  const history = SpaceModelDefaultHistory.parse(membership.modelOverrideHistory);
  await tx.spaceMember.update({
    where: memberKey(actor),
    data: {
      modelOverrideHistory: [
        { value: true, revision: (history[0]?.revision ?? 0) + 1, choice },
        ...history,
      ].slice(0, 20),
    },
  });
}
