import type { TranscriptContext } from "@earendil-works/pi-ai";

const MISMATCHED_SIGNATURE =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation/i;

/** Recognize rejection of a thinking block bound to a different conversation prefix. */
export function isThinkingSignatureMismatch(errorMessage: string | undefined): boolean {
  return !!errorMessage && MISMATCHED_SIGNATURE.test(errorMessage);
}

/** Remove only historical assistant thinking; keep the persisted transcript unchanged. */
export function withoutThinkingBlocks(context: TranscriptContext): TranscriptContext {
  const messages = withoutThinkingFrom(context.messages, 0);
  return messages === context.messages ? context : { ...context, messages };
}

/** Remove assistant thinking only in the range whose conversation prefix changed. */
export function withoutThinkingFrom<T extends TranscriptContext["messages"][number]>(
  messages: T[],
  from: number,
  to = messages.length,
): T[] {
  let changed = false;
  const result = messages.map((message, index) => {
    if (index < from || index >= to || message.role !== "assistant") return message;
    const content = message.content.filter((part) => part.type !== "thinking");
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}
