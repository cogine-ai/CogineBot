import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: async () => ({ kind: "bot", botId: "bot" }),
}));

import { aiConsentStatus, allowAiConsent } from "./ai-consent.js";
import type { RouterDeps } from "./router.js";

function setup() {
  const upsert = vi.fn(async () => ({}));
  const deps = {
    env: { agentRuntime: "scripted" },
    prisma: {
      spaceModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      spaceBackupModel: { findMany: vi.fn(async () => []) },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      secret: { findMany: vi.fn(async () => []) },
      bot: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      spaceVoicePreference: {
        findFirst: vi.fn(async () => ({ credential: { provider: "openai" }, voiceId: "alloy" })),
        findMany: vi.fn(async () => [{ credential: { provider: "openai" } }]),
      },
      spaceMemoryConfig: { findUnique: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      aiDataConsent: { findMany: vi.fn(async () => []), upsert },
      $transaction: vi.fn(async (queries) => Promise.all(queries)),
    },
  } as unknown as RouterDeps;
  return { deps, upsert, actor: { userId: "user", spaceId: "space" } as Actor };
}
describe("consent grants", () => {
  it.each(["bot", "routine", "backup"] as const)(
    "discloses the exact %s connection rather than a newer same-model endpoint",
    async (kind) => {
      const { deps, actor } = setup();
      deps.env.agentRuntime = "pi";
      const rows = ["selected", "newer"].map((id, index) => ({
        id,
        provider: "openai-compatible",
        userId: actor.userId,
        label: "Server",
        secretId: `secret-${id}`,
        connectionRevision: 1,
        preferences: [],
        createdAt: new Date(index),
        updatedAt: new Date(index),
      }));
      const pin = {
        modelProvider: "openai-compatible",
        modelId: "same-model",
        modelCredentialId: "selected",
        thinkingLevel: null,
      };
      const project = async ({ select }: { select?: Record<string, boolean> }) => [
        Object.fromEntries(Object.entries(pin).filter(([key]) => !select || select[key])),
      ];
      if (kind === "backup")
        vi.mocked(deps.prisma.spaceBackupModel.findMany).mockResolvedValue([
          { provider: pin.modelProvider, modelId: pin.modelId, modelCredentialId: "selected" },
        ] as never);
      else
        Object.assign(kind === "bot" ? deps.prisma.bot : deps.prisma.routine, {
          findMany: vi.fn(project),
        });
      Object.assign(deps.prisma.userModelCredential, {
        findMany: vi.fn(async () => [rows[1]]),
        findFirst: vi.fn(
          async ({ where }: { where: { id: string; userId: string; provider: string } }) =>
            rows.find(
              (row) =>
                row.id === where.id &&
                row.userId === where.userId &&
                row.provider === where.provider,
            ) ?? null,
        ),
      });
      Object.assign(deps.prisma.secret, {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          rows
            .filter((row) => where.id.in.includes(row.secretId))
            .map((row) => ({ id: row.secretId, ciphertext: row.id })),
        ),
      });
      Object.assign(deps, {
        secrets: {
          load: vi.fn(async (ciphertext: string) =>
            JSON.stringify({
              kind: "openai_compatible",
              baseUrl: `https://${ciphertext}.example/v1`,
              enabledModelIds: ["same-model"],
            }),
          ),
        },
      });
      const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
      expect(status.recipients).toHaveLength(1);
      expect(status.recipients[0]?.name).toContain("https://selected.example");
      expect(status.recipients[0]?.name).not.toContain("newer.example");
    },
  );
  it("includes reachable helper models and cloud services for a targeted send", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockResolvedValue([
      {
        modelId: "helper-model",
        isDefault: false,
        credential: { provider: "anthropic", secretId: "test-secret" },
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients.map((recipient) => recipient.name)).toEqual(
      expect.arrayContaining(["Anthropic", "Cursor"]),
    );
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot"] } }) }),
    );
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: { in: ["bot"] },
          OR: [{ active: true }],
        }),
      }),
    );
  });
  it("includes an inactive routine only when the check is for that routine", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    await aiConsentStatus(deps, actor, { routineId: "routine-1", uses: ["model"] });
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ active: true }, { id: "routine-1" }],
        }),
      }),
    );
  });
  it("includes selected backup models in the provider-sharing disclosure until each is allowed", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.spaceBackupModel.findMany).mockResolvedValue([
      { provider: "anthropic", modelId: "claude-backup", modelCredentialId: "backup-credential" },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findFirst).mockResolvedValue({
      id: "backup-credential",
      userId: actor.userId,
      provider: "anthropic",
      label: "fixture",
      secretId: "backup-secret",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      preferences: [],
    } as never);

    const status = await aiConsentStatus(deps, actor, { uses: ["model"] });

    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Anthropic",
          detail: "claude-backup",
          use: "model",
          allowed: false,
        }),
      ]),
    );
    expect(deps.prisma.spaceBackupModel.findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      orderBy: { position: "asc" },
    });
  });
  it("discloses only the selected voice provider before a voice action", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.spaceVoicePreference.findMany).mockResolvedValue([
      { credential: { provider: "openai" } },
      { credential: { provider: "elevenlabs" } },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]?.name).toBe("OpenAI");
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
  });
  it("defaults to the repository policy and preserves an operator override", async () => {
    const { deps, actor } = setup();
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe(
      "https://github.com/cogine-ai/CogineBot/blob/main/PRIVACY.md",
    );
    deps.env.privacyPolicyUrl = "https://example.com/privacy";
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe("https://example.com/privacy");
  });
  it("rejects stale disclosures, unknown recipients, and a changed account or Space", async () => {
    const { deps, actor, upsert } = setup();
    const current = await aiConsentStatus(deps, actor);
    const input = {
      scope: current.scope,
      version: current.version,
      keys: [current.recipients[0]!.key],
    };
    for (const invalid of [
      { ...input, version: "old" },
      { ...input, scope: "different-account" },
      { ...input, keys: ["unknown"] },
    ]) {
      await expect(allowAiConsent(deps, actor, invalid)).rejects.toThrow("changed");
    }
    expect(upsert).not.toHaveBeenCalled();
    await allowAiConsent(deps, actor, input);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: AI_DISCLOSURE_VERSION,
        },
      }),
    );
  });
});
