import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";

/** The legacy first-chat picker is setup chrome, not part of the conversation. */
function isInitialFocusPicker(block: MessageBlock): boolean {
  return (
    block.kind === "choice" &&
    block.question === "What do you want me on first?" &&
    block.options.length === 4 &&
    ["day", "inbox", "research", "everything"].every((id) =>
      block.options.some((option) => option.id === id),
    )
  );
}

export function conversationMessages(messages: readonly ThreadMessage[]): ThreadMessage[] {
  return messages.flatMap((message) => {
    const blocks = message.blocks.filter((block) => !isInitialFocusPicker(block));
    if (blocks.length === 0) return [];
    return [blocks.length === message.blocks.length ? message : { ...message, blocks }];
  });
}
