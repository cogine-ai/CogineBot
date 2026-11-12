import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  OWN_INSTRUCTIONS_BASELINE_UNKNOWN,
  prepareOwnBotSettings,
  readOwnBotSettings,
} from "./own-bot-settings.js";
import { ownSettingsApprovalBlock } from "./own-bot-settings-write.js";

const mocked = vi.hoisted(() => ({ voices: vi.fn(), connections: vi.fn() }));
vi.mock("./model-selection.js", async (load) => ({
  ...(await load<typeof import("./model-selection.js")>()),
  listOwnedModelConnections: mocked.connections,
}));
vi.mock("./voice-factory.js", async (load) => ({
  ...(await load<typeof import("./voice-factory.js")>()),
  createVoiceProvider: () => ({ listVoices: mocked.voices }),
}));
vi.mock("./pi-models.js", async (load) => ({
  ...(await load<typeof import("./pi-models.js")>()),
  listPiCatalog: () => [
    { provider: "fixture", id: "checklist", label: "Checklist 3", thinkingLevels: ["off", "low"] },
    ...Array.from({ length: 16 }, (_, index) => ({
      provider: "fixture",
      id: `extra-${index}`,
      label: `Extra ${index}`,
      thinkingLevels: ["off"],
    })),
  ],
}));

const scope = { userId: "owner", spaceId: "space", botId: "bot", runId: "run" };
const context: AdapterContext = {
  ...scope,
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
const fallback = { provider: "fixture", id: "checklist", thinkingLevel: "off" };
const bot = {
  id: "bot",
  name: "Checklist",
  title: "",
  description: "",
  color: "slate",
  notifyOnFinish: true,
  instructions: "Original",
  settingsRevision: 2,
  modelProvider: null as string | null,
  modelId: null as string | null,
  modelCredentialId: null as string | null,
  thinkingLevel: "high" as string | null,
  voiceId: null,
  autoSpeak: false,
};
const connection = {
  id: "one",
  label: "Personal",
  provider: "fixture",
  connectionRevision: 2,
  preferences: [],
};
const other = { ...connection, id: "two", label: "Team" };

function fixture(
  row: Partial<typeof bot> = {},
  modelPreference: {
    credential: typeof connection;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null = null,
) {
  mocked.connections.mockResolvedValue([
    {
      provider: "fixture",
      modelCredentialId: connection.id,
      connectionRevision: connection.connectionRevision,
      label: connection.label,
      modelIds: ["checklist", ...Array.from({ length: 16 }, (_, i) => `extra-${i}`)],
    },
    {
      provider: "fixture",
      modelCredentialId: other.id,
      connectionRevision: other.connectionRevision,
      label: other.label,
      modelIds: ["checklist"],
    },
  ]);
  mocked.voices.mockResolvedValue([
    { id: "one", label: "Alex" },
    { id: "two", label: "Alex" },
  ]);
  const credentials = [
    modelPreference?.credential.id === connection.id
      ? { ...connection, preferences: [modelPreference] }
      : connection,
    other,
  ];
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn().mockResolvedValue({ ...bot, ...row }) },
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue(credentials),
        findFirst: vi.fn(({ where }) =>
          Promise.resolve(credentials.find((row) => row.id === where.id)),
        ),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(modelPreference) },
      spaceVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          credential: {
            id: "voice",
            provider: "openai",
            secretId: "test-voice-secret",
            updatedAt: new Date(0),
          },
          voiceId: "one",
          isDefault: true,
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "test-voice-secret", ciphertext: "fixture" }),
      },
    } as never,
    secretStore: { load: vi.fn().mockResolvedValue("synthetic") },
  };
  const prepare = (
    args: Parameters<typeof prepareOwnBotSettings>[3],
    revision = bot.settingsRevision,
  ) =>
    prepareOwnBotSettings(
      deps,
      scope,
      context,
      args,
      { instructions: bot.instructions, revision },
      fallback,
      [],
    );
  return { deps, prepare };
}

