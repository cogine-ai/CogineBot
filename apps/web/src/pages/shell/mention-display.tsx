import { LinkifiedText } from "@rakazo/chat-ui/web";
import type { ComposerMention } from "@rakazo/core";
import {
  BotAvatar,
  DEFAULT_GROK_BOT_COLOR,
  parseBotAvatar,
  usePortraitDefaults,
} from "@rakazo/ui-web";
import { AtSign, Clock, Puzzle, Users } from "lucide-react";
import { splitSentMentionText } from "../../lib/mention-display";

export function useBotIdentityTextColor(color?: string): string | undefined {
  const portraitDefaults = usePortraitDefaults();
  if (!color) return undefined;
  const avatar = parseBotAvatar(color);
  if (avatar.isImage || (portraitDefaults && avatar.shapeIndex === undefined)) return undefined;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(avatar.color) ? avatar.color : undefined;
}

export function MentionIdentity({
  mention,
  showAt = true,
  truncateName = false,
  testId,
}: {
  mention: ComposerMention;
  showAt?: boolean;
  truncateName?: boolean;
  testId?: string;
}) {
  const identityColor = useBotIdentityTextColor(mention.kind === "bot" ? mention.color : undefined);
  const Icon =
    mention.kind === "group"
      ? Users
      : mention.kind === "routine"
        ? Clock
        : mention.kind === "connector"
          ? Puzzle
          : AtSign;

  return (
    <span
      data-testid={testId}
      data-mention-id={mention.id}
      className="inline-flex min-w-0 max-w-full items-center gap-1 align-middle text-foreground"
      style={identityColor ? { color: identityColor } : undefined}
    >
      {mention.kind === "bot" ? (
        <BotAvatar
          color={mention.color ?? DEFAULT_GROK_BOT_COLOR}
          identity={mention.id}
          size={16}
        />
      ) : (
        <Icon size={16} className="shrink-0" aria-hidden />
      )}
      <span
        className={truncateName ? "min-w-0 truncate" : "min-w-0"}
        title={mention.name}
        dir="auto"
      >
        {showAt ? "@" : ""}
        {mention.name}
      </span>
    </span>
  );
}

export function SentMentionText({
  text,
  targets,
}: {
  text: string;
  targets: readonly ComposerMention[];
}) {
  return splitSentMentionText(text, targets).map((part, index) =>
    part.kind === "mention" ? (
      <MentionIdentity key={index} mention={part.mention} testId="message-mention" />
    ) : (
      <LinkifiedText key={index}>{part.text}</LinkifiedText>
    ),
  );
}
