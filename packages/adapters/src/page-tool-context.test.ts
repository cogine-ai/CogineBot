import { PAGE_KIT_GUIDE } from "@rakazo/page-kit/validate";
import { describe, expect, it } from "vitest";
import { serializeToolResult } from "./pi-runtime.js";

describe("Page tool context", () => {
  it("gives the model the whole on-demand guide instead of an unretrievable preview", () => {
    const result = serializeToolResult({ guide: PAGE_KIT_GUIDE }, "current", "save_page", {
      help: true,
    });
    expect(JSON.parse(result)).toEqual({ guide: PAGE_KIT_GUIDE });
  });
});
