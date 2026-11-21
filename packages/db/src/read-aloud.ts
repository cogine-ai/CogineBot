import { createHash } from "node:crypto";
import type { Actor, UpdateReadAloudInput } from "@rakazo/contracts";
import { ReadAloudStoredVersionSchema, resolveReadAloud } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = Pick<Actor, "userId" | "spaceId">;
const historySchema = ReadAloudStoredVersionSchema.array();

function preference(history: ReturnType<typeof historySchema.parse>) {
  const latest = history[0];
  return { value: latest?.value ?? null, revision: latest?.revision ?? 0 };
}

async function readSettings(tx: Prisma.TransactionClient, actor: Scope) {
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { readAloudHistory: true },
  });
  const memberships = await tx.spaceMember.findMany({
    where: { userId: actor.userId, space: { deletingAt: null } },
    orderBy: [{ space: { name: "asc" } }, { spaceId: "asc" }],
    select: { space: { select: { id: true, name: true } }, readAloudHistory: true },
  });
  const here = memberships.find(({ space }) => space.id === actor.spaceId);
  if (!user || !here) throw new IsolationError();
  const accountHistory = historySchema.parse(user.readAloudHistory);
  const spaceHistory = historySchema.parse(here.readAloudHistory);
  const account = preference(accountHistory);
  const space = preference(spaceHistory);
  return {
    accountHistory,
    spaceHistory,
    settings: {
      account,
      space,
      effective: resolveReadAloud(null, space.value, account.value),
      followingSpaces: memberships
        .filter(
          ({ readAloudHistory }) =>
            preference(historySchema.parse(readAloudHistory)).value === null,
        )
        .map(({ space }) => space),
    },
  };
}

export async function readAloudSettings(prisma: PrismaClient, actor: Scope) {
  return prisma.$transaction(async (tx) => (await readSettings(tx, actor)).settings, {
    isolationLevel: "RepeatableRead",
  });
}

export async function readAloudForBot(prisma: PrismaClient, actor: Scope, botId: string) {
  return prisma.$transaction(
    async (tx) => {
      const bot = await tx.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        select: { autoSpeak: true, autoSpeakInherited: true },
      });
      const member = await tx.spaceMember.findFirst({
        where: { spaceId: actor.spaceId, userId: actor.userId, space: { deletingAt: null } },
        select: { readAloudHistory: true },
      });
      if (!bot || !member) throw new IsolationError();
      if (!bot.autoSpeakInherited) return resolveReadAloud(bot.autoSpeak, null, null);
      const space = preference(historySchema.parse(member.readAloudHistory)).value;
      if (space !== null) return resolveReadAloud(null, space, null);
      const account = await tx.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { readAloudHistory: true },
      });
      return resolveReadAloud(
        null,
        null,
        preference(historySchema.parse(account.readAloudHistory)).value,
      );
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function updateReadAloud(
  prisma: PrismaClient,
  actor: Scope,
  request: UpdateReadAloudInput,
) {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Account writes and explicit overrides serialize on the owner, even across Spaces.
        const [user] = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "user" WHERE id = ${actor.userId} FOR NO KEY UPDATE`;
        const [space] = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM spaces WHERE id = ${actor.spaceId} AND "deletingAt" IS NULL FOR SHARE`;
        const [member] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM space_members
        WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR NO KEY UPDATE`;
        if (!user || !space || !member) throw new IsolationError();
        const { settings, accountHistory, spaceHistory } = await readSettings(tx, actor);
        const fromAccount = request.scope === "account";
        const current = fromAccount ? settings.account : settings.space;
        const history = fromAccount ? accountHistory : spaceHistory;
        const conflict = { status: "conflict" as const, settings };
        const requestHash = createHash("sha256")
          .update(
            JSON.stringify([
              request.scope,
              request.value,
              request.expectedRevision,
              request.scope === "account"
                ? [...request.followingSpaceIds].sort()
                : request.expectedAccountRevision,
            ]),
          )
          .digest("hex");
        const receipt = history.find((version) => version.clientNonce === request.clientNonce);
        if (receipt)
          return receipt.requestHash === requestHash
            ? { status: "updated" as const, settings }
            : conflict;
        if (current.revision !== request.expectedRevision) return conflict;
        if (request.scope === "account") {
          const expected = new Set(request.followingSpaceIds);
          if (
            expected.size !== settings.followingSpaces.length ||
            settings.followingSpaces.some(({ id }) => !expected.has(id))
          )
            return conflict;
        } else if (
          request.expectedAccountRevision !== settings.account.revision ||
          (request.value === "copy" && current.value !== null) ||
          (typeof request.value === "boolean" && current.value === null)
        ) {
          // A Space override may copy a preference just confirmed by the user.
          return conflict;
        }
        const readAloudHistory = [
          {
            value: request.value === "copy" ? settings.effective.enabled : request.value,
            revision: current.revision + 1,
            clientNonce: request.clientNonce,
            requestHash,
          },
          ...history,
        ].slice(0, 20);
        if (fromAccount) {
          await tx.user.update({ where: { id: actor.userId }, data: { readAloudHistory } });
        } else {
          await tx.spaceMember.update({
            where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
            data: { readAloudHistory },
          });
        }
        return { status: "updated" as const, settings: (await readSettings(tx, actor)).settings };
      },
      { isolationLevel: "ReadCommitted" },
    ),
  );
}
