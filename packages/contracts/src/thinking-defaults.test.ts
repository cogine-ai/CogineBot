import { describe, expect, it } from "vitest";
import { resolveThinkingDefault } from "./thinking-defaults.js";

const model = { provider: "openai-compatible", modelId: "fixture-model" };
const account = { model, level: "high" as const };
const defaults = {
  model,
  account,
  allowed: ["low", "high"] as const,
  explicit: null,
  legacy: null,
  space: null,
};

describe("thinking preference precedence", () => {
  it("keeps an explicit Bot or Routine effort", () => {
    expect(resolveThinkingDefault({ ...defaults, explicit: "low" })).toEqual({
      level: "low",
      source: "bot",
      unsupported: false,
    });
  });

  it("preserves an existing local level until the Space explicitly follows", () => {
    expect(resolveThinkingDefault({ ...defaults, legacy: "low" })).toMatchObject({
      level: "low",
      source: "space",
    });
    expect(
      resolveThinkingDefault({
        ...defaults,
        legacy: "low",
        space: { model, mode: "inherit" },
      }),
    ).toMatchObject({ level: "high", source: "account" });
  });

  it("does not clamp an unsupported account level or use it on another model", () => {
    expect(resolveThinkingDefault({ ...defaults, allowed: ["low"] })).toEqual({
      level: null,
      source: "system",
      unsupported: true,
    });
    expect(
      resolveThinkingDefault({ ...defaults, model: { ...model, modelId: "another" } }),
    ).toEqual({
      level: null,
      source: "system",
      unsupported: false,
    });
  });

  it("lets a Space choose the model's default independently of a saved lower-level preference", () => {
    expect(
      resolveThinkingDefault({
        ...defaults,
        legacy: "low",
        space: { model, mode: "fixed", level: null },
      }),
    ).toEqual({ level: null, source: "space", unsupported: false });
  });
});
