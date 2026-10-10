import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearComposerDrafts,
  makeComposerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import { createComposerSendAttemptStore } from "./composer-send-attempt";
import { createComposerSessionGuard } from "./composer-session";

afterEach(() => {
  clearComposerDrafts();
  vi.restoreAllMocks();
});

describe("composer session boundaries", () => {
  it("preserves drafts and send attempts during pending or unreachable session reads", () => {
    const clear = vi.fn();
    const synchronize = createComposerSessionGuard(clear);
    synchronize("authenticated", "user-a");
    synchronize("loading", undefined);
    synchronize("unreachable", undefined);
    synchronize("authenticated", "user-a");
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears on an authoritative anonymous session even without the Shell logout menu", () => {
    const clear = vi.fn();
    const synchronize = createComposerSessionGuard(clear);
    synchronize("authenticated", "user-a");
    synchronize("anonymous", undefined);
    synchronize("anonymous", undefined);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears on a direct authenticated actor change before another actor's draft can appear", () => {
    const clear = vi.fn();
    const synchronize = createComposerSessionGuard(clear);
    synchronize("authenticated", "user-a");
    synchronize("authenticated", "user-b");
    synchronize("authenticated", "user-b");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("does not mistake an incomplete authenticated identity for sign-out", () => {
    const clear = vi.fn();
    const synchronize = createComposerSessionGuard(clear);
    synchronize("authenticated", "user-a");
    synchronize("authenticated", undefined);
    synchronize("authenticated", "user-a");
    expect(clear).not.toHaveBeenCalled();
  });

  it("releases local files and invalidates an upload continuation across an actor switch", async () => {
    const attempts = createComposerSendAttemptStore(() => "send-nonce");
    const synchronize = createComposerSessionGuard(() => {
      clearComposerDrafts();
      attempts.clear();
    });
    const key = makeComposerDraftKey({
      userId: "user-a",
      spaceId: "shared-space",
      targetKind: "bot",
      targetId: "bot-a",
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    synchronize("authenticated", "user-a");
    writeComposerDraft(key, {
      text: "Private pending text",
      attachments: [
        {
          id: "photo",
          threadKey: key,
          file: new File(["photo"], "photo.png"),
          previewUrl: "blob:private-photo",
        },
      ],
    });
    const attempt = attempts.acquire(key, "payload")!;
    let completeUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      completeUpload = resolve;
    });
    const send = vi.fn();
    const continuation = (async () => {
      await upload;
      if (!attempts.isCurrent(key, attempt)) return;
      send();
    })();
    synchronize("authenticated", "user-b");
    completeUpload();
    await continuation;
    expect(send).not.toHaveBeenCalled();
    expect(readComposerDraft(key).text).toBe("");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:private-photo");
  });
});