describe("owner Bot settings", () => {
  it("limits the initial provider list and finds the remaining model by name", async () => {
    const { deps } = fixture();
    const settings = await readOwnBotSettings(deps, scope, context, fallback);
    expect(settings).toMatchObject({
      model: { source: "system", id: "checklist" },
      instructions: { source: "bot", value: "Original" },
      voice: { source: "space", id: "one", available: true },
      readAloud: { value: false },
      models: [{ models: expect.any(Array), more: 3 }],
    });
    expect("models" in settings && settings.models?.[0]?.models).toHaveLength(15);
    const searched = await readOwnBotSettings(deps, scope, context, fallback, "Extra 15");
    expect(searched).toMatchObject({ models: [{ models: [{ model: "extra-15" }], more: 0 }] });
    expect(JSON.stringify(searched)).not.toContain("test-voice-secret");
  });

  it("does not borrow a system model for a connection with no usable default", async () => {
    const { deps, prepare } = fixture(
      { thinkingLevel: null },
      {
        credential: { ...connection, provider: "chatgpt-plan" },
        modelId: null,
        thinkingLevel: null,
      },
    );
    await expect(readOwnBotSettings(deps, scope, context, fallback)).resolves.toMatchObject({
      model: { source: "space", provider: "chatgpt-plan", id: null, available: false },
      thinkingLevel: { value: "default", source: "model" },
    });
    await expect(prepare({ thinkingLevel: "off" })).resolves.toMatchObject({
      error: expect.stringContaining("available model"),
    });
  });

  it("identifies the connection as the source of an inherited thinking level for a pinned model", async () => {
    const { deps } = fixture(
      {
        modelProvider: "fixture",
        modelId: "checklist",
        modelCredentialId: "one",
        thinkingLevel: null,
      },
      { credential: connection, modelId: "checklist", thinkingLevel: "low" },
    );
    await expect(readOwnBotSettings(deps, scope, context, fallback)).resolves.toMatchObject({
      model: { source: "bot", id: "checklist", available: true },
      thinkingLevel: { value: "low", source: "space" },
    });
  });

  it("does not guess between connections and binds the chosen revision", async () => {
    const { prepare } = fixture();
    await expect(prepare({ model: "Checklist 3" })).resolves.toMatchObject({
      error: expect.stringContaining("Several"),
    });
    await expect(prepare({ model: "checklist", connection: "Team" })).resolves.toMatchObject({
      request: {
        modelConnection: { id: "two", revision: 2, label: "Team" },
        after: {
          modelCredentialId: "two",
          modelId: "checklist",
          modelProvider: "fixture",
          thinkingLevel: null,
        },
      },
    });
    await expect(
      prepare({ model: "checklist", connection: "Team", thinkingLevel: "high" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("off, low") });
  });

  it("refuses unknown baseline and never uses a newer revision as a replacement", async () => {
    const { deps, prepare } = fixture();
    await expect(
      prepareOwnBotSettings(deps, scope, context, { instructions: "New" }, {}, fallback, []),
    ).resolves.toEqual({ error: OWN_INSTRUCTIONS_BASELINE_UNKNOWN });
    await expect(prepare({ instructions: "New" }, 1)).resolves.toMatchObject({
      error: expect.stringContaining("changed elsewhere"),
    });
  });

  it("matches voices only on the current provider and permits an exact ID", async () => {
    const { prepare } = fixture();
    await expect(prepare({ voice: "Alex" })).resolves.toMatchObject({
      error: expect.stringContaining("Several voices"),
    });
    const prepared = await prepare({ voice: "two", readAloud: true });
    expect(prepared).toMatchObject({
      request: {
        after: { voiceId: "two", autoSpeak: true },
        voiceConnection: { id: "voice", provider: "openai" },
      },
    });
    if (!prepared.request) throw new Error("Expected a voice change request");
    expect(
      ownSettingsApprovalBlock("effect", prepared.request, []).botSettings.changes,
    ).toContainEqual(expect.objectContaining({ field: "voice", after: "Alex · two" }));
    await expect(prepare({ voice: "default" })).resolves.toEqual({ unchanged: true });
  });
});
