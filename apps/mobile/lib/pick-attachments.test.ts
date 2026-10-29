import { inferAttachmentMimeType } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { filterPickedAttachments } from "./pick-attachments-filter.js";

describe("filterPickedAttachments", () => {
  it("skips unsupported mime types and oversize files", () => {
    const result = filterPickedAttachments(0, [
      {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "bundle.zip",
        mimeType: inferAttachmentMimeType("bundle.zip", "application/x-zip-compressed"),
        size: 12,
        contentBase64: "UEsDBA==",
      },
      {
        name: "payload.exe",
        mimeType: null,
        size: 12,
        contentBase64: "aGVsbG8=",
      },
      {
        name: "big.pdf",
        mimeType: "application/pdf",
        size: 10 * 1024 * 1024 + 1,
        contentBase64: "aGVsbG8=",
      },
    ]);
    expect(result.attachments.map((item) => item.name)).toEqual(["notes.txt"]);
    expect(result.skipped.map((item) => item.name)).toEqual([
      "bundle.zip",
      "payload.exe",
      "big.pdf",
    ]);
  });

  it("assigns distinct ids to duplicate files", () => {
    const candidate = {
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
      contentBase64: "aGVsbG8=",
    };
    const result = filterPickedAttachments(0, [candidate, candidate]);
    expect(new Set(result.attachments.map((attachment) => attachment.id)).size).toBe(2);
    const replacement = filterPickedAttachments(1, [candidate]).attachments[0]!;
    expect(replacement.id).not.toBe(result.attachments[1]!.id);
    expect(replacement).toMatchObject({ name: "notes.txt", size: 12 });
  });
});
