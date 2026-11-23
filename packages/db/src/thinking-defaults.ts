import { createHash } from "node:crypto";
import type {
  DefaultModelChoice,
  ThinkingDefaults,
  ThinkingLevel,
  UpdateThinkingDefaultsInput,
  UpdateThinkingDefaultsResult,
} from "@rakazo/contracts";
import {
  AccountThinkingHistory,
  resolveThinkingDefault,
  SpaceThinkingHistory,
  sameDefaultModel,
  ThinkingLevelSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { lockAccountModelSelection, lockSpaceModelSelection } from "./model-credentials.js";
import { findEffectiveModelDefault } from "./model-defaults.js";
import type { PersonalSettingsScope } from "./personal-settings.js";
import { lockPersonalSettings } from "./personal-settings.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = PersonalSettingsScope;
type Selection = Awaited<ReturnType<typeof findEffectiveModelDefault>>;
type Binding = NonNullable<ThinkingDefaults["binding"]>;

export type PreparedThinkingModel = {
  binding: Binding;
  secretId: string;
  ciphertext: string;
  connectionLevel: ThinkingLevel | null;
  levels: ThinkingLevel[];
};

function memberKey({ userId, spaceId }: Scope) {
  return { spaceId_userId: { userId, spaceId } };
}

function accountVersion(raw: unknown) {
  return AccountThinkingHistory.parse(raw ?? []);
}

function spaceVersion(raw: unknown) {
  return SpaceThinkingHistory.parse(raw ?? []);
}

export async function readThinkingPreferences(
  prisma: Pick<PrismaClient, "spaceMember">,
  scope: Scope,
) {
  const member = await prisma.spaceMember.findUnique({
    where: memberKey(scope),
    select: {
      thinkingOverrideHistory: true,
      member: { select: { user: { select: { thinkingDefaultHistory: true } } } },
    },
  });
  return {
    account: accountVersion(member?.member?.user.thinkingDefaultHistory)[0]?.value ?? null,
    space: spaceVersion(member?.thinkingOverrideHistory)[0]?.value ?? null,
  };
}

export function thinkingModelBinding(selection: Selection): Binding | null {
  if (!selection.choice || !selection.credential || selection.unavailable) return null;
  return {
    model: selection.choice,
    credentialId: selection.credential.id,
    connectionRevision: selection.credential.connectionRevision,
    modelAccountRevision: selection.revisions.account,
    modelSpaceRevision: selection.revisions.space,
  };
}

function sameBinding(left: Binding | null, right: Binding | null) {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        sameDefaultModel(left.model, right.model) &&
        left.credentialId === right.credentialId &&
        left.connectionRevision === right.connectionRevision &&
        left.modelAccountRevision === right.modelAccountRevision &&
        left.modelSpaceRevision === right.modelSpaceRevision,
    )
  );
}

async function readSettings(
  tx: Prisma.TransactionClient,
  actor: Scope,
  prepared: PreparedThinkingModel | null,
  lockProof = false,
) {
  const selection = await findEffectiveModelDefault(tx, actor);
  const binding = thinkingModelBinding(selection);
  const [owner, members, secret] = await Promise.all([
    tx.user.findUnique({
      where: { id: actor.userId },
      select: { thinkingDefaultHistory: true },
    }),
    tx.spaceMember.findMany({
      where: { userId: actor.userId, space: { deletingAt: null } },
      orderBy: [{ space: { name: "asc" } }, { spaceId: "asc" }],
      select: { space: { select: { id: true, name: true } }, thinkingOverrideHistory: true },
    }),
    prepared &&
    binding &&
    sameBinding(binding, prepared.binding) &&
    selection.credential?.secretId === prepared.secretId
      ? lockProof
        ? tx.$queryRaw<Array<{ ciphertext: string }>>`
            SELECT ciphertext FROM secrets WHERE id = ${prepared.secretId}
              AND "userId" = ${actor.userId} AND "spaceId" IS NULL AND kind = 'model'
            FOR SHARE
          `.then(([row]) => row)
        : tx.secret.findFirst({
            where: { id: prepared.secretId, userId: actor.userId, spaceId: null, kind: "model" },
            select: { ciphertext: true },
          })
      : null,
  ]);
  const membership = members.find(({ space }) => space.id === actor.spaceId);
  if (!owner || !membership) throw new IsolationError();
  const accountHistory = accountVersion(owner.thinkingDefaultHistory);
  const spaceHistory = spaceVersion(membership.thinkingOverrideHistory);
  const account = {
    value: accountHistory[0]?.value ?? null,
    revision: accountHistory[0]?.revision ?? 0,
  };
  const space = { value: spaceHistory[0]?.value ?? null, revision: spaceHistory[0]?.revision ?? 0 };
  const context = prepared && secret?.ciphertext === prepared.ciphertext ? prepared : null;
  const levels = context?.levels ?? [];
  const local = ThinkingLevelSchema.safeParse(selection.credential?.thinkingLevel);
  const legacy = local.data ?? context?.connectionLevel ?? null;
  const effective =
    binding && context
      ? resolveThinkingDefault({
          model: binding.model,
          allowed: levels,
          explicit: null,
          legacy,
          account: account.value,
          space: space.value,
        })
      : { level: null, source: "system" as const, unsupported: false };
  const choice = binding?.model ?? account.value?.model ?? null;
  const priorChoice = account.value?.model ?? null;
  const moving = priorChoice !== null && choice !== null && !sameDefaultModel(priorChoice, choice);
  const applies = Boolean(space.value && choice && sameDefaultModel(space.value.model, choice));
  const followsAccount = applies ? space.value?.mode === "inherit" : legacy === null;
  const settings: ThinkingDefaults = {
    account,
    space,
    effective,
    binding,
    levels,
    followsAccount,
    followingSpaces: members
      .filter((member) => {
        // Moving the setting can also change a Space that used the previous model.
        if (moving) return true;
        if (member.space.id === actor.spaceId) return followsAccount;
        const value = spaceVersion(member.thinkingOverrideHistory)[0]?.value;
        return value?.mode !== "fixed" || !choice || !sameDefaultModel(value.model, choice);
      })
      .map(({ space }) => space),
  };
  return { settings, accountHistory, spaceHistory, context };
}

