import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentSteeringMessage } from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { serializeTurnCheckpoint } from "./turn-checkpoint.js";
import { markMcpToolResultRoute } from "./verbatim-mcp-result.js";

const provisionComputer = vi.hoisted(() =>
  vi.fn(async () => ({ id: "computer-1", kind: "desktop" })),
);

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

// Workspace persistence is tested separately. Here the backing file can be written
// without asking this model-delivery fixture to simulate workspace versioning.
vi.mock("./computer-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerWorkspaceModule>()),
  checkpointRunComputerWorkspace: vi.fn(async () => "fixture-revision"),
}));

const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const VISION_MODEL = "openai/gpt-4o";

function historyMessages(
  earlierAttachment: MessageBlock = {
    kind: "image",
    artifactId: "art-1",
    mimeType: "image/png",
    name: "shot.png",
  },
  currentAttachment?: MessageBlock,
): Array<{
  id: string;
  threadId: string;
  seq: number;
  role: string;
  runId: string;
  blocks: MessageBlock[];
  replyToMessageId: null;
  replyQuote: null;
  replyTo: null;
}> {
  return [
    {
      id: "current",
      threadId: "thread-1",
      seq: 2,
      role: "user",
      runId: "run-1",
      blocks: [
        { kind: "text", text: "what was in the screenshot?" },
        ...(currentAttachment ? [currentAttachment] : []),
      ],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
    {
      id: "earlier",
      threadId: "thread-1",
      seq: 1,
      role: "user",
      runId: "run-0",
      blocks: [earlierAttachment],
      replyToMessageId: null,
      replyQuote: null,
      replyTo: null,
    },
  ];
}

async function runWithModel(
  modelId: string,
  switchModel?: { provider: string; modelId: string; modelCredentialId?: string },
  backupReadFails = false,
  scripted = false,
  attachmentOptions: {
    block?: Extract<MessageBlock, { kind: "file" | "image" }>;
    currentSteeringImage?: Extract<MessageBlock, { kind: "image" }>;
    computerMode?: ComputerMode;
    pinned?: boolean;
    accountTimezone?: string | null;
    timezoneReadFails?: boolean;
    botOwnerId?: string;
    useComputer?: boolean;
    turnCheckpoint?: string;
  } = {},
) {
  provisionComputer.mockClear();
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    leaseFence: 0,
    scriptedState: null,
    modelPinned: attachmentOptions.pinned ?? false,
    modelProvider: attachmentOptions.pinned ? "openrouter" : null,
    modelId: attachmentOptions.pinned ? modelId : null,
    modelCredentialId: attachmentOptions.pinned ? "primary-credential" : null,
  };
  const get = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
  const writeFile = vi.fn(async (..._args: unknown[]) => undefined);
  const listFiles = vi.fn(async (..._args: unknown[]) => []);
  const exportWorkspace = vi.fn(async function* () {
    yield* [];
  });
  let request: AgentRunRequest | undefined;
  let steering: AgentSteeringMessage[] | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    if (attachmentOptions.currentSteeringImage) steering = await next.claimSteering?.([]);
    if (switchModel) {
      await next.onModelChange?.(
        switchModel.provider,
        switchModel.modelId,
        switchModel.modelCredentialId ?? "backup-credential",
      );
      await next.onUsage?.({
        type: "usage",
        provider: switchModel.provider,
        model: switchModel.modelId,
        modelCredentialId: switchModel.modelCredentialId ?? "backup-credential",
        inputTokens: 8,
        outputTokens: 3,
        costUsd: 0.00123,
        callId: "backup-call",
      });
    }
    if (attachmentOptions.useComputer) {
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      if (!next.executeTool) throw new Error("File tools are unavailable");
      await next.executeTool("list_files", { path: "attachments" }, "list-1");
    }
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === run.botId ? { spaceId: run.spaceId, disabledBuiltinTools: [] } : null,
      ),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        userId: attachmentOptions.botOwnerId ?? "bot-owner",
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: { id: "computer-1", scope: attachmentOptions.computerMode ?? "dedicated" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 3,
      })),
    },
    message: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (args: { where?: { threadId?: string } }) =>
        args.where?.threadId
          ? historyMessages(attachmentOptions.block, attachmentOptions.currentSteeringImage)
          : [],
      ),
      findUnique: vi.fn(async () => null),
    },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Look again" })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
        async () => null,
      ),
    },
    secret: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "primary-secret" ? { id: where.id, ciphertext: "fake-primary-key" } : null,
      ),
    },
    userModelCredential: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(async () =>
        attachmentOptions.pinned
          ? {
              id: "primary-credential",
              userId: "user-1",
              provider: "openrouter",
              label: "Primary",
              secretId: "primary-secret",
              connectionRevision: 1,
              createdAt: new Date(0),
              updatedAt: new Date(0),
              preferences: [{ modelId, isDefault: false, thinkingLevel: null }],
            }
          : null,
      ),
    },
    spaceBackupModel: {
      findMany: vi.fn(async () => {
        if (backupReadFails) throw new Error("Backup list unavailable");
        return switchModel
          ? [
              {
                provider: switchModel.provider,
                modelId: switchModel.modelId,
                modelCredentialId: switchModel.modelCredentialId ?? "backup-credential",
              },
            ]
          : [];
      }),
    },

    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: modelId,
      })),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (attachmentOptions.timezoneReadFails) throw new Error("Account timezone unavailable");
        return { timezone: attachmentOptions.accountTimezone };
      }),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        attachmentOptions.turnCheckpoint &&
        where.idempotencyKey === JSON.stringify(["runtime_checkpoint", run.id])
          ? {
              runId: run.id,
              spaceId: run.spaceId,
              kind: "runtime_checkpoint",
              status: "runtime_checkpoint",
              request: {},
              result: attachmentOptions.turnCheckpoint,
            }
          : null,
      ),
    },
    mcpServer: {
      findMany: vi.fn(async () =>
        attachmentOptions.turnCheckpoint
          ? [
              {
                id: "mcp-research",
                slug: "research",
                allowAllTools: false,
                allowedTools: ["read"],
                verbatimResults: true,
                installId: null,
              },
            ]
          : [],
      ),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
    usageRecord: { createMany: vi.fn(async () => ({ count: 1 })) },
    artifact: {
      findMany: vi.fn(async () => [
        {
          id: "art-1",
          storageKey: "shot.png",
          size: 4,
          mimeType: attachmentOptions.block?.mimeType ?? "image/png",
          name: attachmentOptions.block?.name ?? "shot.png",
        },
      ]),
    },
  };
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    secretStore: { load: async (ciphertext: string) => ciphertext },
    runtime: { describe: () => ({ capabilities: { scripted } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "desktop", capabilities: { graphical: false } }),
      writeFile,
      listFiles,
      readFile: vi.fn().mockRejectedValue(new Error("computer file not found")),
      exportWorkspace,
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun,
      claimSteering: vi.fn(async () =>
        attachmentOptions.currentSteeringImage
          ? [
              {
                id: "steering-1",
                messageId: "current",
                text: "Look again",
                origin: "user",
                ownerInput: true,
                blocks: [attachmentOptions.currentSteeringImage],
              },
            ]
          : [],
      ),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  expect(runtimeRun).toHaveBeenCalled();
  expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  if (!request) throw new Error("runtime was not called");
  return { request, steering, get, prisma, run, writeFile, listFiles, exportWorkspace };
}

