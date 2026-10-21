import { describe, expect, it } from "vitest";
import {
  compatibleModelRows,
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
  savedCompatibleModelIds,
} from "./model-providers.js";

const connections = [
  {
    id: "first",
    provider: "openai-compatible",
    label: "Server A",
    modelId: "same",
    enabledModelIds: ["same", "extra"],
    connectionRevision: 3,
  },
  {
    id: "second",
    provider: "openai-compatible",
    label: "Server B",
    modelId: "same",
    enabledModelIds: ["same"],
    connectionRevision: 7,
  },
];

describe("connection-bound model choices", () => {
  it("distinguishes identical labels by their canonical endpoints", () => {
    const choices = connectedModelChoices(
      connections.map((connection, index) => ({
        ...connection,
        label: "Custom server",
        baseUrl: `https://server-${index}.example`,
      })),
      [],
    );
    expect(choices[0]?.label).toContain("https://server-0.example/v1");
    expect(choices[2]?.label).toContain("https://server-1.example/v1");
  });
  it("offers the same model on two connections as separate choices with their revisions", () => {
    const choices = connectedModelChoices(connections, []);
    expect(
      choices.map(({ modelCredentialId, modelId, connectionRevision }) => ({
        modelCredentialId,
        modelId,
        connectionRevision,
      })),
    ).toEqual([
      { modelCredentialId: "first", modelId: "same", connectionRevision: 3 },
      { modelCredentialId: "first", modelId: "extra", connectionRevision: 3 },
      { modelCredentialId: "second", modelId: "same", connectionRevision: 7 },
    ]);
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(3);
    expect(choices[0]?.label).not.toBe(choices[2]?.label);
  });

  it("never guesses a connection for an unbound, missing or unsupported pin", () => {
    expect(credentialForModel(connections, "openai-compatible", "same", "second")).toBe(
      connections[1],
    );
    expect(credentialForModel(connections, "openai-compatible", "same")).toBeUndefined();
    expect(credentialForModel(connections, "openai-compatible", "same", "missing")).toBeUndefined();
    expect(credentialForModel(connections, "openai-compatible", "extra", "second")).toBeUndefined();
    expect(credentialForModel(connections, "other", "same", "second")).toBeUndefined();
  });

  it("round-trips selection identity even when the model contains legacy separators", () => {
    expect(
      parseModelOptionKey(modelOptionKey("openai-compatible", "model::name", "first")),
    ).toEqual({
      provider: "openai-compatible",
      modelId: "model::name",
      modelCredentialId: "first",
    });
    expect(parseModelOptionKey('["provider", "model", 3]')).toBeNull();
  });

  it("keeps saved ids only for the same canonical endpoint and merges rows exactly", () => {
    const saved = { baseUrl: "https://models.example/v1/", enabledModelIds: ["same"] };
    expect(savedCompatibleModelIds(saved, "https://models.example")).toEqual(["same"]);
    expect(savedCompatibleModelIds(saved, "https://other.example")).toEqual([]);
    expect(compatibleModelRows(["same"], ["extra", "same"], ["EXTRA", "extra"])).toEqual([
      "same",
      "extra",
      "EXTRA",
    ]);
  });
});