export function readThinkingDefaults(
  prisma: PrismaClient,
  actor: Scope,
  prepared: PreparedThinkingModel | null,
) {
  return prisma.$transaction(async (tx) => (await readSettings(tx, actor, prepared)).settings, {
    isolationLevel: "RepeatableRead",
  });
}

export function updateThinkingDefaults(
  prisma: PrismaClient,
  actor: Scope,
  input: UpdateThinkingDefaultsInput,
  prepared: PreparedThinkingModel | null,
): Promise<UpdateThinkingDefaultsResult> {
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify(
        input.scope === "account"
          ? { ...input, followingSpaceIds: [...input.followingSpaceIds].sort() }
          : input,
      ),
    )
    .digest("hex");
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        if (input.scope === "account") await lockAccountModelSelection(tx, actor.userId, "write");
        else await lockSpaceModelSelection(tx, actor, "write");
        await lockPersonalSettings(tx, actor);
        const { settings, accountHistory, spaceHistory, context } = await readSettings(
          tx,
          actor,
          prepared,
          true,
        );
        const conflict = { status: "conflict" as const, settings };
        const unavailable = { status: "unavailable" as const, settings };
        const history = input.scope === "account" ? accountHistory : spaceHistory;
        const latest = input.scope === "account" ? settings.account : settings.space;
        const earlier = history.find(({ receipt }) => receipt?.clientNonce === input.clientNonce);
        if (earlier)
          return earlier.receipt?.requestHash === requestHash
            ? { status: "updated" as const, settings }
            : conflict;
        if (
          latest.revision !== input.expectedRevision ||
          !sameBinding(settings.binding, input.binding)
        )
          return conflict;
        if (input.scope === "account") {
          const following = new Set(input.followingSpaceIds);
          if (
            following.size !== settings.followingSpaces.length ||
            settings.followingSpaces.some(({ id }) => !following.has(id))
          )
            return conflict;
          if (input.level && (!context || !settings.levels.includes(input.level)))
            return unavailable;
          const value =
            input.level && context ? { model: context.binding.model, level: input.level } : null;
          await tx.user.update({
            where: { id: actor.userId },
            data: {
              thinkingDefaultHistory: [
                {
                  value,
                  revision: latest.revision + 1,
                  receipt: { clientNonce: input.clientNonce, requestHash },
                },
                ...accountHistory,
              ].slice(0, 20),
            },
          });
        } else {
          if (!context) return unavailable;
          if (
            settings.account.revision !== input.expectedAccountRevision ||
            settings.effective.level !== input.expectedLevel ||
            (input.value === "copy" && !settings.followsAccount) ||
            (input.value === "inherit" && settings.followsAccount)
          )
            return conflict;
          const model = context.binding.model;
          const level =
            input.value === "copy"
              ? settings.effective.level
              : input.value === "modelDefault" || input.value === "inherit"
                ? null
                : input.value;
          if (level && !settings.levels.includes(level)) return unavailable;
          const value =
            input.value === "inherit"
              ? { mode: "inherit" as const, model }
              : { mode: "fixed" as const, model, level };
          await tx.spaceMember.update({
            where: memberKey(actor),
            data: {
              thinkingOverrideHistory: [
                {
                  value,
                  revision: latest.revision + 1,
                  receipt: { clientNonce: input.clientNonce, requestHash },
                },
                ...spaceHistory,
              ].slice(0, 20),
            },
          });
        }
        return {
          status: "updated" as const,
          settings: (await readSettings(tx, actor, prepared)).settings,
        };
      },
      { isolationLevel: "ReadCommitted" },
    ),
  );
}

/** Existing per-model effort edits also update an explicit preference for that same model. */
export async function recordSpaceThinkingEdit(
  tx: Prisma.TransactionClient,
  actor: Scope,
  model: DefaultModelChoice,
  level: ThinkingLevel | null,
) {
  const member = await tx.spaceMember.findUnique({
    where: memberKey(actor),
    select: { thinkingOverrideHistory: true },
  });
  const history = spaceVersion(member?.thinkingOverrideHistory);
  const current = history[0];
  if (!current?.value || !sameDefaultModel(current.value.model, model)) return;
  await tx.spaceMember.update({
    where: memberKey(actor),
    data: {
      thinkingOverrideHistory: [
        { value: { mode: "fixed", model, level }, revision: current.revision + 1 },
        ...history,
      ].slice(0, 20),
    },
  });
}
