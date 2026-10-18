import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  attachWorkspaceFileToThread,
  currentTurnFilesInstruction,
  materializeCurrentTurnFiles,
  materializeRecentThreadFiles,
  recentThreadFilesInstruction,
} from "./thread-artifacts.js";

describe("current-turn thread files", () => {
  it("keeps ZIP file attachment outside the current Bot capability", async () => {
    const put = vi.fn();
    await expect(
      attachWorkspaceFileToThread(
        { prisma: {} as PrismaClient, artifacts: { put } as unknown as ArtifactStore },
        {
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          filePath: "bundle.zip",
          bytes: new Uint8Array([1, 2, 3]),
          operationId: "attach-1",
        },
      ),
    ).rejects.toThrow("Unsupported attachment type");
    expect(put).not.toHaveBeenCalled();
  });

  it("removes stored bytes when artifact metadata cannot be created", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("database unavailable");
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(failure),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]) };

    await expect(
      attachWorkspaceFileToThread(
        {
          prisma: {
            artifact,
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as unknown as PrismaClient,
          artifacts: {
            put: vi.fn().mockResolvedValue({ id: "stored-1", hash: "hash" }),
            remove,
          } as unknown as ArtifactStore,
        },
        {
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          filePath: "report.pdf",
          bytes: new Uint8Array([1, 2, 3]),
          operationId: "attach-1",
        },
      ),
    ).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith(
      "stored-1",
      expect.objectContaining({ spaceId: "workspace-1", botId: "bot-1" }),
    );
  });

  it.each([
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
  ])(
    "copies %s attachments into the bot workspace and describes their paths",
    async (mimeType, extension) => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: "artifact-1",
          spaceId: "workspace-1",
          botId: "bot-1",
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
          storageKey: "stored-1",
        },
      ]);
      const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
      const writeFile = vi.fn().mockResolvedValue(undefined);
      const markWorkspaceDirty = vi.fn();
      const context: AdapterContext & { botId: string } = {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      };
      const computer: ComputerRef = {
        id: "computer-1",
        botId: "bot-1",
        kind: "fake",
        providerRef: "fake-1",
      };
      const blocks: MessageBlock[] = [
        {
          kind: "file",
          artifactId: "artifact-1",
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
        },
      ];

      const files = await materializeCurrentTurnFiles(
        {
          prisma: { artifact: { findMany } } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
          sandbox: { writeFile } as unknown as SandboxProvider,
        },
        blocks,
        { context, computer, computerMode: "team", markWorkspaceDirty },
      );

      expect(get).toHaveBeenCalledWith("stored-1", context);
      expect(writeFile).toHaveBeenCalledWith(
        computer,
        {
          path: `bots/bot-1/attachments/artifact-1${extension}`,
          content: new Uint8Array([1, 2, 3, 4]),
        },
        context,
      );
      expect(markWorkspaceDirty).toHaveBeenCalledOnce();
      expect(markWorkspaceDirty.mock.invocationCallOrder[0]).toBeLessThan(
        writeFile.mock.invocationCallOrder[0]!,
      );
      expect(files).toEqual([
        {
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
          path: `attachments/artifact-1${extension}`,
        },
      ]);
      expect(currentTurnFilesInstruction(files)).toContain(`"attachments/artifact-1${extension}"`);
    },
  );

  it("also materializes image attachments, not just files", async () => {
    // A photo attached in chat is only handed to the model as inline vision
    // content otherwise (loadCurrentTurnImages) — a bot that needs the actual
    // bytes (to forward, re-attach, or hand to a shell tool) needs this too.
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "image-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        name: "photo.png",
        mimeType: "image/png",
        size: 4,
        storageKey: "stored-image-1",
      },
    ]);
    const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const files = await materializeCurrentTurnFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: { writeFile } as unknown as SandboxProvider,
      },
      [
        {
          kind: "image",
          artifactId: "image-1",
          name: "photo.png",
          mimeType: "image/png",
        },
      ],
      {
        context: {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          signal: new AbortController().signal,
        },
        computer: {
          id: "computer-1",
          botId: "bot-1",
          kind: "fake",
          providerRef: "fake-1",
        },
        computerMode: "team",
      },
    );

    expect(get).toHaveBeenCalledWith("stored-image-1", expect.objectContaining({ botId: "bot-1" }));
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "bots/bot-1/attachments/image-1.png", content: new Uint8Array([1, 2, 3, 4]) },
      expect.objectContaining({ botId: "bot-1" }),
    );
    expect(files).toEqual([
      { name: "photo.png", mimeType: "image/png", size: 4, path: "attachments/image-1.png" },
    ]);
  });
});

