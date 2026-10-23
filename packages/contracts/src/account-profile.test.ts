import { describe, expect, it } from "vitest";
import {
  BOT_INSTRUCTIONS_CONFLICT_REASON,
  CreateBotInput,
  isBotInstructionsConflict,
  normalizeCreateBotProfile,
  UpdateBotInput,
} from "./domain.js";

describe("bot profile instructions", () => {
  it("identifies rule conflicts without treating model conflicts as stale rules", () => {
    expect(
      isBotInstructionsConflict({
        code: "CONFLICT",
        data: { reason: BOT_INSTRUCTIONS_CONFLICT_REASON },
      }),
    ).toBe(true);
    for (const error of [
      null,
      "CONFLICT",
      { code: "CONFLICT" },
      { code: "CONFLICT", data: null },
      { code: "CONFLICT", data: { reason: "model_changed" } },
      { code: "BAD_REQUEST", data: { reason: BOT_INSTRUCTIONS_CONFLICT_REASON } },
      { status: 409, message: "Instructions changed. Refresh and try again." },
    ]) {
      expect(isBotInstructionsConflict(error)).toBe(false);
    }
  });

  it("distinguishes omitted rules from explicitly empty rules at creation", () => {
    const omitted = CreateBotInput.parse({ name: "Chief", description: " Public role " });
    expect(normalizeCreateBotProfile(omitted).instructions).toBe("Public role");
    expect(normalizeCreateBotProfile({ ...omitted, instructions: "" }).instructions).toBe("");
  });

  it("preserves raw rules independently of the public description", () => {
    const instructions = "  # Rules\n\n- Keep spacing.\n\n";
    const input = CreateBotInput.parse({
      name: " Chief ",
      description: " Public role ",
      instructions,
    });
    expect(normalizeCreateBotProfile(input)).toMatchObject({
      name: "Chief",
      description: "Public role",
      instructions,
    });
    expect(
      UpdateBotInput.parse({ botId: "bot-1", instructions, expectedInstructions: " old \n" }),
    ).toMatchObject({ instructions, expectedInstructions: " old \n" });
  });

  it("rejects oversized explicit rules instead of silently shortening them", () => {
    expect(
      CreateBotInput.safeParse({ name: "Chief", instructions: "R".repeat(20_001) }).success,
    ).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", instructions: "R".repeat(20_001) }).success,
    ).toBe(false);
  });
});
