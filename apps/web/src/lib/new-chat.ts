import type { Bot } from "@rakazo/contracts";
import { newClientId } from "./client-id";

export type NewChatDraft = {
  id: string;
  creationNonce: string;
  botIds: string[];
  creation: { name: string; botIds: string[]; clientNonce: string } | null;
  groupId: string | null;
};

export function newChatDraft(): NewChatDraft {
  const id = newClientId();
  return { id, creationNonce: id, botIds: [], creation: null, groupId: null };
}

/** Freeze the creation intent before making a request: a lost response must replay the same group. */
export function groupCreationIntent(draft: NewChatDraft, bots: readonly Bot[]) {
  if (draft.creation) return draft.creation;
  const names = draft.botIds.map((id) => bots.find((bot) => bot.id === id)?.name ?? "Bot");
  draft.creation = {
    name: names
      .join(", ")
      .slice(0, 80)
      .replace(/[\uD800-\uDBFF]$/, ""),
    botIds: [...draft.botIds],
    clientNonce: draft.creationNonce,
  };
  return draft.creation;
}
