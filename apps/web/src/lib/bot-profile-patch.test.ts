import { BOT_DESCRIPTION_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botProfilePatch } from "./bot-profile-patch.js";

describe("bot profile patch", () => {
  const stored = { description: "Billing", instructions: "  Exact rules\n\n" };
  it("keeps an untouched profile, including a legacy long description, off the wire", () => {
    const legacy = { ...stored, description: "D".repeat(BOT_DESCRIPTION_MAX_LENGTH + 1) };
    expect(botProfilePatch(legacy, legacy)).toEqual({});
  });
  it("edits public description without changing execution rules", () => {
    expect(botProfilePatch(stored, { ...stored, description: "Invoices" })).toEqual({
      description: "Invoices",
    });
  });
  it("compares rules against the accepted raw baseline and preserves whitespace", () => {
    expect(botProfilePatch(stored, { ...stored, instructions: " \n" })).toEqual({
      instructions: " \n",
      expectedInstructions: stored.instructions,
    });
  });
  it("can explicitly clear rules without clearing the public description", () => {
    expect(botProfilePatch(stored, { ...stored, instructions: "" })).toEqual({
      instructions: "",
      expectedInstructions: stored.instructions,
    });
  });
  it("does not silently truncate rules", () => {
    const instructions = "R".repeat(20_001);
    expect(botProfilePatch(stored, { ...stored, instructions })).toEqual({
      instructions,
      expectedInstructions: stored.instructions,
    });
  });
});
