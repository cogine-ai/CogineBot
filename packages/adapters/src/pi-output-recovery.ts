import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { automated } from "./automated-messages.js";
import { effectiveOutputReserve } from "./pi-runtime-limits.js";

export type LengthRecovery = { maxTokens?: number; thinkingLevel?: ModelThinkingLevel };

export const CUT_REPLY_CONTINUATION_PROMPT = automated(
  "Your previous reply was cut off by a connection error. Continue exactly where it stopped, mid-word if needed, without repeating anything. Only finish the text reply.",
);
/**
 * Sent after a reply ran out of output room. Models don't reliably tell a finished last word
 * from a cut one, or keep the space before the next word, so the continuation starts by
 * repeating the reply's last words, quoted here, and the join drops that repeat.
 */
export function cutReplyAtLimitPrompt(cut: string): string {
  const end = cut.trimEnd().slice(-200);
  const words = /(?:\S+\s+){0,5}\S+$/.exec(end)?.[0] ?? end;
  // Escaped so a quote mark in the reply can't end the quote early; line breaks stay as they
  // are, for the model to repeat them.
  const quoted = words.slice(-80).replace(/["\\]/g, "\\$&");
  return automated(
    `Your previous reply hit the output limit. It ended with: "${quoted}" Continue it: start by repeating those last words exactly, then finish the text reply without repeating anything else.`,
  );
}
const MIN_CONTINUATION_OVERLAP = 4;
export const MAX_CONTINUATION_OVERLAP = 240;

/**
 * How much of the start of a continuation repeats the end of the cut reply: the longest such
 * run of at least a few characters, up to about a sentence. Shorter matches are coincidence.
 */
export function continuationOverlap(
  cut: string,
  continuation: string,
  minimum = MIN_CONTINUATION_OVERLAP,
): number {
  const longest = Math.min(cut.length, continuation.length, MAX_CONTINUATION_OVERLAP);
  for (let size = longest; size >= minimum; size -= 1) {
    if (cut.endsWith(continuation.slice(0, size))) return size;
  }
  return 0;
}

// Models often open a continuation with an ellipsis before picking the words up again.
const CONTINUATION_MARKER = /^(?:…|\.{3})[^\S\n]*/;
/** Longest marker the join may drop, so it waits for enough text to decide. */
export const MAX_CONTINUATION_MARKER = 4;

/**
 * How much of the start of a continuation to drop: its repeat of the end of the cut reply, and
 * an ellipsis before that repeat. An ellipsis that doesn't lead into a repeat is kept.
 */
export function continuationRepeat(cut: string, continuation: string, requested = false): number {
  if (requested) cut = cut.trimEnd();
  // Short requested repeats must cover the whole final word or cut fragment.
  const minimum = requested
    ? Math.min(MIN_CONTINUATION_OVERLAP, /\S+$/.exec(cut)?.[0].length ?? MIN_CONTINUATION_OVERLAP)
    : MIN_CONTINUATION_OVERLAP;
  const marker = CONTINUATION_MARKER.exec(continuation)?.[0] ?? "";
  const afterMarker = marker
    ? continuationOverlap(cut, continuation.slice(marker.length), minimum)
    : 0;
  return afterMarker
    ? marker.length + afterMarker
    : continuationOverlap(cut, continuation, minimum);
}
const LOWEST_FIRST_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * A call that spent its whole output budget before writing anything gets one more try with
 * more room: double the budget within the model's ceiling, the input reserve and any output cap
 * the provider asked for, or, when the user set the budget or it is already at that ceiling,
 * one thinking level less (never off, which some endpoints refuse).
 */
export function lengthRecovery(
  model: Model<Api>,
  room: { contextWindow: number; ceiling: number; configured: boolean },
  sentMaxTokens: number,
  thinkingLevel: ModelThinkingLevel,
): LengthRecovery | undefined {
  if (!room.configured) {
    const maxTokens = effectiveOutputReserve(
      room.contextWindow,
      Math.min(room.ceiling, sentMaxTokens * 2),
    );
    if (Number.isFinite(maxTokens) && maxTokens > sentMaxTokens) return { maxTokens };
  }
  if (thinkingLevel === "off") return undefined;
  const supported = getSupportedThinkingLevels(model);
  const lower = LOWEST_FIRST_THINKING_LEVELS.slice(
    0,
    LOWEST_FIRST_THINKING_LEVELS.indexOf(thinkingLevel),
  ).findLast((level) => supported.includes(level));
  return lower ? { thinkingLevel: lower } : undefined;
}
