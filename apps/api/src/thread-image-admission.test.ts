import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { threadModelImageInput } from "./thread-image-admission.js";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage, threadImageInputStatus } from "./thread-target.js";

// Exercise the shared production send entrypoint with an owned stored image.
// No model transport or credential material is needed to reject known text-only input.
function fixture(group = false) {
  const model = { modelProvider: "openrouter", modelId: "deepseek/deepseek-v4-pro" };
  const tx = {
    secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "synthetic" }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "fixture-row" }]),
    chatGroup: {
      findFirst: vi.fn().mockResolvedValue({
        members: [
          { bot: { id: "bot-1", name: "First", color: "blue" } },
          { bot: { id: "bot-2", name: "Second", color: "blue" } },
        ],
      }),
    },
    thread: {
      update: vi.fn(async ({ data }: { data: { nextMessageSeq?: unknown } }) =>
        data.nextMessageSeq ? { nextMessageSeq: 1 } : { nextEventSeq: 1 },
      ),
    },
    artifact: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "image-1", name: "picture.png", mimeType: "image/png", size: 4 },
        ]),
    },
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1", ...model }) },
    spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
    userModelRoleChoice: { findMany: vi.fn().mockResolvedValue([]) },
    spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    userModelCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: "credential-1",
        provider: "openrouter",
        secretId: "secret-1",
        preferences: [],
        supportsImages: false,
      }),
    },
    deploymentSettings: {
      findUnique: vi.fn().mockResolvedValue({
        defaultModelProvider: model.modelProvider,
        defaultModelId: model.modelId,
      }),
    },
    page: { findFirst: vi.fn().mockResolvedValue({ id: "page-1", title: "Design" }) },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 1 }),
      update: vi.fn(),
    },
    run: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ status: "queued", startedAt: null }),
      create: vi.fn().mockResolvedValue({ id: "run-1", taskId: "task-1", status: "queued" }),
    },
    task: { create: vi.fn().mockResolvedValue({ id: "task-1" }) },
    steeringMessage: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    event: {
      create: vi.fn().mockResolvedValue({ seq: 1 }),
      findFirst: vi.fn().mockResolvedValue({ seq: 1, payload: {} }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const notify = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const releaseTakeover = vi.fn().mockResolvedValue(undefined);
  const send = (
    imageAdmission?: Parameters<typeof sendThreadMessage>[0]["imageAdmission"],
    imageHandling: "confirm" | "file" | null = "confirm",
    input: Partial<Parameters<typeof sendThreadMessage>[3]> = {},
  ) =>
    sendThreadMessage(
      { prisma, events: { notify } as never, jobs: { enqueue } as never, imageAdmission },
      { userId: "user-1", spaceId: "space-1" } as Actor,
      (group
        ? { kind: "group", groupId: "group-1", threadId: "thread-1" }
        : {
            kind: "bot",
            botId: "bot-1",
            threadId: "thread-1",
            bot: { id: "bot-1", ...model, computer: null },
          }) as ThreadTarget,
      {
        text: "Read this picture",
        artifactIds: ["image-1"],
        clientNonce: "image-send-1",
        imageHandling: imageHandling ?? undefined,
        mentions: group ? ["bot-1", "bot-2"] : undefined,
        ...input,
      } as Parameters<typeof sendThreadMessage>[3],
    );
  return { tx, send, notify, enqueue, releaseTakeover };
}

describe("current image send admission", () => {
  it.each([
    [false, false, "unsupported"],
    [true, false, "supported"],
    [true, true, "unknown"],
  ] as const)(
    "uses the waiting Run model (vision %s, retired revision %s)",
    async (vision, changed, expected) => {
      const { tx } = fixture();
      const botModel = vision ? "text" : "vision";
      const runModel = vision ? "vision" : "text";
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "openai-compatible",
        modelId: botModel,
        modelCredentialId: "credential-1",
        thinkingLevel: null,
      });
      tx.userModelCredential.findFirst.mockResolvedValue({
        id: "credential-1",
        provider: "openai-compatible",
        secretId: "secret-1",
        preferences: [],
        connectionRevision: 2,
      });
      const status = await threadModelImageInput(
        tx as never,
        { userId: "user-1", spaceId: "space-1" } as Actor,
        "bot-1",
        {
          id: "run-1",
          status: "waiting_input",
          trigger: "user",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          botSettingsSnapshot: {
            instructions: "",
            revision: 1,
            modelProvider: "openai-compatible",
            modelId: runModel,
            modelCredentialId: "credential-1",
            connectionRevision: changed ? 1 : 2,
            thinkingLevel: null,
          },
        },
        {
          deployment: null,
          secrets: {
            load: async () =>
              JSON.stringify({
                kind: "openai_compatible",
                baseUrl: "https://model.example.test/v1",
                enabledModelIds: ["vision", "text"],
                visionModelIds: ["vision"],
              }),
          },
        },
      );
      expect(status).toBe(expected);
    },
  );

  it("admits legacy image sends even when the client omits the new field", async () => {
    const { tx, send } = fixture();
    await expect(send(undefined, null)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.message.create).not.toHaveBeenCalled();
  });
  it("accepts explicit file intent without losing the image artifact", async () => {
    const { tx, send } = fixture();
    await expect(send(undefined, "file")).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: expect.arrayContaining([
            {
              kind: "file",
              artifactId: "image-1",
              name: "picture.png",
              mimeType: "image/png",
              size: 4,
            },
          ]),
        }),
      }),
    );
  });

  it.each([false, true])("honors scoped custom image configuration (%s)", async (images) => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelCredentialId: "credential-1",
      modelId: "custom-model",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      preferences: [],
      supportsImages: false,
    });
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
            visionModelIds: images ? ["custom-model"] : [],
          }),
        ),
      },
    };
    if (images) await expect(send(configuration)).resolves.toMatchObject({ runId: "run-1" });
    else
      await expect(send(configuration)).rejects.toMatchObject({
        code: "CONFLICT",
        data: { imageInputStatus: "unsupported" },
      });
  });

  it.each([false, true])(
    "classifies an unavailable model secret (provider outage: %s)",
    async (outage) => {
      const { tx, send } = fixture();
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "openai-compatible",
        modelCredentialId: "credential-1",
        modelId: "custom-model",
      });
      tx.userModelCredential.findFirst.mockResolvedValue({
        id: "credential-1",
        provider: "openai-compatible",
        secretId: "secret-1",
        preferences: [],
        supportsImages: false,
      });
      const load = vi
        .fn()
        .mockRejectedValue(
          outage ? new SecretStoreUnavailableError() : new Error("Unreadable fixture"),
        );
      await expect(send({ deployment: null, secrets: { load } })).rejects.toMatchObject(
        outage
          ? { code: "SERVICE_UNAVAILABLE" }
          : { code: "CONFLICT", data: { imageInputStatus: "unknown" } },
      );
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it.each([[null], [{ id: "model-a", name: "Model A", input: "image" }]])(
    "reports unknown for a corrupt saved ChatGPT Plan catalog (%j)",
    async (model) => {
      const { tx, send } = fixture();
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "chatgpt-plan",
        modelCredentialId: "credential-1",
        modelId: "model-a",
      });
      tx.userModelCredential.findFirst.mockResolvedValue({
        id: "credential-1",
        provider: "chatgpt-plan",
        secretId: "secret-1",
        preferences: [],
        supportsImages: false,
      });
      const load = vi.fn().mockResolvedValue(
        JSON.stringify({
          kind: "oauth",
          credential: {
            type: "oauth",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: 12345,
            clientId: "fixture-client",
            issuer: "https://auth.openai.com",
            subject: "fixture-account",
            hostId: "urn:uuid:13416834-2fa9-4a82-9b89-327b824534f6",
            scopes: ["chatgpt.tokens.use.direct"],
            idToken: "fixture-token",
            chatgptPlanModels: [model],
          },
        }),
      );
      await expect(send({ deployment: null, secrets: { load } })).rejects.toMatchObject({
        code: "CONFLICT",
        data: { imageInputStatus: "unknown" },
      });
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "uses the Codex account catalog for a live-only model's image input (%s)",
    async (supportsImages) => {
      const { tx, send } = fixture();
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "openai-codex",
        modelCredentialId: "credential-1",
        modelId: "gpt-6.1-terra",
      });
      tx.userModelCredential.findFirst.mockResolvedValue({
        id: "credential-1",
        provider: "openai-codex",
        secretId: "secret-1",
        preferences: [],
        defaultModel: "gpt-6.1-terra",
      });
      const configuration = {
        deployment: null,
        secrets: {
          load: vi.fn(async () =>
            JSON.stringify({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 3_600_000,
              accountId: "acct-live",
            }),
          ),
        },
        codexCatalog: {
          read: vi.fn(async () => [
            {
              slug: "gpt-6.1-terra",
              reasoningEfforts: [],
              supportsImages,
              supportsFastTier: false,
            },
          ]),
        },
      };
      if (supportsImages) {
        await expect(send(configuration)).resolves.toMatchObject({ runId: "run-1" });
      } else {
        await expect(send(configuration)).rejects.toMatchObject({
          code: "CONFLICT",
          message: "This model cannot read images. Choose a model that supports images.",
        });
      }
      expect(configuration.codexCatalog.read).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ accountId: "acct-live" }),
        { waitMs: 0 },
      );
    },
  );

  it("keeps a bundled Codex model's images when the account omits input modalities", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-codex",
      modelCredentialId: "credential-1",
      modelId: "gpt-6.1-sol",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-codex",
      secretId: "secret-1",
      preferences: [],
      defaultModel: "gpt-6.1-sol",
    });
    const read = vi.fn(async () => [
      {
        slug: "gpt-6.1-sol",
        reasoningEfforts: [],
        supportsFastTier: false,
      },
    ]);
    await expect(
      send({
        deployment: null,
        secrets: {
          load: vi.fn(async () =>
            JSON.stringify({
              type: "oauth",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 3_600_000,
              accountId: "acct-live",
            }),
          ),
        },
        codexCatalog: { read },
      }),
    ).resolves.toMatchObject({ runId: "run-1" });
    expect(read).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ accountId: "acct-live" }),
      { waitMs: 0 },
    );
  });

  it("asks to configure image input for a legacy custom connection that never set it", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelCredentialId: "credential-1",
      modelId: "custom-model",
    });
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      preferences: [],
      supportsImages: false,
    });
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
          }),
        ),
      },
    };
    await expect(send(configuration)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Image input is not configured for this model.",
    });
  });

  it("does not require image support for document attachments", async () => {
    const { tx, send } = fixture();
    tx.artifact.findMany.mockResolvedValue([
      { id: "image-1", name: "notes.txt", mimeType: "text/plain", size: 4 },
    ]);
    await expect(send()).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.bot.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a mixed-capability group atomically", async () => {
    const { tx, send, enqueue } = fixture(true);
    tx.bot.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      modelProvider: "openrouter",
      modelId: where.id === "bot-1" ? "openai/gpt-4o" : "deepseek/deepseek-v4-pro",
    }));
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.bot.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replays an accepted nonce before validating attachments or current capabilities", async () => {
    const { tx, send } = fixture();
    tx.message.findUnique.mockResolvedValue({
      id: "accepted",
      seq: 7,
      sourceRuns: [{ id: "accepted-run", taskId: "accepted-task", status: "done" }],
    } as never);
    await expect(send()).resolves.toMatchObject({ seq: 7, runId: "accepted-run" });
    expect(tx.artifact.findMany).not.toHaveBeenCalled();
    expect(tx.bot.findFirst).not.toHaveBeenCalled();
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("uses a running text-only model even after the bot changes to vision", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany.mockResolvedValue([
      {
        id: "active",
        taskId: "task-active",
        status: "running",
        trigger: "user",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelPinned: false,
        leaseFence: 2,
        attemptModel: {
          leaseFence: 2,
          provider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          modelCredentialId: null,
        },
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("matches a legacy image default with surrounding whitespace like the executor", async () => {
    const { tx, send } = fixture();
    const stored = " custom-model ";
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openai-compatible",
      modelCredentialId: "credential-1",
      modelId: stored,
    });
    tx.spaceModelPreference.findFirst.mockResolvedValue({
      id: "preference-1",
      modelId: stored,
      isDefault: true,
      thinkingLevel: null,
      updatedAt: new Date(0),
      credentialId: "credential-1",
      credential: {
        id: "credential-1",
        userId: "user-1",
        provider: "openai-compatible",
        label: "Custom",
        secretId: "secret-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    } as never);
    tx.userModelCredential.findFirst.mockResolvedValue({
      id: "credential-1",
      provider: "openai-compatible",
      secretId: "secret-1",
      supportsImages: true,
      preferences: [{ modelId: stored, isDefault: true, thinkingLevel: null }],
    });
    // A running turn compares its stored model id directly with the saved default.
    tx.run.findMany.mockResolvedValue([
      {
        id: "active",
        taskId: "task-active",
        status: "running",
        trigger: "user",
        modelProvider: "openai-compatible",
        modelCredentialId: "credential-1",
        modelId: stored,
        modelPinned: false,
        leaseFence: 2,
        attemptModel: {
          leaseFence: 2,
          provider: "openai-compatible",
          modelId: stored,
          modelCredentialId: "credential-1",
        },
      },
    ] as never);
    const configuration = {
      deployment: null,
      secrets: {
        load: vi.fn(async () =>
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["custom-model"],
          }),
        ),
      },
    };
    await send(configuration);
    expect(tx.message.create).toHaveBeenCalled();
  });

  it.each([false, true])(
    "checks the actual waiting recipient (Page image only: %s)",
    async (pageOnly) => {
      const { tx, send } = fixture();
      tx.message.findMany = vi
        .fn()
        .mockResolvedValue([
          { id: "ask-1", blocks: [{ kind: "ask", text: "Question", status: "pending" }] },
        ]);
      tx.message.findFirst.mockResolvedValue({ id: "ask-1", role: "bot", blocks: [] } as never);
      tx.bot.findFirst.mockResolvedValue({
        id: "bot-1",
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
      });
      tx.run.findMany.mockResolvedValue([
        {
          id: "waiting",
          botId: "bot-1",
          taskId: "task-waiting",
          status: "waiting_input",
          trigger: "routine",
          modelProvider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          modelPinned: true,
        },
      ] as never);
      await expect(
        send(
          undefined,
          "confirm",
          pageOnly ? { text: undefined, pageContext: { pageId: "page-1" } } : {},
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      if (pageOnly) {
        const status = await threadImageInputStatus(
          { prisma: tx as unknown as PrismaClient },
          { userId: "user-1", spaceId: "space-1" } as Actor,
          { kind: "bot", botId: "bot-1", threadId: "thread-1" } as ThreadTarget,
          { pageContext: { pageId: "page-1" } },
        );
        expect(status).toEqual({ status: "unsupported", botId: "bot-1" });
      }
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it("does not use an obsolete waiting pin when the actual send starts a new turn", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany
      .mockResolvedValueOnce([
        {
          id: "obsolete",
          taskId: "obsolete-task",
          status: "waiting_input",
          trigger: "routine",
          modelProvider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          modelPinned: true,
        },
      ] as never)
      .mockResolvedValue([]);
    tx.run.findFirst = vi.fn().mockResolvedValue(null);
    await expect(send()).resolves.toMatchObject({ runId: "run-1" });
  });
  it("offers honest configuration confirmation for an unknown effective text-only transport", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "fixture/future-model",
    });
    await expect(send()).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Image input is not configured for this model.",
    });
  });
  it("checks a held conversational Run's saved quota target", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      id: "bot-1",
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    tx.run.findMany.mockResolvedValue([
      {
        id: "paused",
        taskId: "task-paused",
        status: "waiting_limit",
        trigger: "user",
        quotaWait: {
          revision: 1,
          beganAt: "2026-11-11T02:00:00.000Z",
          until: "2026-11-11T03:00:00.000Z",
          dispatchedFence: null,
          target: {
            provider: "openrouter",
            modelId: "deepseek/deepseek-v4-pro",
            modelCredentialId: null,
            connectionRevision: null,
            costOwner: "deployment",
            endpointDigest: "a".repeat(64),
          },
        },
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({
      code: "CONFLICT",
      data: { imageInputStatus: "unsupported" },
    });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it.each(["running channel", "quota-held DM"])(
    "checks private continuation instead of %s",
    async (delivery) => {
      const { tx, send } = fixture();
      tx.run.findMany.mockResolvedValue([
        {
          id: "channel",
          taskId: "task-channel",
          status: delivery === "running channel" ? "running" : "waiting_limit",
          trigger: "messaging",
          modelPinned: true,
          sourceMessage: {
            blocks:
              delivery === "running channel"
                ? [{ kind: "channel_message", channelId: "channel-1" }]
                : [],
          },
          modelProvider: "openrouter",
          modelId: "openai/gpt-4o",
        },
      ] as never);
      await expect(send()).rejects.toMatchObject({
        code: "CONFLICT",
        data: { imageInputStatus: "unsupported" },
      });
      expect(tx.message.create).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "uses only the backup on the current lease (matching: %s)",
    async (matching) => {
      const { tx } = fixture();
      expect(
        await threadModelImageInput(
          tx as unknown as PrismaClient,
          {
            spaceId: "space-1",
            userId: "user-1",
          } as Actor,
          "bot-1",
          {
            id: "pinned",
            status: "running",
            trigger: "user",
            modelPinned: true,
            leaseFence: 2,
            modelProvider: "openrouter",
            modelId: "openai/gpt-4o",
            attemptModel: {
              leaseFence: matching ? 2 : 1,
              provider: "openrouter",
              modelId: "deepseek/deepseek-v4-pro",
              modelCredentialId: null,
            },
          },
        ),
      ).toBe(matching ? "unsupported" : "supported");
    },
  );

  it("does not admit against the previous lease's vision model during an unpinned start", async () => {
    const { tx, send } = fixture();
    tx.run.findMany.mockResolvedValue([
      {
        id: "resuming",
        status: "running",
        trigger: "user",
        modelPinned: false,
        leaseFence: 3,
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
        attemptModel: {
          leaseFence: 2,
          provider: "openrouter",
          modelId: "openai/gpt-4o",
          modelCredentialId: null,
        },
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({
      code: "CONFLICT",
      data: { imageInputStatus: "unknown" },
    });
    expect(tx.message.create).not.toHaveBeenCalled();
  });

  it("preserves image steering during offline scripted startup with no configured model", async () => {
    const { tx } = fixture();
    tx.bot.findFirst.mockResolvedValue({ id: "bot-1", modelProvider: null, modelId: null });
    tx.deploymentSettings.findUnique.mockResolvedValue({
      defaultModelProvider: null,
      defaultModelId: null,
    } as never);
    expect(
      await threadModelImageInput(
        tx as unknown as PrismaClient,
        { userId: "user-1", spaceId: "space-1" } as Actor,
        "bot-1",
        {
          id: "active",
          status: "running",
          trigger: "user",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          leaseFence: 1,
        },
        { scripted: true, deployment: null, secrets: { load: vi.fn() } },
      ),
    ).toBe("supported");
  });

  it("follows the Space main connection when the bot has none", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({ id: "bot-1", modelProvider: null, modelId: null });
    // The deployment default can see images; the main model chosen by the member cannot.
    tx.deploymentSettings.findUnique.mockResolvedValue({
      defaultModelProvider: "openrouter",
      defaultModelId: "openai/gpt-4o",
    });
    tx.spaceModelPreference.findFirst.mockResolvedValue({
      modelId: "deepseek/deepseek-v4-pro",
      isDefault: true,
      thinkingLevel: null,
      credential: { id: "credential-1", provider: "openrouter", secretId: "secret-1" },
    });
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
    tx.spaceModelPreference.findFirst.mockResolvedValue({
      modelId: "openai/gpt-4o",
      isDefault: true,
      thinkingLevel: null,
      credential: { id: "vision-credential", provider: "openrouter", secretId: "secret-2" },
    });
    await expect(send()).resolves.toMatchObject({ runId: "run-1" });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelPinned: true,
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
        modelCredentialId: "vision-credential",
      }),
    });
  });

  it("rejects a known text-only effective model before persisting or waking work", async () => {
    const { tx, send, notify, enqueue, releaseTakeover } = fixture();
    await expect(send()).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(tx.message.create).not.toHaveBeenCalled();
    expect(tx.thread.update).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(releaseTakeover).not.toHaveBeenCalled();
  });
});

describe("connection-bound image capability", () => {
  it("never borrows another connection's capability for the same model id", async () => {
    const { tx } = fixture();
    const prisma = tx as unknown as PrismaClient;
    tx.bot.findFirst.mockResolvedValue({
      modelProvider: "openai-compatible",
      modelId: "shared-id",
      modelCredentialId: "vision-key",
      thinkingLevel: null,
    });
    tx.userModelCredential.findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        provider: "openai-compatible",
        secretId: where.id,
        preferences: [],
        supportsImages: false,
      }),
    );
    tx.secret.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ciphertext: where.id,
    }));
    const load = vi.fn(async (ciphertext: string) =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://model.example.test/v1",
        enabledModelIds: ["shared-id"],
        visionModelIds: ciphertext === "vision-key" ? ["shared-id"] : [],
      }),
    );
    const actor = { userId: "user-1", spaceId: "space-1" } as Actor;
    expect(
      await threadModelImageInput(prisma, actor, "bot-1", undefined, {
        secrets: { load },
        deployment: null,
      }),
    ).toBe("supported");
    expect(
      await threadModelImageInput(
        prisma,
        actor,
        "bot-1",
        {
          id: "fallback-run",
          status: "running",
          trigger: "user",
          modelProvider: "openai-compatible",
          modelId: "shared-id",
          modelCredentialId: "text-key",
          thinkingLevel: null,
          leaseFence: 2,
          attemptModel: {
            leaseFence: 2,
            provider: "openai-compatible",
            modelId: "shared-id",
            modelCredentialId: "text-key",
          },
        },
        { secrets: { load }, deployment: null },
      ),
    ).toBe("unsupported");
    expect(load.mock.calls.map(([ciphertext]) => ciphertext)).toEqual(["vision-key", "text-key"]);
  });

  it("checks all eligible waiting recipients rather than only the first", async () => {
    const { tx, send } = fixture();
    tx.bot.findFirst.mockResolvedValue({
      modelProvider: "openrouter",
      modelId: "openai/gpt-4o",
      modelCredentialId: null,
      thinkingLevel: null,
    });
    tx.message.findMany.mockResolvedValue([
      { id: "ask-1", blocks: [{ kind: "ask", text: "Question", status: "pending" }] },
    ]);
    tx.message.findFirst.mockResolvedValue({ id: "ask-1", role: "bot", blocks: [] } as never);
    tx.run.findMany.mockResolvedValue([
      {
        id: "first",
        taskId: "task-1",
        status: "waiting_input",
        trigger: "user",
        modelProvider: "openrouter",
        modelId: "openai/gpt-4o",
        thinkingLevel: null,
        modelPinned: true,
      },
      {
        id: "second",
        taskId: "task-2",
        status: "waiting_input",
        trigger: "routine",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingLevel: null,
        modelPinned: true,
      },
    ] as never);
    await expect(send()).rejects.toMatchObject({
      code: "CONFLICT",
      data: { imageInputStatus: "unsupported" },
    });
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});
