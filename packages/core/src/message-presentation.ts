import type { MessageBlock } from "@rakazo/contracts";
import { formatFileSize } from "./format-file-size.js";

/** Hide at most one exact standalone question per renderable card. */
export function messageBlocksForQuestionCards(
  blocks: readonly MessageBlock[],
  canRenderChoice: boolean,
): readonly MessageBlock[] {
  const questions = new Map<string, number>();
  for (const block of blocks) {
    const question =
      block.kind === "choice" && canRenderChoice && block.answerId !== "_dismissed"
        ? block.question.trim()
        : block.kind === "ask"
          ? block.text.trim()
          : undefined;
    if (question !== undefined) questions.set(question, (questions.get(question) ?? 0) + 1);
  }
  if (questions.size === 0) return blocks;
  return blocks.filter((block) => {
    if (block.kind !== "text") return true;
    const question = block.text.trim(),
      remaining = questions.get(question) ?? 0;
    if (remaining === 0) return true;
    questions.set(question, remaining - 1);
    return false;
  });
}

export type AttachmentIdentity = { id: string; name: string; size?: number };

/** Display-only distinctions: never change the filename sent to storage or downloads. */
export function attachmentLabels(attachments: readonly AttachmentIdentity[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const attachment of attachments)
    counts.set(attachment.name, (counts.get(attachment.name) ?? 0) + 1);
  const result = new Map<string, string>();
  const order = new Map<string, number>();
  for (const attachment of attachments) {
    const ordinal = (order.get(attachment.name) ?? 0) + 1;
    order.set(attachment.name, ordinal);
    if ((counts.get(attachment.name) ?? 0) > 1)
      result.set(
        attachment.id,
        `${ordinal}${attachment.size === undefined ? "" : ` · ${formatFileSize(attachment.size)}`}`,
      );
  }
  return result;
}

/** Compare all loaded attachment versions, including files in different messages. */
export function messageAttachmentLabels(
  messages: readonly { blocks: readonly MessageBlock[] }[],
): Map<string, string> {
  const attachments = new Map<string, AttachmentIdentity>();
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.kind === "image" || block.kind === "file")
        attachments.set(block.artifactId, {
          id: block.artifactId,
          name: block.name,
          size: block.kind === "file" ? block.size : undefined,
        });
    }
  return attachmentLabels([...attachments.values()]);
}
