import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock, protectedContinuationLength, redactSecrets } from "@rakazo/core";

/** Keep mid-turn progress beats short; prefer a few high-signal updates. */
export const USER_PROGRESS_MESSAGE_MAX_LENGTH = 500;
export const MID_TURN_PROGRESS_MIN_TURN_AGE_MS = 60_000;
export const MID_TURN_PROGRESS_MAX_PER_RUN = 3;
export const NARRATION_STATUS_MAX_LENGTH = 60;

/** Ordinary durable progress shares one budget across tools and narration. */
export function midTurnProgressBudgetAllows(publishedCount: number, turnAgeMs: number): boolean {
  return (
    !midTurnProgressBudgetUsed(publishedCount) && turnAgeMs >= MID_TURN_PROGRESS_MIN_TURN_AGE_MS
  );
}

export function midTurnProgressBudgetUsed(publishedCount: number): boolean {
  return publishedCount >= MID_TURN_PROGRESS_MAX_PER_RUN;
}

function shortenProgressText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  const completePrefix =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? prefix.slice(0, -1) : prefix;
  return `${completePrefix.trimEnd()}…`;
}

/** Collapse narration to one line, with the ellipsis inside the cap. */
export function narrationStatusLine(text: string, secrets: string[] = []): string {
  const line = redactSecrets(text.replace(/\s+/g, " ").trim(), secrets);
  return shortenProgressText(line, NARRATION_STATUS_MAX_LENGTH);
}

/** Hide the continuation of a known secret split across narration and the final reply. */
export function redactReplyAfterProgress(
  text: string,
  blocks: MessageBlock[],
  preceding: readonly string[],
  secrets: string[],
): { text: string; blocks: MessageBlock[] } {
  if (!text || preceding.every((context) => !context)) return { text, blocks };
  const length = Math.max(0, ...secrets.map((secret) => secret.length));
  const covered = protectedContinuationLength(text.slice(0, length), preceding, secrets);
  if (covered === 0) return { text, blocks };

  let remaining = covered;
  let marker = "[redacted]";
  return {
    text: marker + text.slice(covered),
    blocks: blocks.map((block) => {
      if (block.kind !== "text" || remaining === 0 || !block.text) return block;
      const safeText = marker + block.text.slice(remaining);
      remaining = Math.max(0, remaining - block.text.length);
      marker = "";
      return { ...block, text: safeText };
    }),
  };
}

export function clampUserProgressMessage(text: string): string {
  return shortenProgressText(text.trim(), USER_PROGRESS_MESSAGE_MAX_LENGTH);
}

/**
 * True when the raw text a caller tried to post as a mid-turn progress update
 * would not fit and got cut off by clampUserProgressMessage. Callers should
 * surface this back to the model (it gets no other signal that its message
 * was mangled) rather than reporting a silent success.
 */
export function isProgressMessageTruncated(text: string): boolean {
  return text.trim().length > USER_PROGRESS_MESSAGE_MAX_LENGTH;
}

/** Preserve the message's source labels without guessing who sent it. */
export function midTaskMessagePrompt(text: string, canMessageUser = false): string {
  const next = canMessageUser
    ? "If it asks something or changes the plan, answer briefly with message_user, then continue the task."
    : "Take it into account and continue the task.";
  return `A message arrived while you were working:\n\n${text}\n\n${next}`;
}

/**
 * Pull narration text out of the in-progress turn segments so it can be posted
 * as a durable mid-turn message. Tool/step blocks stay for the final publish.
 */

/** clientNonce prefix for mid-turn progress messages (reconciler uses this). */
export const USER_PROGRESS_CLIENT_NONCE_PREFIX = "user-progress:";

export function userProgressClientNonce(runId: string, index = 0): string {
  // Include entropy so a resumed executor turn cannot reuse an earlier nonce
  // (threadId + clientNonce is unique).
  return `${USER_PROGRESS_CLIENT_NONCE_PREFIX}${runId}:${index}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isUserProgressClientNonce(clientNonce: string | null | undefined): boolean {
  return Boolean(clientNonce?.startsWith(USER_PROGRESS_CLIENT_NONCE_PREFIX));
}

export function extractNarrationText(
  segments: readonly MessageBlock[],
  currentText: string,
): { text: string; remaining: MessageBlock[] } {
  const parts: string[] = [];
  const remaining: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    remaining.push(block);
  }
  if (currentText) parts.push(currentText);
  return { text: parts.join(""), remaining };
}

/**
 * After mid-turn progress messages were already posted, skip a hollow final
 * message that would only carry hidden tool-activity blocks (or nothing).
 */
export function finalBlocksAfterMidTurnProgress(
  blocks: MessageBlock[],
  publishedMidTurn: boolean,
): MessageBlock[] {
  if (!publishedMidTurn || blocks.length === 0) return blocks;
  if (blocks.every((block) => isToolActivityBlock(block))) return [];
  return blocks;
}

/** Outcome to return for a bot_message run after mid-turn progress posts. */
export function botMessageOutcomeFromMidTurn(
  finalText: string,
  midTurnTexts: readonly string[],
): { text: string; intent: "result" | "status" } | null {
  const trimmed = finalText.trim();
  if (trimmed) return { text: trimmed, intent: "result" };
  const midTurn = midTurnTexts.map((part) => part.trim()).filter(Boolean);
  if (midTurn.length === 0) return null;
  return { text: midTurn.join("\n\n"), intent: "status" };
}
