import { createHash } from "node:crypto";
import type { UpdateVoiceDefaultsInput, VoiceChoice } from "@rakazo/contracts";
import { VoiceDefaultHistorySchema, VoiceOverrideHistorySchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import type { PersonalSettingsScope } from "./personal-settings.js";
import { lockPersonalSettings } from "./personal-settings.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";
import { findDefaultVoiceCredential, lockDefaultVoiceCredential } from "./voice-credentials.js";

type Scope = PersonalSettingsScope;
type Connection = NonNullable<Awaited<ReturnType<typeof findDefaultVoiceCredential>>>;
export type VerifiedVoiceChoice = {
  credentialId: string;
  secretId: string;
  choice: VoiceChoice;
};

function memberKey(actor: Scope) {
  return { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } };
}

async function readSettings(tx: Prisma.TransactionClient, actor: Scope) {
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { voiceDefaultHistory: true },
  });
  const memberships = await tx.spaceMember.findMany({
    where: { userId: actor.userId, space: { deletingAt: null } },
    orderBy: [{ space: { name: "asc" } }, { spaceId: "asc" }],
    select: { space: { select: { id: true, name: true } }, voiceOverrideHistory: true },
  });
  const here = memberships.find(({ space }) => space.id === actor.spaceId);
  if (!user || !here) throw new IsolationError();
  const connection = await findDefaultVoiceCredential(tx, actor);
  const accountHistory = VoiceDefaultHistorySchema.parse(user.voiceDefaultHistory);
  const spaceHistory = VoiceOverrideHistorySchema.parse(here.voiceOverrideHistory);
  const account = {
    value: accountHistory[0]?.value ?? null,
    revision: accountHistory[0]?.revision ?? 0,
  };
  return {
    accountHistory,
    spaceHistory,
    connection,
    settings: {
      account,
      space: { value: spaceHistory[0]?.value ?? false, revision: spaceHistory[0]?.revision ?? 0 },
      provider: connection?.provider ?? null,
      effective: connection?.effectiveVoice ?? {
        choice: null,
        source: spaceHistory[0]?.value
          ? ("space" as const)
          : account.value
            ? ("account" as const)
            : ("system" as const),
      },
      followingSpaces: memberships
        .filter(
          ({ voiceOverrideHistory }) =>
            !VoiceOverrideHistorySchema.parse(voiceOverrideHistory)[0]?.value,
        )
        .map(({ space }) => space),
    },
  };
}

export async function readVoiceDefaults(prisma: PrismaClient, actor: Scope) {
  return prisma.$transaction(async (tx) => (await readSettings(tx, actor)).settings, {
    isolationLevel: "RepeatableRead",
  });
}

function sameChoice(
  proof: VerifiedVoiceChoice | undefined,
  choice: VoiceChoice,
  cred: Connection | null,
) {
  return (
    cred &&
    proof &&
    cred.id === proof.credentialId &&
    cred.secretId === proof.secretId &&
    proof.choice.provider === choice.provider &&
    proof.choice.voiceId === choice.voiceId &&
    cred.provider === choice.provider
  );
}

export async function updateVoiceDefaults(
  prisma: PrismaClient,
  actor: Scope,
  request: UpdateVoiceDefaultsInput,
  proof?: VerifiedVoiceChoice,
) {
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify(
        request.scope === "account"
          ? [
              request.scope,
              request.value?.provider,
              request.value?.voiceId,
              request.expectedRevision,
              [...request.followingSpaceIds].sort(),
            ]
          : [
              request.scope,
              request.enabled,
              request.expectedProvider,
              request.expectedRevision,
              request.expectedAccountRevision,
            ],
      ),
    )
    .digest("hex");
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockPersonalSettings(tx, actor);
        const { accountHistory, spaceHistory, settings, connection } = await readSettings(
          tx,
          actor,
        );
        const account = request.scope === "account";
        const conflict = { status: "conflict" as const, settings };
        const unavailable = { status: "unavailable" as const, settings };
        const previous = (account ? accountHistory : spaceHistory).find(
          ({ receipt }) => receipt?.clientNonce === request.clientNonce,
        );
        if (previous)
          return previous.receipt?.requestHash === requestHash
            ? { status: "updated" as const, settings }
            : conflict;
        const current = account ? settings.account : settings.space;
        if (current.revision !== request.expectedRevision) return conflict;
        const receipt = { clientNonce: request.clientNonce, requestHash };
        const revision = current.revision + 1;
        if (request.scope === "account") {
          const following = new Set(request.followingSpaceIds);
          if (
            following.size !== settings.followingSpaces.length ||
            settings.followingSpaces.some(({ id }) => !following.has(id))
          )
            return conflict;
          if (request.value) {
            if (!proof) return unavailable;
            const currentConnection = await lockDefaultVoiceCredential(
              tx,
              actor,
              proof.credentialId,
            );
            if (!sameChoice(proof, request.value, currentConnection)) return conflict;
          }
          await tx.user.update({
            where: { id: actor.userId },
            data: {
              voiceDefaultHistory: [
                { revision, value: request.value, receipt },
                ...accountHistory,
              ].slice(0, 20),
            },
          });
        } else {
          if (
            request.expectedProvider !== settings.provider ||
            request.expectedAccountRevision !== settings.account.revision ||
            settings.space.value === request.enabled
          )
            return conflict;
          const currentConnection =
            connection && (await lockDefaultVoiceCredential(tx, actor, connection.id));
          if (connection && (!currentConnection || currentConnection.id !== connection.id))
            return conflict;
          const choice = currentConnection?.effectiveVoice.choice;
          if (request.enabled) {
            if (!currentConnection || !choice || !proof) return unavailable;
            if (!sameChoice(proof, choice, currentConnection)) return conflict;
            await tx.spaceVoicePreference.update({
              where: {
                spaceId_userId_credentialId: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  credentialId: currentConnection.id,
                },
              },
              data: { voiceId: choice.voiceId },
            });
          }
          await tx.spaceMember.update({
            where: memberKey(actor),
            data: {
              voiceOverrideHistory: [
                { revision, value: request.enabled, receipt, ...(choice ? { voice: choice } : {}) },
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

/** A manual voice selection is an explicit Space choice, including writes from older clients. */
export async function recordSpaceVoiceChoice(
  tx: Prisma.TransactionClient,
  actor: Scope,
  voice: VoiceChoice,
) {
  const member = await tx.spaceMember.findUniqueOrThrow({
    where: memberKey(actor),
    select: { voiceOverrideHistory: true },
  });
  const history = VoiceOverrideHistorySchema.parse(member.voiceOverrideHistory);
  await tx.spaceMember.update({
    where: memberKey(actor),
    data: {
      voiceOverrideHistory: [
        { revision: (history[0]?.revision ?? 0) + 1, value: true, voice },
        ...history,
      ].slice(0, 20),
    },
  });
}
