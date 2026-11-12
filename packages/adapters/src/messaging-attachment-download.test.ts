import { downloadAttachment } from "@chat-adapter/shared";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  downloadMessagingAttachment,
  withinMessagingAttachmentDeadline,
} from "./messaging-attachment-download.js";

vi.mock("@chat-adapter/shared", () => ({ downloadAttachment: vi.fn() }));

describe("messaging attachment transport limits", () => {
  it("passes the chat byte limit and remaining deadline into the guarded transport", async () => {
    vi.mocked(downloadAttachment).mockResolvedValueOnce(Buffer.from("fixture"));
    const deadlineAt = Date.now() + 2000;
    await withinMessagingAttachmentDeadline(deadlineAt, () =>
      downloadMessagingAttachment("https://example.test/fixture", {
        adapter: "telegram",
        hosts: ["example.test"],
      }),
    );
    const [, options] = vi.mocked(downloadAttachment).mock.calls[0]!;
    expect(options).toMatchObject({
      adapter: "telegram",
      hosts: ["example.test"],
      limit: ATTACHMENT_MAX_BYTES,
    });
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(2000);
    expect(options.transport).toBeUndefined();
  });

  it("does not start another download once the overall deadline has elapsed", () => {
    vi.mocked(downloadAttachment).mockClear();
    expect(() =>
      withinMessagingAttachmentDeadline(Date.now() - 1, () =>
        downloadMessagingAttachment("https://example.test/fixture", { adapter: "slack" }),
      ),
    ).toThrow("Attachment download deadline exceeded");
    expect(downloadAttachment).not.toHaveBeenCalled();
  });
});
