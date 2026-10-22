import { describe, expect, it } from "vitest";
import {
  CreateRoutineInput,
  ModelBackupListSchema,
  ModelConnectInputSchema,
  UpdateBotInput,
} from "./domain.js";

const connection = {
  provider: "openai-compatible",
  baseUrl: "https://models.example/v1",
  modelId: "m0",
};

describe("model connection boundaries", () => {
  it("normalizes exact enabled ids without merging case-sensitive models", () => {
    expect(
      ModelConnectInputSchema.parse({ ...connection, enabledModelIds: [" m0 ", "M0", "m0"] })
        .enabledModelIds,
    ).toEqual(["m0", "M0"]);
  });

  it("limits the effective list including the default to 500 models", () => {
    const enabledModelIds = Array.from({ length: 500 }, (_, index) => `m${index}`);
    expect(ModelConnectInputSchema.safeParse({ ...connection, enabledModelIds }).success).toBe(
      true,
    );
    expect(
      ModelConnectInputSchema.safeParse({ ...connection, modelId: "extra", enabledModelIds })
        .success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({
        ...connection,
        enabledModelIds: [...enabledModelIds, "extra"],
      }).success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({ ...connection, enabledModelIds: ["x".repeat(513)] })
        .success,
    ).toBe(false);
  });

  it("requires the displayed revision when editing a particular connection", () => {
    expect(
      ModelConnectInputSchema.safeParse({ ...connection, credentialId: "connection-one" }).success,
    ).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({
        ...connection,
        credentialId: "connection-one",
        expectedRevision: 1,
      }).success,
    ).toBe(true);
    expect(ModelConnectInputSchema.safeParse({ ...connection, expectedRevision: 1 }).success).toBe(
      false,
    );
  });

  it("keeps identical model ids on different backup connections distinct", () => {
    const first = {
      provider: "openai-compatible",
      modelId: "same",
      modelCredentialId: "one",
      expectedRevision: 1,
    };
    const second = { ...first, modelCredentialId: "two" };
    expect(ModelBackupListSchema.safeParse([first, second]).success).toBe(true);
    expect(ModelBackupListSchema.safeParse([first, first]).success).toBe(false);
  });
});

describe("explicit model pin writes", () => {
  const pin = {
    modelProvider: "openai-compatible",
    modelId: "same",
    modelCredentialId: "one",
    expectedRevision: 3,
  };
  it("requires the whole binding and revision, while allowing a full clear", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot", ...pin }).success).toBe(true);
    expect(
      UpdateBotInput.safeParse({ botId: "bot", ...pin, expectedRevision: undefined }).success,
    ).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot", modelCredentialId: "one" }).success).toBe(
      false,
    );
    expect(
      UpdateBotInput.safeParse({
        botId: "bot",
        modelProvider: null,
        modelId: null,
        modelCredentialId: "one",
      }).success,
    ).toBe(false);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot",
        modelProvider: null,
        modelId: null,
        modelCredentialId: null,
      }).success,
    ).toBe(true);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot",
        name: "Daily",
        prompt: "Run",
        crons: ["0 9 * * *"],
        ...pin,
      }).success,
    ).toBe(true);
  });
});
