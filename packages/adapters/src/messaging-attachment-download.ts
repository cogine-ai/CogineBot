import { AsyncLocalStorage } from "node:async_hooks";
import type { DownloadAttachmentOptions } from "@chat-adapter/shared";
import { downloadAttachment } from "@chat-adapter/shared";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";

const attachmentDeadline = new AsyncLocalStorage<number>();

export function withinMessagingAttachmentDeadline<T>(deadlineAt: number, fetch: () => Promise<T>) {
  return attachmentDeadline.run(deadlineAt, fetch);
}

export function messagingAttachmentTimeRemaining(): number {
  const deadline = attachmentDeadline.getStore();
  if (deadline === undefined) return 10_000;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Attachment download deadline exceeded");
  return remaining;
}

export function downloadMessagingAttachment(
  url: string,
  options: Pick<DownloadAttachmentOptions, "adapter" | "headers" | "hosts" | "onResponse">,
) {
  return downloadAttachment(url, {
    ...options,
    limit: ATTACHMENT_MAX_BYTES,
    timeoutMs: messagingAttachmentTimeRemaining(),
  });
}
