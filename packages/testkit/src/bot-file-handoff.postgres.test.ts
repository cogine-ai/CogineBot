import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, ScriptedTurn } from "@rakazo/adapter-kit";
import {
  ComposioEmulator,
  FakeSandboxProvider,
  messageBot,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { MessageBlock, ThreadSnapshot } from "@rakazo/contracts";
import { attachmentExtensionForMimeType } from "@rakazo/core";
import { runAsTenant, settleCollaborationDelivery } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AppHandles } from "../../../apps/api/src/app.js";
import { resolveBotWorkspacePath, toComputerRef } from "../../adapters/src/computer-support.js";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

const origin = "http://127.0.0.1:5173";
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
type FileBlock = Extract<MessageBlock, { kind: "file" | "image" }>;

async function rpc<T>(handles: AppHandles, cookie: string, procedure: string, input: unknown = {}) {
  const response = await handles.app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ json: input }),
  });
  const value = (await response.json()) as { json: T };
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value.json;
}

describe.skipIf(!enabled)("Bot file delivery through the actual executor (PostgreSQL)", () => {
  it.each([
    { mode: "team", route: "peer" },
    { mode: "dedicated", route: "peer" },
    { mode: "dedicated", route: "group-outside" },
    { mode: "dedicated", route: "group-inside" },
    { mode: "dedicated", route: "group-outside-disabled" },
  ] as const)(
    "delivers selected files through $route on $mode computers",
    async ({ mode, route }) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "bot-file-delivery-"));
      const scripted = new ScriptedAgentRuntime();
      const plans = new Map<string, ScriptedTurn[]>();
      const runtime: AgentRuntime = {
        describe: () => scripted.describe(),
        run: (request, context) =>
          scripted.run(
            plans.has(request.runId) ? { ...request, script: plans.get(request.runId) } : request,
            context,
          ),
        abort: (id) => scripted.abort(id),
      };
      const sandbox = new FakeSandboxProvider();
      const { createApp } = await import("../../../apps/api/src/app.js");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        dataDir,
        sandboxProvider: "fake",
        sandbox,
        agentRuntime: "scripted",
        runtime,
        wakeupDriver: "memory",
        defaultProvider: "scripted",
        defaultModel: "scripted",
        signupsEnabled: "true",
        authUrl: origin,
        webOrigin: origin,
        composio: new ComposioEmulator(),
        encryptionKey: "synthetic-file-delivery-encryption-key",
      });
      let held: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            name: "File owner",
            email: `${randomUUID()}@example.test`,
            password: "password12",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const owner = await rpc<{ userId: string; spaceId: string }>(handles, cookie, "me");
        const a = await rpc<{ id: string }>(handles, cookie, "bots/create", {
          name: "Coordinator",
          title: "",
          description: "",
          computerMode: mode,
          notifyOnFinish: false,
        });
        const b = await rpc<{ id: string }>(handles, cookie, "bots/create", {
          name: "Reviewer",
          title: "",
          description: "",
          computerMode: mode,
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, a.id);
        await discardBotIntroRun(handles, cookie, b.id);
        held = vi.spyOn(handles.jobs, "enqueue").mockResolvedValue(undefined);
        const tenant = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
        const execute = async (runId: string, plan: ScriptedTurn[]) => {
          plans.set(runId, plan);
          await tenant(() => handles.executor.continueRun(runId, "file-delivery-worker"));
          const finished = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          expect({ status: finished.status, error: finished.error }).toMatchObject({
            status: "completed",
            error: null,
          });
        };
        const send = async (botId: string, plan: ScriptedTurn[], groupId?: string) => {
          const { runId } = await rpc<{ runId: string }>(handles, cookie, "threads/send", {
            ...(groupId ? { groupId } : { botId }),
            text: "Complete the selected file task.",
          });
          await execute(runId, plan);
          return runId;
        };
        await send(a.id, [
          {
            toolCalls: [
              {
                name: "write_file",
                args: { path: "notes/input.txt", content: "Selected material α" },
              },
            ],
            complete: true,
          },
        ]);
        await send(b.id, [
          {
            toolCalls: [{ name: "write_file", args: { path: "notes/warm.txt", content: "ready" } }],
            complete: true,
          },
        ]);
        const bots = await handles.prisma.bot.findMany({
          where: { id: { in: [a.id, b.id] } },
          include: { thread: { select: { id: true } } },
        });
        expect(bots.every((bot) => bot.computerId)).toBe(true);
        expect(bots[0]!.computerId === bots[1]!.computerId).toBe(mode === "team");
        if (route !== "peer") {
          const group = await rpc<{ id: string; threadId: string }>(
            handles,
            cookie,
            "groups/create",
            {
              name: "File review",
              botIds: [a.id, b.id],
            },
          );
          const sender = bots.find((bot) => bot.id === a.id)!;
          const senderComputer = await handles.prisma.computer.findUniqueOrThrow({
            where: { id: sender.computerId! },
          });
          // Opaque binary fixtures exercise byte preservation, not document parsing.
          const materials = [
            {
              name: "bundle.zip",
              mimeType: "application/zip",
              bytes: new Uint8Array([80, 75, 5, 6, 0, 255, 1]),
            },
            {
              name: "legacy.xls",
              mimeType: "application/vnd.ms-excel",
              bytes: new Uint8Array([208, 207, 17, 224, 0, 255, 2]),
            },
            {
              name: "review.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              bytes: new Uint8Array([80, 75, 3, 4, 0, 255, 3]),
            },
          ];
          const context = {
            ...owner,
            botId: a.id,
            operationId: "selected-materials",
            traceId: "selected-materials",
            signal: new AbortController().signal,
          };
          for (const material of materials) {
            await sandbox.writeFile(
              toComputerRef(senderComputer),
              {
                path: resolveBotWorkspacePath(mode, a.id, `notes/${material.name}`),
                content: material.bytes,
              },
              context,
            );
          }
          const sourceRunId = await send(
            a.id,
            [
              {
                toolCalls: [
                  {
                    name: "handoff_to_bot",
                    args: {
                      group_id: group.id,
                      bot_id: b.id,
                      message: "Review the selected materials and post the report here.",
                      files: materials.map((file) => `notes/${file.name}`),
                    },
                  },
                ],
                complete: true,
              },
            ],
            route === "group-inside" ? group.id : undefined,
          );
          const recipients = await handles.prisma.run.findMany({
            where: { parentRunId: sourceRunId, botId: b.id },
          });
          expect(recipients).toHaveLength(1);
          const incoming = recipients[0]!;
          expect(incoming).toMatchObject({ threadId: group.threadId, trigger: "follow_up" });
          const source = await handles.prisma.message.findUniqueOrThrow({
            where: { id: incoming.sourceMessageId! },
          });
          const files = (source.blocks as MessageBlock[]).filter(
            (block): block is FileBlock => block.kind === "file" || block.kind === "image",
          );
          expect(files).toHaveLength(3);
          const event = await handles.prisma.event.findFirstOrThrow({
            where: {
              threadId: group.threadId,
              type: "group.handoff",
              payload: { path: ["messageId"], equals: source.id },
            },
          });
          expect(event.payload).toMatchObject({
            messageId: source.id,
            messageSeq: source.seq,
            role: "bot",
            blocks: source.blocks,
          });
          if (route === "group-outside-disabled") {
            const policy = await rpc<{ collaborationRevision: number }>(
              handles,
              cookie,
              "spaces/update",
              {
                spaceId: owner.spaceId,
                allowBotCollaboration: false,
                expectedCollaborationRevision: 0,
              },
            );
            expect(
              await handles.prisma.run.findUniqueOrThrow({ where: { id: incoming.id } }),
            ).toMatchObject({
              status: "cancelled",
              collaborationStatus: "policy_disabled",
              startedAt: null,
            });
            const stopped = await handles.prisma.message.findUniqueOrThrow({
              where: { id: source.id },
            });
            expect(
              (stopped.blocks as MessageBlock[]).find((block) => block.kind === "handoff"),
            ).toMatchObject({ deliveryStatus: "policy_disabled" });
            expect(
              (stopped.blocks as MessageBlock[]).filter((block) => block.kind === "file"),
            ).toEqual(files);
            await rpc(handles, cookie, "spaces/update", {
              spaceId: owner.spaceId,
              allowBotCollaboration: true,
              expectedCollaborationRevision: policy.collaborationRevision,
            });
            await settleCollaborationDelivery(handles.prisma, incoming.id, "completed");
            expect(
              (await handles.prisma.message.findUniqueOrThrow({ where: { id: source.id } })).blocks,
            ).toEqual(stopped.blocks);
            return;
          }
          const paths = files.map(
            (file) =>
              `attachments/${file.artifactId}${attachmentExtensionForMimeType(file.mimeType)}`,
          );
          await execute(incoming.id, [
            ...paths.map((filePath) => ({
              toolCalls: [{ name: "read_file", args: { path: filePath } }],
            })),
            {
              toolCalls: [
                {
                  name: "write_file",
                  args: { path: "notes/report.txt", content: "Selected group review is complete." },
                },
              ],
            },
            { toolCalls: [{ name: "attach_file", args: { path: "notes/report.txt" } }] },
            { assistant: "Selected group review is complete.", complete: true },
          ]);
          const settled = await handles.prisma.message.findUniqueOrThrow({
            where: { id: source.id },
          });
          expect(
            (settled.blocks as MessageBlock[]).find((block) => block.kind === "handoff"),
          ).toMatchObject({ deliveryStatus: "completed" });
          const update = await handles.prisma.event.findFirstOrThrow({
            where: {
              threadId: group.threadId,
              type: "thread.message.updated",
              payload: { path: ["messageId"], equals: source.id },
            },
            orderBy: { seq: "desc" },
          });
          expect((update.payload as { blocks: MessageBlock[] }).blocks).toEqual(settled.blocks);
          const target = bots.find((bot) => bot.id === b.id)!;
          const targetComputer = await handles.prisma.computer.findUniqueOrThrow({
            where: { id: target.computerId! },
          });
          for (const [index, file] of files.entries()) {
            const material = materials[index]!;
            expect(file).toMatchObject({ name: material.name, mimeType: material.mimeType });
            expect(
              await handles.prisma.artifact.findUniqueOrThrow({ where: { id: file.artifactId } }),
            ).toMatchObject({ botId: a.id, groupId: group.id });
            const downloaded = await rpc<{ contentBase64: string }>(
              handles,
              cookie,
              "artifacts/get",
              { groupId: group.id, artifactId: file.artifactId },
            );
            expect(new Uint8Array(Buffer.from(downloaded.contentBase64, "base64"))).toEqual(
              material.bytes,
            );
            expect(
              await sandbox.readFile(
                toComputerRef(targetComputer),
                resolveBotWorkspacePath(mode, b.id, paths[index]!),
                { ...context, botId: b.id },
              ),
            ).toEqual(material.bytes);
          }
          const snapshot = await rpc<ThreadSnapshot>(handles, cookie, "threads/get", {
            groupId: group.id,
          });
          const report = snapshot.messages
            .flatMap((message) => message.blocks)
            .find(
              (block): block is FileBlock => block.kind === "file" && block.name === "report.txt",
            );
          expect(report).toBeDefined();
          const downloaded = await rpc<{ contentBase64: string }>(
            handles,
            cookie,
            "artifacts/get",
            { groupId: group.id, artifactId: report!.artifactId },
          );
          expect(Buffer.from(downloaded.contentBase64, "base64").toString()).toBe(
            "Selected group review is complete.",
          );
          expect(await handles.prisma.run.count({ where: { parentRunId: incoming.id } })).toBe(0);
          return;
        }
        if (mode === "dedicated") {
          const target = bots.find((bot) => bot.id === b.id)!;
          const task = await handles.prisma.task.create({
            data: {
              spaceId: owner.spaceId,
              userId: owner.userId,
              botId: a.id,
              threadId: bots.find((bot) => bot.id === a.id)!.thread!.id,
              prompt: "Selected file delivery boundary",
              status: "running",
            },
          });
          const source = await handles.prisma.run.create({
            data: {
              spaceId: owner.spaceId,
              userId: owner.userId,
              botId: a.id,
              threadId: task.threadId,
              taskId: task.id,
              status: "running",
              trigger: "user",
            },
          });
          const artifact = await rpc<{ id: string }>(handles, cookie, "artifacts/create", {
            botId: b.id,
            name: "delivery-boundary.txt",
            mimeType: "text/plain",
            contentBase64: Buffer.from("selected bytes").toString("base64"),
          });
          const files = [
            {
              kind: "file" as const,
              artifactId: artifact.id,
              name: "delivery-boundary.txt",
              mimeType: "text/plain",
              size: 14,
            },
          ];
          const dispatch = {
            prisma: handles.prisma,
            jobs: handles.jobs,
            events: { notify: vi.fn(async () => undefined) },
          };
          const input = {
            bot_id: target.id,
            message: "Read this selected file",
            deliveryKey: "selected-delivery-once",
            files,
          };
          const first = await tenant(() =>
            messageBot(dispatch, source, { id: a.id, name: "Coordinator" }, input),
          );
          const replay = await tenant(() =>
            messageBot(dispatch, source, { id: a.id, name: "Coordinator" }, input),
          );
          expect(first).toMatchObject({ ok: true });
          expect(replay).toMatchObject({ ok: true, replayed: true });
          expect(await handles.prisma.run.count({ where: { parentRunId: source.id } })).toBe(1);
          expect(
            await handles.prisma.message.count({
              where: {
                threadId: target.thread!.id,
                clientNonce: "bot-message:selected-delivery-once",
              },
            }),
          ).toBe(1);
          await rpc(handles, cookie, "threads/stop", { botId: a.id });
          expect(
            await tenant(() =>
              messageBot(
                dispatch,
                source,
                { id: a.id, name: "Coordinator" },
                { ...input, deliveryKey: "after-stop" },
              ),
            ),
          ).toMatchObject({ ok: false });
          expect(await handles.prisma.run.count({ where: { parentRunId: source.id } })).toBe(1);
        }
        const originalRunId = await send(a.id, [
          {
            toolCalls: [
              {
                name: "message_bot",
                args: {
                  bot_id: b.id,
                  message: "Review this material and return the selected report.",
                  files: ["notes/input.txt"],
                },
              },
            ],
            complete: true,
          },
        ]);
        const incoming = await handles.prisma.run.findFirstOrThrow({
          where: { parentRunId: originalRunId, botId: b.id },
        });
        const source = await handles.prisma.message.findUniqueOrThrow({
          where: { id: incoming.sourceMessageId! },
        });
        const blocks = source.blocks as MessageBlock[];
        const files = blocks.filter(
          (block): block is FileBlock => block.kind === "file" || block.kind === "image",
        );
        expect(files).toHaveLength(mode === "team" ? 0 : 1);
        const inputPath =
          mode === "team"
            ? resolveBotWorkspacePath(mode, a.id, "notes/input.txt")
            : `attachments/${files[0]!.artifactId}${attachmentExtensionForMimeType(files[0]!.mimeType)}`;
        if (files.length) {
          expect(
            await handles.prisma.artifact.findUniqueOrThrow({
              where: { id: files[0]!.artifactId },
            }),
          ).toMatchObject({ botId: b.id, groupId: null });
          const event = await handles.prisma.event.findFirstOrThrow({
            where: {
              threadId: incoming.threadId,
              type: "thread.message.created",
              payload: { path: ["messageId"], equals: source.id },
            },
          });
          expect((event.payload as { blocks: MessageBlock[] }).blocks).toEqual(blocks);
        }
        await execute(incoming.id, [
          { toolCalls: [{ name: "read_file", args: { path: inputPath } }] },
          {
            toolCalls: [
              {
                name: "write_file",
                args: { path: "notes/report.txt", content: "Reviewed selected material α" },
              },
            ],
          },
          {
            assistant: "The selected report was returned.",
            toolCalls: [
              {
                name: "message_bot",
                args: {
                  bot_id: a.id,
                  intent: "result",
                  message: "The selected review is complete.",
                  files: ["notes/report.txt"],
                },
              },
            ],
            complete: true,
          },
        ]);
        const returned = await handles.prisma.run.findMany({
          where: { parentRunId: incoming.id, botId: a.id, origin: "peer_return" },
        });
        expect(returned).toHaveLength(1);
        const result = await handles.prisma.message.findUniqueOrThrow({
          where: { id: returned[0]!.sourceMessageId! },
        });
        const resultFiles = (result.blocks as MessageBlock[]).filter(
          (block): block is FileBlock => block.kind === "file" || block.kind === "image",
        );
        expect(resultFiles).toHaveLength(mode === "team" ? 0 : 1);
        const resultPath =
          mode === "team"
            ? resolveBotWorkspacePath(mode, b.id, "notes/report.txt")
            : `attachments/${resultFiles[0]!.artifactId}.txt`;
        await execute(returned[0]!.id, [
          { toolCalls: [{ name: "read_file", args: { path: resultPath } }] },
          ...(mode === "team"
            ? [{ toolCalls: [{ name: "attach_file", args: { path: resultPath } }] }]
            : []),
          { assistant: "Reviewed selected material α", complete: true },
        ]);
        const snapshot = await rpc<ThreadSnapshot>(handles, cookie, "threads/get", { botId: a.id });
        const visibleFiles = snapshot.messages.flatMap((message) =>
          message.blocks.filter(
            (block): block is FileBlock => block.kind === "file" || block.kind === "image",
          ),
        );
        expect(visibleFiles).toHaveLength(1);
        const downloaded = await rpc<{ contentBase64: string }>(handles, cookie, "artifacts/get", {
          botId: a.id,
          artifactId: visibleFiles[0]!.artifactId,
        });
        expect(Buffer.from(downloaded.contentBase64, "base64").toString()).toBe(
          "Reviewed selected material α",
        );
        const target = bots.find((bot) => bot.id === b.id)!;
        const computer = await handles.prisma.computer.findUniqueOrThrow({
          where: { id: target.computerId! },
        });
        const readback = await sandbox.readFile(
          toComputerRef(computer),
          resolveBotWorkspacePath(mode, b.id, inputPath),
          {
            ...owner,
            botId: b.id,
            operationId: "file-readback",
            traceId: "file-readback",
            signal: new AbortController().signal,
          },
        );
        expect(new TextDecoder().decode(readback)).toBe("Selected material α");
      } finally {
        held?.mockRestore();
        await handles.stop();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
