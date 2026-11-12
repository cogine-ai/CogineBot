import type { MessageBlock } from "@rakazo/contracts";
import { BotSettingsChangeSchema, BotSettingsRevisionSchema } from "@rakazo/contracts";
import { escapeApprovalBidi, redactSecrets } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { Prisma, PrismaClient, RunLease } from "@rakazo/db";
import {
  appendEventInTransaction,
  botSettingsValues,
  describeBotSettingsChange,
  lockBotModelSetting,
  lockOwnedBotSettings,
  lockRunHistoryGrant,
  prepareBotSettingsVersion,
  withTransactionRetry,
  writeBotSettingsVersion,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { completeExternalEffect } from "./approval-effect.js";
import type { OwnSettingsRequest } from "./own-bot-settings.js";
import {
  OWN_BOT_SETTINGS_CHANGED,
  ownSettingsBindingsCurrent,
  readOwnSettingsRequest,
} from "./own-bot-settings.js";
import { persistMessageInTransaction } from "./run-messages.js";

export const BotSettingsRunSnapshot = z.object({
  instructions: z.string(),
  revision: BotSettingsRevisionSchema,
  modelProvider: z.string(),
  modelId: z.string(),
  modelCredentialId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
});

export function ownSettingsApprovalBlock(
  effectId: string,
  request: OwnSettingsRequest,
  secrets: string[],
) {
  const clean = (value: string) => escapeApprovalBidi(redactSecrets(value, secrets));
  const changes = describeBotSettingsChange(request.before, request.after).map((change) => ({
    ...change,
    before: clean(change.before),
    after: clean(
      change.field === "model" && request.after.modelId && request.modelConnection
        ? `${change.after} · ${request.modelConnection.label}`
        : change.field === "voice" && request.voiceLabel
          ? request.voiceLabel
          : change.after,
    ),
  }));
  return {
    kind: "ask",
    text: "Review Bot settings",
    reviewMode: "screen",
    status: "pending",
    approvalEffectId: effectId,
    botSettings: {
      botId: request.botId,
      botName: clean(request.botName),
      changes,
    },
    actions: [
      { id: "allow", label: "Confirm" },
      { id: "deny", label: "Cancel" },
    ],
  } satisfies MessageBlock;
}

type Scope = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  sourceMessageId: string | null;
};

export function settingsRequestBelongsToRun(request: OwnSettingsRequest, run: Scope) {
  return (
    request.runId === run.id &&
    request.userId === run.userId &&
    request.spaceId === run.spaceId &&
    request.botId === run.botId
  );
}

const inactive = { error: "This run can no longer change Bot settings.", unchanged: true };
const conflict = { error: OWN_BOT_SETTINGS_CHANGED, unchanged: true };
const changedConnection = {
  error: "The selected connection changed. Review the current settings and try again.",
  unchanged: true,
};