describe("recent turn images follow model vision", () => {
  it("loads current MCP retention for a saved turn when this attempt offers no MCP tools", async () => {
    const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openrouter",
      model: TEXT_ONLY_MODEL,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    });
    const pastMcpContent = [{ type: "text" as const, text: "Saved complete research evidence" }];
    markMcpToolResultRoute(pastMcpContent, {
      connectorId: "mcp",
      resourceId: "mcp-research",
      resourceRevision: 2,
      catalogGroup: "research",
      toolName: "read",
    });
    const turnCheckpoint = serializeTurnCheckpoint({
      version: 1,
      provider: "openrouter",
      model: TEXT_ONLY_MODEL,
      systemPrompt: "Preserve the saved research evidence.",
      pendingToolCallId: "pending-question",
      effectOccurrences: [],
      messages: [
        { role: "user", content: "Read the research, then ask before continuing.", timestamp: 0 },
        assistant([
          { type: "toolCall", id: "past-read", name: "mcp__research__read", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "past-read",
          toolName: "mcp__research__read",
          content: pastMcpContent,
          isError: false,
          timestamp: 0,
        },
        assistant([
          {
            type: "toolCall",
            id: "pending-question",
            name: "ask_user",
            arguments: { question: "Continue?", options: ["Continue", "Stop"] },
          },
        ]),
      ],
    });
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      turnCheckpoint,
    });

    expect(request.turnCheckpoint).toBe(turnCheckpoint);
    expect(request.tools.some((tool) => tool.route?.connectorId === "mcp")).toBe(false);
    expect(request.verbatimMcpServers).toEqual({ ids: ["mcp-research"], slugs: ["research"] });
    expect(prisma.mcpServer.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1", spaceId: "space-1", enabled: true, verbatimResults: true },
      select: {
        id: true,
        slug: true,
        allowAllTools: true,
        allowedTools: true,
        verbatimResults: true,
        installId: true,
      },
    });
  });

  it("does not send history images to a text-only model", async () => {
    const { request } = await runWithModel(TEXT_ONLY_MODEL);

    expect(request.model.id).toBe(TEXT_ONLY_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
  });

  it("lists an earlier attachment on a text-only turn without starting the computer", async () => {
    const { request, get, writeFile, listFiles, exportWorkspace } =
      await runWithModel(TEXT_ONLY_MODEL);

    expect(provisionComputer).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(request.history.find((entry) => entry.id === "earlier")?.images).toBeUndefined();
    expect(request.prompt).toContain(
      'Earlier attachment candidates may be restored on first computer use. Check the workspace before relying on these paths:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
  });

  it("makes an earlier attachment available when a later text-only turn uses file tools", async () => {
    const { request, writeFile, listFiles, exportWorkspace } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      { useComputer: true },
    );

    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "computer-1" }),
      "attachments",
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
    );

    expect(writeFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "attachments/art-1.png", content: new Uint8Array([1, 2, 3, 4]) },
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
    );
    expect(request.prompt).toContain(
      'Earlier attachment candidates may be restored on first computer use. Check the workspace before relying on these paths:\n- "shot.png" (image/png, 4 bytes): "attachments/art-1.png"',
    );
    expect(exportWorkspace).not.toHaveBeenCalled();
  });

  it("prepares an earlier document in the Bot's Team Computer folder without a checkpoint", async () => {
    const { request, writeFile, listFiles, exportWorkspace } = await runWithModel(
      TEXT_ONLY_MODEL,
      undefined,
      false,
      false,
      {
        useComputer: true,
        computerMode: "team",
        block: {
          kind: "file",
          artifactId: "art-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 4,
        },
      },
    );

    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(listFiles).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "computer-1" }),
      "bots/bot-1/attachments",
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
    );
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "bots/bot-1/attachments/art-1.txt", content: new Uint8Array([1, 2, 3, 4]) },
      expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
    );
    expect(request.prompt).toContain('"notes.txt" (text/plain, 4 bytes): "attachments/art-1.txt"');
    expect(exportWorkspace).not.toHaveBeenCalled();
  });

  it("attaches an earlier turn's image for a model that can see it", async () => {
    const { request, get } = await runWithModel(VISION_MODEL);

    expect(request.model.id).toBe(VISION_MODEL);
    expect(request.history.find((entry) => entry.id === "earlier")?.images?.[0]).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
    });
    expect(request.history.find((entry) => entry.id === "current")?.images).toBeUndefined();
    expect(get).toHaveBeenCalledWith("shot.png", expect.anything());
  });

  it("continues with no backups when the indexed lookup fails", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, true);
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
    expect(prisma.spaceBackupModel.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1", spaceId: "space-1" },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true, modelCredentialId: true },
    });
  });

  it("does not read or configure backups for scripted runs", async () => {
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, true);
    expect(prisma.spaceBackupModel.findMany).not.toHaveBeenCalled();
    expect(request.fallbackModels).toEqual([]);
    expect(request.resolveFallbackModel).toBeUndefined();
  });

  it("does not recover a backup's missing secret with a deployment key", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request } = await runWithModel(TEXT_ONLY_MODEL, backup);
    expect(request.model.apiKey).toBe("fake-deployment-key");
    const resolve = request.resolveFallbackModel;
    if (!resolve) throw new Error("Backup resolver is missing");
    prisma.userModelCredential.findFirst.mockResolvedValue({
      id: "backup-credential",
      userId: "user-1",
      provider: backup.provider,
      label: "Backup",
      secretId: "missing-secret",
      connectionRevision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      preferences: [{ modelId: backup.modelId, isDefault: false, thinkingLevel: null }],
    });
    vi.stubEnv("OPENROUTER_API_KEY", "fake-deployment-key");
    try {
      await expect(resolve(backup.provider, backup.modelId, "backup-credential")).rejects.toThrow(
        "Model connection is unavailable",
      );
      expect(prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "backup-credential", userId: "user-1", provider: backup.provider },
        }),
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { id: "missing-secret", userId: "user-1", spaceId: null },
      });
      await expect(resolve("openai", "gpt-4o")).rejects.toThrow("Backup model is not selected");
      expect(prisma.secret.findFirst).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the captured pin when an attempt switches to another connection for the same model", async () => {
    const backup = {
      provider: "openrouter",
      modelId: TEXT_ONLY_MODEL,
      modelCredentialId: "backup-credential",
    };
    const { prisma, request, run } = await runWithModel(TEXT_ONLY_MODEL, backup, false, false, {
      pinned: true,
    });

    expect(request.model.modelCredentialId).toBe("primary-credential");
    expect(prisma.usageRecord.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          provider: backup.provider,
          model: TEXT_ONLY_MODEL,
          modelCredentialId: "backup-credential",
          costUsd: 0.00123,
          userId: "user-1",
          spaceId: "space-1",
        }),
      ],
      skipDuplicates: true,
    });
    expect(request.fallbackModels).toEqual([
      { provider: backup.provider, id: TEXT_ONLY_MODEL, modelCredentialId: "backup-credential" },
    ]);
    expect(run).toMatchObject({
      modelProvider: "openrouter",
      modelId: TEXT_ONLY_MODEL,
      modelCredentialId: "primary-credential",
      modelPinned: true,
    });
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: expect.any(Number),
      },
      data: {
        attemptModel: {
          leaseFence: expect.any(Number),
          provider: backup.provider,
          modelId: backup.modelId,
          modelCredentialId: "backup-credential",
        },
      },
    });
  });

  it("persists the switched model against the current run lease", async () => {
    const backup = { provider: "openrouter", modelId: "openai/gpt-4o" };
    const { prisma, request, run } = await runWithModel(TEXT_ONLY_MODEL, backup);

    expect(request?.model.id).toBe(TEXT_ONLY_MODEL);
    expect(run).toMatchObject({
      modelProvider: backup.provider,
      modelId: backup.modelId,
      modelCredentialId: "backup-credential",
      modelPinned: false,
    });
    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseOwner: "worker-1",
        leaseFence: expect.any(Number),
      },
      data: {
        modelProvider: backup.provider,
        modelId: backup.modelId,
        modelCredentialId: "backup-credential",
      },
    });
  });
});

