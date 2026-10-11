import type { ComposerMention } from "@rakazo/core";

export type SentMentionPart =
  | { kind: "mention"; text: string; mention: ComposerMention }
  | { kind: "text"; text: string };

/** Visual hints only: sent messages do not persist selected mention identities. */
export function splitSentMentionText(
  text: string,
  targets: readonly ComposerMention[],
): SentMentionPart[] {
  const parts: SentMentionPart[] = [];
  let offset = 0;

  function literal(value: string) {
    if (!value) return;
    const previous = parts.at(-1);
    if (previous?.kind === "text") previous.text += value;
    else parts.push({ kind: "text", text: value });
  }

  while (text[offset] === "@") {
    const matches = targets.filter((target) => {
      if (!target.name.trim() || /[\r\n]/.test(target.name)) return false;
      const token = `@${target.name}`;
      if (!text.startsWith(token, offset)) return false;
      const boundary = text[offset + token.length];
      return boundary === undefined || /\s/.test(boundary);
    });
    // All kinds participate in ambiguity checks. Even a shorter matching name
    // may be the intended recipient, so never guess from the current roster.
    const mention = matches.length === 1 ? matches[0] : undefined;
    if (mention?.kind !== "bot") break;
    const token = `@${mention.name}`;
    parts.push({ kind: "mention", text: token, mention });
    offset += token.length;

    const separatorStart = offset;
    while (text[offset] === " " || text[offset] === "\t") offset += 1;
    literal(text.slice(separatorStart, offset));
  }

  literal(text.slice(offset));
  return parts;
}