export async function lockOwnSettingsRun(
  tx: Prisma.TransactionClient,
  run: Scope,
  lease: RunLease,
  signal: AbortSignal,
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM runs WHERE id = ${run.id} FOR NO KEY UPDATE`;
  if (signal.aborted) return false;
  const live = await tx.run.findFirst({
    where: {
      id: run.id,
      status: "running",
      leaseOwner: lease.owner,
      leaseFence: lease.fence,
      leaseExpiresAt: { gt: new Date() },
      botId: run.botId,
      spaceId: run.spaceId,
      userId: run.userId,
      thread: { botId: run.botId, userId: run.userId, groupId: null, externalConversationId: null },
    },
    select: { id: true },
  });
  return Boolean(
    live &&
      (await lockRunHistoryGrant(tx, {
        id: run.id,
        spaceId: run.spaceId,
        userId: run.userId,
        threadId: run.threadId,
        sourceMessageId: run.sourceMessageId,
        leaseOwner: lease.owner,
        leaseFence: lease.fence,
      })),
  );
}

export async function commitOwnBotSettings(input: {
  prisma: PrismaClient;
  run: Scope;
  effectId: string;
  request: OwnSettingsRequest;
  lease: RunLease;
  signal: AbortSignal;
  secrets: string[];
  rulesBlock: (tx: Prisma.TransactionClient) => Promise<boolean>;
  notify: (threadId: string, seq: number, firstResponseRunId?: string) => Promise<void>;
}) {
  const { prisma, run, effectId, request, lease, signal, secrets, rulesBlock, notify } = input;
  if (!settingsRequestBelongsToRun(request, run)) return inactive;
  const committed = await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      if (request.after.modelId !== undefined || request.after.thinkingLevel !== undefined)
        await lockBotModelSetting(tx, run.botId);
      if (!(await lockOwnSettingsRun(tx, run, lease, signal))) return { result: inactive };

      const effect = await tx.externalEffect.findFirst({
        where: { id: effectId, runId: run.id, spaceId: run.spaceId, kind: "update_bot" },
        select: { request: true, status: true, result: true },
      });
      if (
        !effect ||
        !readOwnSettingsRequest(effect.request) ||
        stableJsonValue(effect.request) !== stableJsonValue(request)
      )
        return { result: inactive };
      if (effect.status === "completed") return { result: effect.result };
      if (effect.status !== "approved") return { result: inactive };

      const settle = async (result: unknown) => {
        signal.throwIfAborted();
        if (!(await completeExternalEffect(tx, effectId, "approved", result)))
          throw new Error("Bot settings approval changed during commit");
        return result;
      };
      if (await rulesBlock(tx))
        return {
          result: await settle({
            error: "An action rule blocks this settings change.",
            unchanged: true,
          }),
        };

      const row = await lockOwnedBotSettings(tx, run, run.botId);
      if (!row) return { result: await settle(inactive) };
      const version = prepareBotSettingsVersion(row, request.after);
      const matched =
        row.settingsRevision === request.revision &&
        version &&
        stableJsonValue(version.before) === stableJsonValue(request.before) &&
        stableJsonValue(version.after) === stableJsonValue(request.after);
      if (!matched || !(await ownSettingsBindingsCurrent(tx, request))) {
        const failure = matched ? changedConnection : conflict;
        const safe = (value: string) => escapeApprovalBidi(redactSecrets(value, secrets));
        const changes = describeBotSettingsChange(botSettingsValues(row), request.after).map(
          ({ field, before }) => ({ field, before: safe(before), after: safe(before) }),
        );
        const message = await persistMessageInTransaction(
          tx,
          run,
          "bot",
          [
            {
              kind: "ask",
              status: "answered",
              text: failure.error,
              botSettings: { botId: row.id, botName: safe(row.name), changes },
            },
          ],
          undefined,
          undefined,
          false,
          lease,
        );
        return { message, result: await settle(failure) };
      }
      const written = await writeBotSettingsVersion(tx, row, version);
      const display = ownSettingsApprovalBlock(effectId, request, secrets).botSettings;
      const message = await persistMessageInTransaction(
        tx,
        run,
        "bot",
        [
          {
            kind: "ask",
            status: "answered",
            text: "Bot settings updated",
            botSettings: { ...display, versionId: version.id, revision: written.settingsRevision },
          },
        ],
        undefined,
        undefined,
        false,
        lease,
      );
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        lease,
        type: "bot.updated",
        payload: {
          botId: row.id,
          name: written.name,
          title: written.title,
          description: written.description,
        },
      });
      const changes = BotSettingsChangeSchema.array().parse(display.changes);
      return {
        message: { ...message, eventSeq: event.seq },
        result: await settle({ ok: true, changes, revision: written.settingsRevision }),
      };
    }),
  );
  if (committed.message)
    await notify(
      run.threadId,
      committed.message.eventSeq,
      committed.message.firstResponseRunId,
    ).catch((error) => getLogger().error("Bot settings notification", error));
  return committed.result;
}
