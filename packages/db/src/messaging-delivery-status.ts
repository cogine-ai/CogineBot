import type { MessagingDelivery } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

export async function readMessagingDelivery(
  prisma: Pick<Prisma.TransactionClient, "messagingOutbound">,
  messageIds: readonly string[],
): Promise<Map<string, MessagingDelivery>> {
  if (!messageIds.length) return new Map();
  const rows = await prisma.messagingOutbound.findMany({
    where: { sourceMessageId: { in: [...messageIds] }, kind: { not: "attachment_notice" } },
    select: {
      sourceMessageId: true,
      status: true,
      deliveryState: true,
      providerHandle: true,
      lastErrorClass: true,
    },
  });
  const byMessage = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.sourceMessageId) continue;
    const list = byMessage.get(row.sourceMessageId);
    if (list) list.push(row);
    else byMessage.set(row.sourceMessageId, [row]);
  }
  const results = new Map<string, MessagingDelivery>();
  for (const [id, parts] of byMessage) {
    const states = parts.map(
      (part) =>
        part.deliveryState ??
        (part.status === "sent"
          ? part.providerHandle
            ? "accepted"
            : "unknown"
          : part.status === "failed"
            ? "failed"
            : "sending"),
    );
    if (states.includes("sending")) {
      results.set(id, { state: "sending" });
    } else if (states.includes("unknown")) {
      results.set(id, { state: "unknown" });
    } else if (states.includes("failed")) {
      const state = states.every((item) => item === "failed") ? "failed" : "partial_failure";
      const reason =
        parts.find((part) => part.lastErrorClass === "reply_window_closed")?.lastErrorClass ??
        parts.find((part) => part.lastErrorClass === "attachment_unavailable")?.lastErrorClass;
      results.set(id, {
        state,
        reason:
          reason === "reply_window_closed" || reason === "attachment_unavailable"
            ? reason
            : "rejected",
      });
    } else {
      results.set(id, {
        state: states.every((item) => item === "delivered") ? "delivered" : "accepted",
      });
    }
  }
  return results;
}
