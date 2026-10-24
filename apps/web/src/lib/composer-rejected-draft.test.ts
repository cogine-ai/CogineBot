import type { ThreadMessage } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerDrafts,
  makeComposerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import type { VerifiedComposerRecoveryTarget } from "./composer-rejected-draft";
import {
  cancelPreparedRejectedComposerDraft,
  discardRejectedComposerDraft,
  prepareRejectedComposerDraft,
  rememberVerifiedComposerRecoveryTarget,
  restoreRejectedComposerDraft,
} from "./composer-rejected-draft";
import { composerSendAttempts } from "./composer-send-attempt";
import { synchronizeComposerSession } from "./composer-session";

const target: VerifiedComposerRecoveryTarget = {
  apiOrigin: "https://chat.example.test",
  userId: "user-a",
  sessionId: "old-session",
  spaceId: "space-a",
  selectionId: null,
  selectionGeneration: 1,
  targetKind: "bot",
  targetId: "bot-a",
  threadId: "thread-a",
};
const key = makeComposerDraftKey(target);
const renewed = { ...target, sessionId: "new-session", selectionGeneration: 2 };
const reply: ThreadMessage = {
  id: "old-message-id",
  threadId: target.threadId,
  seq: 1,
  role: "bot",
  blocks: [{ kind: "text", text: "Visible reply context" }],
  createdAt: "2026-01-01T00:00:00Z",
};
const preview = () => "Visible reply context";

function prepare() {
  return prepareRejectedComposerDraft(target, preview);
}
function signInAgain(userId = target.userId, sessionId = renewed.sessionId) {
  synchronizeComposerSession("anonymous", undefined);
  synchronizeComposerSession("authenticated", userId, sessionId);
}
function restore(next = renewed, canRestore = true) {
  return restoreRejectedComposerDraft(next, makeComposerDraftKey(next), canRestore, () => true);
}

