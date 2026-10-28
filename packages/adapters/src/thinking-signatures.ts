import type { TranscriptContext } from "@earendil-works/pi-ai";

const MISMATCHED_SIGNATURE =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation/i;

/** Recognize rejection of a thinking block bound to a different conversation prefix. */
export function isThinkingSignatureMismatch(errorMessage: string | undefined): boolean {
  return !!errorMessage && MISMATCHED_SIGNATURE.test(errorMessage);
}

/** Remove only historical assistant thinking; keep the persisted transcript unchanged. */
export function withoutThinkingBlocks(context: TranscriptContext): TranscriptContext {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((part) => part.type !== "thinking");
    if (content.length === message.content.length) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}
