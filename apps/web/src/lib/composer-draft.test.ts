import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerDrafts,
  clearSubmittedComposerDraft,
  consumeSubmittedComposerDraft,
  insertEmptyComposerDraft,
  makeComposerDraftKey,
  moveComposerDraft,
  readComposerDraft,
  subscribeComposerDraft,
  writeComposerDraft,
} from "./composer-draft";

const identity = {
  userId: "user-a",
  spaceId: "space-a",
  targetKind: "bot" as const,
  targetId: "bot-a",
};
const key = makeComposerDraftKey(identity);
const mention: ComposerMention = { kind: "bot", id: "bot-b", name: "Robin" };
const skill: AgentSkillCatalogEntry = {
  id: "skill-a",
  name: "Planning",
  description: "Plan a day",
  source: "user",
  readOnly: false,
};
const reply: ThreadMessage = {
  id: "message-a",
  threadId: "thread-a",
  seq: 1,
  role: "bot",
  blocks: [{ kind: "text", text: "How about tomorrow?" }],
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  clearComposerDrafts();
  vi.restoreAllMocks();
});

describe("tab-local composer drafts", () => {
  it("carries edits made during first-send into a new group, preserving files and subscriptions", () => {
    const pendingKey = makeComposerDraftKey({ ...identity, targetKind: "new-chat" });
    const groupKey = makeComposerDraftKey({ ...identity, targetKind: "group" });
    const file = new File(["more"], "more.txt");
    writeComposerDraft(pendingKey, {
      text: "Next thought",
      selectedSkill: skill,
      selectedMentions: [mention],
      attachments: [{ id: "next-file", threadKey: pendingKey, file }],
    });
    const listener = vi.fn();
    const unsubscribe = subscribeComposerDraft(groupKey, listener);
    expect(moveComposerDraft(pendingKey, groupKey)).toBe(true);
    expect(readComposerDraft(pendingKey).text).toBe("");
    const moved = readComposerDraft(groupKey);
    expect(moved.text).toBe("Next thought");
    expect(moved.selectedSkill).toBe(skill);
    expect(moved.selectedMentions).toEqual([mention]);
    expect(moved.attachments[0]?.file).toBe(file);
    expect(moved.attachments[0]?.threadKey).toBe(groupKey);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("never replaces an existing Bot draft while moving a first-message draft", () => {
    const pendingKey = makeComposerDraftKey({ ...identity, targetKind: "new-chat" });
    writeComposerDraft(pendingKey, { text: "New thought" });
    writeComposerDraft(key, { text: "Existing thought" });
    expect(moveComposerDraft(pendingKey, key)).toBe(false);
    expect(readComposerDraft(pendingKey).text).toBe("New thought");
    expect(readComposerDraft(key).text).toBe("Existing thought");
  });
  it("restores the full text, selected skill, mentions, File and quote when returning to a thread", () => {
    const file = new File(["first\nsecond"], "notes.txt", { type: "text/plain" });
    const saved = writeComposerDraft(key, {
      text: "first\nsecond",
      selectedSkill: skill,
      selectedMentions: [mention],
      attachments: [{ id: "file-a", threadKey: key, file }],
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
    writeComposerDraft(makeComposerDraftKey({ ...identity, targetId: "bot-b" }), {
      text: "Other chat",
    });
    expect(readComposerDraft(key)).toBe(saved);
    expect(saved.attachments[0]?.file).toBe(file);
    expect(saved.replyTarget).toBe(reply);
    expect(saved.text).toBe("first\nsecond");
  });

  it("isolates the same target across users, spaces and bot/group kinds", () => {
    writeComposerDraft(key, { text: "Private draft" });
    const otherKeys = [
      makeComposerDraftKey({ ...identity, userId: "user-b" }),
      makeComposerDraftKey({ ...identity, spaceId: "space-b" }),
      makeComposerDraftKey({ ...identity, targetKind: "group" }),
      makeComposerDraftKey({ ...identity, targetId: "bot-b" }),
    ];
    for (const other of otherKeys) expect(readComposerDraft(other).text).toBe("");
    expect(makeComposerDraftKey({ ...identity, userId: "user:a", spaceId: "space" })).not.toBe(
      makeComposerDraftKey({ ...identity, userId: "user", spaceId: "a:space" }),
    );
  });

  it("does not let a late successful send erase newer text, files or quote", () => {
    const submitted = writeComposerDraft(key, { text: "First message", replyTarget: reply });
    const newFile = new File(["new"], "new.txt");
    const newer = writeComposerDraft(key, {
      text: "Second message",
      attachments: [{ id: "file-b", threadKey: key, file: newFile }],
      replyQuote: "New quote",
    });
    expect(clearSubmittedComposerDraft(key, submitted.version)).toBe(false);
    expect(readComposerDraft(key)).toBe(newer);
    expect(clearSubmittedComposerDraft(key, newer.version)).toBe(true);
    expect(readComposerDraft(key).text).toBe("");
  });

  it("keeps failed submission intact until exact-version success, then revokes its preview", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved = writeComposerDraft(key, {
      text: "Send with image",
      attachments: [
        {
          id: "photo",
          threadKey: key,
          file: new File(["image"], "photo.png"),
          previewUrl: "blob:photo",
        },
      ],
      replyTarget: reply,
      selectedMentions: [mention],
    });
    // A failure performs no store mutation; the next click reads the same submission snapshot.
    expect(readComposerDraft(key)).toBe(saved);
    expect(clearSubmittedComposerDraft(key, saved.version)).toBe(true);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:photo");
    expect(readComposerDraft(key)).toMatchObject({
      text: "",
      attachments: [],
      selectedMentions: [],
      replyTarget: null,
    });
  });

  it("clears logout data and prevents an old response from erasing a same-account new session draft", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const old = writeComposerDraft(key, {
      text: "Old session",
      attachments: [
        {
          id: "photo",
          threadKey: key,
          file: new File(["image"], "photo.png"),
          previewUrl: "blob:old",
        },
      ],
    });
    clearComposerDrafts();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:old");
    const next = writeComposerDraft(key, { text: "New session" });
    expect(next.version).toBeGreaterThan(old.version);
    expect(clearSubmittedComposerDraft(key, old.version)).toBe(false);
    expect(readComposerDraft(key).text).toBe("New session");
  });

  it("publishes synchronous stable snapshots only to the changed thread", () => {
    const changed = vi.fn(() => readComposerDraft(key).text);
    const other = vi.fn();
    const stop = subscribeComposerDraft(key, changed);
    const stopOther = subscribeComposerDraft("other", other);
    const first = writeComposerDraft(key, { text: "Draft" });
    expect(changed).toHaveReturnedWith("Draft");
    expect(writeComposerDraft(key, { text: "Draft", selectedMentions: [] })).toBe(first);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    stop();
    stopOther();
    writeComposerDraft(key, { text: "Changed after unmount" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not retain drafts before an authenticated scope is known", () => {
    const empty = readComposerDraft(null);
    expect(writeComposerDraft(null, { text: "Unscoped" })).toBe(empty);
    expect(clearSubmittedComposerDraft(null, empty.version)).toBe(false);
  });

  it("consumes all slots after success when the submitted version is still current", () => {
    const submitted = writeComposerDraft(key, {
      text: "Message",
      selectedSkill: skill,
      selectedMentions: [mention],
      replyTarget: reply,
    });
    expect(consumeSubmittedComposerDraft(key, submitted)).toBe(true);
    expect(readComposerDraft(key)).toMatchObject({
      text: "",
      selectedSkill: null,
      selectedMentions: [],
      replyTarget: null,
    });
  });

  it("preserves newer text and newly attached files while consuming sent attachments and unchanged context", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const oldFile = {
      id: "sent-file",
      threadKey: key,
      file: new File(["old"], "old.png"),
      previewUrl: "blob:sent-file",
    };
    const newFile = {
      id: "new-file",
      threadKey: key,
      file: new File(["new"], "new.png"),
      previewUrl: "blob:new-file",
    };
    const submitted = writeComposerDraft(key, {
      text: "First message",
      attachments: [oldFile],
      selectedSkill: skill,
      selectedMentions: [mention],
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
    writeComposerDraft(key, { text: "Second message", attachments: [oldFile, newFile] });
    expect(consumeSubmittedComposerDraft(key, submitted)).toBe(true);
    expect(readComposerDraft(key)).toMatchObject({
      text: "Second message",
      attachments: [newFile],
      selectedSkill: null,
      selectedMentions: [],
      replyTarget: null,
      replyQuote: null,
    });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:sent-file");
  });

  it("retains an updated quote as one slot even when it still references the same message", () => {
    const submitted = writeComposerDraft(key, {
      text: "First",
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
    writeComposerDraft(key, { text: "Second", replyQuote: "How about tomorrow?" });
    consumeSubmittedComposerDraft(key, submitted);
    expect(readComposerDraft(key)).toMatchObject({
      text: "Second",
      replyTarget: reply,
      replyQuote: "How about tomorrow?",
    });
  });

  it("does not consume a skill, mention or reply explicitly removed and reselected during the send", () => {
    const submitted = writeComposerDraft(key, {
      text: "First",
      selectedSkill: skill,
      selectedMentions: [mention],
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
    writeComposerDraft(key, {
      selectedSkill: null,
      selectedMentions: [],
      replyTarget: null,
      replyQuote: null,
    });
    writeComposerDraft(key, {
      text: "Second",
      selectedSkill: skill,
      selectedMentions: [mention],
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
    consumeSubmittedComposerDraft(key, submitted);
    expect(readComposerDraft(key)).toMatchObject({
      text: "Second",
      selectedSkill: skill,
      selectedMentions: [mention],
      replyTarget: reply,
      replyQuote: "tomorrow",
    });
  });

  it("retains the same File deliberately selected again with a new attachment identity", () => {
    const file = new File(["again"], "notes.txt");
    const submitted = writeComposerDraft(key, {
      text: "First",
      attachments: [{ id: "sent", threadKey: key, file }],
    });
    const selectedAgain = { id: "selected-again", threadKey: key, file };
    writeComposerDraft(key, { text: "Second", attachments: [selectedAgain] });
    consumeSubmittedComposerDraft(key, submitted);
    expect(readComposerDraft(key).attachments).toEqual([selectedAgain]);
  });
});

describe("template example insertion into the actual draft store", () => {
  it("inserts only into an empty current composer without dispatching a send", () => {
    expect(insertEmptyComposerDraft(key, "Example", () => true)).toBe(true);
    expect(readComposerDraft(key).text).toBe("Example");
    expect(insertEmptyComposerDraft(key, "Replacement", () => true)).toBe(false);
    expect(readComposerDraft(key).text).toBe("Example");
  });
  it.each([
    { text: " " },
    { selectedSkill: skill },
    { selectedMentions: [mention] },
    { replyTarget: reply },
    { replyQuote: "" },
    { attachments: [{ id: "file", threadKey: key, file: new File(["x"], "x.txt") }] },
  ])("preserves every occupied draft slot: %o", (patch) => {
    const original = writeComposerDraft(key, patch);
    expect(insertEmptyComposerDraft(key, "Example", () => true)).toBe(false);
    expect(readComposerDraft(key)).toBe(original);
  });
  it("rejects a closed, busy or wrong-target callback and a missing target", () => {
    expect(insertEmptyComposerDraft(key, "Example", () => false)).toBe(false);
    expect(insertEmptyComposerDraft(null, "Example", () => true)).toBe(false);
    expect(readComposerDraft(key).text).toBe("");
  });
});
