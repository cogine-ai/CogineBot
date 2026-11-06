import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import type { MobileMessage } from "../lib/api";
import { useOpenPrivatePage } from "../lib/use-open-page";

export function MessageCaption({
  role,
  text,
  tokens,
  colorScheme,
  streaming,
}: {
  role: MobileMessage["role"];
  text: string;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
}) {
  const onOpenPage = useOpenPrivatePage();
  // User messages keep literal Markdown; only explicit URLs and email addresses link.
  return role === "user" ? (
    <LinkifiedText
      onOpenPage={onOpenPage}
      color={tokens.secondaryForeground}
      linkColor={tokens.link}
      palette={tokens}
    >
      {text}
    </LinkifiedText>
  ) : (
    <ChatMarkdown
      onOpenPage={onOpenPage}
      palette={tokens}
      colorScheme={colorScheme}
      streaming={streaming}
    >
      {text}
    </ChatMarkdown>
  );
}