describe("executor account timezone context", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the bot owner's account zone and carries the same value to the runtime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:42:34.000Z"));
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      accountTimezone: "Asia/Taipei",
      botOwnerId: "bot-owner",
    });
    expect(prisma.user.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: "bot-owner" },
      select: { timezone: true },
    });
    expect(request.userTimezone).toBe("Asia/Taipei");
    expect(request.prompt).toContain("Thursday, 2026-07-16 00:42 (UTC+08:00) (Asia/Taipei)");
    expect(request.prompt).toContain("That is 2026-07-15T16:42:34Z (UTC)");
    expect(request.prompt).toContain("Look again");
    expect(request.instructions).not.toContain("2026-07-15");
    expect(request.instructions).not.toContain("2026-07-16");
  });
  it.each([
    ["America/New_York", "2026-07-15T16:42:34.000Z", "Wednesday, 2026-07-15 12:42 (UTC-04:00)"],
    ["America/New_York", "2026-01-15T16:42:34.000Z", "Thursday, 2026-01-15 11:42 (UTC-05:00)"],
    ["Asia/Kolkata", "2026-07-15T16:42:34.000Z", "Wednesday, 2026-07-15 22:12 (UTC+05:30)"],
    ["UTC", "2026-07-15T16:42:34.000Z", "Wednesday, 2026-07-15 16:42 (UTC+00:00)"],
  ])("uses the accepted %s zone for the main turn at %s", async (timezone, instant, local) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(instant!));
    const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      accountTimezone: timezone,
    });
    expect(request.userTimezone).toBe(timezone);
    expect(request.prompt).toContain(`${local} (${timezone})`);
    expect(request.prompt).toContain(instant!.replace(".000Z", "Z"));
    expect(request.instructions).not.toContain("Current date and time");
  });

  it.each([null, undefined, "Invalid/Zone"])(
    "continues with exact UTC when the account zone is %s",
    async (timezone) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-15T16:42:34.000Z"));
      const { request } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
        accountTimezone: timezone,
      });
      expect(request.userTimezone).toBe(timezone);
      expect(request.prompt).toContain(
        "Current date and time: Wednesday, 2026-07-15T16:42:34Z (UTC)",
      );
      expect(request.prompt).not.toContain("Current date and time for the user");
    },
  );

  it("degrades only the optional timezone read when the database lookup fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-15T16:42:34.000Z"));
    const { request, prisma } = await runWithModel(TEXT_ONLY_MODEL, undefined, false, false, {
      timezoneReadFails: true,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledOnce();
    expect(request.userTimezone).toBeUndefined();
    expect(request.prompt).toContain("2026-07-15T16:42:34Z (UTC)");
    expect(request.prompt).toContain("Look again");
  });

  it("keeps the same owner zone when an attempt changes its model connection", async () => {
    const backup = {
      provider: "openrouter",
      modelId: VISION_MODEL,
      modelCredentialId: "backup-credential",
    };
    const { request, run } = await runWithModel(TEXT_ONLY_MODEL, backup, false, false, {
      accountTimezone: "Asia/Taipei",
    });
    expect(run.modelId).toBe(VISION_MODEL);
    expect(request.userTimezone).toBe("Asia/Taipei");
    expect(request.prompt).toContain("(Asia/Taipei)");
  });
});

it("delivers a waiting image only once when a legacy Run also reads it as its current turn", async () => {
  const { request, steering } = await runWithModel(VISION_MODEL, undefined, false, false, {
    currentSteeringImage: {
      kind: "image",
      imageHandling: "confirm",
      artifactId: "art-1",
      mimeType: "image/png",
      name: "shot.png",
    },
  });
  expect(request.currentTurnImages).toHaveLength(1);
  expect(steering).toHaveLength(1);
  expect(steering?.[0]).toMatchObject({ messageId: "current", requiresImageInput: true });
  expect(steering?.[0]?.images).toBeUndefined();
});
