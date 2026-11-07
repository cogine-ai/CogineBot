import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/native";
import type { PageTextContext } from "@rakazo/contracts";
import { withPageReplyContext } from "@rakazo/core";
import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import type { MobileMessage } from "../lib/api";
import { useOpenPrivatePage } from "../lib/use-open-page";

export function MessageCaption({
  role,
  text,
  pageContext,
  tokens,
  colorScheme,
  streaming,
}: {
  role: MobileMessage["role"];
  text: string;
  pageContext?: PageTextContext;
  tokens: ColorTokens;
  colorScheme: ResolvedAppearance;
  streaming: boolean;
}) {
  const onOpenPage = useOpenPrivatePage();
  if (role !== "user") {
    return (
      <ChatMarkdown
        palette={tokens}
        colorScheme={colorScheme}
        streaming={streaming}
        onOpenPage={onOpenPage}
      >
        {text}
      </ChatMarkdown>
    );
  }
  const prefix = pageContext && withPageReplyContext("", pageContext);
  const reference = prefix?.trimEnd();
  const ownerText =
    prefix && (text === reference || text.startsWith(prefix))
      ? text.slice(prefix.length)
      : undefined;
  return (
    <>
      {reference && ownerText !== undefined ? (
        <LinkifiedText
          color={tokens.secondaryForeground}
          linkColor={tokens.link}
          palette={tokens}
          onOpenPage={onOpenPage}
        >
          {reference}
        </LinkifiedText>
      ) : null}
      {(ownerText ?? text) ? (
        <LinkifiedText color={tokens.secondaryForeground} linkColor={tokens.link} palette={tokens}>
          {ownerText ?? text}
        </LinkifiedText>
      ) : null}
    </>
  );
}
