import { describe, expect, it } from "vitest";
import {
  composerAttachmentUploadKey,
  composerSendSignature,
  createComposerSendAttemptStore,
} from "./composer-send-attempt";

function store() {
  let nonce = 0;
  return createComposerSendAttemptStore(() => `nonce-${++nonce}`);
}

describe("composer send retries", () => {
  it("locks synchronously so repeated clicks cannot issue a second first-send", () => {
    const attempts = store();
    const attempt = attempts.acquire("thread-a", "same-payload");
    expect(attempt?.clientNonce).toBe("nonce-1");
    expect(attempts.acquire("thread-a", "same-payload")).toBeNull();
    expect(attempts.acquire("thread-a", "edited-payload")).toBeNull();
    expect(attempts.acquire("thread-b", "same-payload")?.clientNonce).toBe("nonce-2");
  });

  it("retries with the same nonce and completed uploads/routines after a missing send response", () => {
    const attempts = store();
    const attempt = attempts.acquire("thread-a", "same-payload")!;
    attempt.uploadedArtifactIds.set("file-a", "artifact-a");
    attempt.completedRoutineIds.add("routine-a");
    attempts.finish("thread-a", attempt, false);
    const retry = attempts.acquire("thread-a", "same-payload")!;
    expect(retry).toBe(attempt);
    expect(retry.clientNonce).toBe("nonce-1");
    expect(retry.uploadedArtifactIds.get("file-a")).toBe("artifact-a");
    expect(retry.completedRoutineIds.has("routine-a")).toBe(true);
  });

  it("uses a new nonce and no old upload receipts when the actual payload changes", () => {
    const attempts = store();
    const old = attempts.acquire("thread-a", "first-payload")!;
    old.uploadedArtifactIds.set("file-a", "artifact-a");
    attempts.finish("thread-a", old, false);
    const changed = attempts.acquire("thread-a", "changed-payload")!;
    expect(changed.clientNonce).toBe("nonce-2");
    expect(changed.uploadedArtifactIds.size).toBe(0);
  });

  it("a confirmed send does not suppress a later intentional identical message", () => {
    const attempts = store();
    const first = attempts.acquire("thread-a", "same-payload")!;
    attempts.finish("thread-a", first, true);
    expect(attempts.acquire("thread-a", "same-payload")?.clientNonce).toBe("nonce-2");
  });

  it("ignores a late old-session completion after logout and a new send", () => {
    const attempts = store();
    const old = attempts.acquire("thread-a", "payload")!;
    expect(attempts.isCurrent("thread-a", old)).toBe(true);
    attempts.clear();
    expect(attempts.isCurrent("thread-a", old)).toBe(false);
    const fresh = attempts.acquire("thread-a", "payload")!;
    expect(attempts.isCurrent("thread-a", fresh)).toBe(true);
    attempts.finish("thread-a", old, true);
    expect(fresh.clientNonce).toBe("nonce-2");
    expect(attempts.acquire("thread-a", "payload")).toBeNull();
    attempts.finish("thread-a", fresh, false);
    expect(attempts.acquire("thread-a", "payload")).toBe(fresh);
  });

  it("clears only a deleted group's attempt without changing another draft's retry", () => {
    const attempts = store();
    const deleted = attempts.acquire("pending-group", "payload")!;
    deleted.uploadedArtifactIds.set("file-a", "deleted-group-artifact");
    const other = attempts.acquire("other-thread", "other-payload")!;
    other.uploadedArtifactIds.set("file-b", "other-artifact");
    attempts.finish("other-thread", other, false);

    attempts.clear("pending-group");

    expect(attempts.isCurrent("pending-group", deleted)).toBe(false);
    const fresh = attempts.acquire("pending-group", "payload")!;
    expect(fresh.clientNonce).not.toBe(deleted.clientNonce);
    expect(fresh.uploadedArtifactIds.size).toBe(0);
    attempts.finish("pending-group", deleted, true);
    expect(attempts.isCurrent("pending-group", fresh)).toBe(true);
    const retry = attempts.acquire("other-thread", "other-payload")!;
    expect(retry).toBe(other);
    expect(retry.uploadedArtifactIds.get("file-b")).toBe("other-artifact");
  });
});

