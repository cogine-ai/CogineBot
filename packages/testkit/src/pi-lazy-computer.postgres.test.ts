import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import { createThreadMessage } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("lazy computer through the Pi model request", () => {
  it.each([
    {
      name: "pure text",
      computerTools: false,
      stopDuringStart: false,
      stopBeforeStart: false,
      stopDuringHistory: false,
      task: "Reply with a short greeting.",
    },
    {
      name: "computer tools",
      computerTools: true,
      stopDuringStart: false,
      stopBeforeStart: false,
      stopDuringHistory: false,
      task: "List files, save hello in notes/result.txt, and read it.",
    },
    {
      name: "Stop during a late computer start",
      computerTools: true,
      stopDuringStart: true,
      stopBeforeStart: false,
      stopDuringHistory: false,
      task: "Save hello in notes/result.txt.",
    },
    {
      name: "Stop before the first computer tool",
      computerTools: true,
      stopDuringStart: false,
      stopBeforeStart: true,
      stopDuringHistory: false,
      task: "Save hello in notes/result.txt.",
    },
    {
      name: "Stop while preparing an earlier attachment",
      computerTools: true,
      stopDuringStart: false,
      stopBeforeStart: false,
      stopDuringHistory: true,
      task: "Save hello in notes/result.txt.",
    },
  ])(
    "keeps the required computer lifecycle for $name",
    async ({ computerTools, stopDuringStart, stopBeforeStart, stopDuringHistory, task }) => {
      const fixtureKey = "offline-lazy-computer-fixture-key";
      const stopped = stopBeforeStart || stopDuringStart || stopDuringHistory;
      let modelWaiting = false;
      let finishBlockedWork = () => {};
      const allowReturn = new Promise<void>((resolve) => {
        finishBlockedWork = resolve;
      });
      const startsAtRequests: number[] = [];
      let countStarts = () => -1;
      const capture: ModelEmulatorStep["expect"] = async () => {
        startsAtRequests.push(countStarts());
        if (stopBeforeStart) {
          modelWaiting = true;
          await allowReturn;
        }
      };
      const steps: ModelEmulatorStep[] = stopped
        ? [
            {
              expect: capture,
              response: {
                type: "tool",
                id: "late-write",
                name: "write_file",
                arguments: { path: "notes/result.txt", content: "hello" },
              },
            },
          ]
        : computerTools
          ? [
              {
                expect: capture,
                response: { type: "tool", id: "lazy-list", name: "list_files", arguments: {} },
              },
              {
                expect: capture,
                response: {
                  type: "tool",
                  id: "lazy-write",
                  name: "write_file",
                  arguments: { path: "notes/result.txt", content: "hello" },
                },
              },
              {
                expect: capture,
                response: {
                  type: "tool",
                  id: "lazy-read",
                  name: "read_file",
                  arguments: { path: "notes/result.txt" },
                },
              },
              { expect: capture, response: { type: "text", text: "Saved and checked the file." } },
            ]
          : [{ expect: capture, response: { type: "text", text: "Hello." } }];
      const model = await startModelEmulator({ apiKey: fixtureKey, steps });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-pi-lazy-computer-"));
      vi.stubEnv("SANDBOX_IDLE_MS", "300000");
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("../../../apps/api/src/app.ts");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioEmulator(),
          encryptionKey: "offline-lazy-computer-fixture-encryption-key",
        });
        stop = handles.stop;
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `offline-lazy-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Lazy computer fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        const credential = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        await rpc(handles.app, cookie, "models/setDefault", {
          provider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Lazy computer fixture",
          title: "",
          description: "",
          instructions: "Complete the task.",
          notifyOnFinish: false,
          computerMode: stopped ? "team" : "dedicated",
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        let historyCopyPath = "";
        if (stopDuringHistory) {
          const artifact = await rpc<{ id: string }>(handles.app, cookie, "artifacts/create", {
            botId: bot.id,
            name: "earlier.txt",
            mimeType: "text/plain",
            contentBase64: Buffer.from("old").toString("base64"),
          });
          const thread = await handles.prisma.thread.findFirstOrThrow({ where: { botId: bot.id } });
          await createThreadMessage(handles.prisma, {
            threadId: thread.id,
            role: "user",
            blocks: [
              {
                kind: "file",
                artifactId: artifact.id,
                name: "earlier.txt",
                mimeType: "text/plain",
                size: 3,
              },
            ],
          });
          historyCopyPath = `bots/${bot.id}/attachments/${artifact.id}.txt`;
        }
        const startComputer = handles.sandbox.provision.bind(handles.sandbox);
        const provision = vi.spyOn(handles.sandbox, "provision");
        let providerReady = false;
        if (stopDuringStart) {
          provision.mockImplementation(async (request, context) => {
            const computer = await startComputer(request, context);
            providerReady = true;
            // Hold only the provider return; allocation and lifecycle code stay real.
            await allowReturn;
            return computer;
          });
        }
        const copyFile = handles.sandbox.writeFile.bind(handles.sandbox);
        const writeFile = vi.spyOn(handles.sandbox, "writeFile");
        let historyCopyReady = false;
        if (stopDuringHistory) {
          writeFile.mockImplementation(async (computer, file, context) => {
            if (file.path === historyCopyPath) {
              historyCopyReady = true;
              // An earlier-file copy is already dispatched; pause before its write settles.
              await allowReturn;
            }
            return copyFile(computer, file, context);
          });
        }
        const exportWorkspace = vi.spyOn(handles.sandbox, "exportWorkspace");
        const releaseScreen = vi.spyOn(handles.sandbox, "releaseScreen");
        const enqueue = vi.spyOn(handles.jobs, "enqueue");
        countStarts = () => provision.mock.calls.length;
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: task,
        });
        const started = await handles.prisma.run.findUniqueOrThrow({
          where: { id: sent.runId },
          select: {
            botId: true,
            threadId: true,
            sourceMessageId: true,
            userId: true,
            spaceId: true,
          },
        });
        if (stopped) {
          await expect
            .poll(
              () =>
                stopBeforeStart
                  ? modelWaiting
                  : stopDuringHistory
                    ? historyCopyReady
                    : providerReady,
              {
                timeout: 15_000,
                interval: 20,
              },
            )
            .toBe(true);
          await rpc(handles.app, cookie, "threads/stop", { botId: bot.id });
          expect(
            await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
          ).toMatchObject({ status: "cancelled" });
          expect(writeFile.mock.calls.filter(([, file]) => file.path !== historyCopyPath)).toEqual(
            [],
          );
          finishBlockedWork();
        }
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: sent.runId } });
              if (run?.status === "failed") model.assertComplete();
              return run?.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe(stopped ? "cancelled" : "completed");
        await handles.awaitIdle?.();
        if (stopped) {
          expect
            .soft({
              writes: writeFile.mock.calls
                .filter(([, file]) => file.path !== historyCopyPath)
                .map(([, file, context]) => ({
                  path: file.path,
                  runId: context.runId,
                })),
              exports: exportWorkspace.mock.calls.length,
              requests: model.requests.length,
            })
            .toEqual({ writes: [], exports: 0, requests: 1 });
        }
        model.assertComplete();
        expect(
          writeFile.mock.calls.filter(([, file]) => file.path === historyCopyPath),
        ).toHaveLength(stopDuringHistory ? 1 : 0);
        const firstUserContext = model.requests[0]!.messages.filter(
          (message) => message.role === "user",
        )
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        expect(firstUserContext.split(task)).toHaveLength(2);
        expect(startsAtRequests).toEqual(stopped ? [0] : computerTools ? [0, 1, 1, 1] : [0]);
        expect(provision).toHaveBeenCalledTimes(computerTools && !stopBeforeStart ? 1 : 0);
        const sleepJobs = enqueue.mock.calls.filter(([job]) => job.name === "computer.sleep");
        if (stopped) {
          if (stopBeforeStart) {
            expect(sleepJobs).toEqual([]);
            expect(releaseScreen).not.toHaveBeenCalled();
          } else {
            expect(releaseScreen).toHaveBeenCalled();
          }
        } else if (computerTools) {
          expect(sleepJobs).toHaveLength(1);
          expect(exportWorkspace).toHaveBeenCalledOnce();
          expect(releaseScreen).toHaveBeenCalledOnce();
          const lastTool = model.requests
            .at(-1)
            ?.messages.findLast((message) => message.role === "tool");
          expect(lastTool?.tool_call_id).toBe("lazy-read");
          expect(JSON.parse(String(lastTool?.content))).toMatchObject({
            path: "notes/result.txt",
            content: "hello",
          });
        } else {
          expect(sleepJobs).toEqual([]);
          expect(exportWorkspace).not.toHaveBeenCalled();
          expect(releaseScreen).not.toHaveBeenCalled();
        }
        const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        expect(run).toMatchObject({
          ...started,
          botId: bot.id,
          status: stopped ? "cancelled" : "completed",
        });
        expect(
          await handles.prisma.computerExecutionLease.count({
            where: { runId: run.id, expiresAt: { gt: new Date() } },
          }),
        ).toBe(0);
        const source = await handles.prisma.message.findUniqueOrThrow({
          where: { id: run.sourceMessageId! },
        });
        expect(source).toMatchObject({ threadId: run.threadId, role: "user" });
        expect(source.blocks).toEqual([{ kind: "text", text: task }]);
        const messages = await handles.prisma.message.findMany({
          where: { threadId: run.threadId },
          orderBy: { seq: "asc" },
        });
        expect(messages.filter((message) => message.id === run.sourceMessageId)).toHaveLength(1);
        expect(
          messages.filter(
            (message) => message.role === "user" && JSON.stringify(message.blocks).includes(task),
          ),
        ).toHaveLength(1);
        if (stopped) {
          expect(
            messages.filter((message) => message.runId === run.id && message.role === "bot"),
          ).toEqual([]);
          expect(
            await handles.prisma.event.count({ where: { runId: run.id, type: "run.cancelled" } }),
          ).toBe(1);
        } else {
          expect(JSON.stringify(messages)).toContain(
            computerTools ? "Saved and checked the file." : "Hello.",
          );
        }
        expect(JSON.stringify(messages)).not.toContain(fixtureKey);
        expect(
          await handles.prisma.attempt.count({ where: { runId: run.id, status: "running" } }),
        ).toBe(0);
      } finally {
        finishBlockedWork();
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }
      }
    },
    30_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