describe("recent thread files", () => {
  it.each([
    { name: "Fake file absence", error: new Error("computer file not found"), recover: true },
    {
      name: "Desktop ENOENT",
      error: Object.assign(new Error("read failed"), { code: "ENOENT" }),
      recover: true,
    },
    {
      name: "Docker missing file",
      error: new Error(
        "sandbox file read failed: 404 FileNotFoundError: No such file or directory",
      ),
      recover: true,
    },
    {
      name: "filesystem permission",
      error: new Error("EACCES: permission denied"),
      recover: false,
    },
    {
      name: "Docker 404 permission failure",
      error: new Error("sandbox file read failed: 404 PermissionError: Permission denied"),
      recover: false,
    },
    { name: "network failure", error: new Error("network connection reset"), recover: false },
    { name: "unknown read failure", error: new Error("read failed"), recover: false },
  ])("only replaces confirmed missing historical files: $name", async ({ error, recover }) => {
    const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const writeFile = vi.fn();
    const files = await materializeRecentThreadFiles(
      {
        prisma: {
          artifact: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: "notes",
                name: "notes.txt",
                mimeType: "text/plain",
                size: 3,
                storageKey: "stored",
              },
            ]),
          },
        } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: {
          readFile: vi.fn().mockRejectedValue(error),
          writeFile,
        } as unknown as SandboxProvider,
      },
      [{ id: "earlier", role: "user" }],
      [
        {
          id: "earlier",
          blocks: [
            {
              kind: "file",
              artifactId: "notes",
              name: "notes.txt",
              mimeType: "text/plain",
              size: 3,
            },
          ],
        },
      ],
      {
        context: {
          operationId: "run",
          traceId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          signal: new AbortController().signal,
        },
        computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
        computerMode: "dedicated",
        maxTurns: 3,
      },
    );
    expect(files.map((file) => file.path)).toEqual(recover ? ["attachments/notes.txt"] : []);
    expect(get).toHaveBeenCalledTimes(recover ? 1 : 0);
    expect(writeFile).toHaveBeenCalledTimes(recover ? 1 : 0);
  });

  it("keeps user and Space scope and skips oversized history files without blocking readable ones", async () => {
    const block = (id: string): MessageBlock => ({
      kind: "file",
      artifactId: id,
      name: `${id}.txt`,
      mimeType: "text/plain",
      size: 3,
    });
    const findMany = vi.fn(
      async ({ where }: { where: { id: { in: string[] }; spaceId: string; userId: string } }) => {
        expect(where.spaceId).toBe("space");
        expect(where.userId).toBe("user");
        const id = where.id.in[0];
        return id === "foreign"
          ? []
          : [{ id, name: `${id}.txt`, mimeType: "text/plain", size: 3, storageKey: id }];
      },
    );
    const get = vi.fn(async (key: string) =>
      key === "oversized" ? new Uint8Array(ATTACHMENT_MAX_BYTES + 1) : new Uint8Array([1, 2, 3]),
    );
    const writeFile = vi.fn();
    const messages = ["readable", "oversized", "foreign"].map((id) => ({
      id,
      role: "user",
      blocks: [block(id)],
    }));
    const files = await materializeRecentThreadFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: {
          readFile: vi.fn().mockRejectedValue(new Error("computer file not found")),
          writeFile,
        } as unknown as SandboxProvider,
      },
      messages,
      messages,
      {
        context: {
          operationId: "run",
          traceId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          signal: new AbortController().signal,
        },
        computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
        computerMode: "dedicated",
        maxTurns: 3,
      },
    );
    expect(files.map((file) => file.path)).toEqual(["attachments/readable.txt"]);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.map(([key]) => key)).toEqual(["oversized", "readable"]);
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { path: "attachments/readable.txt", content: new Uint8Array([1, 2, 3]) },
      expect.anything(),
    );
  });

  it("does not recover files outside effective history or from assistant and current turns", async () => {
    const findMany = vi.fn();
    const block: MessageBlock = {
      kind: "file",
      artifactId: "notes",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 3,
    };
    const files = await materializeRecentThreadFiles(
      { prisma: { artifact: { findMany } } } as unknown as Parameters<
        typeof materializeRecentThreadFiles
      >[0],
      [{ role: "user" }, { id: "assistant", role: "assistant" }, { id: "current", role: "user" }],
      ["compacted", "assistant", "current"].map((id) => ({ id, blocks: [block] })),
      {
        context: {
          operationId: "run",
          traceId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          signal: new AbortController().signal,
        },
        computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
        computerMode: "dedicated",
        maxTurns: 3,
        skipMessageId: "current",
      },
    );
    expect(files).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("does not write a historical file after a cancelled artifact read resolves late", async () => {
    const controller = new AbortController();
    const writeFile = vi.fn();
    const context = {
      operationId: "run",
      traceId: "run",
      spaceId: "space",
      userId: "user",
      botId: "bot",
      signal: controller.signal,
    };
    await expect(
      materializeRecentThreadFiles(
        {
          prisma: {
            artifact: {
              findMany: vi.fn().mockResolvedValue([
                {
                  id: "notes",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  size: 3,
                  storageKey: "stored",
                },
              ]),
            },
          } as unknown as PrismaClient,
          artifacts: {
            get: vi.fn(async () => {
              controller.abort(new Error("cancelled"));
              return new Uint8Array([1, 2, 3]);
            }),
          } as unknown as ArtifactStore,
          sandbox: {
            readFile: vi.fn().mockRejectedValue(new Error("computer file not found")),
            writeFile,
          } as unknown as SandboxProvider,
        },
        [{ id: "earlier", role: "user" }],
        [
          {
            id: "earlier",
            blocks: [
              {
                kind: "file",
                artifactId: "notes",
                name: "notes.txt",
                mimeType: "text/plain",
                size: 3,
              },
            ],
          },
        ],
        {
          context,
          computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
          computerMode: "dedicated",
          maxTurns: 3,
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("recent history attachment selection and preservation", () => {
  it.each(["team", "dedicated"] as const)(
    "preserves edited recent files and lists them in %s mode",
    async (computerMode) => {
      const block = {
        kind: "file" as const,
        artifactId: "notes",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 8,
      };
      const get = vi.fn().mockRejectedValue(new Error("original unavailable"));
      const readFile = vi.fn().mockResolvedValue(new TextEncoder().encode("edited"));
      const writeFile = vi.fn();
      const markWorkspaceDirty = vi.fn();
      const files = await materializeRecentThreadFiles(
        {
          prisma: {
            artifact: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ ...block, id: "notes", storageKey: "stored" }]),
            },
          } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
          sandbox: { readFile, writeFile } as unknown as SandboxProvider,
        },
        [{ id: "earlier", role: "user" }],
        [{ id: "earlier", blocks: [block] }],
        {
          context: {
            operationId: "run",
            traceId: "run",
            spaceId: "space",
            userId: "user",
            botId: "bot",
            signal: new AbortController().signal,
          },
          computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
          computerMode,
          maxTurns: 3,
          markWorkspaceDirty,
        },
      );
      expect(readFile).toHaveBeenCalledWith(
        expect.anything(),
        computerMode === "team" ? "bots/bot/attachments/notes.txt" : "attachments/notes.txt",
        expect.anything(),
      );
      expect(get).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(markWorkspaceDirty).not.toHaveBeenCalled();
      expect(recentThreadFilesInstruction(files)).toContain('"attachments/notes.txt"');
    },
  );

  it.each([1, 3])("counts successful files within %s eligible turns", async (maxTurns) => {
    const block = (id: string): MessageBlock => ({
      kind: "file",
      artifactId: id,
      name: `${id}.txt`,
      mimeType: "text/plain",
      size: 3,
    });
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({
        id,
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 3,
        storageKey: id,
      })),
    );
    const get = vi.fn(async (id: string) => {
      if (id.startsWith("missing")) throw new Error("unreadable");
      return new Uint8Array([1, 2, 3]);
    });
    const readFile = vi.fn(async (_computer, path: string) => {
      if (path.endsWith("existing.txt")) return new Uint8Array();
      throw new Error("computer file not found");
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const markWorkspaceDirty = vi.fn();
    const files = await materializeRecentThreadFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: { readFile, writeFile } as unknown as SandboxProvider,
      },
      ["outside", "old", "middle", "new", "current"].map((id) => ({ id, role: "user" })),
      [
        { id: "outside", blocks: [block("outside")] },
        { id: "old", blocks: [block("extra"), block("last")] },
        { id: "middle", blocks: [block("second"), block("first"), block("existing")] },
        {
          id: "new",
          blocks: Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, i) => block(`missing-${i}`)),
        },
        { id: "current", blocks: [block("current")] },
      ],
      {
        context: {
          operationId: "run",
          traceId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          signal: new AbortController().signal,
        },
        computer: { id: "computer", kind: "fake", providerRef: "fake" } as ComputerRef,
        computerMode: "team",
        maxTurns,
        skipMessageId: "current",
        markWorkspaceDirty,
      },
    );
    expect(files.map((file) => file.name)).toEqual(
      maxTurns === 1 ? [] : ["existing.txt", "first.txt", "second.txt", "last.txt"],
    );
    expect(files).toHaveLength(maxTurns === 1 ? 0 : ATTACHMENT_MAX_COUNT);
    expect(writeFile).toHaveBeenCalledTimes(maxTurns === 1 ? 0 : 3);
    expect(markWorkspaceDirty).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([id]) => id)).toEqual([
      "missing-3",
      "missing-2",
      "missing-1",
      "missing-0",
      ...(maxTurns === 1 ? [] : ["first", "second", "last"]),
    ]);
  });

  it("copies attachments from earlier turns the run is answering, skipping unreadable ones", async () => {
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in[0] === "image-1"
        ? [
            {
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              size: 3,
              storageKey: "stored-image-1",
            },
          ]
        : [],
    );
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const context = {
      operationId: "run-1",
      traceId: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const files = await materializeRecentThreadFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: {
          get: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        } as unknown as ArtifactStore,
        sandbox: {
          writeFile,
          readFile: vi.fn().mockRejectedValue(new Error("computer file not found")),
        } as unknown as SandboxProvider,
      },
      [
        { id: "transcript-image", role: "user" },
        { id: "reply", role: "assistant" },
        { id: "transcript-request", role: "user" },
        { id: "run-message", role: "user" },
      ],
      [
        {
          id: "transcript-image",
          blocks: [
            { kind: "text", text: "here it is" },
            { kind: "image", artifactId: "image-1", name: "screenshot.png", mimeType: "image/png" },
            { kind: "image", artifactId: "deleted-1", name: "old.png", mimeType: "image/png" },
          ],
        },
        { id: "reply", blocks: [{ kind: "text", text: "I can see it" }] },
        { id: "transcript-request", blocks: [{ kind: "text", text: "put it in Linear" }] },
        { id: "run-message", blocks: [{ kind: "text", text: "Slack message: put it in Linear" }] },
      ],
      {
        context,
        computer: { id: "computer-1", kind: "fake", providerRef: "fake-1" } as ComputerRef,
        computerMode: "team",
        maxTurns: 3,
      },
    );

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "bots/bot-1/attachments/image-1.png", content: new Uint8Array([1, 2, 3]) },
      context,
    );
    expect(recentThreadFilesInstruction(files)).toBe(
      [
        "Files attached earlier in this conversation are also on your computer:",
        '- "screenshot.png" (image/png, 3 bytes): "attachments/image-1.png"',
      ].join("\n"),
    );
  });
});
