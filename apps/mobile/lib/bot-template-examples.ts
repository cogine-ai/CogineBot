import type { BotCreationReceipt, BotTemplateExampleHandoff } from "@rakazo/core";
import { createBotTemplateExamples } from "@rakazo/core";
import type { MobileScope } from "./mobile-scope";
import { isMobileScopeCurrent } from "./mobile-scope";
import { currentReadySessionGeneration } from "./session";

let authority: { key: string; scope: MobileScope; bots: Set<string> } | null = null;
const examples = createBotTemplateExamples({
  isCurrent: (key, botId) =>
    Boolean(
      authority &&
        authority.key === key &&
        authority.bots.has(botId) &&
        isMobileScopeCurrent(authority.scope) &&
        currentReadySessionGeneration() === authority.scope.sessionGeneration,
    ),
});

/** The authenticated session outlives the creation sheet, but never a scope/ABA change. */
export function rememberMobileBotExample(
  scope: MobileScope,
  userId: string,
  receipt: BotCreationReceipt,
  isEditorCurrent: () => boolean,
) {
  if (
    !isEditorCurrent() ||
    !isMobileScopeCurrent(scope) ||
    !receipt.submitted.template ||
    !receipt.exampleNonce
  )
    return;
  const key = JSON.stringify([scope, userId, receipt.bot.spaceId]);
  if (authority?.key !== key) {
    examples.clear();
    authority = { key, scope, bots: new Set() };
  }
  authority.bots.add(receipt.bot.id);
  examples.remember({
    scopeKey: key,
    botId: receipt.bot.id,
    selection: receipt.submitted.template,
    exampleNonce: receipt.exampleNonce,
  });
}

export function readMobileBotExample(botId: string): BotTemplateExampleHandoff | null {
  if (!authority) return null;
  if (!isMobileScopeCurrent(authority.scope)) {
    examples.clear();
    authority = null;
    return null;
  }
  return examples.read(authority.key, botId);
}

export function insertMobileBotExample(
  handoff: BotTemplateExampleHandoff,
  tryInsert: (text: string) => boolean,
) {
  return examples.insert(handoff.scopeKey, handoff.botId, handoff.exampleNonce, tryInsert);
}
