import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockBotModelSetting } from "../../../apps/api/src/bot-update.js";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeAttachments = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeAttachments("chat attachments", () => {
  let app: App;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const secretStore = new EncryptedSecretStore("offline-attachment-fixture");
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-attachments-"));
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      secretStore,
    });
    app = handles.app;
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("rejects image intent atomically and accepts file intent without changing artifact bytes", async () => {
    const cookie = await signup(app, `image-intent-${stamp}@example.test`, "Image Sender");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Image Sender",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const prisma = botIntroHarness!.prisma;
    const owned = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { thread: true },
    });
    const threadId = owned.thread!.id;
    const image = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "invoice.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const artifactBefore = await prisma.artifact.findUniqueOrThrow({ where: { id: image.id } });
    await prisma.bot.update({
      where: { id: bot.id },
      data: {
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelCredentialId: null,
      },
    });
    expect(await rpc(app, cookie, "threads/imageInput", { botId: bot.id })).toEqual({
      status: "unsupported",
      botId: bot.id,
    });
    const before = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    const messageCount = await prisma.message.count({ where: { threadId } });
    const runCount = await prisma.run.count({ where: { threadId } });
    const input = {
      botId: bot.id,
      text: "Keep this invoice",
      artifactIds: [image.id],
      clientNonce: "image-intent-retry",
    };
    for (const extra of [{}, { imageHandling: "confirm" }]) {
      const rejected = await raw(app, cookie, "threads/send", { ...input, ...extra });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        json: {
          data: { reason: "model_image_input_unsupported", imageInputStatus: "unsupported" },
        },
      });
    }
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).toEqual(before);
    expect(await prisma.message.count({ where: { threadId } })).toBe(messageCount);
    expect(await prisma.run.count({ where: { threadId } })).toBe(runCount);
    const sent = await rpc<{ seq: number; runId: string }>(app, cookie, "threads/send", {
      ...input,
      imageHandling: "file",
    });
    const replay = await rpc(app, cookie, "threads/send", { ...input, imageHandling: "confirm" });
    expect(replay).toEqual(sent);
    const message = await prisma.message.findUniqueOrThrow({
      where: { threadId_seq: { threadId, seq: sent.seq } },
    });
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        {
          kind: "file",
          artifactId: image.id,
          name: "invoice.png",
          mimeType: "image/png",
          size: tinyPng.length,
        },
      ]),
    );
    expect(
      await prisma.message.count({ where: { threadId, clientNonce: input.clientNonce } }),
    ).toBe(1);
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: image.id } })).toEqual(
      artifactBefore,
    );
    expect(
      await rpc(app, cookie, "artifacts/get", { botId: bot.id, artifactId: image.id }),
    ).toMatchObject({ contentBase64: tinyPng.toString("base64") });
  });

  it("rolls back routines with a rejected image and commits them once with the file retry", async () => {
    const cookie = await signup(app, `image-routine-${stamp}@example.test`, "Image Routine");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Image Routine",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const prisma = botIntroHarness!.prisma;
    const { thread } = await prisma.bot.update({
      where: { id: bot.id },
      data: {
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelCredentialId: null,
      },
      include: { thread: true },
    });
    const threadId = thread!.id;
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Daily report",
      prompt: "Prepare the report",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const image = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "report.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const input = {
      botId: bot.id,
      text: "Keep this report",
      routineIds: [routine.id, routine.id],
      artifactIds: [image.id],
      clientNonce: "image-routine-atomic",
    };
    const original = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    const tasksBefore = await prisma.task.count({ where: { threadId } });
    const rejected = await raw(app, cookie, "threads/sendWithRoutines", {
      ...input,
      imageHandling: "confirm",
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      json: { data: { reason: "model_image_input_unsupported", imageInputStatus: "unsupported" } },
    });
    expect(await prisma.task.count({ where: { threadId } })).toBe(tasksBefore);
    expect(await prisma.run.count({ where: { threadId, routineId: routine.id } })).toBe(0);
    expect(
      await prisma.message.count({ where: { threadId, clientNonce: input.clientNonce } }),
    ).toBe(0);
    expect(await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).toEqual(original);

    const retry = { ...input, imageHandling: "file" };
    const [first, second] = await Promise.all([
      rpc<{ seq: number; runId: string }>(app, cookie, "threads/sendWithRoutines", retry),
      rpc(app, cookie, "threads/sendWithRoutines", retry),
    ]);
    expect(second).toEqual(first);
    const runs = await prisma.run.findMany({ where: { threadId, routineId: routine.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(first.runId);
    const message = await prisma.message.findUniqueOrThrow({
      where: { threadId_seq: { threadId, seq: first.seq } },
    });
    expect(message.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "file", artifactId: image.id })]),
    );
    // The routine still consumes its own prompt. The attachment waits for a conversational Run.
    expect(
      await prisma.steeringMessage.findFirst({ where: { messageId: message.id } }),
    ).toMatchObject({
      runId: null,
    });
    expect(
      await prisma.message.count({ where: { threadId, clientNonce: input.clientNonce } }),
    ).toBe(1);
  });

  it.each(["run", "bot", "connection", "finalizer"] as const)(
    "serializes image admission with a concurrent %s write",
    async (scope) => {
      const cookie = await signup(
        app,
        `image-switch-${scope}-${stamp}@example.test`,
        "Image Switch",
      );
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Switcher",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      const prisma = botIntroHarness!.prisma;
      const owned = await prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        include: { thread: true },
      });
      const threadId = owned.thread!.id;
      await prisma.bot.update({
        where: { id: bot.id },
        data: { modelProvider: "openrouter", modelId: "openai/gpt-4o", modelCredentialId: null },
      });
      const setupConnection = async () => {
        const createSecret = async (vision: boolean) => {
          const plaintext = JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://model.example.test/v1",
            enabledModelIds: ["fixture-vision-model"],
            visionModelIds: vision ? ["fixture-vision-model"] : [],
          });
          const encrypted = await secretStore.put(plaintext, {
            userId: owned.userId,
            spaceId: owned.spaceId,
            operationId: "image-fixture",
            traceId: "image-fixture",
            signal: new AbortController().signal,
          });
          return prisma.secret.create({
            data: {
              id: encrypted.id,
              userId: owned.userId,
              kind: "model",
              ciphertext: encrypted.ciphertext,
            },
          });
        };
        const [vision, text] = await Promise.all([createSecret(true), createSecret(false)]);
        const credential = await prisma.userModelCredential.create({
          data: {
            userId: owned.userId,
            provider: "openai-compatible",
            label: "Image fixture",
            secretId: vision.id,
            supportsImages: true,
          },
        });
        await prisma.bot.update({
          where: { id: bot.id },
          data: {
            modelProvider: "openai-compatible",
            modelId: "fixture-vision-model",
            modelCredentialId: credential.id,
          },
        });
        return { credentialId: credential.id, textSecretId: text.id };
      };
      const connection = scope === "connection" ? await setupConnection() : undefined;
      const createActiveRun = async () => {
        const task = await prisma.task.create({
          data: {
            spaceId: owned.spaceId,
            botId: bot.id,
            threadId,
            userId: owned.userId,
            prompt: "Hold the current model",
            status: "running",
          },
        });
        return prisma.run.create({
          data: {
            spaceId: owned.spaceId,
            botId: bot.id,
            threadId,
            userId: owned.userId,
            taskId: task.id,
            status: "running",
            trigger: "user",
            modelProvider: "openrouter",
            modelId: "openai/gpt-4o",
            leaseOwner: "image-fixture-worker",
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        });
      };
      const run = scope === "run" ? await createActiveRun() : undefined;
      const image = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
        botId: bot.id,
        name: "switch.png",
        mimeType: "image/png",
        contentBase64: tinyPng.toString("base64"),
      });
      const before = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      let release = () => {};
      let entered = () => {};
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const switching = prisma.$transaction(
        async (tx) => {
          const data = { modelId: "deepseek/deepseek-v4-pro" };
          if (run) await tx.run.update({ where: { id: run.id }, data });
          else if (connection) {
            await tx.userModelCredential.update({
              where: { id: connection.credentialId },
              data: {
                secretId: connection.textSecretId,
                supportsImages: false,
                connectionRevision: { increment: 1 },
              },
            });
          } else if (scope === "bot") {
            await lockBotModelSetting(tx, bot.id);
            await tx.bot.update({ where: { id: bot.id }, data });
          } else {
            // Finalization locks Thread first, then updates the Bot timestamp.
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
          }
          entered();
          await resume;
          if (scope === "finalizer")
            await tx.bot.update({ where: { id: bot.id }, data: { updatedAt: new Date() } });
        },
        { timeout: 10_000 },
      );
      await held;
      const sending = raw(app, cookie, "threads/send", {
        botId: bot.id,
        text: "Inspect the image",
        artifactIds: [image.id],
        imageHandling: "confirm",
        clientNonce: "image-model-switch",
      });
      let response: Response | undefined;
      try {
        await expect
          .poll(
            async () => {
              const rows = await prisma.$queryRaw<
                Array<{ blocked: boolean }>
              >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${run ? "%runs%FOR UPDATE%" : scope === "bot" ? "%pg_advisory_xact_lock%" : connection ? "%user_model_credentials%FOR SHARE%" : "%threads%FOR NO KEY UPDATE%"}) AS blocked`;
              return rows[0]?.blocked;
            },
            { interval: 10, timeout: 3000 },
          )
          .toBe(true);
      } finally {
        release();
        await switching;
        response = await sending;
      }
      if (scope === "finalizer") {
        expect(response!.status).toBe(200);
        expect(
          await prisma.message.count({ where: { threadId, clientNonce: "image-model-switch" } }),
        ).toBe(1);
        return;
      }
      expect(response!.status).toBe(409);
      expect(await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).toEqual(before);
      expect(
        await prisma.message.count({ where: { threadId, clientNonce: "image-model-switch" } }),
      ).toBe(0);
      if (run) expect(await prisma.steeringMessage.count({ where: { runId: run.id } })).toBe(0);
    },
  );

  it("admits every actual group recipient before committing any message or task", async () => {
    const cookie = await signup(app, `image-group-${stamp}@example.test`, "Image Group");
    const create = (name: string) =>
      rpc<{ id: string }>(app, cookie, "bots/create", {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
    const first = await create("Viewer");
    const second = await create("Writer");
    const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
      name: "Image team",
      botIds: [first.id, second.id],
    });
    const prisma = botIntroHarness!.prisma;
    await prisma.bot.update({
      where: { id: second.id },
      data: {
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        modelCredentialId: null,
      },
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const image = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
      groupId: group.id,
      name: "team.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const beforeGroup = await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    const both = {
      groupId: group.id,
      text: "Inspect the image",
      mentions: [first.id, second.id],
      artifactIds: [image.id],
      imageHandling: "confirm",
      clientNonce: "group-image-atomic",
    };
    expect(await rpc(app, cookie, "threads/imageInput", both)).toEqual({
      status: "unsupported",
      botId: second.id,
    });
    const draftGroup = {
      draftGroupBotIds: [first.id, second.id],
      text: both.text,
      mentions: both.mentions,
    };
    expect(await rpc(app, cookie, "threads/imageInput", draftGroup)).toEqual({
      status: "unsupported",
      botId: second.id,
    });
    expect(
      await rpc(app, cookie, "threads/imageInput", { ...draftGroup, mentions: [first.id] }),
    ).toEqual({ status: "supported" });

    expect((await raw(app, cookie, "threads/send", both)).status).toBe(409);
    expect(await prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.run.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.task.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).toEqual(
      beforeGroup,
    );
    expect(await rpc(app, cookie, "threads/imageInput", { ...both, mentions: [first.id] })).toEqual(
      { status: "supported" },
    );
    const accepted = await rpc<{ runIds: string[] }>(app, cookie, "threads/send", {
      ...both,
      mentions: [first.id],
    });
    expect(accepted.runIds).toHaveLength(1);
    const acceptedRuns = await prisma.run.findMany({
      where: { id: { in: accepted.runIds } },
      select: { botId: true },
    });
    expect(acceptedRuns).toEqual([{ botId: first.id }]);
  });

  it("uploads, sends with image/file, and rejects invalid attachments", async () => {
    const cookie = await signup(app, `attachments-${stamp}@rakazo.test`, "Attachment User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attachments",
      instructions: "",
      notifyOnFinish: true,
    });

    const image = await rpc<{ id: string; mimeType: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "pixel.png",
      mimeType: "image/png",
      contentBase64: tinyPng.toString("base64"),
    });
    const file = await rpc<{ id: string }>(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello attachment").toString("base64"),
    });

    await sendAndWait(app, cookie, bot.id, { text: "see this", artifactIds: [image.id] });
    let snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const imageMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "image"),
    );
    expect(imageMessage?.blocks).toEqual(
      expect.arrayContaining([
        { kind: "text", text: "see this" },
        expect.objectContaining({ kind: "image", artifactId: image.id, name: "pixel.png" }),
      ]),
    );

    await sendAndWait(app, cookie, bot.id, { artifactIds: [file.id] });
    snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    expect(fileMessage?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", artifactId: file.id, name: "notes.txt" }),
      ]),
    );

    const fetched = await rpc<{ contentBase64: string }>(app, cookie, "artifacts/get", {
      botId: bot.id,
      artifactId: image.id,
    });
    expect(fetched.contentBase64).toBe(tinyPng.toString("base64"));

    for (const mimeType of [
      "application/zip",
      "application/x-zip-compressed",
      "application/x-zip",
      "multipart/x-zip",
      "application/octet-stream",
    ]) {
      const rejected = await raw(app, cookie, "artifacts/create", {
        botId: bot.id,
        name: "bundle.ZIP",
        mimeType,
        contentBase64: Buffer.from("PK\x03\x04zip").toString("base64"),
      });
      expect(rejected.status).toBe(400);
    }

    const badMime = await raw(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "payload.exe",
      mimeType: "application/octet-stream",
      contentBase64: Buffer.from("nope").toString("base64"),
    });
    expect(badMime.status).toBeGreaterThanOrEqual(400);

    const oversize = await raw(app, cookie, "artifacts/create", {
      botId: bot.id,
      name: "big.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64"),
    });
    expect(oversize.status).toBeGreaterThanOrEqual(400);
  });

  it("attaches a workspace file into the thread", async () => {
    const cookie = await signup(app, `attach-thread-${stamp}@rakazo.test`, "Attach Thread User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Attacher",
      title: "Attacher",
      description: "tests attach_file",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, bot.id, {
      text: "write notes/result.txt and attach it to the thread",
    });
    const snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const fileMessage = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "file"),
    );
    const fileBlock = fileMessage?.blocks.find((block) => block.kind === "file");
    expect(fileBlock).toMatchObject({ kind: "file", name: "result.txt" });
    if (fileBlock?.kind !== "file") throw new Error("expected file block");
    const fetched = await rpc<{ contentBase64: string }>(app, cookie, "artifacts/get", {
      botId: bot.id,
      artifactId: fileBlock.artifactId,
    });
    expect(Buffer.from(fetched.contentBase64, "base64").toString("utf8")).toContain(
      "write notes/result.txt and attach it to the thread",
    );
  });
  it("persists server-owned reply previews, isolates threads, and handles deletion", async () => {
    const cookie = await signup(app, `replies-${stamp}@rakazo.test`, "Reply User");
    const otherCookie = await signup(app, `replies-other-${stamp}@rakazo.test`, "Other User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Helper",
      title: "Helper",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, bot.id, { text: "Parent first line\nSecond line" });
    let snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const parent = snapshot.messages.find((message) => message.role === "user")!;
    await sendAndWait(app, cookie, bot.id, { text: "A reply", replyToMessageId: parent.id });
    snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const reply = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text === "A reply"),
    )!;
    expect(reply.replyToMessageId).toBe(parent.id);
    expect(reply.replyQuote).toBe("Parent first line");
    expect(reply.replyPreview).toEqual({ role: "user", text: "Parent first line" });
    const event = await botIntroHarness!.prisma.event.findFirst({
      where: {
        threadId: snapshot.threadId,
        type: "thread.message.created",
        payload: { path: ["messageId"], equals: reply.id },
      },
    });
    expect(event?.payload).toMatchObject({
      replyPreview: { role: "user", text: "Parent first line" },
    });

    const denied = await raw(app, otherCookie, "threads/send", {
      botId: bot.id,
      text: "Unauthorized",
      replyToMessageId: parent.id,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const otherBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Other",
      title: "Other",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await sendAndWait(app, cookie, otherBot.id, {
      text: "Foreign target",
      replyToMessageId: parent.id,
    });
    const otherThread = await rpc<ThreadSnapshot>(app, cookie, "threads/get", {
      botId: otherBot.id,
    });
    const foreignReply = otherThread.messages.find((message) => message.role === "user")!;
    expect(foreignReply.replyToMessageId).toBeUndefined();
    expect(foreignReply.replyPreview).toBeNull();
    expect(foreignReply.replyQuote).toBe("");

    await botIntroHarness!.prisma.message.delete({ where: { id: parent.id } });
    snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const deletedReply = snapshot.messages.find((message) => message.id === reply.id)!;
    expect(deletedReply.replyToMessageId).toBeUndefined();
    expect(deletedReply.replyPreview).toBeNull();
    expect(deletedReply.replyQuote).toBe("Parent first line");
    await sendAndWait(app, cookie, bot.id, { text: "Deleted target", replyToMessageId: parent.id });
    snapshot = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId: bot.id });
    const missingReply = snapshot.messages.find((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text === "Deleted target"),
    );
    expect(missingReply?.replyToMessageId).toBeUndefined();
    expect(missingReply?.replyPreview).toBeNull();
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function sendAndWait(
  app: App,
  cookie: string,
  botId: string,
  input: { text?: string; artifactIds?: string[]; replyToMessageId?: string },
) {
  await rpc(app, cookie, "threads/send", { botId, ...input });
  await waitFor(
    app,
    cookie,
    botId,
    (snap) => !snap.run || ["completed", "failed", "cancelled"].includes(snap.run.status),
  );
}

async function waitFor(
  app: App,
  cookie: string,
  botId: string,
  pred: (snap: ThreadSnapshot) => boolean,
) {
  const start = Date.now();
  let last: ThreadSnapshot | null = null;
  while (Date.now() - start < 20_000) {
    last = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId });
    if (pred(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
}
