import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });

  it("keeps operational text and peer bodies out of the conversation preview", () => {
    expect(
      previewFromBlocks([
        { kind: "progress", text: "Using browser" },
        { kind: "bot_message_received", text: "Internal reply" },
        { kind: "text", text: "Let's meet by the lake." },
      ]),
    ).toBe("Let's meet by the lake.");
  });

  it("shows a real filename for an attachment-only message", () => {
    expect(previewFromBlocks([{ kind: "file", name: "weekend-plan.pdf" }])).toBe(
      "weekend-plan.pdf",
    );
    expect(previewFromBlocks([{ kind: "image", name: "lake.png" }])).toBe("lake.png");
  });
});