describe("composer send payload identity", () => {
  const file = new File(["first"], "notes.txt", { lastModified: 100 });
  const attachment = { id: "file-a", threadKey: "scope-a", file };
  const payload = { text: "first\nsecond", target: { botId: "bot-a" }, attachments: [attachment] };

  it("retains multiline text and distinguishes changed text, target, mentions, routines and quotes", () => {
    const signature = composerSendSignature(payload);
    expect(composerSendSignature(payload)).toBe(signature);
    expect(JSON.parse(signature).text).toBe("first\nsecond");
    const changed = [
      { ...payload, text: "first second" },
      { ...payload, target: { groupId: "group-a" } },
      { ...payload, mentions: [{ kind: "bot", botId: "bot-b" }] },
      { ...payload, routineIds: ["routine-a"] },
      { ...payload, replyToMessageId: "message-a", replyQuote: "quote" },
      { ...payload, fromPage: true as const },
    ];
    for (const value of changed) expect(composerSendSignature(value)).not.toBe(signature);
  });

  it("retains a Page retry's receipts and changes its nonce when Page context changes", () => {
    const attempts = store();
    const raw = "[https://owner.example/report](page:manual)\nPlease read this.";
    const pageA = { ...payload, text: raw, pageContext: { pageId: "page-a" } };
    const first = attempts.acquire("thread-a", composerSendSignature(pageA))!;
    first.uploadedArtifactIds.set("file-a", "artifact-a");
    first.completedRoutineIds.add("routine-a");
    attempts.finish("thread-a", first, false);
    const retry = attempts.acquire("thread-a", composerSendSignature(pageA))!;
    expect(retry).toBe(first);
    expect(retry.uploadedArtifactIds.get("file-a")).toBe("artifact-a");
    expect(retry.completedRoutineIds.has("routine-a")).toBe(true);
    attempts.finish("thread-a", retry, false);
    const second = attempts.acquire(
      "thread-a",
      composerSendSignature({
        ...pageA,
        pageContext: { pageId: "page-b" },
      }),
    )!;
    expect(second.clientNonce).not.toBe(first.clientNonce);
    expect(second.uploadedArtifactIds.size).toBe(0);
    expect(second.completedRoutineIds.size).toBe(0);
    attempts.finish("thread-a", second, false);
    const plain = attempts.acquire("thread-a", composerSendSignature({ ...payload, text: raw }))!;
    expect(plain.clientNonce).not.toBe(second.clientNonce);
    expect(plain.uploadedArtifactIds.size).toBe(0);
  });

  it("does not conflate different File payloads with identical names, sizes and timestamps", () => {
    const differentFile = new File(["other"], "notes.txt", { lastModified: 100 });
    expect(differentFile.size).toBe(file.size);
    expect(composerAttachmentUploadKey({ ...attachment, file: differentFile })).not.toBe(
      composerAttachmentUploadKey(attachment),
    );
    expect(
      composerSendSignature({ ...payload, attachments: [{ ...attachment, file: differentFile }] }),
    ).not.toBe(composerSendSignature(payload));
  });

  it("distinguishes a fallback Page context from the same owner text and from another Page", () => {
    const ownerText = "[https://owner.example/report](page:manual)\nPlease read this.";
    const plain = { ...payload, text: ownerText };
    const pageA = { ...plain, pageContext: { pageId: "page-a" } };
    const pageB = { ...plain, pageContext: { pageId: "page-b" } };
    const signature = composerSendSignature(pageA);
    expect(composerSendSignature({ ...pageA, pageContext: { pageId: "page-a" } })).toBe(signature);
    expect(composerSendSignature(plain)).not.toBe(signature);
    expect(composerSendSignature(pageB)).not.toBe(signature);
    expect(JSON.parse(signature)).toMatchObject({
      text: ownerText,
      pageContext: { pageId: "page-a" },
    });
  });
});
