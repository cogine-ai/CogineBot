import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import { revokePendingAttachmentPreviews } from "./pending-attachments";

export type PendingComposerAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

export type ComposerDraft = {
  text: string;
  selectedSkill: AgentSkillCatalogEntry | null;
  selectedMentions: ComposerMention[];
  attachments: PendingComposerAttachment[];
  replyTarget: ThreadMessage | null;
  replyQuote: string | null;
  version: number;
  slotVersions: {
    skill: number;
    mentions: number;
    reply: number;
  };
};

export type ComposerDraftChange =
  | Partial<Omit<ComposerDraft, "version" | "slotVersions">>
  | ((current: ComposerDraft) => Partial<Omit<ComposerDraft, "version" | "slotVersions">>);

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  selectedSkill: null,
  selectedMentions: [],
  attachments: [],
  replyTarget: null,
  replyQuote: null,
  version: 0,
  slotVersions: { skill: 0, mentions: 0, reply: 0 },
};

// Deliberately tab-local: File objects and quoted messages never enter browser storage.
const drafts = new Map<string, ComposerDraft>();
const listeners = new Map<string, Set<() => void>>();
let nextVersion = 1;

export function makeComposerDraftKey(input: {
  userId: string;
  spaceId: string;
  targetKind: "bot" | "group";
  targetId: string;
}): string {
  return JSON.stringify([input.userId, input.spaceId, input.targetKind, input.targetId]);
}

export function readComposerDraft(key: string | null): ComposerDraft {
  return (key ? drafts.get(key) : undefined) ?? EMPTY_DRAFT;
}

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function subscribeComposerDraft(key: string | null, listener: () => void): () => void {
  if (!key) return () => {};
  const subscriptions = listeners.get(key) ?? new Set<() => void>();
  subscriptions.add(listener);
  listeners.set(key, subscriptions);
  return () => {
    subscriptions.delete(listener);
    if (subscriptions.size === 0) listeners.delete(key);
  };
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function writeComposerDraft(key: string | null, change: ComposerDraftChange): ComposerDraft {
  const current = readComposerDraft(key);
  if (!key) return current;
  const patch = typeof change === "function" ? change(current) : change;
  const next = { ...current, ...patch };
  const skillChanged = next.selectedSkill !== current.selectedSkill;
  const mentionsChanged = !sameItems(next.selectedMentions, current.selectedMentions);
  const replyChanged =
    next.replyTarget !== current.replyTarget || next.replyQuote !== current.replyQuote;
  if (
    next.text === current.text &&
    !skillChanged &&
    !mentionsChanged &&
    sameItems(next.attachments, current.attachments) &&
    !replyChanged
  ) {
    return current;
  }
  next.version = nextVersion++;
  next.slotVersions = {
    skill: skillChanged ? next.version : current.slotVersions.skill,
    mentions: mentionsChanged ? next.version : current.slotVersions.mentions,
    reply: replyChanged ? next.version : current.slotVersions.reply,
  };
  drafts.set(key, next);
  notify(key);
  return next;
}

/** An old response cannot clear text, files or a quote edited after submission. */
export function clearSubmittedComposerDraft(key: string | null, version: number): boolean {
  if (!key) return false;
  const submitted = drafts.get(key);
  if (!submitted || submitted.version !== version) return false;
  revokePendingAttachmentPreviews(submitted.attachments);
  drafts.delete(key);
  notify(key);
  return true;
}

/** Consume sent context without touching text or context deliberately changed during an in-flight send. */
export function consumeSubmittedComposerDraft(
  key: string | null,
  submitted: ComposerDraft,
): boolean {
  if (!key) return false;
  const current = drafts.get(key);
  if (!current) return false;
  if (current.version === submitted.version) {
    return clearSubmittedComposerDraft(key, submitted.version);
  }
  const sentAttachmentIds = new Set(submitted.attachments.map((attachment) => attachment.id));
  const consumedAttachments = current.attachments.filter((attachment) =>
    sentAttachmentIds.has(attachment.id),
  );
  const patch: Partial<Omit<ComposerDraft, "version" | "slotVersions">> = {
    attachments: current.attachments.filter((attachment) => !sentAttachmentIds.has(attachment.id)),
  };
  if (current.slotVersions.skill === submitted.slotVersions.skill) patch.selectedSkill = null;
  if (current.slotVersions.mentions === submitted.slotVersions.mentions)
    patch.selectedMentions = [];
  if (current.slotVersions.reply === submitted.slotVersions.reply) {
    patch.replyTarget = null;
    patch.replyQuote = null;
  }
  const next = writeComposerDraft(key, patch);
  revokePendingAttachmentPreviews(consumedAttachments);
  return next !== current;
}

/** Called on logout; versions stay monotonic so a late old-account send cannot clear a new draft. */
export function clearComposerDrafts(): void {
  const keys = Array.from(drafts.keys());
  for (const draft of drafts.values()) revokePendingAttachmentPreviews(draft.attachments);
  drafts.clear();
  for (const key of keys) notify(key);
}
