import { describe, expect, it } from "vitest";
import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./domain.js";
import { connectedBackupOptions, moveBackupChoice, sameBackupChoices } from "./model-backups.js";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-sonnet",
    label: "Claude Sonnet",
    billing: "",
  },
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude-haiku",
    label: "Claude Haiku",
    billing: "",
  },
  {
    provider: "unconnected",
    providerName: "Unconnected",
    id: "model-1",
    label: "Model 1",
    billing: "",
  },
  {
    provider: "anthropic",
    id: "anthropic-placeholder",
    label: "Anthropic",
    billing: "",
    placeholder: true,
  },
  {
    provider: "openai-compatible",
    providerName: "OpenAI-compatible",
    id: "custom-from-catalog",
    label: "Custom from catalog",
    billing: "",
  },
];
const credentials: ModelCredential[] = [
  {
    id: "cred-anthropic",
    connectionRevision: 1,
    provider: "anthropic",
    label: "Anthropic",
    hasKey: true,
    isDefault: true,
  },
  {
    id: "cred-openai-compatible",
    connectionRevision: 1,
    provider: "openai-compatible",
    label: "Local server",
    hasKey: true,
    isDefault: false,
    modelId: "custom-model",
  },
];
const choices: ModelBackupChoice[] = [
  { provider: "anthropic", modelId: "claude-sonnet" },
  { provider: "anthropic", modelId: "claude-haiku" },
];

describe("connected backup model choices", () => {
  it("keeps the native catalog provider name when a credential label is a provider id", () => {
    const options = connectedBackupOptions(catalog, [{ ...credentials[0]!, label: "anthropic" }]);
    expect(options[0]?.providerName).toBe("Anthropic");
  });
  it("offers only non-placeholder catalog models for connected providers", () => {
    expect(connectedBackupOptions(catalog, credentials)).toEqual([
      {
        provider: "anthropic",
        modelCredentialId: "cred-anthropic",
        expectedRevision: 1,
        modelId: "claude-sonnet",
        label: "Claude Sonnet",
        providerName: "Anthropic",
      },
      {
        provider: "anthropic",
        modelCredentialId: "cred-anthropic",
        expectedRevision: 1,
        modelId: "claude-haiku",
        label: "Claude Haiku",
        providerName: "Anthropic",
      },
      {
        provider: "openai-compatible",
        modelCredentialId: "cred-openai-compatible",
        expectedRevision: 1,
        modelId: "custom-model",
        label: "custom-model",
        providerName: "Local server",
      },
    ]);
  });

  it("keeps an unnamed compatible model and skips disconnected catalog rows", () => {
    const mobileCatalog: ModelCatalogEntry[] = [
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "sonnet",
        label: "Sonnet",
        billing: "",
      },
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "haiku",
        label: "Haiku",
        billing: "",
      },
      { provider: "other", id: "other-model", label: "Other", billing: "" },
      {
        provider: "anthropic",
        id: "placeholder",
        label: "Anthropic",
        billing: "",
        placeholder: true,
      },
      { provider: "openai-compatible", id: "server-model", label: "Server model", billing: "" },
    ];
    const mobileCredentials: ModelCredential[] = [
      {
        id: "anthropic-credential",
        connectionRevision: 1,
        provider: "anthropic",
        label: "Anthropic",
        hasKey: true,
        isDefault: false,
      },
      {
        id: "compatible-credential",
        connectionRevision: 1,
        provider: "openai-compatible",
        label: "Private endpoint",
        hasKey: true,
        isDefault: false,
        modelId: "custom-model",
      },
    ];

    expect(connectedBackupOptions(mobileCatalog, mobileCredentials)).toEqual([
      {
        provider: "anthropic",
        modelCredentialId: "anthropic-credential",
        expectedRevision: 1,
        modelId: "sonnet",
        label: "Sonnet",
        providerName: "Anthropic",
      },
      {
        provider: "anthropic",
        modelCredentialId: "anthropic-credential",
        expectedRevision: 1,
        modelId: "haiku",
        label: "Haiku",
        providerName: "Anthropic",
      },
      {
        provider: "openai-compatible",
        modelCredentialId: "compatible-credential",
        expectedRevision: 1,
        modelId: "custom-model",
        label: "custom-model",
        providerName: "Private endpoint",
      },
    ]);
  });

  it("moves a backup one place without changing the source list", () => {
    expect(moveBackupChoice(choices, 1, -1)).toEqual([choices[1], choices[0]]);
    expect(choices).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "anthropic", modelId: "claude-haiku" },
    ]);
    expect(moveBackupChoice(choices, 0, -1)).toEqual(choices);
    expect(moveBackupChoice(choices, 1, 1)).toEqual(choices);
  });

  it("compares ordered pairs exactly", () => {
    expect(sameBackupChoices(choices, [...choices])).toBe(true);
    expect(sameBackupChoices(choices, [choices[1]!, choices[0]!])).toBe(false);
    expect(sameBackupChoices(choices, [{ ...choices[0]!, modelId: "other" }, choices[1]!])).toBe(
      false,
    );
  });
});