beforeEach(() => {
  vi.stubGlobal("window", { location: { origin: target.apiOrigin } });
  discardRejectedComposerDraft();
  clearComposerDrafts();
  composerSendAttempts.clear();
  synchronizeComposerSession("anonymous", undefined);
  synchronizeComposerSession("authenticated", target.userId, target.sessionId);
  rememberVerifiedComposerRecoveryTarget(target, key, false);
});
afterEach(() => {
  discardRejectedComposerDraft();
  clearComposerDrafts();
  composerSendAttempts.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit rejected-session editable draft recovery", () => {
  it("cancels the failed copy but allows an explicit retry to capture the current editable draft", () => {
    writeComposerDraft(key, { text: "Old prepared text" });
    expect(prepare()).toBe(true);
    cancelPreparedRejectedComposerDraft();
    writeComposerDraft(key, { text: "Current text for the explicit retry" });
    expect(prepare()).toBe(true);
    signInAgain();
    expect(restore()).toBe(true);
    expect(readComposerDraft(key).text).toBe("Current text for the explicit retry");
  });

  it("does not carry a cancelled copy or its verified descriptor through an unrelated anonymous transition", () => {
    writeComposerDraft(key, { text: "Private failed recovery" });
    expect(prepare()).toBe(true);
    cancelPreparedRejectedComposerDraft();
    signInAgain();
    expect(restore()).toBe(false);
    expect(prepareRejectedComposerDraft(renewed, preview)).toBe(false);
    expect(readComposerDraft(key).text).toBe("");
  });

  it("still forgets the verified editor on explicit logout after a failed recovery", () => {
    writeComposerDraft(key, { text: "Private failed recovery" });
    expect(prepare()).toBe(true);
    cancelPreparedRejectedComposerDraft();
    discardRejectedComposerDraft();
    expect(prepare()).toBe(false);
    signInAgain();
    expect(restore()).toBe(false);
  });

  it("survives the actual anonymous draft/attempt wipe with only plain editable content and copied File bytes", async () => {
    const file = new File(["File bytes: \u{1f4dd}\nsecond line"], "draft.txt", {
      type: "text/plain",
      lastModified: 123,
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    writeComposerDraft(key, {
      text: "  Raw \u{1f4dd}\n\ntext  ",
      selectedSkill: {
        id: "old-skill-id",
        name: "Planning",
        description: "",
        source: "user",
        readOnly: false,
      },
      selectedMentions: [{ kind: "bot", id: "old-mentioned-id", name: "Robin" }],
      attachments: [{ id: "old-file-id", threadKey: key, file, previewUrl: "blob:old-preview" }],
      replyTarget: reply,
    });
    const old = composerSendAttempts.acquire(key, "old-request")!;
    old.uploadedArtifactIds.set("old-file-id", "old-server-artifact");
    composerSendAttempts.finish(key, old, false);
    expect(prepare()).toBe(true);
    synchronizeComposerSession("anonymous", undefined);
    expect(readComposerDraft(key).text).toBe("");
    expect(readComposerDraft(key).attachments).toEqual([]);
    expect(composerSendAttempts.isCurrent(key, old)).toBe(false);
    expect(revoke).toHaveBeenCalledWith("blob:old-preview");
    expect(restore()).toBe(false);
    synchronizeComposerSession("authenticated", target.userId, renewed.sessionId);
    expect(restore()).toBe(true);
    const recovered = readComposerDraft(key);
    expect(recovered.text).toBe(
      "> Visible reply context\n\n/Planning\n@Robin\n  Raw \u{1f4dd}\n\ntext  ",
    );
    expect(recovered).toMatchObject({
      selectedSkill: null,
      selectedMentions: [],
      replyTarget: null,
      replyQuote: null,
    });
    expect(recovered.attachments).toHaveLength(1);
    const attachment = recovered.attachments[0]!;
    expect(attachment.id).not.toBe("old-file-id");
    expect(attachment.previewUrl).toBeUndefined();
    expect(attachment.file).not.toBe(file);
    expect(attachment.file.name).toBe(file.name);
    expect(attachment.file.type).toBe(file.type);
    expect(attachment.file.lastModified).toBe(file.lastModified);
    expect(await attachment.file.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(composerSendAttempts.isCurrent(key, old)).toBe(false);
    // Only a later explicit user action creates a new nonce without old upload receipts.
    const next = composerSendAttempts.acquire(key, "new-request")!;
    expect(next.clientNonce).not.toBe(old.clientNonce);
    expect(next.uploadedArtifactIds.size).toBe(0);
    expect(restore()).toBe(false);
  });

  it("does not retain any draft on ordinary anonymous transitions without explicit preparation", () => {
    writeComposerDraft(key, { text: "Private unsent text" });
    signInAgain();
    expect(readComposerDraft(key).text).toBe("");
    expect(restore()).toBe(false);
  });

  it("requires the anonymous boundary and a new authenticated session before fresh thread proof can restore", () => {
    writeComposerDraft(key, { text: "Private unsent text" });
    expect(prepare()).toBe(true);
    expect(restore(target)).toBe(false);
    synchronizeComposerSession("loading", undefined);
    synchronizeComposerSession("unreachable", undefined);
    expect(restore()).toBe(false);
    signInAgain();
    expect(restore()).toBe(true);
  });

  it("does not authorize the old session returning after an anonymous read", () => {
    writeComposerDraft(key, { text: "Private unsent text" });
    prepare();
    signInAgain(target.userId, target.sessionId);
    expect(restore(target)).toBe(false);
    expect(readComposerDraft(key).text).toBe("");
  });

  it.each([
    { userId: "different-user" },
    { apiOrigin: "https://different.example.test" },
    { sessionId: "different-session" },
    { targetKind: "group" as const },
    { targetId: "different-target" },
  ])(
    "never captures a residual descriptor for a different current route or owner: %j",
    (change) => {
      writeComposerDraft(key, { text: "Private unsent text" });
      expect(prepareRejectedComposerDraft({ ...target, ...change }, preview)).toBe(false);
      signInAgain();
      expect(restore()).toBe(false);
      expect(readComposerDraft(key).text).toBe("");
    },
  );

  it.each([{ selectionId: "different-selection" }, { selectionGeneration: 3 }])(
    "rejects a Space selection or ABA after the verified editor was left: %j",
    (change) => {
      writeComposerDraft(key, { text: "Private unsent text" });
      expect(prepareRejectedComposerDraft({ ...target, ...change }, preview)).toBe(false);
      signInAgain();
      expect(restore()).toBe(false);
    },
  );

  it.each([
    { userId: "different-user" },
    { apiOrigin: "https://different.example.test" },
    { spaceId: "different-space" },
    { targetKind: "group" as const },
    { targetId: "different-target" },
    { threadId: "different-thread" },
  ])("discards on different verified proof and never revives through target ABA: %j", (change) => {
    writeComposerDraft(key, { text: "Private unsent text" });
    prepare();
    signInAgain();
    const different = { ...renewed, ...change };
    rememberVerifiedComposerRecoveryTarget(different, makeComposerDraftKey(different), false);
    expect(restore(different)).toBe(false);
    expect(restore()).toBe(false);
  });

  it.each(["text", "file", "skill", "mention", "reply", "empty-quote"])(
    "never overwrites a newer occupied %s editor and never inserts after it is cleared",
    (occupied) => {
      writeComposerDraft(key, { text: "Old draft" });
      prepare();
      signInAgain();
      const patch = {
        text: occupied === "text" ? " \nNewer text" : "",
        attachments:
          occupied === "file"
            ? [{ id: "new-file", threadKey: key, file: new File(["new"], "new.txt") }]
            : [],
        selectedSkill:
          occupied === "skill"
            ? {
                id: "new-skill",
                name: "New",
                description: "",
                source: "user" as const,
                readOnly: false,
              }
            : null,
        selectedMentions:
          occupied === "mention" ? [{ kind: "bot" as const, id: "new-bot", name: "New" }] : [],
        replyTarget: occupied === "reply" ? reply : null,
        replyQuote: occupied === "empty-quote" ? "" : null,
      };
      writeComposerDraft(key, patch);
      expect(restore()).toBe(false);
      expect(readComposerDraft(key)).toMatchObject(patch);
      clearComposerDrafts();
      expect(restore()).toBe(false);
    },
  );

  it("rejects an in-flight send before capture without keeping its attempt or nonce", () => {
    writeComposerDraft(key, { text: "Sending text" });
    composerSendAttempts.acquire(key, "sending");
    expect(prepare()).toBe(false);
    signInAgain();
    expect(restore()).toBe(false);
  });

  it.each(["capture", "restore"])("keeps the current blocked %s editor untouched", (phase) => {
    writeComposerDraft(key, { text: "Blocked draft" });
    if (phase === "capture") rememberVerifiedComposerRecoveryTarget(target, key, true);
    expect(prepare()).toBe(phase !== "capture");
    signInAgain();
    expect(restore(renewed, false)).toBe(false);
    expect(restore()).toBe(false);
  });

  it("drops an explicit logout or a later authentication change instead of renewing the candidate", () => {
    writeComposerDraft(key, { text: "Private unsent text" });
    prepare();
    signInAgain();
    synchronizeComposerSession("authenticated", target.userId, "later-session");
    expect(restore()).toBe(false);
    rememberVerifiedComposerRecoveryTarget(renewed, key, false);
    writeComposerDraft(key, { text: "Another draft" });
    prepareRejectedComposerDraft(renewed, preview);
    discardRejectedComposerDraft();
    signInAgain(target.userId, "later-session");
    expect(restore({ ...renewed, sessionId: "later-session" })).toBe(false);
  });

  it("discards immediately when fresh authentication belongs to another user", () => {
    writeComposerDraft(key, { text: "Private unsent text" });
    prepare();
    signInAgain("different-user");
    synchronizeComposerSession("authenticated", target.userId, renewed.sessionId);
    expect(restore()).toBe(false);
    expect(readComposerDraft(key).text).toBe("");
  });

  it("retains an attachment-only group draft and consumes it once with no Bot authority", () => {
    const group = { ...target, targetKind: "group" as const, targetId: "group-a" };
    const groupKey = makeComposerDraftKey(group);
    rememberVerifiedComposerRecoveryTarget(group, groupKey, false);
    writeComposerDraft(groupKey, {
      attachments: [
        { id: "old-file", threadKey: groupKey, file: new File(["only file"], "only.txt") },
      ],
    });
    expect(prepareRejectedComposerDraft(group, preview)).toBe(true);
    signInAgain();
    expect(
      restoreRejectedComposerDraft(
        { ...group, sessionId: renewed.sessionId },
        groupKey,
        true,
        () => true,
      ),
    ).toBe(true);
    expect(readComposerDraft(groupKey).text).toBe("");
    expect(readComposerDraft(groupKey).attachments).toHaveLength(1);
    expect(
      restoreRejectedComposerDraft(
        { ...group, sessionId: renewed.sessionId },
        groupKey,
        true,
        () => true,
      ),
    ).toBe(false);
  });

  it("leaves ordinary clearing available if copying editable reply text fails", () => {
    writeComposerDraft(key, { text: "Private unsent text", replyTarget: reply });
    expect(
      prepareRejectedComposerDraft(target, () => {
        throw new Error("Bad preview");
      }),
    ).toBe(false);
    signInAgain();
    expect(readComposerDraft(key).text).toBe("");
    expect(restore()).toBe(false);
  });
});
