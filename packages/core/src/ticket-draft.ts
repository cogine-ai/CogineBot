import type { CreateTicketInput, Ticket, TicketStatus, UpdateTicketInput } from "@rakazo/contracts";

export type TicketDraft = Omit<CreateTicketInput, "boardId"> & { status: TicketStatus };

export function ticketDraft(ticket: Ticket | null, firstBotId = ""): TicketDraft {
  return {
    title: ticket?.title ?? "",
    description: ticket?.description ?? "",
    assigneeBotId: ticket?.assigneeBotId ?? firstBotId,
    priority: ticket?.priority ?? "normal",
    status: ticket?.status ?? "todo",
  };
}

/** Only submit edited fields so concurrent bot work is not overwritten by a stale form. */
export function ticketUpdate(
  ticket: Ticket,
  draft: TicketDraft,
  firstBotId = "",
): UpdateTicketInput {
  return {
    id: ticket.id,
    ...(draft.title !== ticket.title ? { title: draft.title } : {}),
    ...(draft.description !== (ticket.description ?? "") ? { description: draft.description } : {}),
    ...(draft.assigneeBotId !== (ticket.assigneeBotId ?? firstBotId)
      ? { assigneeBotId: draft.assigneeBotId }
      : {}),
    ...(draft.status !== ticket.status ? { status: draft.status } : {}),
    ...(draft.priority !== ticket.priority ? { priority: draft.priority } : {}),
  };
}
