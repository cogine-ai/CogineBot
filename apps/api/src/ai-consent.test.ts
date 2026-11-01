import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { parsePlatformModelAllowlist } from "@rakazo/core";
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
      expect(status.recipients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "OpenAI-compatible (https://selected.example)",
            detail: "same-model",
          }),
        ]),
      );
    },
  );
  it("discloses enabled helper models from an owned connection without a Space preference", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    const rows = [
      {
        id: "other-space",
        userId: actor.userId,
        provider: "openai-compatible",
        secretId: "helper-secret",
        preferences: [],
      },
      {
        id: "retired",
        userId: actor.userId,
        provider: "openai-compatible",
        secretId: "missing-secret",
        preferences: [],
      },
      {
        id: "foreign",
        userId: "another-user",
        provider: "openai-compatible",
        secretId: "foreign-secret",
        preferences: [],
      },
    ];
    Object.assign(deps.prisma.userModelCredential, {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows.filter((row) => row.userId === where.userId),
      ),
    });
    Object.assign(deps.prisma.secret, {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; spaceId: null; id: { in: string[] } } }) =>
          where.userId === actor.userId &&
          where.spaceId === null &&
          where.id.in.includes("helper-secret")
            ? [{ id: "helper-secret", ciphertext: "helper-ciphertext" }]
            : [],
      ),
    });
    Object.assign(deps, {
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://helper.example/v1",
            apiKey: "synthetic-key",
            enabledModelIds: ["same-model", "extra-model"],
            discoveredModelIds: ["disabled-model"],
          }),
        ),
      },
    });

    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });

    expect(
      status.recipients.map(({ name, detail, allowed }) => ({ name, detail, allowed })),
    ).toEqual([
      { name: "OpenAI-compatible (https://helper.example)", detail: "same-model", allowed: false },
      { name: "OpenAI-compatible (https://helper.example)", detail: "extra-model", allowed: false },
    ]);
    expect(deps.prisma.userModelCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId },
      }),
    );
    expect(deps.secrets.load).toHaveBeenCalledTimes(1);
  });
  it("discloses helper catalog models allowed by the saved authentication", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "subscription",
        userId: actor.userId,
        provider: "openai-codex",
        secretId: "oauth-secret",
        preferences: [],
      },
    ] as never);
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue([
      {
        id: "oauth-secret",
        ciphertext: "synthetic-oauth-ciphertext",
      },
    ] as never);
    Object.assign(deps, {
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "oauth",
            provider: "openai-codex",
            credential: {
              type: "oauth",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: 9999999999999,
            },
          }),
        ),
      },
    });

    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });

    expect(status.recipients.some(({ detail }) => detail === "gpt-6.1-sol")).toBe(true);
    expect(status.recipients.some(({ detail }) => detail === "gpt-5.3-codex-spark")).toBe(false);
  });
  it("rejects an incomplete helper disclosure while the secret store is unavailable", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "other-space",
        userId: actor.userId,
        provider: "openai-compatible",
        secretId: "helper-secret",
        preferences: [],
      },
    ] as never);
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue([
      { id: "helper-secret", ciphertext: "fixture" },
    ] as never);
    Object.assign(deps, {
      secrets: {
        load: vi.fn(async () => {
          throw new SecretStoreUnavailableError(503, "temporary fixture outage");
        }),
      },
    });

    await expect(
      aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
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

describe("platform model consent policy", () => {
  function policyConsent(raw: string | undefined, email: string, verified: boolean, owner = false) {
    const f = setup();
    Object.assign(f.deps.env, {
      agentRuntime: "pi",
      deploymentModelConfigured: true,
      defaultProvider: "openai",
      defaultModel: "shared-model",
      platformModelAllowlist: parsePlatformModelAllowlist(raw),
    });
    const findUser = vi.fn(async () => ({ email, emailVerified: verified }));
    Object.assign(f.deps.prisma, { user: { findUnique: findUser } });
    vi.mocked(f.deps.prisma.deploymentSettings.findUnique).mockResolvedValue({
      ownerUserId: owner ? f.actor.userId : "different-owner",
    } as never);
    f.actor.email = "member@allowed.test";
    f.actor.isDeploymentOwner = !owner;
    return { ...f, findUser };
  }

  it.each([
    ["none", "member@allowed.test", true],
    ["@allowed.test", "member@allowed.test", false],
    ["@allowed.test", "member@allowed.test.attacker.invalid", true],
  ] as const)(
    "omits a denied shared recipient (%s / %s / proof=%s)",
    async (raw, email, verified) => {
      const f = policyConsent(raw, email, verified);
      const result = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
      expect(result.recipients).toEqual([]);
      expect(f.findUser).toHaveBeenCalledWith({
        where: { id: f.actor.userId },
        select: { email: true, emailVerified: true },
      });
    },
  );

  it("uses the stored owner grant rather than the caller's cached owner flag", async () => {
    const f = policyConsent("none", "owner@messaging.invalid", false, true);
    const result = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
    expect(result.recipients).toEqual([
      expect.objectContaining({ name: "OpenAI", detail: "shared-model", use: "model" }),
    ]);
  });

  it("keeps BYOK disclosure while excluding the denied deployment model", async () => {
    const f = policyConsent("none", "member@outside.test", false);
    const credential = {
      id: "byok",
      userId: f.actor.userId,
      provider: "anthropic",
      secretId: "user-secret",
      preferences: [],
    };
    vi.mocked(f.deps.prisma.spaceModelPreference.findFirst).mockResolvedValue({
      modelId: "user-model",
      isDefault: true,
      thinkingLevel: null,
      credential,
    } as never);
    vi.mocked(f.deps.prisma.secret.findMany).mockResolvedValue([
      { id: "user-secret", ciphertext: "fake-cipher" },
    ] as never);
    f.deps.secrets = { load: vi.fn(async () => "fake-user-key") } as never;
    const result = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
    expect(result.recipients).toEqual([
      expect.objectContaining({ name: "Anthropic", detail: "user-model", use: "model" }),
    ]);
  });

  it("keeps unrestricted disclosure without an authority lookup", async () => {
    const f = policyConsent(undefined, "member@outside.test", false);
    const result = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
    expect(result.recipients).toEqual([
      expect.objectContaining({ name: "OpenAI", detail: "shared-model" }),
    ]);
    expect(f.findUser).not.toHaveBeenCalled();
  });
});

describe("local model data disclosure", () => {
  it.each([undefined, "none"])(
    "retains local recipient independently of funding policy %s",
    async (policy) => {
      vi.stubEnv("RAKAZO_LOCAL_MODELS_URL", "https://models.example.test/v1");
      vi.stubEnv("RAKAZO_LOCAL_MODELS", "fixture-local-model");
      const f = setup();
      Object.assign(f.deps.env, {
        agentRuntime: "pi",
        deploymentModelConfigured: false,
        defaultProvider: "local",
        defaultModel: "fixture-local-model",
        platformModelAllowlist: parsePlatformModelAllowlist(policy),
      });
      Object.assign(f.deps.prisma, {
        user: {
          findUnique: vi.fn(async () => ({ email: "member@outside.test", emailVerified: false })),
        },
      });
      vi.mocked(f.deps.prisma.deploymentSettings.findUnique).mockResolvedValue({
        ownerUserId: "different-owner",
        defaultModelProvider: "local",
        defaultModelId: "fixture-local-model",
      } as never);
      try {
        const status = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
        expect(status.recipients).toEqual([
          expect.objectContaining({
            name: expect.stringContaining("models.example.test"),
            use: "model",
            detail: "fixture-local-model",
            allowed: false,
          }),
        ]);
        vi.mocked(f.deps.prisma.aiDataConsent.findMany).mockResolvedValue([
          { recipientKey: status.recipients[0]!.key },
        ] as never);
        const granted = await aiConsentStatus(f.deps, f.actor, { uses: ["model"] });
        expect(granted.recipients).toEqual([{ ...status.recipients[0], allowed: true }]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
