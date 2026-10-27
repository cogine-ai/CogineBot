import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    const fixtureKey = "offline-product-fixture-key";
    let helperCredentialId = "";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            const helper = request.tools?.find((tool) => tool.function.name === "run_subagent");
            expect(helper?.function.description).toContain(helperCredentialId);
            expect(helper?.function.description).toContain('"model_provider":"openai-compatible"');
            expect(helper?.function.description).toContain('"model_ids":["helper-only-model"]');
            expect(helper?.function.description).not.toContain("helper-fixture-key");
            expect(helper?.function.description).not.toContain("http://127.0.0.1:11435");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: {
            type: "tool",
            id: "product-shell",
            name: "shell",
            arguments: { command: "wc -c notes/result.txt" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-shell");
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
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
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
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
      const helper = await rpc<ModelCredential>(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: "helper-only-model",
        enabledModelIds: ["helper-only-model"],
        baseUrl: "http://127.0.0.1:11435/v1",
        apiKey: "helper-fixture-key",
      });
      helperCredentialId = helper.id;
      // This account connection remains explicitly available to helpers without a local preference.
      await handles.prisma.spaceModelPreference.deleteMany({ where: { credentialId: helper.id } });
      await rpc(handles.app, cookie, "models/setDefault", {
        provider: model.model.provider,
        modelId: model.model.id,
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "File fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
        modelCredentialId: credential.id,
        expectedRevision: credential.connectionRevision,
      });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await expect
        .poll(
          async () => {
            const run = await handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { status: true },
            });
            if (run?.status === "failed") model.assertComplete();
            return run?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/result.txt",
      });
      expect(file.content).toBe("hello");
      const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const messages = JSON.stringify(thread.messages);
      expect(messages).toContain("Saved notes/result.txt.");
      expect(messages).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        select: { payload: true },
      });
      expect(tools).toHaveLength(2);
      expect(JSON.stringify(tools[0])).toContain("write_file");
      const commands = await rpc<Array<Record<string, unknown>>>(
        handles.app,
        cookie,
        "computer/commands",
        { botId: bot.id },
      );
      expect(commands).toEqual([
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-write"]),
          kind: "write_file",
          command: "notes/result.txt",
          status: "done",
          exitCode: 0,
          bytes: 5,
        }),
        expect.objectContaining({
          executionId: JSON.stringify(["pi-tool", "main", "product-shell"]),
          kind: "shell",
          command: "wc -c notes/result.txt",
          status: "done",
          exitCode: 0,
        }),
      ]);
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it.each([
    {
      reason: "done" as const,
      note: "The user handed the computer back. Continue from where you left off. Do not request takeover again.",
    },
    {
      reason: "skipped" as const,
      note: "The takeover ended without the user completing it. Continue without assuming that step was done. Do not request takeover again unless you still cannot proceed.",
    },
  ])(
    "passes a neutral $reason takeover resume through the Pi model request",
    async ({ reason, note }) => {
      const fixtureKey = "offline-takeover-fixture-key";
      const task = "Check the login screen, then wait for my manual confirmation.";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              const current = request.messages.findLast((message) => message.role === "user");
              expect(JSON.stringify(current?.content)).toContain(task);
              expect(JSON.stringify(current?.content)).not.toContain(note);
            },
            response: {
              type: "tool",
              id: "manual-screen-choice",
              name: "request_takeover",
              arguments: { reason: "Choose an option on the current screen." },
            },
          },
          {
            expect(request) {
              expect(request.messages.findLast((message) => message.role === "user")).toBeDefined();
            },
            response: { type: "text", text: "Control handoff received." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-takeover-"));
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
          encryptionKey: "offline-takeover-fixture-encryption-key",
        });
        stop = handles.stop;
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `offline-takeover-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Takeover fixture",
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
          name: "Screen fixture",
          title: "",
          description: "",
          instructions: "Continue only from observed state.",
          notifyOnFinish: false,
          computerMode: "dedicated",
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
          modelCredentialId: credential.id,
          expectedRevision: credential.connectionRevision,
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: task,
        });
        await expect
          .poll(
            async () =>
              (await handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
            { timeout: 15_000, interval: 50 },
          )
          .toBe("waiting_takeover");
        const waiting = await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
        const userMessages = await handles.prisma.message.findMany({
          where: { threadId: waiting.threadId, role: "user" },
          select: { id: true },
          orderBy: { seq: "asc" },
        });
        expect(userMessages).toContainEqual({ id: waiting.sourceMessageId });
        await rpc(handles.app, cookie, "computer/boot", { botId: bot.id });
        await rpc(handles.app, cookie, "computer/takeover", { botId: bot.id });
        await rpc(handles.app, cookie, "computer/release", { botId: bot.id, reason });
        await expect
          .poll(
            async () => {
              const run = await handles.prisma.run.findUnique({ where: { id: sent.runId } });
              if (run?.status === "failed") model.assertComplete();
              return run?.status;
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe("completed");
        model.assertComplete();
        expect(model.requests).toHaveLength(2);
        const resumed = model.requests[1]!;
        const currentUser = resumed.messages.findLast((message) => message.role === "user");
        const prompt = JSON.stringify(currentUser?.content);
        expect(prompt).toContain(note);
        expect(prompt.split(note)).toHaveLength(2);
        expect(prompt).not.toMatch(/The user (?:finished|skipped) the login/i);
        const userContext = resumed.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content))
          .join("\n");
        expect(userContext.split(task)).toHaveLength(2);
        expect(
          await handles.prisma.message.findMany({
            where: { threadId: waiting.threadId, role: "user" },
            select: { id: true },
            orderBy: { seq: "asc" },
          }),
        ).toEqual(userMessages);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
        ).toMatchObject({
          threadId: waiting.threadId,
          sourceMessageId: waiting.sourceMessageId,
          status: "completed",
        });
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
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
