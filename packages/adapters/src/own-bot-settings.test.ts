import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  OWN_INSTRUCTIONS_BASELINE_UNKNOWN,
  prepareOwnBotSettings,
  readOwnBotSettings,
} from "./own-bot-settings.js";

const mocked = vi.hoisted(() => ({ voices: vi.fn(), connections: vi.fn() }));
vi.mock("./model-selection.js", async (load) => ({
  ...(await load<typeof import("./model-selection.js")>()),
  listHelperModelConnections: mocked.connections,
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
  settingsHistory: [],
  modelProvider: null,
  modelId: null,
  modelCredentialId: null,
  thinkingLevel: "high",
  voiceId: null,
  autoSpeak: false,
};
const connection = { id: "one", label: "Personal", provider: "fixture", connectionRevision: 2 };
const other = { ...connection, id: "two", label: "Team" };

function fixture() {
  mocked.connections.mockResolvedValue([
    {
      provider: "fixture",
      modelCredentialId: connection.id,
      modelIds: ["checklist", ...Array.from({ length: 16 }, (_, i) => `extra-${i}`)],
    },
    { provider: "fixture", modelCredentialId: other.id, modelIds: ["checklist"] },
  ]);
  mocked.voices.mockResolvedValue([
    { id: "one", label: "Alex" },
    { id: "two", label: "Alex" },
  ]);
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn().mockResolvedValue(bot) },
      userModelCredential: {
        findMany: vi.fn().mockResolvedValue([connection, other]),
        findFirst: vi.fn(({ where }) =>
          Promise.resolve([connection, other].find((row) => row.id === where.id)),
        ),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
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
    await expect(prepare({ voice: "two", readAloud: true })).resolves.toMatchObject({
      request: {
        after: { voiceId: "two", autoSpeak: true },
        voiceConnection: { id: "voice", provider: "openai" },
      },
    });
    await expect(prepare({ voice: "default" })).resolves.toEqual({ unchanged: true });
  });
});
